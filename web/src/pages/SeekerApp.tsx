import { useState } from 'react'
import { Link, Route, Routes } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import {
  addMyApplication, answerQuestion, coachName, isOpen, sendRequest, useSeekerView,
  type Question, type SeekerView,
} from '../lib/seeker'
import { APP_STATUS, EMPLOYMENT, WORK_AUTH } from '../lib/types'

interface Ctx {
  view: SeekerView
  base: string
  reload: () => void
  /** Admin preview: everything shows, nothing is sent. */
  preview: boolean
}

const PREVIEW_NOTE = (v: SeekerView) => `This is a preview. Only ${v.person.first_name} can send this.`

/**
 * The job seeker's side of the app. `base` is where it lives: '' when they are signed in,
 * '/person/<id>/view' when a coach previews it.
 */
export function SeekerApp({ base = '', personId }: { base?: string; personId?: string }) {
  const { view, error, reload } = useSeekerView(personId)
  if (error) return <main><p className="error">{error}</p></main>
  if (!view) return <main><p className="muted">Loading…</p></main>
  const ctx: Ctx = { view, base, reload, preview: Boolean(personId) }
  return (
    <>
      {ctx.preview && (
        <div className="preview-bar">
          Preview of {view.person.first_name}'s view · <Link to={`/person/${view.person.id}`}>Back to the profile</Link>
        </div>
      )}
      <Routes>
        <Route path="questions" element={<Questions {...ctx} />} />
        <Route path="profile" element={<Profile {...ctx} />} />
        <Route path="applications" element={<Applications {...ctx} />} />
        <Route path="*" element={<Home {...ctx} />} />
      </Routes>
    </>
  )
}

function Back({ base }: { base: string }) {
  return <Link className="back" to={base || '/'}>‹ Home</Link>
}

// ---- home -------------------------------------------------------------------

function Home({ view, base, preview }: Ctx) {
  const { signOut } = useAuth()
  const open = view.questions.filter(isOpen)
  const waiting = view.questions.filter((q) => q.answered_at && !q.done)
  const coach = coachName(view)
  return (
    <main>
      <div className="top">
        <div>
          <p className="eyebrow">AiA Job Alerts</p>
          <h1>Hi {view.person.first_name}</h1>
        </div>
        {!preview && <button className="link" onClick={signOut}>Sign out</button>}
      </div>

      {open.length > 0 ? (
        <Link to={`${base}/questions`} className="card tile tile-ask">
          <span className="tile-title">{open.length === 1 ? '1 question' : `${open.length} questions`} from {coach}</span>
          <span className="tile-text">Your answers help the search find the right jobs for you.</span>
          <span className="tile-go">Answer ›</span>
        </Link>
      ) : waiting.length > 0 ? (
        <Link to={`${base}/questions`} className="card tile">
          <span className="tile-title">Thank you for your answers</span>
          <span className="tile-text">{coach === 'us' ? 'They are saved.' : `${coach} has them and will update your search.`}</span>
        </Link>
      ) : null}

      <div className="card tile">
        <span className="tile-title">Your job leads</span>
        <span className="tile-text">Jobs picked for you will show here every morning, best first. Until then they keep arriving by email.</span>
      </div>

      <Link to={`${base}/profile`} className="card tile">
        <span className="tile-title">Your profile</span>
        <span className="tile-text">What we look for, and how we describe you on your resumes.</span>
        <span className="tile-go">View ›</span>
      </Link>

      <Link to={`${base}/applications`} className="card tile">
        <span className="tile-title">Your applications</span>
        <span className="tile-text">
          {view.applications.length ? `${view.applications.length} so far. ` : ''}Applied somewhere yourself? Add it so we never suggest it again.
        </span>
        <span className="tile-go">Open ›</span>
      </Link>

      <p className="muted small footer">You always apply yourself. We find the jobs and prepare the paperwork.</p>
    </main>
  )
}

// ---- questions --------------------------------------------------------------

