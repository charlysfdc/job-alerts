// daily-search: finds jobs for one person, keeps the ones that fit, and emails them.
//
// Called two ways:
//  - pg_cron every 10 minutes with an empty body: runs the next person who is due today
//    (in the background) and returns at once. Without a due person it does nothing.
//  - an admin with { person_id, email?: boolean } ("Run now"): runs that person and waits.
//
// Sources, each switched on by its secrets (Supabase > Edge Functions > Secrets):
//  - SerpApi Google Jobs: SERPAPI_KEY. Optional SERPAPI_PER_RUN (searches per person per run, default 2)
//    and SERPAPI_MONTHLY_LIMIT (stop for the month at this many, default 240: the free plan is 250).
//  - Adzuna: ADZUNA_APP_ID + ADZUNA_APP_KEY. Optional ADZUNA_PER_RUN (default 6).
// Email: RESEND_API_KEY (+ optional EMAIL_FROM, APP_URL). Without it, leads still land in the app.
// Claude (ANTHROPIC_API_KEY) judges every new posting against the person's profile.
import Anthropic from 'npm:@anthropic-ai/sdk@0.135.0'
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0'

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

function admin(): SupabaseClient {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY')
  if (!key) throw new HttpError(500, 'The function has no service key.')
  return createClient(Deno.env.get('SUPABASE_URL')!, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

const env = (k: string) => Deno.env.get(k) || null
const num = (k: string, d: number) => {
  const n = Number(env(k))
  return Number.isFinite(n) && n >= 0 ? n : d
}
const APP_URL = env('APP_URL') ?? 'https://jobs.afrikanerinamerika.com'
const EMAIL_FROM = env('EMAIL_FROM') ?? 'AiA Job Alerts <jobs@afrikanerinamerika.com>'
const MAX_TO_JUDGE = 40

const hasSerp = () => Boolean(env('SERPAPI_KEY'))
const hasAdzuna = () => Boolean(env('ADZUNA_APP_ID') && env('ADZUNA_APP_KEY'))

// ---- places ------------------------------------------------------------------------

const STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
}

/** "Austin TX 78737 (Dripping Springs)" → city Austin, state Texas, zip 78737 */
function place(homeBase: string | null) {
  const s = (homeBase ?? '').replace(/\(.*?\)/g, ' ').replace(/,/g, ' ').trim()
  const m = s.match(/^(.*?)\s+([A-Z]{2})\b(?:\s+(\d{5}))?/)
  if (!m || !STATES[m[2]]) return null
  return { city: m[1].trim(), stateCode: m[2], state: STATES[m[2]], zip: m[3] ?? null }
}

// ---- postings ------------------------------------------------------------------------

interface Posting {
  source: 'google_jobs' | 'adzuna'
  source_id: string | null
  title: string
  employer: string
  location: string | null
  remote: boolean
  url: string | null
  apply_links: { title: string; link: string }[]
  posted_at: string | null
  pay_text: string | null
  employment_type: string | null
  description: string
}

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()

const normalise = (s: string) =>
  s.toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|plc|group)\b\.?/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
const keyOf = (employer: string, title: string) => `${normalise(employer)}|${normalise(title)}`

const day = (d: Date) => d.toISOString().slice(0, 10)

/** "3 days ago", "21 hours ago", "1 month ago" → a date */
function ago(text: string | undefined | null): string | null {
  if (!text) return null
  const m = text.match(/(\d+)\+?\s*(minute|hour|day|week|month)/i)
  if (!m) return /just|today/i.test(text) ? day(new Date()) : null
  const n = Number(m[1])
  const unit = m[2].toLowerCase()
  const ms = { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6 }[unit as 'day']
  return day(new Date(Date.now() - n * ms))
}

const AGGREGATORS = /linkedin|indeed|ziprecruiter|glassdoor|monster|simplyhired|talent\.com|jooble|careerbuilder|lensa|adzuna|bebee|jobrapido|salary\.com/i

