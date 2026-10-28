// process-document: Claude reads an uploaded resume or document and suggests profile updates.
// Body: { document_id }. The caller must be an admin, or the person the document belongs to.
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

interface Findings {
  kind: 'resume' | 'linkedin' | 'certificate' | 'other'
  belongs_to_person: boolean
  summary: string
  headline: string | null
  new_facts: { text: string; reason: string }[]
  changed_facts: { number: number; proposed: string; reason: string }[]
  families: { name: string; why: string; search_titles: string[] }[]
  conflicts: { topic: string; question_for_person: string }[]
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'belongs_to_person', 'summary', 'headline', 'new_facts', 'changed_facts', 'families', 'conflicts'],
  properties: {
    kind: { type: 'string', enum: ['resume', 'linkedin', 'certificate', 'other'] },
    belongs_to_person: { type: 'boolean' },
    summary: { type: 'string' },
    headline: { type: ['string', 'null'] },
    new_facts: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['text', 'reason'],
        properties: { text: { type: 'string' }, reason: { type: 'string' } } },
    },
    changed_facts: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['number', 'proposed', 'reason'],
        properties: { number: { type: 'integer' }, proposed: { type: 'string' }, reason: { type: 'string' } } },
    },
    families: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['name', 'why', 'search_titles'],
        properties: { name: { type: 'string' }, why: { type: 'string' }, search_titles: { type: 'array', items: { type: 'string' } } } },
    },
    conflicts: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['topic', 'question_for_person'],
        properties: { topic: { type: 'string' }, question_for_person: { type: 'string' } } },
    },
  },
} as const

