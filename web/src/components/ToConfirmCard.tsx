import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { WORK_AUTH, type ToConfirm } from '../lib/types'

const FIELD_LABELS: Record<string, string> = {
  work_authorization: 'Work authorisation',
  remote: 'Remote or local',
  pay_floor_annual: 'Pay floor, yearly',
  pay_floor_hourly: 'Pay floor, hourly',
  max_commute_minutes: 'Longest daily drive',
  fact_metric: 'the fact',
}

const shown = (t: ToConfirm) => (t.answer_kind === 'choice' && t.answer ? WORK_AUTH[t.answer] ?? t.answer : t.answer ?? '')

/** Open questions about a person (the body of the To confirm module). Never used as search filters. */
export function ToConfirmCard({ personId, firstName, items, onChange }: {
  personId: string
  firstName: string
  items: ToConfirm[]
  onChange: () => void
}) {
  const fromThem = items.filter((t) => !t.resolved_at && t.answered_at)
  const open = items.filter((t) => !t.resolved_at && !t.answered_at)
  const answered = items.filter((t) => t.resolved_at)
  const [answering, setAnswering] = useState<string | null>(null)
  const [answer, setAnswer] = useState('')
  const [wording, setWording] = useState<string | null>(null)
  const [wordingText, setWordingText] = useState('')
  const [adding, setAdding] = useState(false)
  const [topic, setTopic] = useState('')
  const [question, setQuestion] = useState('')
  const [personQuestion, setPersonQuestion] = useState('')
  const [showAnswered, setShowAnswered] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (p: PromiseLike<{ error: { message: string } | null }>) => {
    const { error: e } = await p
    if (e) return setError(e.message)
    setError(null)
    onChange()
  }

  const saveAnswer = (id: string) => {
    setAnswering(null)
    return run(supabase.from('to_confirm').update({ answer: answer.trim() || null, resolved_at: new Date().toISOString() }).eq('id', id))
  }
  const applyAnswer = (id: string) => run(supabase.rpc('apply_answer', { q_id: id }))
  const close = (id: string) => run(supabase.from('to_confirm').update({ resolved_at: new Date().toISOString() }).eq('id', id))
  const reopen = (id: string) => run(supabase.from('to_confirm').update({ resolved_at: null, answered_at: null }).eq('id', id))
  const saveWording = (t: ToConfirm) => {
    setWording(null)
    const text = wordingText.trim()
    return run(supabase.from('to_confirm').update({ person_question: text || null, ask_person: Boolean(text) }).eq('id', t.id))
  }
  const toggleAsk = (t: ToConfirm) => {
    if (!t.ask_person && !t.person_question) {
      setWording(t.id)
      setWordingText('')
      return
    }
    return run(supabase.from('to_confirm').update({ ask_person: !t.ask_person }).eq('id', t.id))
  }
  const add = () => {
    if (!topic.trim() || !question.trim()) return setError('Add a topic and the question.')
    setAdding(false)
    const pq = personQuestion.trim()
    setTopic(''); setQuestion(''); setPersonQuestion('')
    return run(supabase.from('to_confirm').insert({
      person_id: personId, topic: topic.trim(), question: question.trim(), person_question: pq || null, ask_person: Boolean(pq),
    }))
  }

  return (
    <div>
      {fromThem.length > 0 && (
        <>
          <p className="tc-heading">Answered by {firstName}</p>
          <ul className="tc-list">
            {fromThem.map((t) => (
              <li key={t.id} className="tc-answered-by-them">
                <span className="tc-topic">{t.topic}</span>
                <span className="tc-answer">“{shown(t)}”</span>
                <span className="tc-buttons">
                  {t.field && (
                    <button className="primary small-btn" onClick={() => applyAnswer(t.id)}>Save to {FIELD_LABELS[t.field] ?? t.field}</button>
                  )}
                  <button className="secondary" onClick={() => close(t.id)}>{t.field ? 'Close only' : 'Done'}</button>
                </span>
                {!t.field && <span className="field-hint">Update the profile where this belongs, then tap Done.</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {(fromThem.length > 0 || open.length > 0) && <p className="tc-heading">Open</p>}
      {open.length === 0 && fromThem.length === 0 && !adding && <p className="muted small">Nothing open.</p>}
      <ul className="tc-list">
        {open.map((t) => (
          <li key={t.id}>
            <span className="tc-topic">{t.topic}</span>
            <span className="tc-question">{t.question}</span>
            {t.ask_person && t.person_question && wording !== t.id && (
              <span className="tc-asked">Asked in the app: “{t.person_question}”</span>
            )}
            {wording === t.id ? (
              <div className="form">
                <textarea rows={2} value={wordingText} onChange={(e) => setWordingText(e.target.value)}
                  placeholder={`How ${firstName} sees it, e.g. "What's the lowest hourly rate you'd accept?"`} aria-label="Question as they see it" />
                <div className="actions">
                  <button className="primary small-btn" onClick={() => saveWording(t)}>Ask in the app</button>
                  <button className="secondary" onClick={() => setWording(null)}>Cancel</button>
                </div>
              </div>
            ) : answering === t.id ? (
              <div className="form">
                <textarea rows={2} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Their answer" aria-label={`Answer for ${t.topic}`} />
                <span className="field-hint">Then update the profile field it belongs to.</span>
                <div className="actions">
                  <button className="primary small-btn" onClick={() => saveAnswer(t.id)}>Mark answered</button>
                  <button className="secondary" onClick={() => setAnswering(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <span className="tc-links">
                <button className="link" onClick={() => { setAnswering(t.id); setAnswer('') }}>I have the answer</button>
                <button className="link" onClick={() => toggleAsk(t)}>{t.ask_person ? 'Stop asking in the app' : `Ask ${firstName} in the app`}</button>
                {t.ask_person && (
                  <button className="link" onClick={() => { setWording(t.id); setWordingText(t.person_question ?? '') }}>Edit wording</button>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>

      {adding ? (
        <div className="form">
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Topic, e.g. Pay floor" aria-label="Topic" />
          <textarea rows={2} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="The question, as a note for you" aria-label="Question" />
          <textarea rows={2} value={personQuestion} onChange={(e) => setPersonQuestion(e.target.value)}
            placeholder={`Optional: ask ${firstName} in the app, in their words`} aria-label="Question as they see it" />
          <div className="actions">
            <button className="primary small-btn" onClick={add}>Add</button>
            <button className="secondary" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="link body-action" onClick={() => setAdding(true)}>Add a question</button>
      )}
      {error && <p className="error">{error}</p>}

      {answered.length > 0 && (
        <>
          <button className="link small" onClick={() => setShowAnswered(!showAnswered)}>
            {showAnswered ? 'Hide' : 'Show'} {answered.length} closed
          </button>
          {showAnswered && (
            <ul className="tc-list tc-answered">
              {answered.map((t) => (
                <li key={t.id}>
                  <span className="tc-topic">{t.topic}</span>
                  <span className="tc-question">{shown(t) || 'Closed'}{t.answered_by === 'person' ? ` · from ${firstName}` : ''}</span>
                  <button className="link" onClick={() => reopen(t.id)}>Reopen</button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