async function serpSearch(q: string, where: string | null, remote: boolean, radiusKm: number): Promise<Posting[]> {
  const params = new URLSearchParams({ engine: 'google_jobs', q, hl: 'en', gl: 'us', api_key: env('SERPAPI_KEY')! })
  if (remote) params.set('ltype', '1')
  if (where) {
    params.set('location', where)
    if (!remote) params.set('lrad', String(Math.round(radiusKm)))
  } else params.set('location', 'United States')
  const r = await fetch(`https://serpapi.com/search.json?${params}`)
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data?.error ?? `SerpApi ${r.status}`)
  if (data?.error && !/hasn't returned any results/i.test(data.error)) throw new Error(data.error)
  // deno-lint-ignore no-explicit-any
  return (data.jobs_results ?? []).map((j: any): Posting => {
    const links: { title: string; link: string }[] = (j.apply_options ?? []).slice(0, 5).map((a: { title: string; link: string }) => ({ title: a.title, link: a.link }))
    const direct = links.find((a) => !AGGREGATORS.test(a.title) && !AGGREGATORS.test(a.link))
    const ext = j.detected_extensions ?? {}
    return {
      source: 'google_jobs',
      source_id: j.job_id ? String(j.job_id).slice(0, 300) : null,
      title: stripHtml(j.title ?? ''),
      employer: stripHtml(j.company_name ?? ''),
      location: j.location ?? null,
      remote: Boolean(ext.work_from_home) || /remote|anywhere/i.test(j.location ?? ''),
      url: direct?.link ?? links[0]?.link ?? j.share_link ?? null,
      apply_links: links,
      posted_at: ago(ext.posted_at),
      pay_text: ext.salary ?? null,
      employment_type: ext.schedule_type ?? null,
      description: j.description ?? '',
    }
  })
}

async function adzunaSearch(what: string, where: string | null, radiusKm: number, maxDays: number): Promise<Posting[]> {
  const params = new URLSearchParams({
    app_id: env('ADZUNA_APP_ID')!, app_key: env('ADZUNA_APP_KEY')!,
    results_per_page: '20', what, max_days_old: String(maxDays), sort_by: 'date',
  })
  if (where) {
    params.set('where', where)
    params.set('distance', String(Math.round(radiusKm)))
  }
  const r = await fetch(`https://api.adzuna.com/v1/api/jobs/us/search/1?${params}`, { headers: { Accept: 'application/json' } })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data?.display ?? data?.exception ?? `Adzuna ${r.status}`)
  // deno-lint-ignore no-explicit-any
  return (data.results ?? []).map((j: any): Posting => {
    const desc = stripHtml(j.description ?? '')
    const title = stripHtml(j.title ?? '')
    const pay = j.salary_min && !Number(j.salary_is_predicted)
      ? `$${Math.round(j.salary_min).toLocaleString('en-US')}${j.salary_max && j.salary_max !== j.salary_min ? `–$${Math.round(j.salary_max).toLocaleString('en-US')}` : ''} a year`
      : null
    return {
      source: 'adzuna',
      source_id: j.id ? String(j.id) : null,
      title,
      employer: stripHtml(j.company?.display_name ?? ''),
      location: j.location?.display_name ?? null,
      remote: /remote|work from home/i.test(`${title} ${desc}`),
      url: j.redirect_url ?? null,
      apply_links: [],
      posted_at: j.created ? String(j.created).slice(0, 10) : null,
      pay_text: pay,
      employment_type: j.contract_time ?? j.contract_type ?? null,
      description: desc,
    }
  })
}

// ---- rules that need no judgement ------------------------------------------------------

/** "$45–$55 an hour", "120K–150K a year", "$90,000" → yearly dollars (hourly × 2,080) */
function yearlyPay(text: string | null): { min: number; max: number } | null {
  if (!text) return null
  const nums = [...text.matchAll(/\$?\s*(\d[\d,]*(?:\.\d+)?)\s*([kK])?/g)]
    .map((m) => Number(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1))
    .filter((n) => n > 0)
  if (!nums.length) return null
  const hourly = /hour|hr\b|hourly/i.test(text)
  const monthly = /month/i.test(text)
  const f = hourly ? 2080 : monthly ? 12 : 1
  const vals = nums.map((n) => n * f).filter((n) => n >= 10_000)
  if (!vals.length) return null
  return { min: Math.min(...vals), max: Math.max(...vals) }
}

