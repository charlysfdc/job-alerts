import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Person } from '../lib/types'

interface Run {
  id: string
  trigger: 'schedule' | 'manual'
  status: 'running' | 'done' | 'failed'
  started_at: string
  found: number
  fresh: number
  kept: number
  emailed_to: string | null
  error: string | null
  queries: { source: string; q: string; where: string; found: number; error?: string }[]
}

const EMAIL_TO: Record<Person['email_leads'], string> = {
  coach: 'To me (a preview, while the old emails still go out)',
  person: 'To them',
  off: 'Off',
}

const SOURCE: Record<string, string> = { google_jobs: 'Google Jobs', adzuna: 'Adzuna' }

const stamp = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** Admin: the daily search for one person. Run it now, choose who gets the email, see what recent runs did. */
export function SearchRuns({ person, onSavePerson }: {
  person: Person
  onSavePerson: (patch: Record<string, unknown>) => Promise<string | null>
}) {
  const [runs, setRuns] = useState<Run[] | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [r, l] = await Promise.all([
      supabase.from('runs').select('*').eq('person_id', person.id).order('started_at', { ascending: false }).limit(6),
      supabase.from('leads').select('status').eq('person_id', person.id),
    ])
    if (r.error || l.error) return setError((r.error ?? l.error)!.message)
    setRuns(r.data as Run[])
    const c: Record<string, number> = {}
    for (const x of (l.data as { status: string }[]) ?? []) c[x.status] = (c[x.status] ?? 0) + 1
    setCounts(c)
  }, [person.id])
  useEffect(() => { load() }, [load])

  const runNow = async (email: boolean) => {
    setBusy(true)
    setError(null)
    setNote(null)
    const r = await supabase.functions.invoke('daily-search', { body: { person_id: person.id, email } })
    setBusy(false)
    if (r.error) {
      let message = r.error.message
      try { message = (await (r.error as unknown as { context?: Response }).context?.json())?.error ?? message } catch { /* keep the generic message */ }
      setError(message)
    } else setNote((r.data as { summary?: string } | null)?.summary ?? 'Done.')
    load()
  }

  const setEmail = async (v: string) => {
    const e = await onSavePerson({ email_leads: v })
    if (e) setError(e)
  }

  return (
    <div>
      <p className="small">
        {(counts.new ?? 0) + (counts.interested ?? 0)} in their leads now · {counts.interested ?? 0} interested · {counts.applied ?? 0} applied · {counts.not_for_me ?? 0} not for them · {counts.filtered ?? 0} dropped by the rules or Claude
      </p>
      <label className="field">
        <span className="field-label">Daily email</span>
        <select value={person.email_leads ?? 'coach'} onChange={(e) => setEmail(e.target.value)}>
          {Object.entries(EMAIL_TO).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </label>
      <span className="tc-buttons">
        <button className="secondary" disabled={busy} onClick={() => runNow(false)}>{busy ? 'Searching…' : 'Run now'}</button>
        <button className="link" disabled={busy} onClick={() => runNow(true)}>Run now and email</button>
      </span>
      {busy && <p className="muted small reading"><span className="spinner" aria-hidden /> Searching and judging new postings… about a minute.</p>}
      {note && <p className="muted small">{note}</p>}
      {error && <p className="error small">{error}</p>}
      {runs && runs.length > 0 && (
        <ul className="runs">
          {runs.map((r) => (
            <li key={r.id}>
              <span><strong>{stamp(r.started_at)}</strong> · {r.trigger === 'manual' ? 'Run now' : 'Daily'} · {r.status === 'running' ? 'running…' : r.status === 'failed' ? <span className="error">failed</span> : `${r.kept} kept of ${r.fresh} new (${r.found} found)`}{r.emailed_to ? ` · emailed ${r.emailed_to}` : ''}</span>
              {r.queries.length > 0 && (
                <span className="muted small">{r.queries.map((q) => `${SOURCE[q.source] ?? q.source}: ${q.q} (${q.error ? 'error' : q.found})`).join(' · ')}</span>
              )}
              {r.error && <span className={r.status === 'failed' ? 'error small' : 'muted small'}>{r.error}</span>}
            </li>
          ))}
        </ul>
      )}
      {runs && runs.length === 0 && <p className="muted small">No searches yet. They start once a job source is connected.</p>}
    </div>
  )
}
