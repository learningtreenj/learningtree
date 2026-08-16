import { useEffect, useState } from 'react'
import { supabase } from './supabase.js'

// Marks the current browser session as having passed 2FA for this user.
export function markMfaVerified(userId) {
  try { sessionStorage.setItem('mfa_ok', userId) } catch { /* ignore */ }
}
export function isMfaVerified(userId) {
  try { return sessionStorage.getItem('mfa_ok') === userId } catch { return false }
}
export function clearMfaVerified() {
  try { sessionStorage.removeItem('mfa_ok') } catch { /* ignore */ }
}

// Two-factor gate shown after password login (contractors). Offers two methods:
//   • Authenticator app (TOTP) — native Supabase MFA, upgrades the session to aal2.
//   • Email code — one-time code emailed via the mfa-email edge function.
export default function TwoFactor({ user, onVerified }) {
  const [method, setMethod] = useState(null) // null | 'email' | 'totp'

  function finish() {
    markMfaVerified(user.id)
    onVerified()
  }

  return (
    <div className="login-wrap">
      <div className="login-box" style={{ width: 400 }}>
        <div className="login-logo">
          <div className="brand">Verify it&apos;s you</div>
          <div className="tagline">A second step is required to protect your account</div>
        </div>

        {method === null && (
          <>
            <p style={{ fontSize: 13, color: '#555', margin: '0 0 16px', textAlign: 'center' }}>
              Choose how you&apos;d like to receive your verification.
            </p>
            <button className="btn btn-primary btn-block" onClick={() => setMethod('totp')}>
              📱 Use an authenticator app
            </button>
            <div style={{ height: 10 }} />
            <button className="btn btn-ghost btn-block" onClick={() => setMethod('email')}>
              ✉️ Email me a code
            </button>
            <p style={{ fontSize: 11, color: '#999', margin: '16px 0 0', textAlign: 'center' }}>
              An authenticator app (Google Authenticator, Authy, etc.) is the most secure option.
            </p>
            <button className="btn btn-ghost btn-block" style={{ marginTop: 18 }}
              onClick={() => supabase.auth.signOut()}>Sign out</button>
          </>
        )}

        {method === 'email' && <EmailFactor email={user.email} onBack={() => setMethod(null)} onVerified={finish} />}
        {method === 'totp' && <TotpFactor onBack={() => setMethod(null)} onVerified={finish} />}
      </div>
    </div>
  )
}

function maskEmail(em) {
  const [name, domain] = String(em || '').split('@')
  if (!domain) return em || 'your email'
  const shown = name.length <= 2 ? name[0] || '' : name.slice(0, 2)
  return `${shown}${'•'.repeat(Math.max(1, name.length - shown.length))}@${domain}`
}

function EmailFactor({ email, onBack, onVerified }) {
  const [stage, setStage] = useState('send') // 'send' | 'code'
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  async function send() {
    setBusy(true); setMsg(null)
    const { data, error } = await supabase.functions.invoke('mfa-email', { body: { action: 'send' } })
    setBusy(false)
    if (error || data?.success === false) { setMsg({ kind: 'danger', text: error?.message || data?.error || 'Could not send the code.' }); return }
    if (data?.sent === false) { setMsg({ kind: 'warn', text: data?.warning || 'Email is not configured yet — contact the office.' }); return }
    setStage('code'); setMsg({ kind: 'success', text: 'We sent a 6-digit code to your email.' })
  }

  async function verify(e) {
    e.preventDefault()
    if (!/^\d{6}$/.test(code)) { setMsg({ kind: 'warn', text: 'Enter the 6-digit code.' }); return }
    setBusy(true); setMsg(null)
    const { data, error } = await supabase.functions.invoke('mfa-email', { body: { action: 'verify', code } })
    setBusy(false)
    if (error || !data?.verified) { setMsg({ kind: 'danger', text: error?.message || data?.error || 'Incorrect code.' }); return }
    onVerified()
  }

  return (
    <>
      {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}
      {stage === 'send' && (
        <>
          <p style={{ fontSize: 13, color: '#555', margin: '0 0 16px' }}>
            We&apos;ll email a one-time code to <strong>{maskEmail(email)}</strong>.
          </p>
          <button className="btn btn-primary btn-block" disabled={busy} onClick={send}>
            {busy ? 'Sending…' : 'Send code'}
          </button>
        </>
      )}
      {stage === 'code' && (
        <form onSubmit={verify}>
          <div className="form-group">
            <label>6-digit code</label>
            <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
              style={{ letterSpacing: 6, fontSize: 20, textAlign: 'center' }} autoFocus />
          </div>
          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? 'Verifying…' : 'Verify & continue'}
          </button>
          <button type="button" className="btn btn-ghost btn-block" style={{ marginTop: 8 }} disabled={busy} onClick={send}>
            Resend code
          </button>
        </form>
      )}
      <button type="button" className="btn btn-ghost btn-block" style={{ marginTop: 8 }} onClick={onBack}>← Other options</button>
    </>
  )
}