const TYPE: [RegExp, string][] = [
  [/full[\s_-]?time|permanent/i, 'full_time'],
  [/part[\s_-]?time/i, 'part_time'],
  [/contract|temporary|temp\b|freelance/i, 'contract'],
]

// deno-lint-ignore no-explicit-any
function ruleOut(p: Posting, profile: any): string | null {
  const windowDays = profile.posting_window_days ?? 14
  if (p.posted_at && Date.now() - new Date(p.posted_at).getTime() > (windowDays + 1) * 864e5) return `Posted more than ${windowDays} days ago`

  const loc = (p.location ?? '').toLowerCase()
  for (const out of profile.out_of_range_places ?? []) {
    const o = String(out).toLowerCase().replace(/\(.*?\)/g, '').trim()
    if (o.length > 2 && loc.includes(o)) return `In ${out}, which is out of range`
  }
  if (profile.remote === 'onsite_only' && p.remote && !p.location) return 'Remote only'

  const pay = yearlyPay(p.pay_text)
  const floor = profile.pay_floor_annual ?? (profile.pay_floor_hourly ? Number(profile.pay_floor_hourly) * 2080 : null)
  if (pay && floor && pay.max < floor) return `Pays ${p.pay_text}, below the floor`

  const text = `${p.title} ${p.description}`
  const auth = profile.work_authorization
  if (auth !== 'citizen' && /(u\.?s\.? citizen(ship)?( is)? required|must be a u\.?s\.? citizen|requires? u\.?s\.? citizenship|(active|current|secret|top secret|ts\/sci) (security )?clearance)/i.test(text)) {
    return 'Needs US citizenship or a security clearance'
  }
  if (auth === 'needs_sponsorship' && /(no|not|unable to|will not|won't|cannot|can't) (provide |offer |support )?(visa )?sponsor/i.test(text)) {
    return 'Does not sponsor visas'
  }

  const kinds: string[] = profile.employment_types ?? []
  if (kinds.length && p.employment_type) {
    const kind = TYPE.find(([re]) => re.test(p.employment_type!))?.[1]
    const adjunct = kinds.includes('adjunct') && /adjunct/i.test(p.title)
    if (kind && !kinds.includes(kind) && !adjunct) return `${p.employment_type}, not the kind of work they want`
  }
  return null
}

// ---- Claude's judgement ----------------------------------------------------------------

interface Verdict {
  n: number
  keep: boolean
  score: number
  fit: 'strong' | 'good' | 'stretch'
  family: string
  why: string
  concerns: string[]
  reject_reason: string
}

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['n', 'keep', 'score', 'fit', 'family', 'why', 'concerns', 'reject_reason'],
        properties: {
          n: { type: 'integer' },
          keep: { type: 'boolean' },
          score: { type: 'integer' },
          fit: { type: 'string', enum: ['strong', 'good', 'stretch'] },
          family: { type: 'string' },
          why: { type: 'string' },
          concerns: { type: 'array', items: { type: 'string' } },
          reject_reason: { type: 'string' },
        },
      },
    },
  },
}

