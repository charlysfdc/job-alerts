import { useAuth } from '../lib/auth'
import { supabaseConfigured } from '../lib/supabase'

export function SignIn() {
  const { signIn, error } = useAuth()
  return (
    <main className="signin">
      <img src={`${import.meta.env.BASE_URL}icon-192.png`} alt="" width={96} height={96} className="logo" />
      <h1>AiA Job Alerts</h1>
      <p className="muted">Your daily job leads, sorted and ready to apply.</p>
      {!supabaseConfigured && <p className="error">The app is not connected to its database yet.</p>}
      {error && <p className="error">{error}</p>}
      <button className="primary" onClick={signIn} disabled={!supabaseConfigured}>
        Sign in with Google
      </button>
      <p className="muted small">Use the Gmail address you gave Charly. The app only sees your name and email address.</p>
    </main>
  )
}
