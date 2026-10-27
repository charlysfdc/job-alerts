import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'

export type Role = 'admin' | 'seeker' | 'none'

export interface Me {
  role: Role
  email: string
  person: { id: string; name: string } | null
}

interface AuthState {
  session: Session | null
  me: Me | null
  loading: boolean
  error: string | null
  signIn: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

const NOT_LISTED = 'This Google account is not on the AiA Job Alerts list. Sign in with the Gmail address you gave Charly, or ask Charly to add you.'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Google sends errors back in the URL (an account not on the list fails as a "Database error").
    const params = new URLSearchParams(window.location.hash.replace(/^#/, '') || window.location.search)
    const desc = params.get('error_description')
    if (desc) {
      setError(desc.includes('Database error') ? NOT_LISTED : desc)
      window.history.replaceState({}, '', window.location.pathname)
    }

    const loadMe = async (s: Session | null) => {
      setSession(s)
      if (!s) { setMe(null); setLoading(false); return }
      const { data, error: rpcError } = await supabase.rpc('me')
      if (rpcError) setError(rpcError.message)
      setMe((data as Me | null) ?? null)
      setLoading(false)
    }

    supabase.auth.getSession().then(({ data }) => loadMe(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'TOKEN_REFRESHED') { setSession(s); return }
      // supabase-js asks not to await other calls inside this callback
      window.setTimeout(() => loadMe(s), 0)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const signIn = async () => {
    setError(null)
    const redirectTo = new URL(import.meta.env.BASE_URL, window.location.origin).toString()
    const { error: e } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, queryParams: { prompt: 'select_account' } },
    })
    if (e) setError(e.message)
  }

  const signOut = async () => {
    await supabase.auth.signOut()
  }

  return <AuthContext.Provider value={{ session, me, loading, error, signIn, signOut }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth outside AuthProvider')
  return ctx
}