function Questions({ view, base, reload, preview }: Ctx) {
  const open = view.questions.filter(isOpen)
  const answered = view.questions.filter((q) => !isOpen(q))
  const coach = coachName(view)
  return (
    <main>
      <Back base={base} />
      <h1>Questions</h1>
      <p className="muted">{coach === 'us' ? 'Your answers go straight into your profile.' : `Your answers go to ${coach}, who updates your search.`}</p>
      {open.length === 0 && <p className="card tile-text">No questions for you right now.</p>}
      {open.map((q) => <AnswerCard key={q.id} q={q} view={view} reload={reload} preview={preview} />)}
      {answered.length > 0 && (
        <>
          <h2 className="group">Your answers</h2>
          <ul className="list">
            {answered.map((q) => (
              <li key={q.id} className="row">
                <span className="row-main">
                  <span className="row-title">{q.question}</span>
                  <span className="row-sub"><span>{showAnswer(q)}</span><span>{q.done ? 'Done' : `With ${coach}`}</span></span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  )
}

function showAnswer(q: Question) {
  if (!q.answer) return '—'
  if (q.kind === 'choice') return WORK_AUTH[q.answer] ?? q.answer
  if (q.kind === 'number') return `$${q.answer}`
  return q.answer
}

function AnswerCard({ q, view, reload, preview }: { q: Question; view: SeekerView; reload: () => void; preview: boolean }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  const send = async () => {
    if (!value.trim()) return setError('Write an answer first.')
    if (preview) return setError(PREVIEW_NOTE(view))
    setSending(true)
    const e = await answerQuestion(q.id, value)
    setSending(false)
    if (e) setError(e)
    else reload()
  }

  return (
    <section className="card question">
      <p className="question-text">{q.question}</p>
      {q.kind === 'yesno' ? (
        <div className="choice-row">
          {['Yes', 'No'].map((c) => (
            <button key={c} className={value === c ? 'choice on' : 'choice'} onClick={() => { setValue(c); setError(null) }}>{c}</button>
          ))}
        </div>
      ) : q.kind === 'choice' ? (
        <div className="choice-list">
          {q.choices.map((c) => (
            <label key={c} className={value === c ? 'choice on' : 'choice'}>
              <input type="radio" name={q.id} checked={value === c} onChange={() => { setValue(c); setError(null) }} />
              {WORK_AUTH[c] ?? c}
            </label>
          ))}
        </div>
      ) : q.kind === 'number' ? (
        <label className="money">
          <span aria-hidden>$</span>
          <input inputMode="decimal" value={value} onChange={(e) => { setValue(e.target.value); setError(null) }} aria-label={q.question} placeholder="18" />
        </label>
      ) : (
        <textarea rows={3} value={value} onChange={(e) => { setValue(e.target.value); setError(null) }} aria-label={q.question} />
      )}
      {error && <p className="error small">{error}</p>}
      <button className="primary small-btn" onClick={send} disabled={sending}>{sending ? 'Sending…' : 'Send'}</button>
    </section>
  )
}

// ---- profile ----------------------------------------------------------------

function whereText(v: SeekerView) {
  const p = v.profile
  const home = v.person.home_base?.replace(/\s*\d{5}.*$/, '') || 'home'
  const drive = p.max_commute_minutes ? `about ${p.max_commute_minutes} minutes' drive of ${home}` : `a reasonable drive of ${home}`
  if (p.remote === 'remote_first') return `Remote jobs first, and local jobs within ${drive}.`
  if (p.remote === 'onsite_only') return `Jobs within ${drive}.`
  return `Jobs within ${drive}, and remote jobs.`
}

function Profile({ view, base, reload, preview }: Ctx) {
  const p = view.profile
  const [openFamily, setOpenFamily] = useState<number | null>(null)
  const pay = [p.pay_floor_annual ? `$${p.pay_floor_annual.toLocaleString('en-US')} a year` : null, p.pay_floor_hourly ? `$${p.pay_floor_hourly} an hour` : null].filter(Boolean)
  return (
    <main>
      <Back base={base} />
      <h1>Your profile</h1>

      <section className="card section">
        <h2 className="section-title">What we look for</h2>
        <h3 className="sub">Kinds of jobs</h3>
        <ul className="plain">
          {p.families.map((f, i) => (
            <li key={f.name}>
              <button className="family" onClick={() => setOpenFamily(openFamily === i ? null : i)} aria-expanded={openFamily === i}>
                <span>{f.name}</span><span className="muted" aria-hidden>{openFamily === i ? '−' : '+'}</span>
              </button>
              {openFamily === i && <p className="muted small family-titles">For example: {f.titles.join(', ')}</p>}
            </li>
          ))}
        </ul>
        <h3 className="sub">Where</h3>
        <p>{whereText(view)}</p>
        {p.in_range_places.length > 0 && (
          <p className="muted small">Including {p.in_range_places.slice(0, 8).join(', ')}{p.in_range_places.length > 8 ? ' and more' : ''}.</p>
        )}
        {p.employment_types.length > 0 && (
          <>
            <h3 className="sub">Kind of work</h3>
            <p>{p.employment_types.map((k) => EMPLOYMENT[k] ?? k).join(', ')}</p>
          </>
        )}
        {pay.length > 0 && (
          <>
            <h3 className="sub">Lowest pay</h3>
            <p>{pay.join(', or ')}</p>
          </>
        )}
        <Tell section="What we look for" view={view} reload={reload} preview={preview} />
      </section>

      <section className="card section">
        <h2 className="section-title">How we describe you</h2>
        <p className="muted small">
          Your resumes and cover letters are built only from this. Nothing else goes on them, so please check it.
        </p>
        {p.headline && <p className="headline">{p.headline}</p>}
        <ul className="items">
          {p.facts.map((f, i) => <li key={i}>{f}</li>)}
        </ul>
        <Tell section="How we describe you" view={view} reload={reload} preview={preview} />
      </section>

      {view.requests.length > 0 && (
        <>
          <h2 className="group">Your messages</h2>
          <ul className="list">
            {view.requests.map((r) => (
              <li key={r.id} className="row">
                <span className="row-main">
                  <span className="row-title">{r.message}</span>
                  <span className="row-sub"><span>{r.section}</span><span>{r.done ? 'Done' : 'Sent'}</span></span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  )
}

/** "Something wrong or missing? Tell Charly" */
function Tell({ section, view, reload, preview }: { section: string; view: SeekerView; reload: () => void; preview: boolean }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const coach = coachName(view)

  const send = async () => {
    if (!text.trim()) return setError('Write a message first.')
    if (preview) return setError(PREVIEW_NOTE(view))
    const e = await sendRequest(section, text)
    if (e) return setError(e)
    setText('')
    setOpen(false)
    setSent(true)
    reload()
  }

  if (!open) {
    return (
      <div className="tell">
        {sent && <p className="muted small">Sent. {coach === 'us' ? 'We' : coach} will look at it.</p>}
        <button className="link" onClick={() => { setOpen(true); setSent(false) }}>Something wrong or missing? Tell {coach}</button>
      </div>
    )
  }
  return (
    <div className="form tell">
      <textarea rows={3} value={text} onChange={(e) => { setText(e.target.value); setError(null) }} aria-label={`Message about ${section}`} placeholder="What should change?" />
      {error && <p className="error small">{error}</p>}
      <div className="actions">
        <button className="primary small-btn" onClick={send}>Send</button>
        <button className="secondary" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  )
}

// ---- applications -----------------------------------------------------------

function Applications({ view, base, reload, preview }: Ctx) {
  const [employer, setEmployer] = useState('')
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)

  const add = async () => {
    if (!employer.trim() || !title.trim()) return setError('Add the employer and the job title.')
    if (preview) return setError(PREVIEW_NOTE(view))
    const e = await addMyApplication(employer, title)
    if (e) return setError(e)
    setEmployer('')
    setTitle('')
    reload()
  }

  return (
    <main>
      <Back base={base} />
      <h1>Your applications</h1>
      <p className="muted">Jobs listed here are never suggested to you again.</p>
      {view.applications.length > 0 && (
        <ul className="list">
          {view.applications.map((a) => (
            <li key={a.id} className="row">
              <span className="row-main">
                <span className="row-title">{a.title}</span>
                <span className="row-sub">
                  <span>{a.employer}</span>
                  <span>{APP_STATUS[a.status] ?? a.status}</span>
                  {a.added_by === 'person' && <span>Added by you</span>}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <section className="card section">
        <h2 className="section-title">Applied somewhere yourself?</h2>
        <div className="form">
          <input value={employer} onChange={(e) => { setEmployer(e.target.value); setError(null) }} placeholder="Employer" aria-label="Employer" />
          <input value={title} onChange={(e) => { setTitle(e.target.value); setError(null) }} placeholder="Job title" aria-label="Job title" />
          {error && <p className="error small">{error}</p>}
          <div className="actions"><button className="primary small-btn" onClick={add}>Add</button></div>
        </div>
      </section>
    </main>
  )
}
