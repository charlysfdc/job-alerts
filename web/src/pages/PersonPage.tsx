import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { Section, type Field } from '../components/Section'
import { ToConfirmCard } from '../components/ToConfirmCard'
import { Applications } from '../components/Applications'
import {
  EMPLOYMENT, REMOTE, SCHEDULES, WORK_AUTH,
  type Application, type JobFamily, type Person, type Profile, type ToConfirm,
} from '../lib/types'

const PERSON_FIELDS: Field[] = [
  { key: 'name', label: 'Name', kind: 'text' },
  { key: 'email', label: 'Google sign-in email', kind: 'text', hint: 'The Gmail address they sign in with.' },
  { key: 'email_confirmed', label: 'Email confirmed', kind: 'bool' },
  { key: 'home_base', label: 'Home base', kind: 'text' },
  { key: 'schedule', label: 'Search schedule', kind: 'select', options: SCHEDULES },
  { key: 'run_at', label: 'Run time (Central)', kind: 'time' },
  { key: 'drive_folder_id', label: 'Drive folder ID', kind: 'text', hint: 'The last part of the folder link.' },
]

const RULE_FIELDS: Field[] = [
  { key: 'work_authorization', label: 'Work authorisation', kind: 'select', options: WORK_AUTH },
  { key: 'work_authorization_note', label: 'Work authorisation note', kind: 'textarea' },
  { key: 'remote', label: 'Remote or local', kind: 'select', options: REMOTE },
  { key: 'max_commute_minutes', label: 'Longest daily drive (minutes)', kind: 'number' },
  { key: 'commute_note', label: 'Commute note', kind: 'textarea' },
  { key: 'in_range_places', label: 'In range', kind: 'lines' },
  { key: 'out_of_range_places', label: 'Out of range', kind: 'lines' },
  { key: 'relocation', label: 'Relocation', kind: 'textarea' },
  { key: 'employment_types', label: 'Kinds of work', kind: 'checks', options: EMPLOYMENT },
  { key: 'pay_floor_annual', label: 'Pay floor, yearly (USD)', kind: 'number', hint: 'Leave empty if not agreed. Roles below it are dropped.' },
  { key: 'pay_floor_hourly', label: 'Pay floor, hourly (USD)', kind: 'number' },
  { key: 'pay_note', label: 'Pay note', kind: 'textarea' },
  { key: 'hours_note', label: 'Hours', kind: 'textarea' },
  { key: 'education_note', label: 'Education', kind: 'textarea' },
  { key: 'posting_window_days', label: 'Only postings from the last … days', kind: 'number' },
  { key: 'exclusions', label: 'Exclude', kind: 'lines' },
  { key: 'other_rules', label: 'Other rules', kind: 'paragraphs' },
]

const BRING_FIELDS: Field[] = [
  { key: 'headline', label: 'Headline', kind: 'textarea' },
  { key: 'facts', label: 'Facts (the only facts allowed on their documents)', kind: 'paragraphs' },
  { key: 'never_claim', label: 'Never claim', kind: 'lines' },
]

const SOURCE_FIELDS: Field[] = [{ key: 'sources', label: 'Job boards and employers', kind: 'lines' }]

const FAMILY_FIELDS: Field[] = [
  { key: 'letter', label: 'Letter', kind: 'text' },
  { key: 'name', label: 'Name', kind: 'text' },
  { key: 'active', label: 'Searched daily', kind: 'bool' },
  { key: 'why', label: 'Why they fit', kind: 'textarea' },
  { key: 'search_titles', label: 'Search titles', kind: 'lines' },
  { key: 'where_to_look', label: 'Where', kind: 'lines' },
  { key: 'gaps', label: 'Known gaps', kind: 'paragraphs' },
  { key: 'pay_seen', label: 'Pay seen', kind: 'textarea' },
  { key: 'notes', label: 'Notes', kind: 'textarea' },
]

interface Loaded {
  person: Person
  profile: Profile | null
  families: JobFamily[]
  applications: Application[]
  toConfirm: ToConfirm[]
}

async function load(id: string): Promise<Loaded> {
  const [p, pr, f, a, t] = await Promise.all([
    supabase.from('people').select('*').eq('id', id).single(),
    supabase.from('profiles').select('*').eq('person_id', id).maybeSingle(),
    supabase.from('job_families').select('*').eq('person_id', id).order('position'),
    supabase.from('applications').select('*').eq('person_id', id).order('created_at'),
    supabase.from('to_confirm').select('*').eq('person_id', id).order('created_at'),
  ])
  const err = p.error ?? pr.error ?? f.error ?? a.error ?? t.error
  if (err) throw new Error(err.message)
  return {
    person: p.data as Person,
    profile: (pr.data as Profile | null) ?? null,
    families: (f.data as JobFamily[]) ?? [],
    applications: (a.data as Application[]) ?? [],
    toConfirm: (t.data as ToConfirm[]) ?? [],
  }
}