const SYSTEM = `You pick jobs for one job seeker. Most of the people this service helps are immigrants to the United States (many from South Africa) rebuilding a career here, following the Charly Resume Method.

You get their profile (rules, facts, job families) and numbered job postings. Judge every posting and return one result per number.

How to judge:
- Use only the facts given. Never assume experience, licences or degrees that are not in the facts.
- keep = false when the job needs something they clearly lack (a licence, a US degree they don't have, citizenship or clearance they don't have), breaks one of their rules or exclusions, is in a different field from all their job families, is commission-only (unless their rules allow it), or is a vague staffing-agency ad with no real job behind it. Put the reason in reject_reason (short, plain). Otherwise reject_reason is "".
- Job families have a track. "Get working now" (bridge) families are jobs they could start soon for income and US references: be generous about level, strict about whether they could really be hired soon. "Career path" families: be strict about level and fit.
- score 0–100 for how well it fits and how likely they are to be hired. 85+ is strong (apply this week), 70–84 good, 55–69 stretch. Below 55 means keep = false.
- fit: strong, good or stretch, matching the score.
- family: the name of the job family it fits best, exactly as given.
- why: one sentence written to the person, naming the one or two facts from their profile that make them a match. Plain American English, no hype, no exclamation marks.
- concerns: at most two short things they should know before applying (for example "Asks for a US bachelor's degree", "About 50 minutes from home", "Pay not listed"). Empty when there are none.
- Facts may contain notes marked TO CONFIRM; treat those parts as unknown.`

// deno-lint-ignore no-explicit-any
function profileText(person: any, profile: any, families: any[]) {
  const list = (xs: string[] | null | undefined) => (xs && xs.length ? xs.map((x) => `- ${x}`).join('\n') : '(none)')
  return [
    `Name: ${person.name}`,
    `Home base: ${person.home_base ?? '(not set)'}`,
    `Work authorisation: ${profile.work_authorization}${profile.work_authorization_note ? ` (${profile.work_authorization_note})` : ''}`,
    `Remote or local: ${profile.remote}; longest daily drive: ${profile.max_commute_minutes ?? 'not set'} minutes${profile.commute_note ? ` (${profile.commute_note})` : ''}`,
    `In range: ${(profile.in_range_places ?? []).join(', ') || '(not listed)'}`,
    `Out of range: ${(profile.out_of_range_places ?? []).join(', ') || '(not listed)'}`,
    `Kinds of work: ${(profile.employment_types ?? []).join(', ') || 'any'}`,
    `Pay floor: ${profile.pay_floor_annual ? `$${profile.pay_floor_annual}/year` : ''}${profile.pay_floor_hourly ? ` $${profile.pay_floor_hourly}/hour` : ''}${!profile.pay_floor_annual && !profile.pay_floor_hourly ? 'not set' : ''}${profile.pay_note ? ` (${profile.pay_note})` : ''}`,
    `Hours: ${profile.hours_note ?? '(no note)'}`,
    `Education: ${profile.education_note ?? '(no note)'}`,
    `Exclude:\n${list(profile.exclusions)}`,
    `Other rules:\n${list(profile.other_rules)}`,
    `Headline: ${profile.headline ?? '(none)'}`,
    `Facts:\n${list(profile.facts)}`,
    `Job families:\n${families.map((f) => `- ${f.name} [${f.track === 'asap' ? 'Get working now' : 'Career path'}]: ${(f.search_titles ?? []).join(', ')}${f.why ? `. Why: ${f.why}` : ''}${(f.gaps ?? []).length ? `. Known gaps: ${f.gaps.join('; ')}` : ''}`).join('\n') || '(none)'}`,
  ].join('\n')
}

function postingText(p: Posting, n: number) {
  return [
    `[${n}] ${p.title} | ${p.employer} | ${p.location ?? 'location not given'}${p.remote ? ' | remote' : ''}`,
    `Posted: ${p.posted_at ?? 'unknown'} | Pay: ${p.pay_text ?? 'not listed'} | Type: ${p.employment_type ?? 'not listed'}`,
    p.description.slice(0, 1800),
  ].join('\n')
}

// deno-lint-ignore no-explicit-any
async function judge(person: any, profile: any, families: any[], postings: Posting[]): Promise<Verdict[]> {
  const client = new Anthropic()
  // fallbacks: 'default' re-runs a declined request on Anthropic's recommended model (beta header below)
  // deno-lint-ignore no-explicit-any
  const params: any = {
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `The job seeker's profile:\n\n${profileText(person, profile, families)}\n\nThe postings:\n\n${postings.map((p, i) => postingText(p, i + 1)).join('\n\n---\n\n')}`,
    }],
  }
  const response = await client.beta.messages.create(params)
  if (response.stop_reason === 'refusal') throw new Error('Claude declined to judge these postings.')
  if (response.stop_reason === 'max_tokens') throw new Error('Too many postings to judge at once.')
  // deno-lint-ignore no-explicit-any
  const text = response.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
  return (JSON.parse(text) as { results: Verdict[] }).results
}

