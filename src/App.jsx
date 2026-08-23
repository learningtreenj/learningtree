import { useEffect, useState } from 'react'
import { supabase } from './supabase.js'
import Login from './Login.jsx'
import ContractorPortal from './ContractorPortal.jsx'
import AdminPortal from './AdminPortal.jsx'
import TwoFactor, { isMfaVerified, isDeviceTrusted, clearMfaVerified } from './TwoFactor.jsx'

export default function App() {
  const [session, setSession] = useState(undefined) // undefined = loading
  const [role, setRole] = useState(null) // { isAdmin, contractor }
  const [mfaOk, setMfaOk] = useState(false)
  const [mfaChecked, setMfaChecked] = useState(false)
  // Invite and password-recovery links land with type=invite / type=recovery in
  // the URL hash — show the set-password screen before entering the portal.
  const [needsPassword, setNeedsPassword] = useState(() => /type=(invite|recovery)/.test(window.location.hash))

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s)
      if (event === 'PASSWORD_RECOVERY') setNeedsPassword(true)
      if (event === 'SIGNED_OUT') { clearMfaVerified(); setMfaOk(false); setMfaChecked(false) }
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) { setRole(null); return }
    let cancelled = false
    async function loadRole() {
      const [{ data: isAdmin }, { data: contractor }] = await Promise.all([
        supabase.rpc('is_admin'),
        supabase.from('Contractors').select('*').eq('user_id', session.user.id).maybeSingle(),
      ])
      if (!cancelled) setRole({ isAdmin: !!isAdmin, contractor: contractor || null })
    }
    loadRole()
    return () => { cancelled = true }
  }, [session])

  // Determine whether 2FA has been satisfied this session. Contractors are gated;
  // a session already elevated to aal2 (authenticator app) or flagged after an
  // email code counts as verified. Admins are not gated (yet).
  useEffect(() => {
    if (!session || !role) { setMfaChecked(false); return }
    if (role.isAdmin || !role.contractor) { setMfaOk(true); setMfaChecked(true); return }
    let cancelled = false
    async function check() {
      let aal2 = false
      try {
        const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
        aal2 = data?.currentLevel === 'aal2'
      } catch { /* treat as not elevated */ }
      if (!cancelled) { setMfaOk(aal2 || isMfaVerified(session.user.id) || isDeviceTrusted(session.user.id)); setMfaChecked(true) }
    }
    check()
    return () => { cancelled = true }
  }, [session, role])

  if (session === undefined) return <div className="login-wrap" />
  if (session && needsPassword) return <SetPassword onDone={() => setNeedsPassword(false)} />
  if (!session) return <Login />
  if (!role) return <div className="login-wrap" />

  if (role.isAdmin) return <AdminPortal user={session.user} />
  if (role.contractor) {
    if (!mfaChecked) return <div className="login-wrap" />
    if (!mfaOk) return <TwoFactor user={session.user} onVerified={() => setMfaOk(true)} />
    return <ContractorPortal user={session.user} contractor={role.contractor} />
  }

  return (
    <div className="login-wrap">
      <div className="login-box">
        <div className="login-logo">
          <div className="brand">Bilingual Evaluation Portal</div>
          <div className="tagline">Account not yet linked</div>
        </div>
        <div className="alert alert-warn">
          Your login ({session.user.email}) isn&apos;t linked to a contractor profile yet.
          Please contact the office to have your account activated.
        </div>
        <button className="btn btn-ghost btn-block" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
    </div>
  )
}

function SetPassword({ onDone }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)

  async function save(e) {
    e.preventDefault()
    if (password.length < 8) { setMsg({ kind: 'warn', text: 'Password must be at least 8 characters.' }); return }
    if (password !== confirm) { setMsg({ kind: 'warn', text: 'Passwords do not match.' }); return }
    setBusy(true); setMsg(null)
    const { error } = await supabase.auth.updateUser({ password })
    if (error) { setMsg({ kind: 'danger', text: error.message }); setBusy(false); return }
    window.history.replaceState(null, '', window.location.pathname)
    onDone()
  }

  return (
    <div className="login-wrap">
      <form className="login-box" onSubmit={save}>
        <div className="login-logo">
          <div className="brand">Bilingual Evaluation Portal</div>
          <div className="tagline">Set your password to continue</div>
        </div>
        {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}
        <div className="form-group">
          <label>New Password</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" />
        </div>
        <div className="form-group">
          <label>Confirm Password</label>
          <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" />
        </div>
        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>Save Password &amp; Continue</button>
      </form>
    </div>
  )
}