const NEXT_LETTER = (fams: JobFamily[]) => String.fromCharCode(65 + fams.length)

export function PersonPage() {
  const { id = '' } = useParams()
  const { me } = useAuth()
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    load(id).then(setData).catch((e: Error) => setError(e.message))
  }, [id])
  useEffect(reload, [reload])

  if (error) return <main><Link className="back" to="/">‹ People</Link><p className="error">{error}</p></main>
  if (!data) return <main><p className="muted">Loading…</p></main>
  const { person, profile, families, applications, toConfirm } = data

  const done = (e: { message: string } | null) => {
    if (e) return e.message
    reload()
    return null
  }
  const savePerson = async (patch: Record<string, unknown>) =>
    done((await supabase.from('people').update(patch).eq('id', id)).error)
  const saveProfile = async (patch: Record<string, unknown>) =>
    done((await supabase.from('profiles').update({ ...patch, updated_by: me?.email ?? null }).eq('person_id', id)).error)
  const saveFamily = (fid: string) => async (patch: Record<string, unknown>) =>
    done((await supabase.from('job_families').update(patch).eq('id', fid)).error)

  const move = async (i: number, dir: -1 | 1) => {
    const a = families[i]
    const b = families[i + dir]
    if (!a || !b) return
    await supabase.from('job_families').update({ position: b.position }).eq('id', a.id)
    await supabase.from('job_families').update({ position: a.position }).eq('id', b.id)
    reload()
  }
  const addFamily = async () => {
    const position = families.reduce((m, f) => Math.max(m, f.position), 0) + 1
    const { error: e } = await supabase.from('job_families').insert({ person_id: id, position, letter: NEXT_LETTER(families), name: 'New job family' })
    if (e) setError(e.message)
    else reload()
  }

  const docUrl = profile?.source_doc_id ? `https://docs.google.com/document/d/${profile.source_doc_id}/edit` : null
  const folderUrl = person.drive_folder_id ? `https://drive.google.com/drive/folders/${person.drive_folder_id}` : null

  return (
    <main>
      <Link className="back" to="/">‹ People</Link>
      <h1>{person.name}</h1>
      <p className="muted small">
        {person.home_base ?? 'No home base'} · {SCHEDULES[person.schedule] ?? person.schedule}
        {folderUrl && <> · <a href={folderUrl} target="_blank" rel="noreferrer">Drive folder</a></>}
        {docUrl && <> · <a href={docUrl} target="_blank" rel="noreferrer">Old profile Doc</a></>}
      </p>

      <ToConfirmCard personId={id} items={toConfirm} onChange={reload} />

      {!profile ? (
        <p className="error">This person has no profile row. Run migrations/0002_profiles.sql.</p>
      ) : (
        <>
          <Section title="Search rules" fields={RULE_FIELDS} values={profile as unknown as Record<string, unknown>} onSave={saveProfile} />
          <Section title="What they bring" fields={BRING_FIELDS} values={profile as unknown as Record<string, unknown>} onSave={saveProfile} />

          <h2 className="group">Job families <span className="count">{families.filter((f) => f.active).length}</span></h2>
          <p className="muted small">In priority order. The search runs at least one search per active family.</p>
          {families.map((f, i) => (
            <Section
              key={f.id}
              title={`${f.letter}. ${f.name}`}
              fields={FAMILY_FIELDS}
              values={f as unknown as Record<string, unknown>}
              onSave={saveFamily(f.id)}
              muted={!f.active}
              summary={<p className="muted small summary">{f.active ? '' : 'Not searched · '}{f.search_titles.slice(0, 4).join(', ')}{f.search_titles.length > 4 ? '…' : ''}</p>}
              tools={
                <>
                  <button className="link" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                  <button className="link" onClick={() => move(i, 1)} disabled={i === families.length - 1} aria-label="Move down">↓</button>
                </>
              }
            />
          ))}
          <button className="secondary add" onClick={addFamily}>Add a job family</button>

          <Applications personId={id} items={applications} onChange={reload} />

          <Section title="Where to search" fields={SOURCE_FIELDS} values={profile as unknown as Record<string, unknown>} onSave={saveProfile} />
          <Section title="Person" fields={PERSON_FIELDS} values={person as unknown as Record<string, unknown>} onSave={savePerson} />

          <p className="muted small footer">
            Profile last changed {new Date(profile.updated_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
            {profile.updated_by ? ` by ${profile.updated_by}` : ''}
          </p>
        </>
      )}
    </main>
  )
}
