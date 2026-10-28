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
