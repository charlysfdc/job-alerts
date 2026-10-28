import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { APP_STATUS, type Application } from '../lib/types'

/** Jobs already applied for or under way. The daily search never suggests these again. */
export function Applications({ personId, items, onChange }: { personId: string; items: Application[]; onChange: () => void }) {
  const [adding, setAdding] = useState(false)
  const [employer, setEmployer] = useState('')
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState('in_progress')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const setAppStatus = async (id: string, s: string) => {
    const { error: e } = await supabase.from('applications').update({ status: s }).eq('id', id)
    if (e) return setError(e.message)
    onChange()
  }

  const add = async () => {
    if (!employer.trim() || !title.trim()) return
    const { error: e } = await supabase.from('applications').insert({
      person_id: personId, employer: employer.trim(), title: title.trim(), status, note: note.trim() || null,
    })
    if (e) return setError(e.message)
    setAdding(false)
    setEmployer('')
    setTitle('')
    setNote('')
    setStatus('in_progress')
    onChange()
  }

  return (
    <div>
      {!adding && <button className="link body-action" onClick={() => setAdding(true)}>Add an application</button>}
      {items.length === 0 && !adding && <p className="muted small">None recorded yet.</p>}
      <ul className="tc-list">
        {items.map((a) => (
          <li key={a.id}>
            <span className="tc-topic">{a.title}</span>
            <span className="tc-question">{a.employer}{a.note ? ` · ${a.note}` : ''}</span>
            <select className="status-select" value={a.status} onChange={(e) => setAppStatus(a.id, e.target.value)} aria-label={`Status of ${a.title}`}>
              {Object.entries(APP_STATUS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </li>
        ))}
      </ul>
      {adding && (
        <div className="form">
          <input value={employer} onChange={(e) => setEmployer(e.target.value)} placeholder="Employer" aria-label="Employer" />
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Job title" aria-label="Job title" />
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            {Object.entries(APP_STATUS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label="Note" />
          <div className="actions">
            <button className="primary small-btn" onClick={add}>Add</button>
            <button className="secondary" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  )
}
