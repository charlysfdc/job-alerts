import { useState } from 'react'
import { FIT_LABEL, TRACKS, setLeadStatus, type Lead, type LeadStatus } from '../lib/seeker'

const posted = (d: string | null) =>
  d ? new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null

/** One job lead: what it is, why it fits, and what to do with it. */
export function LeadCard({ lead, onChange, disabledNote, compact = false }: {
  lead: Lead
  onChange: () => void
  /** Admin preview: buttons show this note instead of changing anything. */
  disabledNote?: string
  compact?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const set = async (status: LeadStatus) => {
    if (disabledNote) return setError(disabledNote)
    setBusy(true)
    setError(null)
    const e = await setLeadStatus(lead.id, status)
    setBusy(false)
    if (e) setError(e)
    else onChange()
  }

  const where = [lead.employer, lead.location ?? (lead.remote ? 'Remote' : null), lead.pay_text].filter(Boolean).join(' · ')
  const when = posted(lead.posted_at)

  return (
    <li className={`lead lead-${lead.fit ?? 'good'}${lead.status === 'interested' ? ' lead-interested' : ''}`}>
      <span className="lead-top">
        {lead.fit && <span className="lead-fit">{FIT_LABEL[lead.fit]}</span>}
        {lead.track === 'asap' && <span className="lead-track">{TRACKS.asap.label}</span>}
        {lead.status === 'interested' && <span className="lead-track">Interested</span>}
      </span>
      {lead.url
        ? <a className="lead-title" href={lead.url} target="_blank" rel="noreferrer">{lead.title}</a>
        : <span className="lead-title">{lead.title}</span>}
      <span className="mini-sub">{where}{when ? ` · posted ${when}` : ''}</span>
      {!compact && lead.why && <span className="lead-why">{lead.why}</span>}
      {!compact && lead.concerns.length > 0 && <span className="lead-concerns">Good to know: {lead.concerns.join('; ')}</span>}
      {!compact && (
        <span className="tc-buttons">
          {lead.url && <a className="primary small-btn button-link" href={lead.url} target="_blank" rel="noreferrer">Open the job ↗</a>}
          {lead.status !== 'interested' && <button className="secondary" disabled={busy} onClick={() => set('interested')}>Interested</button>}
          <button className="secondary" disabled={busy} onClick={() => set('applied')}>I applied</button>
          <button className="link" disabled={busy} onClick={() => set('not_for_me')}>Not for me</button>
        </span>
      )}
      {error && <span className="error small">{error}</span>}
    </li>
  )
}

/** "Jobs by Adzuna": their terms ask for a credit wherever their jobs are shown. */
export function AdzunaCredit({ leads }: { leads: Lead[] }) {
  if (!leads.some((l) => l.source === 'adzuna')) return null
  return <p className="muted small">Some jobs by <a href="https://www.adzuna.com" target="_blank" rel="noreferrer">Adzuna</a>.</p>
}
