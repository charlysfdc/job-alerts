import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import { SignIn } from './pages/SignIn'
import { Admin } from './pages/Admin'
import { MyLeads } from './pages/MyLeads'
import { NotListed } from './pages/NotListed'

function Gate() {
  const { session, me, loading } = useAuth()
  if (loading) return <main><p className="muted">Loading…</p></main>
  if (!session) return <SignIn />
  if (!me || me.role === 'none') return <NotListed />
  return (
    <Routes>
      <Route path="*" element={me.role === 'admin' ? <Admin /> : <MyLeads />} />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </BrowserRouter>
  )
}
