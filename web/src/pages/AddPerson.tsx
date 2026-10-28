import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'

/** Folder links look like https://drive.google.com/drive/folders/<id>?usp=… ; keep only the id. */
function folderId(s: string): string | null {
  const t = s.trim()
  if (!t) return null
  const m = t.match(/folders\/([\w-]+)/)
  return m ? m[1] : t
}

export function AddPerson() {
  const navigate = useNavigate()
  const { me } = useAuth()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [homeBase, setHomeBase] = useState('')
  const [folder, setFolder] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (!name.trim() || !email.trim()) return setError('Name and email are needed.')
    setSaving(true)
    setError(null)
    const { data, error: e } = await supabase
      .from('people')
      .insert({ name: name.trim(), email: email.trim().toLowerCase(), email_confirmed: true, coach_email: me?.email ?? null, home_base: homeBase.trim() || null, drive_folder_id: folderId(folder) })
      .select('id')
      .single()
    if (e || !data) {
      setSaving(false)
      return setError(e?.message ?? 'Could not add them.')
    }
    // the database gives every new person an empty profile and the starter questions (question_templates)
    navigate(`/person/${data.id}`)
  }

  return (
    <main>
      <Link className="back" to="/">‹ People</Link>
      <h1>Add a person</h1>
      <p className="muted small">They can sign in with this Gmail address as soon as you save. You'll be their coach. They get three starter questions in the app; fill in the rest of their profile on the next page.</p>
      <div className="card form">
        <label className="field"><span className="field-label">Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span className="field-label">Gmail address they sign in with</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="field"><span className="field-label">Home base</span><input value={homeBase} onChange={(e) => setHomeBase(e.target.value)} placeholder="City TX zip" /></label>
        <label className="field"><span className="field-label">Drive folder link</span><input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="https://drive.google.com/drive/folders/…" /></label>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button className="primary small-btn" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Add person'}</button>
        </div>
      </div>
    </main>
  )
}