// ---- email -------------------------------------------------------------------------------

const esc = (s: string | null | undefined) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const FIT_LABEL = { strong: 'Strong match', good: 'Good match', stretch: 'Worth a look' }
const FIT_COLOR = { strong: '#1f7a4d', good: '#2b5fa8', stretch: '#8a6d1f' }

// deno-lint-ignore no-explicit-any
function emailHtml(firstName: string, leads: any[], forCoach: boolean) {
  const items = leads.map((l) => `
    <tr><td style="padding:16px 0;border-bottom:1px solid #e6e2da">
      <div style="font-size:12px;font-weight:600;color:${FIT_COLOR[l.fit as 'good'] ?? '#555'};text-transform:uppercase;letter-spacing:.04em">${esc(FIT_LABEL[l.fit as 'good'] ?? '')}${l.track === 'asap' ? ' · Get working now' : ''}</div>
      <div style="font-size:17px;font-weight:600;margin:4px 0 2px"><a href="${esc(l.url ?? APP_URL)}" style="color:#1d1d1b;text-decoration:none">${esc(l.title)}</a></div>
      <div style="font-size:14px;color:#555">${esc(l.employer)}${l.location ? ` · ${esc(l.location)}` : ''}${l.pay_text ? ` · ${esc(l.pay_text)}` : ''}${l.posted_at ? ` · posted ${esc(new Date(l.posted_at + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}` : ''}</div>
      <div style="font-size:14px;margin-top:8px">${esc(l.why)}</div>
      ${(l.concerns ?? []).length ? `<div style="font-size:13px;color:#8a5a1f;margin-top:4px">Good to know: ${esc(l.concerns.join('; '))}</div>` : ''}
      ${l.url ? `<div style="margin-top:8px"><a href="${esc(l.url)}" style="font-size:14px;color:#2b5fa8">Open the job ›</a></div>` : ''}
    </td></tr>`).join('')
  const adzuna = leads.some((l) => l.source === 'adzuna')
  return `<!doctype html><html><body style="margin:0;background:#f6f4ef;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1d1d1b">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;padding:24px">
    <tr><td>
      <div style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.06em">AiA Job Alerts</div>
      <h1 style="font-size:22px;margin:6px 0 4px">${forCoach ? `${esc(firstName)}'s new jobs` : `Good morning, ${esc(firstName)}`}</h1>
      <p style="font-size:15px;margin:0 0 8px;color:#444">${forCoach ? `Preview: ${esc(firstName)} is not emailed yet.` : ''} ${leads.length === 1 ? 'One new job fits you today.' : `${leads.length} new jobs fit you today, best first.`}</p>
    </td></tr>
    ${items}
    <tr><td style="padding-top:20px">
      <a href="${esc(APP_URL)}" style="display:inline-block;background:#1d1d1b;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:15px">Open your job leads</a>
      <p style="font-size:13px;color:#777;margin-top:16px">Mark each one Interested or Not for me in the app, and we learn what you want. You always apply yourself.</p>
      ${adzuna ? '<p style="font-size:12px;color:#999">Some jobs by <a href="https://www.adzuna.com" style="color:#999">Adzuna</a>.</p>' : ''}
    </td></tr>
  </table></td></tr></table></body></html>`
}

// deno-lint-ignore no-explicit-any
function emailText(firstName: string, leads: any[]) {
  return [`New jobs for ${firstName}:`, '', ...leads.map((l) => `${l.title} at ${l.employer}${l.location ? `, ${l.location}` : ''}\n${l.why}\n${l.url ?? ''}\n`), `Open your leads: ${APP_URL}`].join('\n')
}

async function sendEmail(to: string, replyTo: string | null, subject: string, html: string, text: string) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: EMAIL_FROM, to: [to], ...(replyTo ? { reply_to: replyTo } : {}), subject, html, text }),
  })
  if (!r.ok) throw new Error(`Email not sent: ${(await r.json().catch(() => ({})))?.message ?? r.status}`)
}

// ---- one run -------------------------------------------------------------------------------

/** The same families each day would waste searches: walk through families and titles day by day. */
function rotate<T>(xs: T[], count: number, dayNo: number): T[] {
  if (!xs.length) return []
  const start = (dayNo * count) % xs.length
  return Array.from({ length: Math.min(count, xs.length) }, (_, i) => xs[(start + i) % xs.length])
}

async function serpUsedThisMonth(db: SupabaseClient): Promise<number> {
  const first = new Date()
  first.setUTCDate(1)
  first.setUTCHours(0, 0, 0, 0)
  const { data } = await db.from('runs').select('queries').gte('started_at', first.toISOString())
  // deno-lint-ignore no-explicit-any
  return (data ?? []).reduce((n, r: any) => n + (r.queries ?? []).filter((q: any) => q.source === 'google_jobs').length, 0)
}

interface RunResult { found: number; fresh: number; kept: number; emailed_to: string | null; notes: string[] }

async function runSearch(db: SupabaseClient, personId: string, runId: string, sendMail: boolean): Promise<RunResult> {
  const [{ data: person }, { data: profile }, { data: fams }, { data: apps }, { data: seen }] = await Promise.all([
    db.from('people').select('*').eq('id', personId).single(),
    db.from('profiles').select('*').eq('person_id', personId).single(),
    db.from('job_families').select('*').eq('person_id', personId).eq('active', true).order('position'),
    db.from('applications').select('employer, title').eq('person_id', personId),
    db.from('leads').select('dedupe_key').eq('person_id', personId).limit(10000),
  ])
  if (!person || !profile) throw new Error('No profile for this person.')
  const families = fams ?? []
  if (!families.length) throw new Error('No job families to search yet.')

  const notes: string[] = []
  const dayNo = Math.floor(Date.now() / 864e5)
  const home = place(person.home_base)
  const radiusKm = Math.max(15, (profile.max_commute_minutes ?? 40) * 0.75 * 1.6)
  const remoteFirst = profile.remote === 'remote_first'
  const remoteOk = profile.remote !== 'onsite_only'
  // one search title per family, moving to the next title on later days
  const pick = (f: { search_titles: string[]; name: string }) => {
    const titles = (f.search_titles ?? []).length ? f.search_titles : [f.name]
    return titles[Math.floor(dayNo / Math.max(1, families.length)) % titles.length]
  }
  // bridge (asap) families first: income now matters most
  const ordered = [...families].sort((a, b) => (a.track === 'asap' ? 0 : 1) - (b.track === 'asap' ? 0 : 1) || a.position - b.position)

  // deno-lint-ignore no-explicit-any
  const queries: any[] = []
  const jobs: Promise<Posting[]>[] = []

  if (hasSerp()) {
    const left = num('SERPAPI_MONTHLY_LIMIT', 240) - (await serpUsedThisMonth(db))
    const count = Math.min(num('SERPAPI_PER_RUN', 2), Math.max(0, left))
    if (count <= 0) notes.push('Google Jobs searches are used up for this month.')
    rotate(ordered, count, dayNo).forEach((f, i) => {
      const q = pick(f)
      const remote = remoteFirst ? i % 2 === 0 : remoteOk && !home
      const where = remote ? null : home ? `${home.city}, ${home.state}, United States` : null
      const entry = { source: 'google_jobs', q, where: where ?? (remote ? 'Remote' : 'United States'), found: 0 } as Record<string, unknown>
      queries.push(entry)
      jobs.push(serpSearch(q, where, remote, radiusKm).then((r) => { entry.found = r.length; return r }, (e) => { entry.error = String(e.message ?? e); return [] }))
    })
  }
  if (hasAdzuna()) {
    rotate(ordered, num('ADZUNA_PER_RUN', 6), dayNo).forEach((f, i) => {
      const q = pick(f)
      const where = remoteFirst || !home ? null : home.zip ?? `${home.city}, ${home.stateCode}`
      const entry = { source: 'adzuna', q, where: where ?? 'United States', found: 0 } as Record<string, unknown>
      queries.push(entry)
      jobs.push(adzunaSearch(remoteFirst ? `${q} remote` : q, where, radiusKm, profile.posting_window_days ?? 14)
        .then((r) => { entry.found = r.length; return r }, (e) => { entry.error = String(e.message ?? e); return [] }))
    })
  }
  if (!queries.length) throw new Error('No job sources are connected yet.')

  const all = (await Promise.all(jobs)).flat().filter((p) => p.title && p.employer)
  await db.from('runs').update({ queries }).eq('id', runId)

  // dedupe: across sources, against everything seen before, and against applications
  const known = new Set((seen ?? []).map((s) => s.dedupe_key))
  const applied = new Set((apps ?? []).map((a) => keyOf(a.employer, a.title)))
  const fresh = new Map<string, Posting>()
  for (const p of all) {
    const k = keyOf(p.employer, p.title)
    if (known.has(k) || applied.has(k)) continue
    const had = fresh.get(k)
    // prefer Google Jobs (direct apply links), then the one with pay
    if (!had || (had.source === 'adzuna' && p.source === 'google_jobs') || (!had.pay_text && p.pay_text && had.source === p.source)) fresh.set(k, p)
  }

  // deno-lint-ignore no-explicit-any
  const rows: any[] = []
  const row = (k: string, p: Posting, extra: Record<string, unknown>) => ({
    person_id: personId, run_id: runId, dedupe_key: k, source: p.source, source_id: p.source_id,
    title: p.title.slice(0, 300), employer: p.employer.slice(0, 200), location: p.location, remote: p.remote,
    url: p.url, apply_links: p.apply_links, posted_at: p.posted_at, pay_text: p.pay_text, employment_type: p.employment_type,
    description: p.description.slice(0, 6000),
    family: null, track: null, score: null, fit: null, why: null, concerns: [] as string[], status: 'filtered', filter_reason: null,
    ...extra,
  })

  const toJudge: [string, Posting][] = []
  for (const [k, p] of fresh) {
    const reason = ruleOut(p, profile)
    if (reason) rows.push(row(k, p, { filter_reason: reason }))
    else toJudge.push([k, p])
  }
  // newest first; the rest wait for a later day (they are not stored, so they come back)
  toJudge.sort((a, b) => (b[1].posted_at ?? '').localeCompare(a[1].posted_at ?? ''))
  const batch = toJudge.slice(0, MAX_TO_JUDGE)

  if (batch.length) {
    const verdicts = await judge(person, profile, families, batch.map(([, p]) => p))
    const byN = new Map(verdicts.map((v) => [v.n, v]))
    const famTrack = new Map(families.map((f) => [f.name, f.track]))
    batch.forEach(([k, p], i) => {
      const v = byN.get(i + 1)
      if (!v) return // not judged: leave it for another day
      const keep = v.keep && v.score >= 55
      rows.push(row(k, p, keep
        ? { family: v.family, track: famTrack.get(v.family) ?? null, score: v.score, fit: v.fit, why: v.why, concerns: (v.concerns ?? []).slice(0, 2), status: 'new' }
        : { score: v.score, filter_reason: v.reject_reason || 'Not a close enough fit' }))
    })
  }

  if (rows.length) {
    const { error } = await db.from('leads').upsert(rows, { onConflict: 'person_id,dedupe_key', ignoreDuplicates: true })
    if (error) throw new Error(error.message)
  }
  const kept = rows.filter((r) => r.status === 'new').sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

  // email: to the coach while the old daily emails still go out, to the person once switched over
  let emailedTo: string | null = null
  if (sendMail && kept.length && person.email_leads !== 'off') {
    if (!env('RESEND_API_KEY')) notes.push('Email is not connected yet (RESEND_API_KEY).')
    else {
      const toCoach = person.email_leads === 'coach' && person.coach_email
      const to = toCoach ? person.coach_email : person.email
      const first = person.name.split(' ')[0]
      const top = kept.slice(0, 10)
      const subject = `${toCoach ? `[${first}] ` : ''}${kept.length === 1 ? '1 new job' : `${kept.length} new jobs`}: ${top[0].title} at ${top[0].employer}${kept.length > 1 ? ' and more' : ''}`
      await sendEmail(to, toCoach ? null : person.coach_email, subject, emailHtml(first, top, Boolean(toCoach)), emailText(first, top))
      emailedTo = to
      await db.from('leads').update({ emailed_at: new Date().toISOString() }).eq('run_id', runId).eq('status', 'new')
    }
  }
  if (toJudge.length > MAX_TO_JUDGE) notes.push(`${toJudge.length - MAX_TO_JUDGE} more postings wait for the next run.`)
  return { found: all.length, fresh: fresh.size, kept: kept.length, emailed_to: emailedTo, notes }
}

async function finish(db: SupabaseClient, runId: string, work: Promise<RunResult>) {
  try {
    const r = await work
    await db.from('runs').update({
      status: 'done', finished_at: new Date().toISOString(), found: r.found, fresh: r.fresh, kept: r.kept,
      emailed_to: r.emailed_to, error: r.notes.length ? r.notes.join(' ') : null,
    }).eq('id', runId)
    return r
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await db.from('runs').update({ status: 'failed', finished_at: new Date().toISOString(), error: message }).eq('id', runId)
    throw new HttpError(500, message)
  }
}

// ---- handler ---------------------------------------------------------------------------------

async function handle(req: Request): Promise<Response> {
  const db = admin()
  const body = (await req.json().catch(() => ({}))) as { person_id?: string; email?: boolean }

  // "Run now" from the admin page
  if (body.person_id) {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: auth } = token ? await db.auth.getUser(token) : { data: { user: null } }
    const email = (auth?.user?.email ?? '').toLowerCase()
    const { data: isAdmin } = email ? await db.from('admins').select('email').ilike('email', email).maybeSingle() : { data: null }
    if (!isAdmin) throw new HttpError(403, 'Only an admin can run a search now.')
    if (!hasSerp() && !hasAdzuna()) throw new HttpError(400, 'No job sources are connected yet. Add SERPAPI_KEY, or ADZUNA_APP_ID and ADZUNA_APP_KEY, in Supabase > Edge Functions > Secrets.')
    const { data: run, error } = await db.from('runs').insert({ person_id: body.person_id, trigger: 'manual' }).select('id').single()
    if (error || !run) throw new HttpError(500, error?.message ?? 'Could not start the run.')
    const r = await finish(db, run.id, runSearch(db, body.person_id, run.id, Boolean(body.email)))
    return json({ ...r, summary: `${r.kept === 1 ? '1 new job' : `${r.kept} new jobs`} kept from ${r.found} found (${r.fresh} not seen before).${r.notes.length ? ` ${r.notes.join(' ')}` : ''}` })
  }

  // the 10-minute tick: run the next person who is due, if any
  if (!hasSerp() && !hasAdzuna()) return json({ skipped: 'No job sources connected.' })
  const { data: due, error: dueError } = await db.rpc('next_due_person')
  if (dueError) throw new HttpError(500, dueError.message)
  if (!due) return json({ skipped: 'Nobody is due.' })
  // claiming the day's run: a second tick for the same person hits the unique index and stops
  const { data: run, error } = await db.from('runs').insert({ person_id: due, trigger: 'schedule' }).select('id').single()
  if (error || !run) return json({ skipped: 'Already running.' })
  const work = finish(db, run.id, runSearch(db, due as string, run.id, true)).catch(() => null)
  if (typeof EdgeRuntime !== 'undefined') {
    EdgeRuntime.waitUntil(work)
    return json({ started: due }, 202)
  }
  await work
  return json({ done: due })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    return await handle(req)
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    return json({ error: e instanceof Error ? e.message : String(e) }, status)
  }
})
