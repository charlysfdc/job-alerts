import { useRef, useState } from 'react'
import {
  ACCEPTED_FILES, TRACKS, checkProfile, decideSuggestion, openDocument, retryDocument, uploadDocument,
  type Doc, type Flag, type Suggestion,
} from '../lib/seeker'
import { FactText } from './FactText'

const KIND_LABEL: Record<Suggestion['kind'], string> = {
  fact_new: 'New',
  fact_change: 'Update',
  fact_rewrite: 'Duties → accomplishment',
  headline: 'Summary',
  family: 'New kind of job',
}

const FLAG_LABEL: Record<Flag['kind'], string> = {
  remove: 'Remove',
  translate: 'Use the US term',
  spelling: 'US spelling',
  format: 'Layout',
}

/** "Method check": what to fix in the document itself, grouped by kind. */
function Flags({ flags }: { flags: Flag[] }) {
  if (!flags?.length) return null
  const order: Flag['kind'][] = ['remove', 'translate', 'spelling', 'format']
  return (
    <details className="flags">
      <summary>Method check: {flags.length === 1 ? '1 thing' : `${flags.length} things`} to fix in this document</summary>
      {order.filter((k) => flags.some((f) => f.kind === k)).map((k) => (
        <div key={k} className="flag-group">
          <span className="flag-kind">{FLAG_LABEL[k]}</span>
          <ul>
            {flags.filter((f) => f.kind === k).map((f, i) => (
              <li key={i}><span className="flag-found">{f.found}</span> → {f.fix}</li>
            ))}
          </ul>
        </div>
      ))}
    </details>
  )
}

/** Run the Method on the profile itself: accomplishment rewrites, summary, kinds of jobs. */
export function CheckProfileButton({ personId, onDone, disabledNote }: { personId: string; onDone: () => void; disabledNote?: string }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async () => {
    if (disabledNote) return setError(disabledNote)
    setBusy(true)
    setError(null)
    setNote(null)
    const r = await checkProfile(personId)
    setBusy(false)
    if (r.error) setError(r.error)
    else setNote(r.summary ?? 'Checked.')
    onDone()
  }
  return (
    <div className="upload">
      <button className="secondary" onClick={run} disabled={busy}>{busy ? 'Checking…' : 'Check my profile with the Method'}</button>
      {busy && <p className="muted small reading"><span className="spinner" aria-hidden /> Turning duties into accomplishments… about a minute.</p>}
      {note && <p className="muted small">{note}</p>}
      {error && <p className="error small">{error}</p>}
    </div>
  )
}

const when = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

/** Upload button with "reading" progress. Used on the person's home, their profile and the admin page. */
export function UploadButton({ personId, onDone, disabledNote, label = 'Upload a resume or document' }: {
  personId: string
  onDone: (message: string) => void
  /** When set (an admin preview), uploading shows this note instead. */
  disabledNote?: string
  label?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pick = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    setBusy(`Reading ${file.name}… this takes about a minute.`)
    const r = await uploadDocument(personId, file)
    setBusy(null)
    if (input.current) input.current.value = ''
    if (r.error) setError(r.error)
    onDone(r.error ? '' : r.summary ?? 'Read.')
  }

  return (
    <div className="upload">
      <input ref={input} type="file" accept={ACCEPTED_FILES} hidden onChange={(e) => pick(e.target.files?.[0])} />
      <button className="secondary" disabled={Boolean(busy)}
        onClick={() => (disabledNote ? setError(disabledNote) : input.current?.click())}>
        {busy ? 'Reading…' : label}
      </button>
      {busy && <p className="muted small reading"><span className="spinner" aria-hidden /> {busy}</p>}
      {error && <p className="error small">{error}</p>}
      {!busy && !error && <p className="field-hint">PDF, Word (.docx) or text, up to 10 MB. Nothing changes until you accept it.</p>}
    </div>
  )
}

/** The list of uploaded files and their status. */
export function DocumentList({ docs, onChange }: { docs: Doc[]; onChange: () => void }) {
  const [error, setError] = useState<string | null>(null)
  if (!docs.length) return null

  const open = async (d: Doc) => {
    const url = await openDocument(d.path)
    if (url) window.open(url, '_blank', 'noopener')
    else setError('That file could not be opened.')
  }
  const retry = async (d: Doc) => {
    setError(null)
    const e = await retryDocument(d.id)
    if (e) setError(e)
    onChange()
  }

  return (
    <>
      <ul className="mini-list docs">
        {docs.map((d) => (
          <li key={d.id}>
            <button className="doc-name" onClick={() => open(d)}>{d.filename}</button>
            <span className="mini-sub">
              {when(d.created_at)} · {d.status === 'ready' ? d.summary ?? 'Read' : d.status === 'failed' ? d.error ?? 'Could not be read' : 'Reading…'}
            </span>
            {d.status === 'ready' && <Flags flags={d.flags} />}
            {d.status === 'failed' && <button className="link small" onClick={() => retry(d)}>Try again</button>}
          </li>
        ))}
      </ul>
      {error && <p className="error small">{error}</p>}
    </>
  )
}

/** What Claude found, one item at a time: Add or Skip. */
export function SuggestionList({ items, canDecide, waitingFor, onChange }: {
  items: Suggestion[]
  canDecide: boolean
  /** Who reviews when the person can't (the coach's name). */
  waitingFor: string
  onChange: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!items.length) return null

  const decide = async (s: Suggestion, accept: boolean) => {
    setBusy(s.id)
    setError(null)
    const e = await decideSuggestion(s.id, accept)
    setBusy(null)
    if (e) setError(e)
    onChange()
  }

  return (
    <div className="suggestions">
      <p className="tc-heading">{items.length === 1 ? '1 update' : `${items.length} updates`} from your documents</p>
      {!canDecide && <p className="muted small">{waitingFor} reviews these before they go on your resumes.</p>}
      <ul className="tc-list">
        {items.map((s) => (
          <li key={s.id} className="suggestion">
            <span className="suggestion-kind">{KIND_LABEL[s.kind]}</span>
            {s.kind === 'family' && s.family ? (
              <span className="suggestion-text">
                <strong>{s.family.name}</strong>{s.family.track ? ` · ${TRACKS[s.family.track].label}` : ''}: {s.family.search_titles.join(', ')}
              </span>
            ) : (
              <span className="suggestion-text"><FactText text={s.proposed_text ?? ''} /></span>
            )}
            {s.metrics?.length > 0 && (
              <span className="muted small">
                {s.metrics.length === 1 ? 'The highlighted part needs a number' : `The ${s.metrics.length} highlighted parts need numbers`}. Add this and we'll ask you for {s.metrics.length === 1 ? 'it' : 'them'}.
              </span>
            )}
            {(s.kind === 'fact_change' || s.kind === 'fact_rewrite') && s.current_text && (
              <details className="was"><summary>What it says now</summary><span>{s.current_text}</span></details>
            )}
            {s.reason && <span className="muted small">{s.reason}</span>}
            {canDecide && (
              <span className="tc-buttons">
                <button className="primary small-btn" disabled={busy === s.id} onClick={() => decide(s, true)}>Add</button>
                <button className="secondary" disabled={busy === s.id} onClick={() => decide(s, false)}>Skip</button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="error small">{error}</p>}
    </div>
  )
}