const SYSTEM = `You help job seekers keep their job-search profile up to date. The profile's facts are the ONLY facts \
allowed on the resumes and cover letters written for them, so accuracy matters more than anything else.

You get the person's current profile and a document they uploaded (usually a resume). Compare them and report:

- kind: what the document is.
- belongs_to_person: false if the document is clearly about someone else (a different name).
- summary: one plain sentence for the person, e.g. "Your 2025 resume: 2 new things and 1 update."
- headline: a one or two sentence professional headline copied or closely condensed from the document, only if the \
profile has none or the document's is clearly newer. Otherwise null.
- new_facts: experience, roles, certifications, education, skills or achievements in the document that no current \
fact covers. Write each like the existing facts: one self-contained paragraph per role or topic, starting with the \
employer or topic, then title, dates and place, then what they did, in the document's own words. Never merge two \
roles into one fact.
- changed_facts: a current fact (by its number) that the document shows is out of date or incomplete. "proposed" is \
the full replacement paragraph: keep everything still true from the current fact and add or correct only what the \
document supports.
- families: kinds of jobs worth searching that the profile's job families don't cover yet, with 4 to 8 job titles \
each. Only when the document gives clear evidence. Usually an empty list.
- conflicts: where the document and the profile disagree and you cannot tell which is right (different titles, \
dates, numbers), or where the document claims something on the profile's never-claim list. Ask the person a short, \
friendly question in plain English, addressed to them as "you". Never resolve a conflict yourself.

Rules:
- Use only what is written in the document or the profile. Never invent or infer employers, dates, numbers, \
titles, certifications, degrees or achievements. Leave out anything you are unsure of.
- Do not suggest a fact that only repeats what a current fact already says.
- Nothing from the never-claim list may appear in new_facts, changed_facts or headline.
- Keep reasons short and plain, written to the person ("Your resume adds…").
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

  const body = (await req.json().catch(() => ({}))) as { document_id?: string }
  if (!body.document_id) throw new HttpError(400, 'No document given.')

  const { data: doc } = await db.from('documents').select('*').eq('id', body.document_id).maybeSingle()
  if (!doc) throw new HttpError(404, 'Document not found.')
  const { data: person } = await db.from('people').select('id, name, email').eq('id', doc.person_id).single()
  const { data: isAdmin } = await db.from('admins').select('email').ilike('email', email).maybeSingle()
  if (!isAdmin && person.email.toLowerCase() !== email) throw new HttpError(403, 'Not your document.')

  await db.from('documents').update({ status: 'reading', error: null }).eq('id', doc.id)

  try {
    const file = await db.storage.from('documents').download(doc.path)
    if (file.error || !file.data) throw new HttpError(500, 'The file could not be opened.')
    const bytes = new Uint8Array(await file.data.arrayBuffer())

    const [{ data: profile }, { data: families }] = await Promise.all([
      db.from('profiles').select('headline, facts, never_claim').eq('person_id', doc.person_id).single(),
      db.from('job_families').select('name, search_titles').eq('person_id', doc.person_id).order('position'),
    ])

    const facts: string[] = profile?.facts ?? []
    const profileText = [
      `Name: ${person.name}`,
      `Headline: ${profile?.headline ?? '(none)'}`,
      'Current facts:',
      ...(facts.length ? facts.map((f, i) => `${i + 1}. ${f}`) : ['(none yet)']),
      'Never claim:',
      ...((profile?.never_claim ?? []).length ? profile!.never_claim.map((n: string) => `- ${n}`) : ['(nothing listed)']),
      'Job families searched now:',
      ...((families ?? []).length ? families!.map((f) => `- ${f.name}: ${(f.search_titles ?? []).slice(0, 4).join(', ')}`) : ['(none yet)']),
    ].join('\n')

    const docBlock: Record<string, unknown> =
      doc.mime === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64(bytes) }, title: doc.filename }
        : {
            type: 'text',
            text: `<document name="${doc.filename}">\n${
              doc.mime === 'text/plain' ? new TextDecoder().decode(bytes) : await docxText(bytes)
            }\n</document>`,
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
      messages: [{
        role: 'user',
        content: [docBlock, { type: 'text', text: `The person's current profile:\n\n${profileText}` }],
      }],
    }
    const response = await client.beta.messages.create(params)

    if (response.stop_reason === 'refusal') throw new HttpError(422, 'This document could not be read automatically.')
    if (response.stop_reason === 'max_tokens') throw new HttpError(500, 'The document was too long to finish reading.')
    const text = response.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
    const found = JSON.parse(text) as Findings

    const rows: Record<string, unknown>[] = []
    const base = { document_id: doc.id, person_id: doc.person_id }
    if (found.belongs_to_person) {
      if (found.headline && found.headline.trim() !== (profile?.headline ?? '').trim()) {
        rows.push({ ...base, kind: 'headline', current_text: profile?.headline ?? null, proposed_text: found.headline.trim(),
          reason: profile?.headline ? 'A newer headline from this document.' : 'Your profile has no headline yet.' })
      }
      for (const f of found.new_facts) rows.push({ ...base, kind: 'fact_new', proposed_text: f.text.trim(), reason: f.reason })
      for (const c of found.changed_facts) {
        if (c.number < 1 || c.number > facts.length) continue
        rows.push({ ...base, kind: 'fact_change', fact_index: c.number, current_text: facts[c.number - 1], proposed_text: c.proposed.trim(), reason: c.reason })
      }
      for (const fam of found.families) rows.push({ ...base, kind: 'family', family: fam, reason: fam.why })
    }
    if (rows.length) {
      const { error } = await db.from('suggestions').insert(rows)
      if (error) throw new HttpError(500, error.message)
    }
    if (found.belongs_to_person && found.conflicts.length) {
      await db.from('to_confirm').insert(found.conflicts.map((c) => ({
        person_id: doc.person_id, topic: c.topic.slice(0, 80), question: `From ${doc.filename}: ${c.question_for_person}`,
        person_question: c.question_for_person, ask_person: true,
      })))
    }

    const summary = found.belongs_to_person ? found.summary : `This looks like someone else's document. ${found.summary}`
    await db.from('documents').update({ status: 'ready', kind: found.kind, summary, processed_at: new Date().toISOString() }).eq('id', doc.id)
    return { status: 'ready', summary, suggestions: rows.length, questions: found.belongs_to_person ? found.conflicts.length : 0 }
  } catch (e) {
    const message = e instanceof HttpError ? e.message : 'Reading the document failed. Try again in a minute.'
    await db.from('documents').update({ status: 'failed', error: message }).eq('id', doc.id)
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
