export interface Person {
  id: string
  coach_email: string | null
  name: string
  email: string
  email_confirmed: boolean
  home_base: string | null
  drive_folder_id: string | null
  schedule: string
  run_at: string | null
  last_sign_in_at: string | null
}

export interface Profile {
  person_id: string
  source_doc_id: string | null
  work_authorization: string
  work_authorization_note: string | null
  remote: string
  max_commute_minutes: number | null
  commute_note: string | null
  in_range_places: string[]
  out_of_range_places: string[]
  relocation: string | null
  employment_types: string[]
  pay_floor_annual: number | null
  pay_floor_hourly: number | null
  pay_note: string | null
  hours_note: string | null
  education_note: string | null
  posting_window_days: number
  exclusions: string[]
  other_rules: string[]
  headline: string | null
  facts: string[]
  never_claim: string[]
  sources: string[]
  updated_at: string
  updated_by: string | null
}

export interface JobFamily {
  id: string
  person_id: string
  position: number
  letter: string
  name: string
  active: boolean
  why: string | null
  search_titles: string[]
  where_to_look: string[]
  gaps: string[]
  pay_seen: string | null
  notes: string | null
}

export interface Application {
  id: string
  person_id: string
  employer: string
  title: string
  status: string
  note: string | null
  created_at: string
}

export interface ToConfirm {
  id: string
  person_id: string
  topic: string
  question: string
  answer: string | null
  resolved_at: string | null
  created_at: string
  ask_person: boolean
  person_question: string | null
  field: string | null
  answer_kind: 'text' | 'yesno' | 'number' | 'choice'
  choices: string[]
  answered_at: string | null
  answered_by: string | null
}

export interface Request {
  id: string
  person_id: string
  section: string
  message: string
  created_at: string
  resolved_at: string | null
  resolved_by: string | null
}

export const SCHEDULES: Record<string, string> = {
  daily: 'Daily',
  mon_wed_fri: 'Mon, Wed, Fri',
  weekly: 'Weekly',
  paused: 'Paused',
}

export const WORK_AUTH: Record<string, string> = {
  to_confirm: 'TO CONFIRM',
  citizen: 'US citizen',
  green_card: 'Green card',
  work_permit: 'Work permit (EAD)',
  authorized: 'Authorized, no sponsorship needed',
  needs_sponsorship: 'Needs sponsorship',
}

export const REMOTE: Record<string, string> = {
  remote_first: 'Remote first',
  remote_ok: 'Remote or local',
  onsite_only: 'Local only',
}

export const EMPLOYMENT: Record<string, string> = {
  full_time: 'Full-time',
  part_time: 'Part-time',
  contract: 'Contract',
  adjunct: 'Adjunct',
}

export const APP_STATUS: Record<string, string> = {
  candidate: 'Candidate',
  in_progress: 'In progress',
  submitted: 'Submitted',
  interview: 'Interview',
  offer: 'Offer',
  closed: 'Closed',
}
