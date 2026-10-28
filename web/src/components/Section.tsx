import { useState, type ReactNode } from 'react'

/** A field in an editable section. "lines" = one item per line; "paragraphs" = items separated by a blank line. */
export type Field =
  | { key: string; label: string; kind: 'text' | 'textarea' | 'number' | 'time'; hint?: string }
  | { key: string; label: string; kind: 'lines' | 'paragraphs'; hint?: string }
  | { key: string; label: string; kind: 'select' | 'checks'; options: Record<string, string>; hint?: string }
  | { key: string; label: string; kind: 'bool'; hint?: string }

type Draft = string | boolean | string[]
type Values = Record<string, unknown>

function toDraft(f: Field, v: unknown): Draft {
  switch (f.kind) {
    case 'lines': return ((v as string[] | null) ?? []).join('\n')
    case 'paragraphs': return ((v as string[] | null) ?? []).join('\n\n')
    case 'checks': return (v as string[] | null) ?? []
    case 'bool': return Boolean(v)
    case 'time': return typeof v === 'string' ? v.slice(0, 5) : ''
    default: return v === null || v === undefined ? '' : String(v)
  }
}

function fromDraft(f: Field, d: Draft): unknown {
  switch (f.kind) {
    case 'lines': return (d as string).split('\n').map((s) => s.trim()).filter(Boolean)
    case 'paragraphs':
      return (d as string).split(/\n\s*\n/).map((s) => s.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean)
    case 'checks':
    case 'bool':
    case 'select':
      return d
    case 'number': {
      const s = (d as string).replace(/[$,\s]/g, '')
      return s === '' || Number.isNaN(Number(s)) ? null : Number(s)
    }
    default: return (d as string).trim() || null
  }
}

/** The words TO CONFIRM stand out wherever an open question sits inside longer text. */
export function Flagged({ text }: { text: string }) {
  const parts = text.split(/(TO CONFIRM(?: WITH [A-Z]+)?)/i)
  if (parts.length === 1) return <>{text}</>
  return <>{parts.map((p, i) => (i % 2 ? <span key={i} className="flagged">{p}</span> : p))}</>
}

function View({ f, v }: { f: Field; v: unknown }) {
  if (f.kind === 'lines' || f.kind === 'paragraphs') {
    const items = (v as string[] | null) ?? []
    if (!items.length) return <span className="muted">—</span>
    return <ul className={f.kind === 'lines' ? 'items items-short' : 'items'}>{items.map((s, i) => <li key={i}><Flagged text={s} /></li>)}</ul>
  }
  if (f.kind === 'select') {
    const label = f.options[v as string] ?? String(v ?? '—')
    return v === 'to_confirm' ? <span className="flagged">{label}</span> : <>{label}</>
  }
  if (f.kind === 'checks') {
    const items = (v as string[] | null) ?? []
    return items.length ? <>{items.map((k) => f.options[k] ?? k).join(', ')}</> : <span className="muted">—</span>
  }
  if (f.kind === 'bool') return <>{v ? 'Yes' : 'No'}</>
  if (v === null || v === undefined || v === '') return <span className="muted">—</span>
  if (f.kind === 'time') return <>{String(v).slice(0, 5)}</>
  return <Flagged text={String(v)} />
}

function Input({ f, d, set }: { f: Field; d: Draft; set: (d: Draft) => void }) {
  switch (f.kind) {
    case 'textarea':
      return <textarea rows={3} value={d as string} onChange={(e) => set(e.target.value)} />
    case 'lines':
      return <textarea rows={Math.min(12, Math.max(3, (d as string).split('\n').length + 1))} value={d as string} onChange={(e) => set(e.target.value)} />
    case 'paragraphs':
      return <textarea rows={Math.min(24, Math.max(4, (d as string).split('\n').length + 2))} value={d as string} onChange={(e) => set(e.target.value)} />
    case 'select':
      return (
        <select value={d as string} onChange={(e) => set(e.target.value)}>
          {Object.entries(f.options).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      )
    case 'checks': {
      const on = d as string[]
      return (
        <span className="checks">
          {Object.entries(f.options).map(([k, label]) => (
            <label key={k}>
              <input type="checkbox" checked={on.includes(k)} onChange={(e) => set(e.target.checked ? [...on, k] : on.filter((x) => x !== k))} /> {label}
            </label>
          ))}
        </span>
      )
    }
    case 'bool':
      return <label className="checks"><input type="checkbox" checked={d as boolean} onChange={(e) => set(e.target.checked)} /> Yes</label>
    case 'number':
      return <input inputMode="decimal" value={d as string} onChange={(e) => set(e.target.value)} />
    case 'time':
      return <input type="time" value={d as string} onChange={(e) => set(e.target.value)} />
    default:
      return <input value={d as string} onChange={(e) => set(e.target.value)} />
  }
}

const HINTS: Partial<Record<Field['kind'], string>> = {
  lines: 'One per line.',
  paragraphs: 'Leave a blank line between items.',
}

interface SectionProps {
  title: ReactNode
  fields: Field[]
  values: Values
  onSave: (patch: Values) => Promise<string | null>
  /** Shown beside the Edit button (e.g. move up/down). */
  tools?: ReactNode
  /** When set, the section starts folded and shows this line instead of its fields. */
  summary?: ReactNode
  muted?: boolean
}

export function Section({ title, fields, values, onSave, tools, summary, muted }: SectionProps) {
  const [open, setOpen] = useState(summary === undefined)
  const [draft, setDraft] = useState<Record<string, Draft> | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const edit = () => {
    setDraft(Object.fromEntries(fields.map((f) => [f.key, toDraft(f, values[f.key])])))
    setOpen(true)
    setError(null)
  }

  const save = async () => {
    if (!draft) return
    setSaving(true)
    const patch = Object.fromEntries(fields.map((f) => [f.key, fromDraft(f, draft[f.key])]))
    const e = await onSave(patch)
    setSaving(false)
    if (e) setError(e)
    else setDraft(null)
  }

  return (
    <section className={muted ? 'card section section-muted' : 'card section'}>
      <div className="section-head">
        {summary !== undefined && !draft ? (
          <button className="section-title as-button" onClick={() => setOpen(!open)} aria-expanded={open}>
            <span className="caret">{open ? '▾' : '▸'}</span> {title}
          </button>
        ) : (
          <h2 className="section-title">{title}</h2>
        )}
        <span className="section-tools">
          {!draft && tools}
          {!draft && <button className="link" onClick={edit}>Edit</button>}
        </span>
      </div>
      {!open && !draft && summary}
      {draft ? (
        <div className="form">
          {fields.map((f) => (
            <div key={f.key} className="field">
              <span className="field-label">{f.label}</span>
              <Input f={f} d={draft[f.key]} set={(d) => setDraft({ ...draft, [f.key]: d })} />
              {(f.hint || HINTS[f.kind]) && <span className="field-hint">{f.hint ?? HINTS[f.kind]}</span>}
            </div>
          ))}
          {error && <p className="error">{error}</p>}
          <div className="actions">
            <button className="primary small-btn" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            <button className="secondary" onClick={() => setDraft(null)} disabled={saving}>Cancel</button>
          </div>
        </div>
      ) : open ? (
        <dl className="facts">
          {fields.map((f) => (
            <div key={f.key} className="fact">
              <dt>{f.label}</dt>
              <dd><View f={f} v={values[f.key]} /></dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  )
}
