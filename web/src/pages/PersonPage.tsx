import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { Fields, Flagged, Item, type Field } from '../components/Section'
import { Module, setAllModules } from '../components/Module'
import { ToConfirmCard } from '../components/ToConfirmCard'
import { Applications } from '../components/Applications'
import { Requests } from '../components/Requests'
import { DocumentList, SuggestionList, UploadButton } from '../components/Documents'
import type { Doc, Suggestion } from '../lib/seeker'
import {
  APP_STATUS, EMPLOYMENT, REMOTE, SCHEDULES, WORK_AUTH,
  type Application, type JobFamily, type Person, type Profile, type Request, type ToConfirm,
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
  requests: Request[]
  documents: Doc[]
  suggestions: Suggestion[]
}

async function load(id: string): Promise<Loaded> {
  const [p, pr, f, a, t, r, d, s] = await Promise.all([
    supabase.from('people').select('*').eq('id', id).single(),
    supabase.from('profiles').select('*').eq('person_id', id).maybeSingle(),
    supabase.from('job_families').select('*').eq('person_id', id).order('position'),
    supabase.from('applications').select('*').eq('person_id', id).order('created_at'),
    supabase.from('to_confirm').select('*').eq('person_id', id).order('created_at'),
    supabase.from('requests').select('*').eq('person_id', id).order('created_at', { ascending: false }),
    supabase.from('documents').select('*').eq('person_id', id).order('created_at', { ascending: false }),
    supabase.from('suggestions').select('*').eq('person_id', id).eq('status', 'pending').order('created_at'),
  ])
  const err = p.error ?? pr.error ?? f.error ?? a.error ?? t.error ?? r.error ?? d.error ?? s.error
  if (err) throw new Error(err.message)
  return {
    person: p.data as Person,
    profile: (pr.data as Profile | null) ?? null,
    families: (f.data as JobFamily[]) ?? [],
    applications: (a.data as Application[]) ?? [],
    toConfirm: (t.data as ToConfirm[]) ?? [],
    requests: (r.data as Request[]) ?? [],
    documents: (d.data as Doc[]) ?? [],
    suggestions: (s.data as Suggestion[]) ?? [],
  }
}

const NEXT_LETTER = (fams: JobFamily[]) => String.fromCharCode(65 + fams.length)

const money = (n: number) => `$${n.toLocaleString('en-US')}`

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
}

function shortDate(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null
}

/** "Remote first · 45 min drive" */
function whereLine(p: Profile) {
  const parts = [REMOTE[p.remote] ?? p.remote]
  if (p.max_commute_minutes) parts.push(`${p.max_commute_minutes} min drive`)
  return parts.join(' · ')
}

