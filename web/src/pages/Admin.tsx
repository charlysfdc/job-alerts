import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'
import { SCHEDULES, WORK_AUTH, type Person } from '../lib/types'

type Row = Person & { profiles: { work_authorization: string } | null }

function when(iso: string | null): string {
  if (!iso) return 'Never signed in'
  return `Signed in ${new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

export function Admin() {
  const { me, signOut } = useAuth()
  const [people, setPeople] = useState<Row[] | null>(null)
  const [open, setOpen] = useState<Record<string, number>>({})
  const [fromThem, setFromThem] = useState<Record<string, number>>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      supabase.from('people').select('*, profiles(work_authorization)').order('name'),
      supabase.from('to_confirm').select('person_id, answered_at').is('resolved_at', null),
      supabase.from('requests').select('person_id').is('resolved_at', null),
    ]).then(([p, t, r]) => {
      const e = p.error ?? t.error ?? r.error
      if (e) setError(e.message)
      setPeople((p.data as Row[] | null) ?? [])
      const counts: Record<string, number> = {}
      const replies: Record<string, number> = {}
      for (const q of (t.data as { person_id: string; answered_at: string | null }[] | null) ?? []) {
        if (q.answered_at) replies[q.person_id] = (replies[q.person_id] ?? 0) + 1
        else counts[q.person_id] = (counts[q.person_id] ?? 0) + 1
      }
      for (const m of (r.data as { person_id: string }[] | null) ?? []) replies[m.person_id] = (replies[m.person_id] ?? 0) + 1
      setOpen(counts)
      setFromThem(replies)
    })
  }, [])

  return (
    <main>
      <div className="top">
        <div>
          <p className="eyebrow">AiA Job Alerts · Admin</p>
          <h1>People</h1>
        </div>
        <button className="link" onClick={signOut}>Sign out</button>
      </div>
      <p className="muted small">Signed in as {me?.email}</p>
      {error && <p className="error">{error}</p>}
      {people === null ? (
        <p className="muted">Loading…</p>
      ) : people.length === 0 ? (
        <p className="empty">Nobody added yet.</p>
      ) : (
        <ul className="list">
          {people.map((p) => {
            const auth = p.profiles?.work_authorization ?? 'to_confirm'
            return (
              <li key={p.id}>
                <Link to={`/person/${p.id}`} className="row">
                  <span className="row-main">
                    <span className="row-title">{p.name}</span>
                    <span className="row-sub">
                      <span>{p.home_base ?? 'No home base'}</span>
                      <span>{SCHEDULES[p.schedule] ?? p.schedule}{p.run_at ? ` ${p.run_at.slice(0, 5)}` : ''}</span>
                    </span>
                    <span className="row-sub">
                      <span>{auth === 'to_confirm' ? 'Work authorisation TO CONFIRM' : WORK_AUTH[auth]}</span>
                      <span>{when(p.last_sign_in_at)}</span>
                    </span>
                  </span>
                  {(fromThem[p.id] ?? 0) > 0 && <span className="chip chip-new">{fromThem[p.id]} new from them</span>}
                  {(open[p.id] ?? 0) > 0 && <span className="chip chip-ask">{open[p.id]} to confirm</span>}
                  {!p.email_confirmed && <span className="chip chip-ask">Email</span>}
                  <span className="chev" aria-hidden>›</span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
      <Link to="/add" className="button secondary add">Add a person</Link>
    </main>
  )
}
