import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'

/** What a job seeker sees of themselves (from person_view / my_view; never the coach's notes). */
export interface SeekerView {
  person: { id: string; name: string; first_name: string; home_base: string | null }
  coach: { name: string } | null
  profile: {
    remote: string
    max_commute_minutes: number | null
    in_range_places: string[]
    employment_types: string[]
    pay_floor_annual: number | null
    pay_floor_hourly: number | null
    headline: string | null
    facts: string[]
    families: { name: string; titles: string[] }[]
  }
  questions: {
    id: string
    topic: string
    question: string
    kind: 'text' | 'yesno' | 'number' | 'choice'
    choices: string[]
    answer: string | null
    answered_at: string | null
    done: boolean
  }[]
  applications: { id: string; employer: string; title: string; status: string; added_by: string }[]
  requests: { id: string; section: string; message: string; created_at: string; done: boolean }[]
  /** No coach: the person accepts their own suggestions. */
  can_decide: boolean
  documents: Doc[]
  suggestions: Suggestion[]
}

export interface Doc {
  id: string
  path: string
  filename: string
  status: 'uploaded' | 'reading' | 'ready' | 'failed'
  kind: string | null
  summary: string | null
  error: string | null
  created_at: string
}

export interface Suggestion {
  id: string
  document_id: string
  kind: 'fact_new' | 'fact_change' | 'headline' | 'family'
  current_text: string | null
  proposed_text: string | null
  family: { name: string; why: string; search_titles: string[] } | null
  reason: string | null
}

export type Question = SeekerView['questions'][number]

/** A question still waiting for them: not answered yet and not closed by the coach. */
export const isOpen = (q: Question) => !q.done && !q.answered_at

/** Loads the signed-in seeker's view, or (for an admin preview) a given person's. */
export function useSeekerView(personId?: string) {
  const [view, setView] = useState<SeekerView | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    const call = personId ? supabase.rpc('person_view', { p_id: personId }) : supabase.rpc('my_view')
    call.then(({ data, error: e }) => {
      if (e) setError(e.message)
      else if (!data) setError('Your profile is not set up yet.')
      else setView(data as SeekerView)
    })
  }, [personId])

  useEffect(reload, [reload])
  return { view, error, reload }
}

export async function answerQuestion(id: string, answer: string): Promise<string | null> {
  const { error } = await supabase.rpc('answer_question', { q_id: id, answer_text: answer })
  return error?.message ?? null
}

export async function sendRequest(section: string, message: string): Promise<string | null> {
  const { error } = await supabase.rpc('send_request', { p_section: section, p_message: message })
  return error?.message ?? null
}

export async function addMyApplication(employer: string, title: string): Promise<string | null> {
  const { error } = await supabase.rpc('add_my_application', { p_employer: employer, p_title: title })
  return error?.message ?? null
}

/** "Charly" with a coach; "us" for someone who signed up on their own. */
export const coachName = (v: SeekerView) => v.coach?.name ?? 'us'

// ---- documents ----------------------------------------------------------------------

export const ACCEPTED_FILES = '.pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain'
const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
}

/**
 * Upload a file into the person's folder, record it, and have Claude read it.
 * Resolves when reading is done (usually under a minute) with a one-line summary.
 */
export async function uploadDocument(personId: string, file: File): Promise<{ error?: string; summary?: string }> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const mime = MIME[ext]
  if (!mime) return { error: 'Upload a PDF, a Word file (.docx) or a text file.' }
  if (file.size > 10 * 1024 * 1024) return { error: 'That file is bigger than 10 MB.' }
  const safe = file.name.replace(/[^\w.\- ]+/g, '').replace(/\s+/g, ' ').trim().slice(-80) || `document.${ext}`
  const path = `${personId}/${crypto.randomUUID()}-${safe}`
  const up = await supabase.storage.from('documents').upload(path, file, { contentType: mime, upsert: false })
  if (up.error) return { error: up.error.message }
  const reg = await supabase.rpc('register_document', { p_person: personId, p_path: path, p_filename: file.name, p_mime: mime, p_size: file.size })
  if (reg.error) return { error: reg.error.message }
  const run = await supabase.functions.invoke('process-document', { body: { document_id: reg.data } })
  if (run.error) {
    let message = run.error.message
    try { message = (await (run.error as unknown as { context?: Response }).context?.json())?.error ?? message } catch { /* keep the generic message */ }
    return { error: message }
  }
  return { summary: (run.data as { summary?: string } | null)?.summary }
}

export async function retryDocument(documentId: string): Promise<string | null> {
  const run = await supabase.functions.invoke('process-document', { body: { document_id: documentId } })
  return run.error ? run.error.message : null
}

export async function openDocument(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from('documents').createSignedUrl(path, 300)
  if (error || !data) return null
  return data.signedUrl
}

export async function decideSuggestion(id: string, accept: boolean): Promise<string | null> {
  const { error } = await supabase.rpc('decide_suggestion', { s_id: id, accept })
  return error?.message ?? null
}
