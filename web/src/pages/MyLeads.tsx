import { useAuth } from '../lib/auth'

export function MyLeads() {
  const { me, signOut } = useAuth()
  const first = me?.person?.name.split(' ')[0] ?? ''
  return (
    <main>
      <div className="top">
        <div>
          <p className="eyebrow">AiA Job Alerts</p>
          <h1>Hi {first}</h1>
        </div>
        <button className="link" onClick={signOut}>Sign out</button>
      </div>
      <div className="card intro">
        <p className="card-title">Your job leads will show here</p>
        <p className="muted small">
          Every morning the app looks for jobs that suit you. You will see them here, best first, with the closing date.
          Tap Interested and your tailored resume and cover letter are prepared for you. You still apply yourself.
        </p>
        <p className="muted small">Until this page is ready, your leads keep arriving by email as before.</p>
      </div>
    </main>
  )
}
