import { useState } from 'react'
import { supabase } from './supabase.js'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [msg, setMsg] = useState(null) // { kind, text }
  const [busy, setBusy] = useState(false)

  async function signIn(e) {
    e.preventDefault()
    setBusy(true); setMsg(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setMsg({ kind: 'danger', text: error.message })
    setBusy(false)
  }

  async function magicLink() {
    if (!email) { setMsg({ kind: 'warn', text: 'Enter your email address first.' }); return }
    setBusy(true); setMsg(null)
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: window.location.origin },
    })
    setMsg(error
      ? { kind: 'danger', text: error.message }
      : { kind: 'success', text: 'Check your email for a sign-in link.' })
    setBusy(false)
  }

  async function resetPassword() {
    if (!email) { setMsg({ kind: 'warn', text: 'Enter your email address first.' }); return }
    setBusy(true); setMsg(null)
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    })
    setMsg(error
      ? { kind: 'danger', text: error.message }
      : { kind: 'success', text: 'Password reset email sent.' })
    setBusy(false)
  }

  return (
    <div className="login-wrap">
      <form className="login-box" onSubmit={signIn}>
        <div className="login-logo">
          <div className="brand">Bilingual Evaluation Portal</div>
          <div className="tagline">Contractor &amp; Case Management System</div>
        </div>

        {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}

        <div className="form-group">
          <label>Email Address</label>
          <input type="email" placeholder="you@example.com" value={email}
            onChange={e => setEmail(e.target.value)} autoComplete="email" />
        </div>
        <div className="form-group">
          <label>Password</label>
          <input type="password" value={password}
            onChange={e => setPassword(e.target.value)} autoComplete="current-password" />
        </div>
        <div style={{ textAlign: 'right', marginBottom: 14 }}>
          <span style={{ fontSize: 12, color: 'var(--accent)', cursor: 'pointer' }} onClick={resetPassword}>
            Forgot Password?
          </span>
        </div>

        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>Login</button>
        <button className="btn btn-ghost btn-block" type="button" style={{ marginTop: 7 }}
          disabled={busy} onClick={magicLink}>
          Email me a sign-in link
        </button>

        <div style={{ marginTop: 16, textAlign: 'center', fontSize: 11, color: '#bbb' }}>
          Bilingual Evaluation Portal · Secure Login
        </div>
      </form>
    </div>
  )
}
