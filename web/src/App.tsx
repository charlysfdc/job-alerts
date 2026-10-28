import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import { SignIn } from './pages/SignIn'
import { Admin } from './pages/Admin'
import { MyLeads } from './pages/MyLeads'
import { NotListed } from './pages/NotListed'
import { PersonPage } from './pages/PersonPage'
import { AddPerson } from './pages/AddPerson'

function Gate() {
  const { session, me, loading } = useAuth()
  if (loading) return <main><p className="muted">Loading…</p></main>
  if (!session) return <SignIn />
  if (!me || me.role === 'none') return <NotListed />
  if (me.role !== 'admin') {
    return (
      <Routes>
        <Route path="*" element={<MyLeads />} />
      </Routes>
    )
  }
  return (
    <Routes>
      <Route path="/person/:id" element={<PersonPage />} />
      <Route path="/add" element={<AddPerson />} />
      <Route path="*" element={<Admin />} />
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