function TotpFactor({ onBack, onVerified }) {
  const [stage, setStage] = useState('loading') // 'loading' | 'enroll' | 'challenge'
  const [factorId, setFactorId] = useState(null)
  const [qr, setQr] = useState(null)
  const [secret, setSecret] = useState(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => { begin() }, [])

  async function begin() {
    setMsg(null)
    const { data: list, error } = await supabase.auth.mfa.listFactors()
    if (error) { setMsg({ kind: 'danger', text: error.message }); return }
    const verified = (list?.totp || []).find(f => f.status === 'verified')
    if (verified) { setFactorId(verified.id); setStage('challenge'); return }
    // Remove any half-finished (unverified) factors so a fresh enroll won't collide.
    for (const f of (list?.all || []).filter(f => f.factor_type === 'totp' && f.status !== 'verified')) {
      await supabase.auth.mfa.unenroll({ factorId: f.id })
    }
    const { data, error: enrErr } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Authenticator' })
    if (enrErr) { setMsg({ kind: 'danger', text: enrErr.message }); return }
    setFactorId(data.id); setQr(data.totp.qr_code); setSecret(data.totp.secret); setStage('enroll')
  }

  async function verify(e) {
    e.preventDefault()
    if (!/^\d{6}$/.test(code)) { setMsg({ kind: 'warn', text: 'Enter the 6-digit code from your app.' }); return }
    setBusy(true); setMsg(null)
    const { data: ch, error: e1 } = await supabase.auth.mfa.challenge({ factorId })
    if (e1) { setBusy(false); setMsg({ kind: 'danger', text: e1.message }); return }
    const { error: e2 } = await supabase.auth.mfa.verify({ factorId, challengeId: ch.id, code })
    setBusy(false)
    if (e2) { setMsg({ kind: 'danger', text: e2.message }); return }
    onVerified()
  }

  return (
    <>
      {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}
      {stage === 'loading' && <p style={{ color: '#888', textAlign: 'center' }}>Loading…</p>}

      {stage === 'enroll' && (
        <>
          <p style={{ fontSize: 13, color: '#555', margin: '0 0 12px' }}>
            Scan this QR code with your authenticator app, then enter the 6-digit code it shows.
          </p>
          {qr && <div style={{ textAlign: 'center', margin: '0 0 10px' }}>
            <img src={qr} alt="Authenticator QR code" style={{ width: 180, height: 180 }} />
          </div>}
          {secret && <p style={{ fontSize: 11, color: '#888', textAlign: 'center', wordBreak: 'break-all', margin: '0 0 12px' }}>
            Can&apos;t scan? Enter this key manually: <br /><code>{secret}</code>
          </p>}
        </>
      )}
      {stage === 'challenge' && (
        <p style={{ fontSize: 13, color: '#555', margin: '0 0 12px' }}>
          Open your authenticator app and enter the current 6-digit code.
        </p>
      )}

      {(stage === 'enroll' || stage === 'challenge') && (
        <form onSubmit={verify}>
          <div className="form-group">
            <label>6-digit code</label>
            <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
              style={{ letterSpacing: 6, fontSize: 20, textAlign: 'center' }} autoFocus />
          </div>
          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? 'Verifying…' : 'Verify & continue'}
          </button>
        </form>
      )}
      <button type="button" className="btn btn-ghost btn-block" style={{ marginTop: 8 }} onClick={onBack}>← Other options</button>
    </>
  )
}
