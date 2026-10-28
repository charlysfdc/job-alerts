import { useState } from 'react'
import { supabase } from '../lib/supabase'
import type { ToConfirm } from '../lib/types'

/** Open questions about a person. Never used as search filters; answering one does not change the profile by itself. */
export function ToConfirmCard({ personId, items, onChange }: { personId: string; items: ToConfirm[]; onChange: () => void }) {
  const open = items.filter((t) => !t.resolved_at)
  const answered = items.filter((t) => t.resolved_at)
  const [answering, setAnswering] = useState<string | null>(null)
  const [answer, setAnswer] = useState('')
  const [adding, setAdding] = useState(false)
  const [topic, setTopic] = useState('')
  const [question, setQuestion] = useState('')
  const [showAnswered, setShowAnswered] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const saveAnswer = async (id: string) => {
    const { error: e } = await supabase.from('to_confirm').update({ answer: answer.trim() || null, resolved_at: new Date().toISOString() }).eq('id', id)
    if (e) return setError(e.message)
    setAnswering(null)
    setAnswer('')
    onChange()
  }

  const reopen = async (id: string) => {
    const { error: e } = await supabase.from('to_confirm').update({ resolved_at: null }).eq('id', id)
    if (e) return setError(e.message)
    onChange()
  }

  const add = async () => {
    if (!topic.trim() || !question.trim()) return
    const { error: e } = await supabase.from('to_confirm').insert({ person_id: personId, topic: topic.trim(), question: question.trim() })
    if (e) return setError(e.message)
    setAdding(false)
    setTopic('')
    setQuestion('')
    onChange()
  }

  return (
    <section className={open.length ? 'card section tc-card' : 'card section'}>
      <div className="section-head">
        <h2 className="section-title">To confirm {open.length > 0 && <span className="count count-ask">{open.length}</span>}</h2>
        {!adding && <button className="link" onClick={() => setAdding(true)}>Add</button>}
      </div>
      {open.length === 0 && !adding && <p className="muted small">Nothing open.</p>}
      <ul className="tc-list">
        {open.map((t) => (
          <li key={t.id}>
            <span className="tc-topic">{t.topic}</span>
            <span className="tc-question">{t.question}</span>
            {answering === t.id ? (
              <div className="form">
                <textarea rows={2} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Their answer" aria-label={`Answer for ${t.topic}`} />
                <span className="field-hint">Then update the profile field it belongs to.</span>
                <div className="actions">
                  <button className="primary small-btn" onClick={() => saveAnswer(t.id)}>Mark answered</button>
                  <button className="secondary" onClick={() => setAnswering(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <button className="link" onClick={() => { setAnswering(t.id); setAnswer('') }}>Answer</button>
            )}
          </li>
        ))}
      </ul>
      {adding && (
        <div className="form">
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Topic, e.g. Pay floor" aria-label="Topic" />
          <textarea rows={2} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="The question to ask them" aria-label="Question" />
          <div className="actions">
            <button className="primary small-btn" onClick={add}>Add</button>
            <button className="secondary" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {answered.length > 0 && (
        <>
          <button className="link small" onClick={() => setShowAnswered(!showAnswered)}>
            {showAnswered ? 'Hide' : 'Show'} {answered.length} answered
          </button>
          {showAnswered && (
            <ul className="tc-list tc-answered">
              {answered.map((t) => (
                <li key={t.id}>
                  <span className="tc-topic">{t.topic}</span>
                  <span className="tc-question">{t.answer ?? 'Answered'}</span>
                  <button className="link" onClick={() => reopen(t.id)}>Reopen</button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
