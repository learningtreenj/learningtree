import { useEffect, useMemo, useState } from 'react'
import { supabase, STATUSES, fmtDate, daysLeft, dueColor } from './supabase.js'
import { Shell, Badge, StatCard, Meta } from './ui.jsx'

// Once a case is assigned to a contractor, show its initial "Assigned" stage as "In Progress"
const showStatus = (s) => (s || '').toLowerCase() === 'assigned' ? 'In Progress' : s

export default function ContractorPortal({ contractor }) {
  const [screen, setScreen] = useState('assignments')
  const [assignments, setAssignments] = useState([])
  const [earnings, setEarnings] = useState([])
  const [selected, setSelected] = useState(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    const [a, e] = await Promise.all([
      supabase.from('Assignments').select('*, Cases(*)')
        .order('report_due_date', { ascending: true, nullsFirst: false }),
      supabase.from('contractor_earnings').select('*, payment_batches(batch_month, status)')
        .order('billable_date', { ascending: false }),
    ])
    if (!a.error) setAssignments(a.data || [])
    if (!e.error) setEarnings(e.data || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const open = assignments.filter(a => (a.status || '').toLowerCase() !== 'submitted')
  const dueSoon = open.filter(a => { const n = daysLeft(a.report_due_date); return n !== null && n <= 7 })

  const nav = [
    { label: 'My Work', items: [
      { id: 'assignments', icon: '📋', label: 'My Assignments', badge: open.length || null },
    ]},
    { label: 'Account', items: [
      { id: 'profile', icon: '👤', label: 'My Profile' },
      { id: 'payouts', icon: '💵', label: 'My Earnings' },
      { id: 'help', icon: '❓', label: 'Help' },
    ]},
  ]

  const titles = { assignments: 'My Assignments', detail: 'Assignment Detail', profile: 'My Profile', payouts: 'My Earnings', help: 'Help & Support' }

  return (
    <Shell brand="BEval Portal" sub="Contractor View"
      userName={contractor.name} userRole={[contractor.field, contractor.language].filter(Boolean).join(' · ')}
      navSections={nav} active={screen === 'detail' ? 'assignments' : screen}
      onNav={id => { setScreen(id); setSelected(null) }}
      onLogout={() => supabase.auth.signOut()}
      title={titles[screen]}>

      {screen === 'assignments' && (
        <AssignmentList assignments={assignments} loading={loading} dueSoonCount={dueSoon.length}
          onOpen={a => { setSelected(a); setScreen('detail') }} />
      )}
      {screen === 'detail' && selected && (
        <AssignmentDetail assignment={selected} contractor={contractor}
          onBack={() => { setScreen('assignments'); load() }}
          onChanged={load} />
      )}
      {screen === 'profile' && <Profile contractor={contractor} />}
      {screen === 'payouts' && <Earnings earnings={earnings} assignments={assignments} contractor={contractor} />}
      {screen === 'help' && <Help />}
    </Shell>
  )
}

function AssignmentList({ assignments, loading, dueSoonCount, onOpen }) {
  const [q, setQ] = useState('')
  const [chip, setChip] = useState('all')

  const counts = useMemo(() => {
    const c = { assigned: 0, scheduled: 0, awaiting: 0, completed: 0 }
    for (const a of assignments) {
      const s = (a.status || '').toLowerCase()
      if (s === 'submitted') c.completed++
      else if (s.includes('testing complet') || s.includes('draft')) c.awaiting++
      else if (s.includes('schedul') || s.includes('contact')) c.scheduled++
      else c.assigned++
    }
    return c
  }, [assignments])

  const rows = assignments.filter(a => {
    const s = (a.status || '').toLowerCase()
    if (chip === 'soon') { const n = daysLeft(a.report_due_date); if (s === 'submitted' || n === null || n > 7) return false }
    if (chip === 'done' && s !== 'submitted') return false
    if (chip === 'open' && s === 'submitted') return false
    const hay = `${a.Cases?.case_number || ''} ${a.eval_type || ''} ${a.Cases?.Language || ''} ${a.Cases?.School_district || ''}`.toLowerCase()
    return hay.includes(q.toLowerCase())
  })

  return (
    <>
      {dueSoonCount > 0 && (
        <div className="alert alert-warn">⏰ <span><strong>{dueSoonCount} report{dueSoonCount > 1 ? 's' : ''} due within 7 days.</strong> Please make sure testing is scheduled and reports are submitted on time.</span></div>
      )}
      <div className="stat-grid stat-grid-4">
        <StatCard num={counts.assigned} label="Assigned" color="blue" />
        <StatCard num={counts.scheduled} label="Scheduled" color="yellow" />
        <StatCard num={counts.awaiting} label="Awaiting Report" color="orange" />
        <StatCard num={counts.completed} label="Completed" color="green" />
      </div>
      <div className="card">
        <div className="sec-head">
          <h3>Assignments</h3>
          <div className="filter-bar" style={{ margin: 0 }}>
            <input type="text" placeholder="🔍 Search case, type, district…" value={q} onChange={e => setQ(e.target.value)} />
            {[['all', 'All'], ['open', 'Open'], ['soon', 'Due Soon'], ['done', 'Completed']].map(([id, label]) => (
              <span key={id} className={`filter-chip ${chip === id ? 'active' : ''}`} onClick={() => setChip(id)}>{label}</span>
            ))}
          </div>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Case</th><th>Eval Type</th><th>Language</th><th>District</th><th>Due Date</th><th>Testing Date</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={8} style={{ color: '#888' }}>Loading…</td></tr>}
              {!loading && rows.length === 0 && <tr><td colSpan={8} style={{ color: '#888' }}>No assignments found.</td></tr>}
              {rows.map(a => (
                <tr key={a.id}>
                  <td><span className="tbl-link" onClick={() => onOpen(a)}>{a.Cases?.case_number || a.case_id}</span></td>
                  <td>{a.eval_type || '—'}</td>
                  <td>{a.Cases?.Language || '—'}</td>
                  <td>{a.Cases?.School_district || '—'}</td>
                  <td style={dueColor(a.report_due_date)}>{fmtDate(a.report_due_date)}</td>
                  <td>{a.testing_date ? fmtDate(a.testing_date) : <span style={{ color: 'var(--red)' }}>Not Set</span>}</td>
                  <td>
                    <Badge status={showStatus(a.status)} />
                    {a.acceptance_status === 'pending' && <div><span className="badge-s s-scheduled" style={{ marginTop: 3 }}>⚠ Respond</span></div>}
                    {a.acceptance_status === 'declined' && <div><span className="badge-s s-overdue" style={{ marginTop: 3 }}>Declined</span></div>}
                  </td>
                  <td><button className="btn btn-secondary btn-sm" onClick={() => onOpen(a)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

function AssignmentDetail({ assignment, contractor, onBack }) {
  const a = assignment
  const c = a.Cases || {}
  const [status, setStatus] = useState(a.status || 'Assigned')
  const [testingDate, setTestingDate] = useState(a.testing_date || '')
  const [notes, setNotes] = useState(a.notes || '')
  const [reportUrl, setReportUrl] = useState(a.report_url || '')
  // Multiple report files. Fall back to the legacy single report_url for older assignments.
  const [reportFiles, setReportFiles] = useState(
    Array.isArray(a.report_files) && a.report_files.length
      ? a.report_files
      : (a.report_url ? [{ path: a.report_url, name: a.report_url.split('/').pop() }] : [])
  )
  const [acceptance, setAcceptance] = useState(a.acceptance_status)
  const [declining, setDeclining] = useState(false)
  const [declineReason, setDeclineReason] = useState('')
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)

  async function respond(action) {
    setBusy(true); setMsg(null)
    const patch = action === 'accept'
      ? { acceptance_status: 'accepted', accepted_at: new Date().toISOString() }
      : { acceptance_status: 'declined', declined_at: new Date().toISOString(), decline_reason: declineReason || null }
    const { error } = await supabase.from('Assignments').update(patch).eq('id', a.id)
    if (error) setMsg({ kind: 'danger', text: error.message })
    else {
      setAcceptance(patch.acceptance_status)
      setDeclining(false)
      // Email the office so an admin can reassign the case (non-blocking, best-effort)
      if (action === 'decline') {
        try { await supabase.functions.invoke('notify-assignment-declined', { body: { assignment_id: a.id } }) } catch { /* best-effort */ }
      }
      setMsg(action === 'accept'
        ? { kind: 'success', text: 'Assignment accepted — thank you! Please contact the family to schedule testing.' }
        : { kind: 'info', text: 'Assignment declined. The office has been notified and will reassign the case.' })
    }
    setBusy(false)
  }

  async function save(extra = {}) {
    // A case can only be marked "Submitted" once a report file has been uploaded
    if ((status || '').toLowerCase() === 'submitted' && reportFiles.length === 0) {
      setMsg({ kind: 'warn', text: 'Please upload your completed report before marking this Submitted — a report attachment is required.' })
      return false
    }
    // The testing date is required to submit a report.
    if ((status || '').toLowerCase() === 'submitted' && !testingDate) {
      setMsg({ kind: 'warn', text: 'Please enter the Testing Date before submitting — it is required.' })
      return false
    }
    setBusy(true); setMsg(null)
    const patch = { status, testing_date: testingDate || null, notes: notes || null, ...extra }
    const { error } = await supabase.from('Assignments').update(patch).eq('id', a.id)
    setMsg(error ? { kind: 'danger', text: error.message } : { kind: 'success', text: 'Saved.' })
    setBusy(false)
    return !error
  }

  async function uploadReports(fileList) {
    const files = Array.from(fileList || [])
    if (!files.length) return
    // The testing date is required — uploading a report marks the assignment Submitted.
    if (!testingDate) {
      setMsg({ kind: 'warn', text: 'Please enter the Testing Date above before uploading your report — it is required to submit.' })
      return
    }
    setBusy(true); setMsg(null)
    const uploaded = []
    for (const file of files) {
      const path = `${contractor.identifier}/${a.id}/${file.name}`
      const { error: upErr } = await supabase.storage.from('reports').upload(path, file, { upsert: true })
      if (upErr) { setMsg({ kind: 'danger', text: `Upload failed for ${file.name}: ${upErr.message}` }); setBusy(false); return }
      uploaded.push({ path, name: file.name, uploaded_at: new Date().toISOString() })
    }
    // Merge with existing files; a re-uploaded filename replaces its prior entry.
    const merged = [...reportFiles.filter(f => !uploaded.some(u => u.path === f.path)), ...uploaded]
    const { error } = await supabase.from('Assignments').update({
      report_files: merged,
      report_url: merged[merged.length - 1].path,   // keep latest as the primary for back-compat
      status: 'Submitted', submitted_at: new Date().toISOString(),
      testing_date: testingDate || null, notes: notes || null,
    }).eq('id', a.id)
    if (error) setMsg({ kind: 'danger', text: error.message })
    else {
      setReportFiles(merged); setReportUrl(merged[merged.length - 1].path); setStatus('Submitted')
      setMsg({ kind: 'success', text: `${uploaded.length} file${uploaded.length === 1 ? '' : 's'} uploaded and marked as Submitted. Thank you!` })
      // Notify the office that a report is ready for review (non-blocking)
      try { await supabase.functions.invoke('notify-report-submitted', { body: { assignment_id: a.id } }) } catch { /* best-effort */ }
    }
    setBusy(false)
  }

  async function viewReport(path) {
    const { data, error } = await supabase.storage.from('reports').createSignedUrl(path, 300)
    if (!error && data?.signedUrl) window.open(data.signedUrl, '_blank')
  }

  async function deleteReportFile(f) {
    if (!window.confirm(`Remove "${f.name || f.path.split('/').pop()}"? This deletes the uploaded file.`)) return
    setBusy(true); setMsg(null)
    await supabase.storage.from('reports').remove([f.path])   // best-effort storage cleanup
    const remaining = reportFiles.filter(x => x.path !== f.path)
    const patch = { report_files: remaining, report_url: remaining.length ? remaining[remaining.length - 1].path : null }
    // If the last file is removed, the report is no longer submitted
    if (remaining.length === 0) { patch.status = 'Draft Report'; patch.submitted_at = null }
    const { error } = await supabase.from('Assignments').update(patch).eq('id', a.id)
    if (error) { setMsg({ kind: 'danger', text: error.message }); setBusy(false); return }
    setReportFiles(remaining)
    setReportUrl(patch.report_url || '')
    if (remaining.length === 0) setStatus('Draft Report')
    setMsg({ kind: 'success', text: remaining.length ? 'File removed.' : 'File removed — this report is no longer marked Submitted.' })
    setBusy(false)
  }

  async function viewReferral() {
    if (!c.referral_file_path) return
    const { data, error } = await supabase.storage.from('referrals').createSignedUrl(c.referral_file_path, 300)
    if (!error && data?.signedUrl) window.open(data.signedUrl, '_blank')
  }

  const stepIndex = Math.max(0, STATUSES.findIndex(s => s.toLowerCase() === (status || '').toLowerCase()))

  return (
    <>
      <div style={{ marginBottom: 10 }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← Back to My Assignments</button>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h2 style={{ fontSize: 17, fontWeight: 800 }}>Case {c.case_number || a.case_id} — {a.eval_type || 'Evaluation'}</h2>
            <div style={{ fontSize: 13, color: '#888', marginTop: 3 }}>
              {c.Language || ''} · Due: <strong style={dueColor(a.report_due_date)}>{fmtDate(a.report_due_date)}</strong>
            </div>
          </div>
          <Badge status={showStatus(status)} />
        </div>
      </div>

      {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}

      {acceptance === 'pending' && (
        <div className="card" style={{ border: '2px solid #ffc107', marginBottom: 14, background: '#fffbeb' }}>
          <div className="card-title">⚠️ Response Required — do you accept this assignment?</div>
          <div style={{ fontSize: 13, color: '#555', marginBottom: 10 }}>
            Please accept or decline within 3 days. If you decline, the case will be reassigned.
          </div>
          {!declining ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" disabled={busy} onClick={() => respond('accept')}>✅ Accept Assignment</button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setDeclining(true)}>Decline…</button>
            </div>
          ) : (
            <div>
              <div className="form-group">
                <label>Reason for Declining</label>
                <textarea value={declineReason} onChange={e => setDeclineReason(e.target.value)}
                  placeholder="e.g. schedule conflict, distance, language mismatch…" />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary" disabled={busy} onClick={() => respond('decline')}>Confirm Decline</button>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setDeclining(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
      {acceptance === 'declined' && (
        <div className="alert alert-danger">You declined this assignment{a.decline_reason ? ` — "${a.decline_reason}"` : ''}. The office will reassign it.</div>
      )}

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card">
            <div className="card-title">📋 Case Information</div>
            <div className="meta-grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Meta k="Student" v={c.Student_name} />
              <Meta k="Grade" v={c['grade level']} />
              <Meta k="Language" v={c.Language} />
              <Meta k="DOB" v={c.student_dob ? fmtDate(c.student_dob) : null} />
              <Meta k="District" v={c.School_district} />
              <Meta k="County" v={c.County} />
              <Meta k="Report Due" v={fmtDate(a.report_due_date)} style={dueColor(a.report_due_date)} />
              <Meta k="Case Manager" v={c.case_manager_name} />
            </div>
            {c.referral_file_path && (
              <div className="alert alert-info" style={{ marginTop: 12, marginBottom: 0 }}>
                📎 <span>Original referral form: <span className="tbl-link" onClick={viewReferral}>{c.referral_file_name || 'View'}</span> — open it to verify the case details.</span>
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-title">👪 Parent / Guardian Contact</div>
            <div className="meta-grid" style={{ gridTemplateColumns: '1fr', gap: 8 }}>
              <Meta k="Parent Name" v={c.parents_name} />
              <Meta k="Phone" v={c.parents_phone ? String(c.parents_phone) : null} />
              <Meta k="Email" v={c.parents_email} />
              <Meta k="Home Address" v={c.home_address} />
            </div>
            <div className="privacy-note" style={{ marginTop: 10 }}>🔒 Confidential student record — do not share outside this evaluation.</div>
          </div>

          <div className="card">
            <div className="card-title">🧪 Requested Testing Materials</div>
            <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{c.testing_materials || 'See referral — contact office if unclear.'}</div>
            {c.reason_for_referral && (
              <>
                <div className="card-title" style={{ marginTop: 14 }}>Reason for Referral</div>
                <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{c.reason_for_referral}</div>
              </>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card" style={{ border: '2px solid var(--accent)' }}>
            <div className="card-title">✏️ Update Status &amp; Schedule</div>
            <div className="form-group">
              <label>Current Status</label>
              <select value={status} onChange={e => setStatus(e.target.value)}>
                {STATUSES.map(s => <option key={s} value={s}>{showStatus(s)}</option>)}
                {!STATUSES.some(s => s.toLowerCase() === (status || '').toLowerCase()) && <option value={status}>{status}</option>}
              </select>
            </div>
            <div className="form-group">
              <label>Testing Date <span style={{ color: 'var(--red)' }}>*</span></label>
              <input type="date" value={testingDate} onChange={e => setTestingDate(e.target.value)} required />
              <div style={{ fontSize: 11, color: '#888', marginTop: 3 }}>Required before you can submit your report.</div>
            </div>
            <div className="form-group">
              <label>Notes</label>
              <textarea placeholder="Scheduling notes, parent contact attempts, etc." value={notes} onChange={e => setNotes(e.target.value)} />
            </div>
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => save()}>💾 Save</button>
            <div style={{ marginTop: 8, fontSize: 11, color: '#888' }}>Progress: step {stepIndex + 1} of {STATUSES.length} ({showStatus(STATUSES[stepIndex])})</div>
          </div>

          <div className="card">
            <div className="card-title">📤 Upload Completed Report(s)</div>
            <label className="upload-zone" style={{ display: 'block' }}>
              <div style={{ fontSize: 24, marginBottom: 6 }}>📄</div>
              <div><strong>Click to choose one or more files</strong></div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>DOCX preferred · PDF accepted · Max 50 MB each · You can select multiple files at once</div>
              <input type="file" accept=".pdf,.doc,.docx" multiple style={{ display: 'none' }}
                onChange={e => uploadReports(e.target.files)} disabled={busy} />
            </label>
            <div style={{ marginTop: 8, fontSize: 12, color: '#888' }}>
              {reportFiles.length
                ? <>
                    <div style={{ marginBottom: 4 }}>Uploaded {reportFiles.length} file{reportFiles.length === 1 ? '' : 's'}:</div>
                    {reportFiles.map(f => (
                      <div key={f.path} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className="tbl-link" onClick={() => viewReport(f.path)}>📄 {f.name || f.path.split('/').pop()}</span>
                        <span className="tbl-link" style={{ color: 'var(--red)', fontSize: 12 }} onClick={() => deleteReportFile(f)}>✕ remove</span>
                      </div>
                    ))}
                    <div style={{ marginTop: 4 }}>Uploading more adds to this list (a file with the same name replaces the old one).</div>
                  </>
                : 'No report uploaded yet. Uploading marks this assignment as Submitted.'}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function Profile({ contractor }) {
  const [phone, setPhone] = useState(contractor.phone || '')
  const [address, setAddress] = useState(contractor.address || '')
  const [msg, setMsg] = useState(null)
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [pwMsg, setPwMsg] = useState(null)
  const [pwBusy, setPwBusy] = useState(false)

  async function save() {
    const { error } = await supabase.from('Contractors')
      .update({ phone: phone || null, address: address || null })
      .eq('identifier', contractor.identifier)
    setMsg(error ? { kind: 'danger', text: error.message } : { kind: 'success', text: 'Profile updated.' })
  }

  async function changePassword() {
    if (pw1.length < 6) { setPwMsg({ kind: 'warn', text: 'Password must be at least 6 characters.' }); return }
    if (pw1 !== pw2) { setPwMsg({ kind: 'warn', text: 'The two passwords do not match.' }); return }
    setPwBusy(true); setPwMsg(null)
    const { error } = await supabase.auth.updateUser({ password: pw1 })
    if (error) setPwMsg({ kind: 'danger', text: error.message })
    else { setPwMsg({ kind: 'success', text: 'Password changed. Use it next time you log in.' }); setPw1(''); setPw2('') }
    setPwBusy(false)
  }

  return (
    <div className="card" style={{ maxWidth: 520 }}>
      <div className="card-title">My Profile</div>
      {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}
      <div className="meta-grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
        <Meta k="Name" v={contractor.name} />
        <Meta k="Email" v={contractor.email} />
        <Meta k="Field" v={contractor.field} />
        <Meta k="Languages" v={[contractor.language, contractor.language_2].filter(Boolean).join(', ')} />
        <Meta k="County" v={contractor.county} />
        <Meta k="Rate" v={contractor.current_rate} />
        <Meta k="W-9 on file" v={contractor.w9_on_file ? '✓ Yes' : 'No — contact office'} />
        <Meta k="Background check" v={contractor.criminal_history_done ? '✓ Complete' : 'Pending'} />
      </div>
      <div className="form-group"><label>Phone</label><input value={phone} onChange={e => setPhone(e.target.value)} /></div>
      <div className="form-group"><label>Mailing Address</label><input value={address} onChange={e => setAddress(e.target.value)} /></div>
      <button className="btn btn-primary" onClick={save}>Save Changes</button>
      <div style={{ marginTop: 10, fontSize: 12, color: '#888' }}>To change your name, rate, or credentials on file, contact the office.</div>

      <div style={{ borderTop: '1px solid #e5e7eb', marginTop: 18, paddingTop: 14 }}>
        <div className="card-title" style={{ marginBottom: 8 }}>🔒 Change Password</div>
        {pwMsg && <div className={`alert alert-${pwMsg.kind}`}>{pwMsg.text}</div>}
        <div className="form-group"><label>New Password</label>
          <input type="password" value={pw1} onChange={e => setPw1(e.target.value)} autoComplete="new-password" placeholder="At least 6 characters" />
        </div>
        <div className="form-group"><label>Confirm New Password</label>
          <input type="password" value={pw2} onChange={e => setPw2(e.target.value)} autoComplete="new-password" />
        </div>
        <button className="btn btn-secondary" disabled={pwBusy} onClick={changePassword}>{pwBusy ? 'Saving…' : 'Update Password'}</button>
        <div style={{ marginTop: 8, fontSize: 12, color: '#888' }}>If the office gave you a temporary password, set your own here.</div>
      </div>
    </div>
  )
}

function Earnings({ earnings, assignments, contractor }) {
  const byAssignment = new Map(assignments.map(a => [a.id, a]))
  const pending = earnings.filter(e => e.status !== 'paid').reduce((n, e) => n + Number(e.amount || 0), 0)
  const paid = earnings.filter(e => e.status === 'paid').reduce((n, e) => n + Number(e.amount || 0), 0)
  const submittedAwaitingQa = assignments.filter(a => a.submitted_at && !earnings.some(e => e.assignment_id === a.id))

  return (
    <>
      <div className="stat-grid stat-grid-3">
        <div className="stat-card"><div className="num" style={{ color: 'var(--yellow)' }}>${pending.toLocaleString()}</div><div className="lbl">Pending / Approved</div></div>
        <div className="stat-card"><div className="num" style={{ color: 'var(--green)' }}>${paid.toLocaleString()}</div><div className="lbl">Paid to Date</div></div>
        <div className="stat-card"><div className="num">{contractor.current_rate || '—'}</div><div className="lbl">Rate on File</div></div>
      </div>
      <div className="alert alert-info">💵 Earnings are created when your submitted report passes review, and are paid in the monthly batch at the end of each month after client invoice collection.</div>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-title">Earnings</div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Case</th><th>Eval Type</th><th>Date</th><th>Amount</th><th>Status</th><th>Payout Batch</th></tr></thead>
            <tbody>
              {earnings.length === 0 && <tr><td colSpan={6} style={{ color: '#888' }}>No approved earnings yet. Earnings appear after your submitted reports pass review.</td></tr>}
              {earnings.map(e => {
                const a = byAssignment.get(e.assignment_id)
                return (
                  <tr key={e.id}>
                    <td>{a?.Cases?.case_number || '—'}</td>
                    <td>{a?.eval_type || '—'}</td>
                    <td>{fmtDate(e.billable_date)}</td>
                    <td style={{ fontWeight: 700 }}>${Number(e.amount || 0).toLocaleString()}</td>
                    <td><Badge status={e.status} /></td>
                    <td>{e.payment_batches ? `${e.payment_batches.batch_month} (${e.payment_batches.status})` : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
      {submittedAwaitingQa.length > 0 && (
        <div className="card">
          <div className="card-title">Submitted — awaiting review ({submittedAwaitingQa.length})</div>
          <div style={{ fontSize: 13, color: '#555' }}>
            {submittedAwaitingQa.map(a => `${a.Cases?.case_number || a.case_id} (${a.eval_type || '—'})`).join(', ')}
          </div>
        </div>
      )}
    </>
  )
}

function Help() {
  const faqs = [
    ['How do I set my testing date?', 'Open the case from My Assignments, fill in the Testing Date field, and click Save.'],
    ['When will I get paid?', 'Payroll runs on the last business day of each month for all evaluations submitted that month, after district invoices are collected.'],
    ['What file format should I upload?', 'Please upload your report as a DOCX (Word) file. PDF is accepted, but DOCX allows the admin team to apply letterhead and make corrections before delivery to the district.'],
    ['I finished testing — what now?', 'Update the status to "Testing Completed", then to "Draft Report" while writing. When your report is final, upload it — that automatically marks the assignment Submitted.'],
  ]
  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <div className="card-title">❓ Help &amp; Support</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, color: '#555' }}>
        {faqs.map(([q, a]) => (
          <div key={q} style={{ padding: 10, background: '#f9f9f9', borderRadius: 5, border: '1px solid #eee' }}>
            <strong>{q}</strong><p style={{ marginTop: 4 }}>{a}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