function payLine(p: Profile) {
  const floors = [p.pay_floor_annual ? `${money(p.pay_floor_annual)}/yr` : null, p.pay_floor_hourly ? `${money(p.pay_floor_hourly)}/hr` : null].filter(Boolean)
  const note = p.pay_note ?? ''
  const open = /TO CONFIRM/i.test(note)
  let line = floors.length ? `Floor ${floors.join(' or ')}` : /\$\d/.test(note) ? 'Targets, no hard floor' : open ? '' : 'Not set'
  if (open) line = line ? `${line} · TO CONFIRM` : 'TO CONFIRM'
  return line
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function PersonPage() {
  const { id = '' } = useParams()
  const { me } = useAuth()
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editingCore, setEditingCore] = useState(false)

  const reload = useCallback(() => {
    load(id).then(setData).catch((e: Error) => setError(e.message))
  }, [id])
  useEffect(reload, [reload])

  if (error) return <main><Link className="back" to="/">‹ People</Link><p className="error">{error}</p></main>
  if (!data) return <main><p className="muted">Loading…</p></main>
  const { person, profile, families, applications, toConfirm, requests, documents, suggestions } = data

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
  const open = toConfirm.filter((t) => !t.resolved_at)
  const fromThem = open.filter((t) => t.answered_at)
  const openRequests = requests.filter((r) => !r.resolved_at)
  const firstName = person.name.split(' ')[0]
  const active = families.filter((f) => f.active)
  const live = applications.filter((a) => a.status !== 'closed')
  const values = profile as unknown as Record<string, unknown>
  const authFlag = !profile || profile.work_authorization === 'to_confirm'

  return (
    <main className="wide">
      <Link className="back" to="/">‹ People</Link>

      {/* core details: everything needed at a glance */}
      <section className="card hero">
        <div className="hero-top">
          <span className="avatar" aria-hidden>{initials(person.name)}</span>
          <div className="hero-name">
            <h1>{person.name}</h1>
            <p className="muted small">
              {person.home_base ?? 'No home base'} · {person.email}
              {!person.email_confirmed && <> · <span className="flagged">email TO CONFIRM</span></>}
            </p>
          </div>
          {!editingCore && (
            <span className="hero-actions">
              <Link to={`/person/${id}/view`} className="link">See their view</Link>
              <button className="link" onClick={() => setEditingCore(true)}>Edit</button>
            </span>
          )}
        </div>
        {editingCore ? (
          <Fields fields={PERSON_FIELDS} values={person as unknown as Record<string, unknown>} onSave={savePerson} editing onEditingChange={setEditingCore} formOnly />
        ) : (
          <>
            {profile && (
              <div className="chips">
                <span className={authFlag ? 'chip chip-ask' : 'chip chip-ok'}>
                  {authFlag ? 'Work authorisation TO CONFIRM' : WORK_AUTH[profile.work_authorization]}
                </span>
                <span className="chip">{whereLine(profile)}</span>
                {profile.employment_types.length > 0 && (
                  <span className="chip">{profile.employment_types.map((k) => EMPLOYMENT[k] ?? k).join(', ')}</span>
                )}
              </div>
            )}
            <dl className="stats">
              <div><dt>Pay</dt><dd>{profile ? <Flagged text={payLine(profile)} /> : '—'}</dd></div>
              <div><dt>Search</dt><dd>{SCHEDULES[person.schedule] ?? person.schedule}{person.run_at ? ` ${person.run_at.slice(0, 5)}` : ''}</dd></div>
              <div><dt>Open questions</dt><dd className={open.length ? 'ask-text' : ''}>{open.length}</dd></div>
              <div><dt>Applications</dt><dd>{live.length}</dd></div>
              <div><dt>Last sign-in</dt><dd>{shortDate(person.last_sign_in_at) ?? 'Never'}</dd></div>
              <div><dt>Profile changed</dt><dd>{shortDate(profile?.updated_at ?? null) ?? '—'}</dd></div>
            </dl>
            {(folderUrl || docUrl) && (
              <p className="hero-links small">
                {folderUrl && <a href={folderUrl} target="_blank" rel="noreferrer">Drive folder ↗</a>}
                {docUrl && <a href={docUrl} target="_blank" rel="noreferrer">Old profile Doc ↗</a>}
              </p>
            )}
          </>
        )}
      </section>

      {!profile ? (
        <p className="error">This person has no profile row. Run migrations/0002_profiles.sql.</p>
      ) : (
        <>
          <div className="module-bar">
            <button className="link small" onClick={() => setAllModules(true)}>Expand all</button>
            <button className="link small" onClick={() => setAllModules(false)}>Collapse all</button>
          </div>

          <div className="modules">
            <div className="col col-main">
              <Module id="rules" title="Search rules" className="o-2"
                summary={`${whereLine(profile)} · ${plural(profile.in_range_places.length, 'place')} in range · ${plural(profile.exclusions.length, 'exclusion')}`}>
                <Fields fields={RULE_FIELDS} values={values} onSave={saveProfile} />
              </Module>

              <Module id="bring" title="What they bring" count={profile.facts.length} className="o-3"
                summary={profile.headline ?? `${plural(profile.facts.length, 'fact')} · ${plural(profile.never_claim.length, 'thing', 'things')} never to claim`}>
                <Fields fields={BRING_FIELDS} values={values} onSave={saveProfile} />
              </Module>

              <Module id="documents" title="Resumes and documents" count={suggestions.length} tone="ask" className="o-4"
                forceOpen={suggestions.length > 0}
                summary={suggestions.length
                  ? `${suggestions.length} updates to review from ${documents.length === 1 ? '1 document' : `${documents.length} documents`}`
                  : documents.length ? `${documents.length === 1 ? '1 document' : `${documents.length} documents`} · nothing to review` : 'None uploaded yet'}>
                <SuggestionList items={suggestions} canDecide waitingFor="" onChange={reload} />
                <DocumentList docs={documents} onChange={reload} />
                <UploadButton personId={id} label={`Upload a document for ${firstName}`} onDone={() => reload()} />
              </Module>

              <Module id="families" title="Job families" count={active.length} className="o-4"
                summary={active.length ? active.map((f) => `${f.letter}. ${f.name}`).join(' · ') : 'None yet'}>
                <p className="muted small">In priority order. The search runs at least one search per active family.</p>
                <div className="items-list">
                  {families.map((f, i) => (
                    <Item
                      key={f.id}
                      title={`${f.letter}. ${f.name}`}
                      fields={FAMILY_FIELDS}
                      values={f as unknown as Record<string, unknown>}
                      onSave={saveFamily(f.id)}
                      muted={!f.active}
                      summary={`${f.active ? '' : 'Not searched · '}${f.search_titles.slice(0, 4).join(', ')}${f.search_titles.length > 4 ? '…' : ''}`}
                      tools={
                        <>
                          <button className="link" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${f.name} up`}>↑</button>
                          <button className="link" onClick={() => move(i, 1)} disabled={i === families.length - 1} aria-label={`Move ${f.name} down`}>↓</button>
                        </>
                      }
                    />
                  ))}
                </div>
                <button className="secondary add" onClick={addFamily}>Add a job family</button>
              </Module>
            </div>

            <div className="col col-side">
              <Module id="confirm" title="To confirm" count={open.length} tone="ask" className="o-1" forceOpen={open.length > 0}
                summary={open.length
                  ? `${fromThem.length ? `${fromThem.length} answered by ${firstName} · ` : ''}${open.filter((t) => !t.answered_at).map((t) => t.topic).join(' · ')}`
                  : 'Nothing open'}>
                <ToConfirmCard personId={id} firstName={firstName} items={toConfirm} onChange={reload} />
              </Module>

              <Module id="messages" title={`Messages from ${firstName}`} count={openRequests.length} tone="ask" className="o-1" forceOpen={openRequests.length > 0}
                summary={openRequests.length ? openRequests.map((r) => r.section).join(' · ') : 'None waiting'}>
                <Requests items={requests} onChange={reload} />
              </Module>

              <Module id="applications" title="Applications" count={applications.length} className="o-5"
                summary={applications.length
                  ? Object.entries(applications.reduce<Record<string, number>>((m, a) => ({ ...m, [a.status]: (m[a.status] ?? 0) + 1 }), {}))
                      .map(([k, n]) => `${n} ${(APP_STATUS[k] ?? k).toLowerCase()}`).join(' · ')
                  : 'None recorded · never suggested again once added'}>
                <Applications personId={id} items={applications} onChange={reload} />
              </Module>

              <Module id="sources" title="Where to search" count={profile.sources.length} className="o-6"
                summary={profile.sources.slice(0, 3).join(' · ') + (profile.sources.length > 3 ? '…' : '')}>
                <Fields fields={SOURCE_FIELDS} values={values} onSave={saveProfile} />
              </Module>
            </div>
          </div>

          <p className="muted small footer">
            Profile last changed {new Date(profile.updated_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
            {profile.updated_by ? ` by ${profile.updated_by}` : ''}
          </p>
        </>
      )}
    </main>
  )
}
