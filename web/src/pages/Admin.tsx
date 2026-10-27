import { useEffect, useState } from 'react'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'

interface Person {
  id: string
  name: string
  email: string
  email_confirmed: boolean
  home_base: string | null
  schedule: string
  run_at: string | null
  last_sign_in_at: string | null
}

const SCHEDULES: Record<string, string> = { daily: 'Daily', mon_wed_fri: 'Mon, Wed, Fri', weekly: 'Weekly', paused: 'Paused' }

function when(iso: string | null): string {
  if (!iso) return 'Never signed in'
  return `Signed in ${new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

export function Admin() {
  const { me, signOut } = useAuth()
  const [people, setPeople] = useState<Person[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    supabase
      .from('people')
      .select('id, name, email, email_confirmed, home_base, schedule, run_at, last_sign_in_at')
      .order('name')
      .then(({ data, error: e }) => {
        if (e) setError(e.message)
        setPeople((data as Person[] | null) ?? [])
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
        <p className="empty">Nobody added yet. Run supabase/seed.private.sql in the SQL editor.</p>
      ) : (
        <ul className="list">
          {people.map((p) => (
            <li key={p.id} className="row">
              <span className="row-main">
                <span className="row-title">{p.name}</span>
                <span className="row-sub">
                  <span>{p.home_base ?? 'No home base'}</span>
                  <span>{SCHEDULES[p.schedule] ?? p.schedule}{p.run_at ? ` ${p.run_at.slice(0, 5)}` : ''}</span>
                </span>
                <span className="row-sub">
                  <span>{p.email}</span>
                  <span>{when(p.last_sign_in_at)}</span>
                </span>
              </span>
              {!p.email_confirmed && <span className="chip chip-ask">Email to confirm</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="muted small footer">Profiles, leads and packs come in the next phases.</p>
    </main>
  )
}
