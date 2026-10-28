// process-document: the Charly Resume Method, run by Claude.
// Body: { document_id } to read an uploaded resume or document, or { person_id, review: true } to check the profile
// itself without a document. The caller must be an admin, or the person concerned.
// Writes `suggestions` (new facts, changed facts, headline, job families) and, for anything the document and the
// profile disagree on, a TO CONFIRM question for the person. Nothing touches the profile itself: suggestions are
// accepted one by one in the app (decide_suggestion).
// Secrets (Supabase > Edge Functions > Secrets): ANTHROPIC_API_KEY. SUPABASE_URL and the service key are provided.
import Anthropic from 'npm:@anthropic-ai/sdk@0.135.0'
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0'
import JSZip from 'npm:jszip@3.10.1'

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

// ---- what Claude returns ---------------------------------------------------------

interface Metric { placeholder: string; question: string }
interface Findings {
  kind: 'resume' | 'linkedin' | 'certificate' | 'other' | 'profile'
  belongs_to_person: boolean
  summary: string
  headline: string | null
  new_facts: { text: string; reason: string; metrics: Metric[] }[]
  changed_facts: { number: number; proposed: string; reason: string; metrics: Metric[] }[]
  rewrites: { number: number; proposed: string; reason: string; metrics: Metric[] }[]
  families: { name: string; why: string; track: 'asap' | 'long_term'; search_titles: string[] }[]
  conflicts: { topic: string; question_for_person: string }[]
  flags: { kind: 'remove' | 'translate' | 'spelling' | 'format'; found: string; fix: string }[]
}

const METRIC = {
  type: 'object', additionalProperties: false, required: ['placeholder', 'question'],
  properties: { placeholder: { type: 'string' }, question: { type: 'string' } },
}
const FACT_EDIT = {
  type: 'object', additionalProperties: false, required: ['number', 'proposed', 'reason', 'metrics'],
  properties: { number: { type: 'integer' }, proposed: { type: 'string' }, reason: { type: 'string' }, metrics: { type: 'array', items: METRIC } },
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'belongs_to_person', 'summary', 'headline', 'new_facts', 'changed_facts', 'rewrites', 'families', 'conflicts', 'flags'],
  properties: {
    kind: { type: 'string', enum: ['resume', 'linkedin', 'certificate', 'other', 'profile'] },
    belongs_to_person: { type: 'boolean' },
    summary: { type: 'string' },
    headline: { type: ['string', 'null'] },
    new_facts: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['text', 'reason', 'metrics'],
        properties: { text: { type: 'string' }, reason: { type: 'string' }, metrics: { type: 'array', items: METRIC } } },
    },
    changed_facts: { type: 'array', items: FACT_EDIT },
    rewrites: { type: 'array', items: FACT_EDIT },
    families: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['name', 'why', 'track', 'search_titles'],
        properties: { name: { type: 'string' }, why: { type: 'string' }, track: { type: 'string', enum: ['asap', 'long_term'] },
          search_titles: { type: 'array', items: { type: 'string' } } } },
    },
    conflicts: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['topic', 'question_for_person'],
        properties: { topic: { type: 'string' }, question_for_person: { type: 'string' } } },
    },
    flags: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['kind', 'found', 'fix'],
        properties: { kind: { type: 'string', enum: ['remove', 'translate', 'spelling', 'format'] }, found: { type: 'string' }, fix: { type: 'string' } } },
    },
  },
} as const

