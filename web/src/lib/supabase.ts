import { createClient } from '@supabase/supabase-js'

// An unset GitHub repository variable arrives as '' (not undefined), so test for empty too.
const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || undefined
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || undefined

export const supabaseConfigured = Boolean(url && anonKey)

export const supabase = createClient(url ?? 'https://not-configured.supabase.co', anonKey ?? 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
})
