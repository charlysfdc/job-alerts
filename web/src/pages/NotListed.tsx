import { useAuth } from '../lib/auth'

export function NotListed() {
  const { me, session, signOut } = useAuth()
  const email = me?.email || session?.user.email
  return (
    <main className="signin">
      <h1>Not on the list</h1>
      <p className="muted">{email ? `${email} is` : 'This account is'} not set up for AiA Job Alerts.</p>
      <p className="muted small">Sign out and use the Gmail address you gave Charly, or ask Charly to add you.</p>
      <button className="primary" onClick={signOut}>Sign out</button>
    </main>
  )
}