const SYSTEM = `You are a resume coach working the Charly Resume Method: helping people from South Africa (and \
elsewhere) turn their CVs into strong, honest US resumes. Each person has a profile whose facts are the ONLY facts \
allowed on the resumes and cover letters written for them, so accuracy matters more than anything else.

You get the person's current profile and either a document they uploaded (usually a resume) or, with no document, \
the profile alone to check. Report:

- kind: what the document is ("profile" when there is no document).
- belongs_to_person: false if the document is clearly about someone else (a different name). True when there is no document.
- summary: one plain sentence for the person, e.g. "Your 2025 resume: 2 new things, 3 accomplishment rewrites and 4 things to fix."
- headline: a 2 to 3 sentence professional summary (years of experience, core domain, top value), only from facts \
given, if the profile has none or the document's is clearly better. Otherwise null.
- new_facts: experience, roles, certifications, education, skills or achievements in the document that no current \
fact covers. One self-contained paragraph per role or topic: employer or topic first, then title, dates and place, \
then accomplishments.
- changed_facts: a current fact (by number) that the document shows is out of date or incomplete. "proposed" is the \
full replacement paragraph.
- rewrites: current facts (by number) written as duties ("Responsible for…", "Assisted with…", lists of tasks) that \
would read stronger as accomplishments. Duties tell, accomplishments sell: Action verb + what they did (scope, \
scale, tools) + the result. Use only what the fact or document says. Where a number would make it stronger \
(people served, team size, volume, budget, acres, percent improved), write a gap as [[phrase with __]], e.g. \
"[[serving about __ guests a year]]", where __ is where their number goes and the phrase still reads well if it is \
removed. At most 3 gaps per fact, and add one metric per gap: the exact placeholder text including the brackets, and \
a short friendly question to the person ("About how many guests did KaalvoetKoppies host in a year?"). Skip facts \
that already read as accomplishments. Never rewrite more than 5 facts at once.
- families: kinds of jobs worth searching that the profile's job families don't cover yet, 4 to 8 job titles each, \
with track "asap" for bridge jobs they could start soon for income and US references (retail, warehouse, front \
desk, customer service, hospitality) or "long_term" for their real career path. Only with clear evidence; usually \
an empty list.
- conflicts: where the document and the profile disagree and you cannot tell which is right, where the document \
claims something on the never-claim list, or where a South African qualification is presented as a US degree without \
an evaluation (WES, SpanTran, ECE). Ask a short, friendly question in plain English, addressed to the person as \
"you". Never resolve a conflict yourself.
- flags: what the Method says to fix in the DOCUMENT itself (empty when there is no document):
  - remove: photo or headshot, ID or passport numbers, driver's licence codes (e.g. "Code 08"), date of birth or age, \
gender, marital status, dependents, religion, race or EE status, health, full street address (keep City, State), \
"Curriculum Vitae" as a heading, "Reason for leaving" lines, a references section or "References available on request".
  - translate: South African terms a US recruiter or ATS won't know: Matric or Grade 12 or NSC -> High School \
Diploma; tertiary -> higher education; NQF levels -> the evaluated US equivalent; articles -> audit associate / \
trainee accountant (or candidate attorney for law); bakkie or LDV -> pickup truck; retrenched -> leave it off; \
medical aid -> health insurance; provident fund -> retirement plan / 401(k); turnover -> revenue; debtors -> \
accounts receivable; creditors -> accounts payable; stock take -> inventory audit; shrinkage -> inventory loss; \
hectares -> acres; rand amounts -> approximate US dollars with the year.
  - spelling: UK spelling to US (organise -> organize, colour -> color, programme -> program, centre -> center), with \
the words found.
  - format: graphics, columns, tables, skill bars or text boxes that break applicant tracking systems; more than 2 \
pages for a tailored version (a long Master Resume is fine); duties-only bullets.
  Keep each flag short: "found" is what is in the document, "fix" is what to do.

Rules:
- Use only what is written in the document or the profile. Never invent or infer employers, dates, numbers, titles, \
certifications, degrees, company sizes or achievements. A number you don't have becomes a [[gap]], never a guess.
- Write proposed facts in US English with US terms (see translate above). Convert rand only when the document gives \
an amount, as "about $X (R Y, year)".
- Keep real job titles exactly. You may add the US meaning in brackets, e.g. "Managing Director (Owner/Operator)".
- Never call a South African qualification a US degree unless the profile says it was evaluated.
- Do not suggest a fact that only repeats what a current fact already says.
- Nothing from the never-claim list may appear in new_facts, changed_facts, rewrites or headline.
- Keep reasons short and plain, written to the person ("Your resume adds…", "Numbers make this stand out…").
- If the document is not about the person, return empty lists and explain in summary.`

