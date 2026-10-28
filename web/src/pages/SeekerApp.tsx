import { useEffect, useState, type MouseEvent } from 'react'
import { Link, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import {
  TRACKS, addMyApplication, answerQuestion, coachName, isOpen, sendRequest, useSeekerView,
  type Question, type SeekerView,
} from '../lib/seeker'
import { APP_STATUS, EMPLOYMENT, WORK_AUTH } from '../lib/types'
import { CheckProfileButton, DocumentList, SuggestionList, UploadButton } from '../components/Documents'
import { FactText } from '../components/FactText'

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

function Home({ view, base, reload, preview }: Ctx) {
  const { signOut } = useAuth()
  const open = view.questions.filter(isOpen)
  const waiting = view.questions.filter((q) => q.answered_at && !q.done)
  const coach = coachName(view)
  const p = view.profile
  const recent = view.applications.slice(0, 4)
  const leads = 0 // daily leads arrive in phase 2
  const documents = view.documents.length
  const toReview = view.can_decide ? view.suggestions.length : 0
  const openItems = open.length + toReview
  const [note, setNote] = useState<string | null>(null)

  const jump = (id: string) => (e: MouseEvent) => {
    e.preventDefault()
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <main className="wide">
      <div className="top">
        <div>
          <p className="eyebrow">AiA Job Alerts</p>
          <h1>Hi {view.person.first_name}</h1>
        </div>
        {!preview && <button className="link" onClick={signOut}>Sign out</button>}
      </div>

      {/* stats bar: every number jumps to its section */}
      <nav className="statbar" aria-label="Your summary">
        <a href="#todo" onClick={jump('todo')} className={openItems ? 'stat stat-ask' : 'stat'}>
          <span className="stat-n">{openItems}</span><span className="stat-l">{openItems === 1 ? 'Open item' : 'Open items'}</span>
        </a>
        <a href="#leads" onClick={jump('leads')} className="stat">
          <span className="stat-n">{leads}</span><span className="stat-l">Job leads</span>
        </a>
        <a href="#applications" onClick={jump('applications')} className="stat">
          <span className="stat-n">{view.applications.length}</span><span className="stat-l">Applications</span>
        </a>
        <a href="#documents" onClick={jump('documents')} className="stat">
          <span className="stat-n">{documents}</span><span className="stat-l">Documents</span>
        </a>
      </nav>

      {/* 1. profile */}
      <section className="card section home-block" id="profile">
        <div className="section-head">
          <h2 className="section-title">Your profile</h2>
          <Link to={`${base}/profile`} className="link">View ›</Link>
        </div>
        <p className="muted small">What we look for, and how we describe you on your resumes.</p>
        <div className="chips">
          {p.families.map((f) => (
            <span key={f.name} className={f.track === 'asap' ? 'chip chip-asap' : 'chip'} title={TRACKS[f.track ?? 'long_term'].label}>{f.name}</span>
          ))}
        </div>
        <p className="small">{whereText(view)}</p>
        <p className="muted small">
          {p.facts.length} parts of your experience go on your resumes. <Link to={`${base}/profile`}>Check them</Link>
        </p>
      </section>

      {/* 2. leads and applications side by side */}
      <div className="two-col">
        <section className="card section home-block" id="leads">
          <div className="section-head">
            <h2 className="section-title">Your job leads <span className="count">{leads}</span></h2>
          </div>
          <p className="empty-state">Jobs picked for you will show here every morning, best first, with the closing date. Until then they keep arriving by email.</p>
        </section>

        <section className="card section home-block" id="applications">
          <div className="section-head">
            <h2 className="section-title">Your applications <span className="count">{view.applications.length}</span></h2>
            <Link to={`${base}/applications`} className="link">{view.applications.length ? 'All ›' : 'Add ›'}</Link>
          </div>
          {recent.length ? (
            <ul className="mini-list">
              {recent.map((a) => (
                <li key={a.id}>
                  <span className="mini-title">{a.title}</span>
                  <span className="mini-sub">{a.employer} · {APP_STATUS[a.status] ?? a.status}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-state">None yet. Applied somewhere yourself? Add it so we never suggest it again.</p>
          )}
          {view.applications.length > recent.length && (
            <Link to={`${base}/applications`} className="small">{view.applications.length - recent.length} more ›</Link>
          )}
        </section>
      </div>

      {/* 3. documents */}
      <section className="card section home-block" id="documents">
        <div className="section-head">
          <h2 className="section-title">Your documents <span className="count">{documents}</span></h2>
        </div>
        <p className="muted small">
          Upload your latest resume, a LinkedIn PDF or a certificate, and we update your profile from it. Your tailored resumes and cover letters will appear here too.
        </p>
        <DocumentList docs={view.documents} onChange={reload} />
        {view.suggestions.length > 0 && (
          <p className="small">
            <Link to={`${base}/profile#updates`}>
              {view.suggestions.length === 1 ? '1 update' : `${view.suggestions.length} updates`} {view.can_decide ? 'to review ›' : `waiting for ${coach}`}
            </Link>
          </p>
        )}
        {note && <p className="muted small">{note}</p>}
        <UploadButton personId={view.person.id} disabledNote={preview ? PREVIEW_NOTE(view) : undefined}
          onDone={(m) => { if (m) setNote(m); reload() }} />
      </section>

      {/* 4. to do */}
      <section className="home-block" id="todo">
        <h2 className="group">To do <span className={openItems ? 'count count-ask' : 'count'}>{openItems}</span></h2>
        {toReview > 0 && (
          <Link to={`${base}/profile#updates`} className="card tile tile-ask todo-review">
            <span className="tile-title">Review {toReview === 1 ? '1 update' : `${toReview} updates`} from your documents</span>
            <span className="tile-text">Add or skip each one. Nothing goes on your resumes until you add it.</span>
          </Link>
        )}
        {open.length === 0 ? (
          <p className="card empty-state">
            {waiting.length
              ? (coach === 'us' ? 'All done. Your answers are saved.' : `All done. ${coach} has your answers and will update your search.`)
              : 'Nothing to do right now.'}
          </p>
        ) : (
          <>
            <p className="muted small todo-intro">
              {coach === 'us' ? 'Your answers go straight into your profile.' : `Questions from ${coach}. Your answers help the search find the right jobs for you.`}
            </p>
            <div className="todo-grid">
              {open.map((q) => <AnswerCard key={q.id} q={q} view={view} reload={reload} preview={preview} />)}
            </div>
          </>
        )}
        {view.questions.length > open.length && (
          <Link to={`${base}/questions`} className="small">See your answers ›</Link>
        )}
      </section>

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

  const send = async (answer = value) => {
    if (!answer.trim()) return setError('Write an answer first.')
    if (preview) return setError(PREVIEW_NOTE(view))
    setSending(true)
    const e = await answerQuestion(q.id, answer)
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
          <input inputMode="decimal" value={value} onChange={(e) => { setValue(e.target.value); setError(null) }} aria-label={q.question} placeholder={/year/i.test(q.question) ? '150000' : '18'} />
        </label>
      ) : (
        <textarea rows={3} value={value} onChange={(e) => { setValue(e.target.value); setError(null) }} aria-label={q.question} />
      )}
      {error && <p className="error small">{error}</p>}
      <div className="actions">
        <button className="primary small-btn" onClick={() => send()} disabled={sending}>{sending ? 'Sending…' : 'Send'}</button>
        {q.metric && <button className="secondary" onClick={() => send('not sure')} disabled={sending}>I'm not sure</button>}
      </div>
      {q.metric && <p className="field-hint">An estimate is fine. "I'm not sure" leaves this part out of your resume.</p>}
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
  const { hash } = useLocation()
  // links like /profile#updates land on that section
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' })
  }, [hash])
  const pay = [p.pay_floor_annual ? `$${p.pay_floor_annual.toLocaleString('en-US')} a year` : null, p.pay_floor_hourly ? `$${p.pay_floor_hourly} an hour` : null].filter(Boolean)
  return (
    <main>
      <Back base={base} />
      <h1>Your profile</h1>

      <section className="card section">
        <h2 className="section-title">What we look for</h2>
        {(['asap', 'long_term'] as const).filter((t) => p.families.some((f) => (f.track ?? 'long_term') === t)).map((t) => (
          <div key={t}>
            <h3 className="sub">{TRACKS[t].label}</h3>
            <p className="muted small track-hint">{TRACKS[t].hint}</p>
            <ul className="plain">
              {p.families.map((f, i) => (f.track ?? 'long_term') !== t ? null : (
                <li key={f.name}>
                  <button className="family" onClick={() => setOpenFamily(openFamily === i ? null : i)} aria-expanded={openFamily === i}>
                    <span>{f.name}</span><span className="muted" aria-hidden>{openFamily === i ? '−' : '+'}</span>
                  </button>
                  {openFamily === i && <p className="muted small family-titles">For example: {f.titles.join(', ')}</p>}
                </li>
              ))}
            </ul>
          </div>
        ))}
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
          {p.facts.map((f, i) => <li key={i}><FactText text={f} /></li>)}
        </ul>
        <Tell section="How we describe you" view={view} reload={reload} preview={preview} />
      </section>

      <section className="card section" id="updates">
        <h2 className="section-title">Your resumes and documents</h2>
        <p className="muted small">Upload a newer resume, a LinkedIn PDF or a certificate. We read it and suggest updates to your profile.</p>
        <SuggestionList items={view.suggestions} canDecide={view.can_decide && !preview} waitingFor={coachName(view)} onChange={reload} />
        <DocumentList docs={view.documents} onChange={reload} />
        <UploadButton personId={view.person.id} disabledNote={preview ? PREVIEW_NOTE(view) : undefined} onDone={() => reload()} />
        <CheckProfileButton personId={view.person.id} disabledNote={preview ? PREVIEW_NOTE(view) : undefined} onDone={reload} />
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
