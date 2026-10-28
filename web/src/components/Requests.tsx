import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import type { Request } from '../lib/types'

/** Messages the person sent from their profile ("Something wrong or missing?"). */
export function Requests({ items, onChange }: { items: Request[]; onChange: () => void }) {
  const { me } = useAuth()
  const [showDone, setShowDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = items.filter((r) => !r.resolved_at)
  const done = items.filter((r) => r.resolved_at)

  const setDone = async (id: string, isDone: boolean) => {
    const { error: e } = await supabase.from('requests')
      .update(isDone ? { resolved_at: new Date().toISOString(), resolved_by: me?.email ?? null } : { resolved_at: null, resolved_by: null })
      .eq('id', id)
    if (e) return setError(e.message)
    onChange()
  }

  const when = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  return (
    <div>
      {open.length === 0 && <p className="muted small">Nothing waiting. Messages they send from their profile show here.</p>}
      <ul className="tc-list">
        {open.map((r) => (
          <li key={r.id}>
            <span className="tc-topic">{r.section} · {when(r.created_at)}</span>
            <span className="tc-answer">“{r.message}”</span>
            <button className="link" onClick={() => setDone(r.id, true)}>Done</button>
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
      {done.length > 0 && (
        <>
          <button className="link small" onClick={() => setShowDone(!showDone)}>{showDone ? 'Hide' : 'Show'} {done.length} done</button>
          {showDone && (
            <ul className="tc-list tc-answered">
              {done.map((r) => (
                <li key={r.id}>
                  <span className="tc-topic">{r.section} · {when(r.created_at)}</span>
                  <span className="tc-question">{r.message}</span>
                  <button className="link" onClick={() => setDone(r.id, false)}>Reopen</button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