// ---- reading the file ------------------------------------------------------------

function base64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

async function docxText(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes)
  const xml = await zip.file('word/document.xml')?.async('string')
  if (!xml) throw new HttpError(422, 'That Word file could not be read.')
  return xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---- handler -------------------------------------------------------------------------

async function handle(req: Request): Promise<unknown> {
  const db = admin()
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) throw new HttpError(401, 'Sign in first.')
  const { data: auth, error: authError } = await db.auth.getUser(token)
  if (authError || !auth.user) throw new HttpError(401, 'Your sign-in has expired. Sign in again.')
  const email = (auth.user.email ?? '').toLowerCase()

  const body = (await req.json().catch(() => ({}))) as { document_id?: string; person_id?: string; review?: boolean }
  // deno-lint-ignore no-explicit-any
  let doc: any = null
  let personId = body.person_id ?? null
  if (body.document_id) {
    const { data } = await db.from('documents').select('*').eq('id', body.document_id).maybeSingle()
    if (!data) throw new HttpError(404, 'Document not found.')
    doc = data
    personId = doc.person_id
  } else if (!body.review || !personId) {
    throw new HttpError(400, 'No document given.')
  }

  const { data: person } = await db.from('people').select('id, name, email').eq('id', personId).single()
  if (!person) throw new HttpError(404, 'Person not found.')
  const { data: isAdmin } = await db.from('admins').select('email').ilike('email', email).maybeSingle()
  if (!isAdmin && person.email.toLowerCase() !== email) throw new HttpError(403, 'Not your profile.')

  if (doc) await db.from('documents').update({ status: 'reading', error: null }).eq('id', doc.id)

  try {
    const [{ data: profile }, { data: families }, { data: pending }] = await Promise.all([
      db.from('profiles').select('headline, facts, never_claim, education_note').eq('person_id', personId).single(),
      db.from('job_families').select('name, track, search_titles').eq('person_id', personId).order('position'),
      db.from('suggestions').select('kind, fact_index').eq('person_id', personId).eq('status', 'pending'),
    ])

    const facts: string[] = profile?.facts ?? []
    // facts already waiting for a decision are not suggested again
    const busy = new Set((pending ?? []).filter((p) => p.fact_index).map((p) => p.fact_index as number))
    const profileText = [
      `Name: ${person.name}`,
      `Headline: ${profile?.headline ?? '(none)'}`,
      `Education note: ${profile?.education_note ?? '(none)'}`,
      'Current facts:',
      ...(facts.length ? facts.map((f, i) => `${i + 1}. ${f}${busy.has(i + 1) ? ' (an update for this fact is already waiting; skip it)' : ''}`) : ['(none yet)']),
      'Never claim:',
      ...((profile?.never_claim ?? []).length ? profile!.never_claim.map((n: string) => `- ${n}`) : ['(nothing listed)']),
      'Job families searched now:',
      ...((families ?? []).length ? families!.map((f) => `- ${f.name} (${f.track === 'asap' ? 'bridge job' : 'career path'}): ${(f.search_titles ?? []).slice(0, 4).join(', ')}`) : ['(none yet)']),
    ].join('\n')

    // deno-lint-ignore no-explicit-any
    const content: any[] = []
    if (doc) {
      const file = await db.storage.from('documents').download(doc.path)
      if (file.error || !file.data) throw new HttpError(500, 'The file could not be opened.')
      const bytes = new Uint8Array(await file.data.arrayBuffer())
      content.push(
        doc.mime === 'application/pdf'
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64(bytes) }, title: doc.filename }
          : { type: 'text', text: `<document name="${doc.filename}">\n${doc.mime === 'text/plain' ? new TextDecoder().decode(bytes) : await docxText(bytes)}\n</document>` },
      )
      content.push({ type: 'text', text: `The person's current profile:\n\n${profileText}` })
    } else {
      content.push({ type: 'text', text: `There is no document. Check this profile with the Method (rewrites, headline, families, conflicts; flags stay empty):\n\n${profileText}` })
    }

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
      messages: [{ role: 'user', content }],
    }
    const response = await client.beta.messages.create(params)

    if (response.stop_reason === 'refusal') throw new HttpError(422, 'This could not be checked automatically.')
    if (response.stop_reason === 'max_tokens') throw new HttpError(500, 'There was too much to finish reading.')
    // deno-lint-ignore no-explicit-any
    const text = response.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
    const found = JSON.parse(text) as Findings

    // a gap counts only if its placeholder really is in the proposed text
    const keep = (proposed: string, metrics: Metric[]) =>
      (metrics ?? []).filter((m) => m.placeholder.startsWith('[[') && m.placeholder.endsWith(']]') && proposed.includes(m.placeholder))

    const rows: Record<string, unknown>[] = []
    const base = { document_id: doc?.id ?? null, person_id: personId }
    const fit = (n: number) => n >= 1 && n <= facts.length && !busy.has(n)
    if (found.belongs_to_person) {
      if (found.headline && found.headline.trim() !== (profile?.headline ?? '').trim()) {
        rows.push({ ...base, kind: 'headline', current_text: profile?.headline ?? null, proposed_text: found.headline.trim(),
          reason: profile?.headline ? 'A stronger summary for the top of your resume.' : 'Your profile has no summary yet.' })
      }
      for (const f of found.new_facts) {
        rows.push({ ...base, kind: 'fact_new', proposed_text: f.text.trim(), reason: f.reason, metrics: keep(f.text, f.metrics) })
      }
      const seen = new Set<number>()
      for (const c of found.changed_facts) {
        if (!fit(c.number) || seen.has(c.number)) continue
        seen.add(c.number)
        rows.push({ ...base, kind: 'fact_change', fact_index: c.number, current_text: facts[c.number - 1],
          proposed_text: c.proposed.trim(), reason: c.reason, metrics: keep(c.proposed, c.metrics) })
      }
      for (const r of found.rewrites) {
        if (!fit(r.number) || seen.has(r.number)) continue
        seen.add(r.number)
        rows.push({ ...base, kind: 'fact_rewrite', fact_index: r.number, current_text: facts[r.number - 1],
          proposed_text: r.proposed.trim(), reason: r.reason, metrics: keep(r.proposed, r.metrics) })
      }
      for (const fam of found.families) rows.push({ ...base, kind: 'family', family: fam, reason: fam.why })
    }
    if (rows.length) {
      const { error } = await db.from('suggestions').insert(rows)
      if (error) throw new HttpError(500, error.message)
    }
    if (found.belongs_to_person && found.conflicts.length) {
      await db.from('to_confirm').insert(found.conflicts.map((c) => ({
        person_id: personId, topic: c.topic.slice(0, 80),
        question: `${doc ? `From ${doc.filename}` : 'From the Method check'}: ${c.question_for_person}`,
        person_question: c.question_for_person, ask_person: true,
      })))
    }

    const summary = found.belongs_to_person ? found.summary : `This looks like someone else's document. ${found.summary}`
    if (doc) {
      await db.from('documents').update({
        status: 'ready', kind: found.kind, summary, flags: found.belongs_to_person ? found.flags : [],
        processed_at: new Date().toISOString(),
      }).eq('id', doc.id)
    }
    return { status: 'ready', summary, suggestions: rows.length, questions: found.belongs_to_person ? found.conflicts.length : 0, flags: found.flags.length }
  } catch (e) {
    const message = e instanceof HttpError ? e.message : 'Reading failed. Try again in a minute.'
    if (doc) await db.from('documents').update({ status: 'failed', error: message }).eq('id', doc.id)
    throw e
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    return json(await handle(req))
  } catch (e) {
    console.error(e)
    const status = e instanceof HttpError ? e.status : 500
    return json({ error: e instanceof HttpError ? e.message : 'Something went wrong reading the document.' }, status)
  }
})
