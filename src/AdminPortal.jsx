import { Fragment, useEffect, useMemo, useState } from 'react'
import { supabase, fetchAll, STATUSES, fmtDate, daysLeft, dueColor, parseRate, toISODate } from './supabase.js'
import { Shell, Badge, StatCard, Meta } from './ui.jsx'
import { generateInvoiceDoc, RATE_PER_EVAL } from './invoice.js'
import { scoreContractors } from './smartAssign.js'
import { extractTextFromFile } from './extractDocumentText.js'
import { exportCasesToExcel } from './exportExcel.js'
import { zipSync } from 'fflate'

const EVAL_TYPES = ['Speech', 'Educational', 'Psych', 'Social', 'OT', 'PT']
const CASE_STATUSES = ['Unassigned', 'Assigned', 'In Progress', 'Report Submitted', 'Pending Approval', 'Completed']
const GRADES = ['Pre-K', 'K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']

// Canonical picklists for the contractor editor
const CONTRACTOR_FIELDS = ['Speech Pathologist', 'Psychologist', 'Learning Consultant', 'Social Worker', 'Occupational Therapist', 'Physical Therapist', 'Translator', 'Interpreter']
const LANGUAGES = ['English', 'Spanish', 'Portuguese', 'Arabic', 'Creole', 'Russian', 'Chinese', 'Mandarin', 'Cantonese', 'Hebrew', 'Polish', 'Korean', 'Italian', 'French', 'Turkish', 'Vietnamese', 'Urdu', 'Hindi', 'Punjabi', 'Gujarati', 'Bengali', 'Tamil', 'Telugu', 'Marathi', 'Malayalam', 'Kannada', 'Tagalog', 'Japanese', 'Ukrainian', 'Persian', 'Greek', 'Indonesian']

// Dropdown that preserves an existing non-standard value as a selectable option so edits never silently drop it
function ChoiceSelect({ value, options, onChange }) {
  const list = (!value || options.includes(value)) ? options : [value, ...options]
  return (
    <select value={value || ''} onChange={e => onChange(e.target.value)}>
      <option value="">— Select —</option>
      {list.map(o => <option key={o} value={o}>{options.includes(o) ? o : `${o} (existing)`}</option>)}
    </select>
  )
}

// Per-eval-type status. An evaluation is "Completed" only once its report is approved
// (which creates a contractor_earnings row → its id is in completedSet).
function evalTypeStatus(a, completedSet) {
  if (!a || a.contractor_id == null) return { label: 'Unassigned', cls: 's-unassigned' }
  if (completedSet.has(a.id)) return { label: 'Completed', cls: 's-completed' }
  const acc = (a.acceptance_status || 'pending').toLowerCase()
  if (acc === 'declined') return { label: 'Declined', cls: 's-overdue' }
  if (acc === 'pending') return { label: 'Pending Approval', cls: 's-scheduled' }  // assigned, awaiting the evaluator's acceptance
  const s = (a.status || '').toLowerCase()
  if (s === 'submitted') return { label: 'Under Review', cls: 's-drafting' }        // accepted + report submitted, awaiting admin QA
  return { label: 'In Progress', cls: 's-drafting' }                                 // accepted, working on it (purple)
}

// Build one expanded sub-row per requested eval type: matched assignment (evaluator + status) or Unassigned
function buildEvalBreakdown(caseRow, asgs, completedSet) {
  const requested = (caseRow.evaluation_type || '').split(',').map(t => t.trim()).filter(Boolean)
  const rows = []
  const covered = new Set()
  for (const a of asgs) {
    rows.push({ evalType: a.eval_type || '—', evaluator: a.Contractors?.name || null, status: evalTypeStatus(a, completedSet), a })
    if (a.eval_type) covered.add(a.eval_type.toLowerCase())
  }
  for (const t of requested) {
    if (!covered.has(t.toLowerCase())) rows.push({ evalType: t, evaluator: null, status: { label: 'Unassigned', cls: 's-unassigned' }, a: null })
  }
  return rows
}

// A case is truly complete only when every requested eval type is assigned AND every
// assignment's evaluation is approved/completed.
function caseFullyComplete(caseRow, asgs, completedSet) {
  if (!asgs.length) return false
  const requested = (caseRow.evaluation_type || '').split(',').map(t => t.trim()).filter(Boolean)
  const covered = new Set(asgs.map(a => (a.eval_type || '').toLowerCase()))
  const allAssigned = requested.every(t => covered.has(t.toLowerCase()))
  return allAssigned && asgs.every(a => completedSet.has(a.id))
}

// Shows whether the contractor has accepted/declined an assignment
function AcceptBadge({ status }) {
  const s = (status || 'pending').toLowerCase()
  if (s === 'accepted') return <span className="badge-s s-completed">✓ Accepted</span>
  if (s === 'declined') return <span className="badge-s s-overdue">✕ Declined</span>
  return <span className="badge-s s-pending">Awaiting</span>
}

export default function AdminPortal({ user }) {
  const [screen, setScreen] = useState('dashboard')
  const [cases, setCases] = useState([])
  const [assignments, setAssignments] = useState([])
  const [contractors, setContractors] = useState([])
  const [invoices, setInvoices] = useState([])
  const [qaReviews, setQaReviews] = useState([])
  const [earnings, setEarnings] = useState([])
  const [batches, setBatches] = useState([])
  const [emailLog, setEmailLog] = useState([])
  const [selectedCase, setSelectedCase] = useState(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    const [c, a, k, i, q, e, b, m] = await Promise.all([
      fetchAll(() => supabase.from('Cases').select('*').order('id', { ascending: false })),
      fetchAll(() => supabase.from('Assignments').select('*, Contractors(identifier, name, current_rate, email), Cases(id, case_number, Student_name, School_district, Language, County)').order('report_due_date', { ascending: true, nullsFirst: false }).order('id')),
      fetchAll(() => supabase.from('Contractors').select('*').order('name').order('identifier')),
      fetchAll(() => supabase.from('Invoices').select('*').order('id', { ascending: false })),
      fetchAll(() => supabase.from('qa_reviews').select('*').order('assignment_id')),
      fetchAll(() => supabase.from('contractor_earnings').select('*').order('id')),
      fetchAll(() => supabase.from('payment_batches').select('*').order('id', { ascending: false })),
      fetchAll(() => supabase.from('email_log').select('*').order('sent_at', { ascending: false })),
    ])
    setCases(c.data || []); setAssignments(a.data || []); setContractors(k.data || []); setInvoices(i.data || [])
    setQaReviews(q.data || []); setEarnings(e.data || []); setBatches(b.data || []); setEmailLog(m.data || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const openAssignments = assignments.filter(x => (x.status || '').toLowerCase() !== 'submitted')
  const dueThisWeek = openAssignments.filter(x => { const n = daysLeft(x.report_due_date); return n !== null && n <= 7 })
  const qaByAssignment = useMemo(() => new Map(qaReviews.map(q => [q.assignment_id, q])), [qaReviews])
  const awaitingQa = assignments.filter(a => a.submitted_at && qaByAssignment.get(a.id)?.qa_status !== 'approved')

  const nav = [
    { label: 'Operations', items: [
      { id: 'dashboard', icon: '📊', label: 'Dashboard' },
      { id: 'referral', icon: '📥', label: 'New Referral' },
      { id: 'cases', icon: '📋', label: 'Cases', badge: dueThisWeek.length || null },
      { id: 'contractors', icon: '👥', label: 'Contractors' },
    ]},
    { label: 'Documents & Finance', items: [
      { id: 'qa', icon: '🔍', label: 'Report Review', badge: awaitingQa.length || null },
      { id: 'invoices', icon: '🧾', label: 'Client Invoices' },
      { id: 'payroll', icon: '💰', label: 'Payroll' },
    ]},
    { label: 'Monitoring', items: [
      { id: 'due', icon: '⏰', label: 'Due Date Monitor' },
      { id: 'emaillog', icon: '📧', label: 'Email Log' },
    ]},
  ]

  const titles = { dashboard: 'Dashboard', referral: 'New Referral Intake', cases: 'Cases', casedetail: 'Case Detail', contractors: 'Contractors', qa: 'Report Review & QA', invoices: 'Client Invoices', payroll: 'Payroll & Payment Batches', due: 'Due Date Monitor', emaillog: 'Email Log' }

  return (
    <Shell brand="BEval Portal" sub="Admin / Coordinator"
      userName={user.email} userRole="Administrator"
      navSections={nav} active={screen === 'casedetail' ? 'cases' : screen}
      onNav={id => { setScreen(id); setSelectedCase(null) }}
      onLogout={() => supabase.auth.signOut()}
      title={titles[screen]}
      topbarExtra={<button className="btn btn-primary btn-sm" onClick={() => setScreen('referral')}>+ New Referral</button>}>

      {screen === 'dashboard' && <Dashboard assignments={assignments} openAssignments={openAssignments} dueThisWeek={dueThisWeek} loading={loading}
        onOpenCase={c => { setSelectedCase(c); setScreen('casedetail') }} cases={cases} earnings={earnings} />}
      {screen === 'referral' && <NewReferral onCreated={c => { load(); setSelectedCase(c); setScreen('casedetail') }} />}
      {screen === 'cases' && <CaseList cases={cases} assignments={assignments} contractors={contractors} earnings={earnings} loading={loading}
        onOpen={c => { setSelectedCase(c); setScreen('casedetail') }} onChanged={load} />}
      {screen === 'casedetail' && selectedCase && <CaseDetail caseRow={selectedCase} assignments={assignments.filter(a => a.case_id === selectedCase.id)}
        allAssignments={assignments} contractors={contractors} onBack={() => setScreen('cases')} onChanged={load} />}
      {screen === 'contractors' && <ContractorList contractors={contractors} assignments={assignments} onChanged={load} />}
      {screen === 'qa' && <QaQueue assignments={assignments} qaByAssignment={qaByAssignment} earnings={earnings} onChanged={load} />}
      {screen === 'invoices' && <InvoiceList invoices={invoices} cases={cases} onChanged={load} />}
      {screen === 'payroll' && <Payroll assignments={assignments} earnings={earnings} batches={batches} contractors={contractors} onChanged={load} />}
      {screen === 'due' && <DueMonitor assignments={openAssignments} onOpenCase={id => { const c = cases.find(x => x.id === id); if (c) { setSelectedCase(c); setScreen('casedetail') } }} />}
      {screen === 'emaillog' && <EmailLog emailLog={emailLog} assignments={assignments} onChanged={load} />}
    </Shell>
  )
}

function Dashboard({ assignments, openAssignments, dueThisWeek, cases, loading, onOpenCase, earnings = [] }) {
  const now = new Date().toISOString().slice(0, 7)
  const completedThisMonth = assignments.filter(a => (a.submitted_at || '').slice(0, 7) === now).length
  const awaiting = openAssignments.filter(a => /testing complet|draft/i.test(a.status || '')).length
  const overdue = openAssignments.filter(a => { const n = daysLeft(a.report_due_date); return n !== null && n < 0 })

  const [expanded, setExpanded] = useState({})
  const toggle = name => setExpanded(p => ({ ...p, [name]: !p[name] }))
  const completedSet = useMemo(() => new Set((earnings || []).map(e => e.assignment_id)), [earnings])
  const statusBadge = (a) => { const s = evalTypeStatus(a, completedSet); return <span className={`badge-s ${s.cls}`}>{s.label}</span> }
  const openCaseById = id => { const c = cases.find(x => x.id === id); if (c) onOpenCase(c) }

  // One row per unique student; students with multiple open evaluations expand to show each
  const studentGroups = useMemo(() => {
    const out = []
    const idx = new Map()
    for (const a of openAssignments) {
      const name = a.Cases?.Student_name || '(Unknown student)'
      let g = idx.get(name)
      if (!g) { g = { name, items: [] }; idx.set(name, g); out.push(g) }
      g.items.push(a)
    }
    for (const g of out) g.items.sort((x, y) => (x.report_due_date || '9999').localeCompare(y.report_due_date || '9999'))
    out.sort((a, b) => (a.items[0]?.report_due_date || '9999').localeCompare(b.items[0]?.report_due_date || '9999'))
    return out
  }, [openAssignments])

  return (
    <>
      {overdue.length > 0 && <div className="alert alert-danger">⚠️ <span><strong>{overdue.length} assignment{overdue.length > 1 ? 's are' : ' is'} past due.</strong> Check the Due Date Monitor.</span></div>}
      <div className="stat-grid stat-grid-4">
        <StatCard num={dueThisWeek.length} label="Due This Week" color="blue" />
        <StatCard num={openAssignments.length} label="Open Assignments" color="yellow" />
        <StatCard num={completedThisMonth} label="Submitted This Month" color="green" />
        <StatCard num={awaiting} label="Awaiting Reports" color="orange" />
      </div>
      <div className="card">
        <div className="card-title">Upcoming Due Dates</div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Case #</th><th>Student</th><th>Evaluation</th><th>Contractor</th><th>Due Date</th><th>Days Left</th><th>Status</th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={7} style={{ color: '#888' }}>Loading…</td></tr>}
              {!loading && studentGroups.length === 0 && <tr><td colSpan={7} style={{ color: '#888' }}>No open assignments.</td></tr>}
              {studentGroups.slice(0, 15).map(g => {
                if (g.items.length === 1) {
                  const a = g.items[0]
                  return (
                    <tr key={g.name}>
                      <td><span className="tbl-link" onClick={() => openCaseById(a.case_id)}>{a.Cases?.case_number || a.case_id}</span></td>
                      <td style={{ fontWeight: 600 }}>{g.name}</td>
                      <td>{a.eval_type || '—'}</td>
                      <td>{a.Contractors?.name || <span className="badge-s s-unassigned">Unassigned</span>}</td>
                      <td style={dueColor(a.report_due_date)}>{fmtDate(a.report_due_date)}</td>
                      <td style={dueColor(a.report_due_date)}>{daysLeft(a.report_due_date) ?? '—'}</td>
                      <td>{statusBadge(a)}</td>
                    </tr>
                  )
                }
                const nearest = g.items[0]
                const groupPending = g.items.some(a => a.contractor_id != null && (a.acceptance_status || 'pending').toLowerCase() === 'pending')
                const sameCase = g.items.every(x => x.case_id === g.items[0].case_id) ? g.items[0] : null
                return (
                  <Fragment key={g.name}>
                    <tr style={{ cursor: 'pointer' }} onClick={() => toggle(g.name)}>
                      <td>{sameCase ? <span className="tbl-link" onClick={e => { e.stopPropagation(); openCaseById(sameCase.case_id) }}>{sameCase.Cases?.case_number || sameCase.case_id}</span> : '—'}</td>
                      <td style={{ fontWeight: 600 }}>{g.name}</td>
                      <td><span className="tbl-link"><span style={{ display: 'inline-block', width: 12 }}>{expanded[g.name] ? '▾' : '▸'}</span>{g.items.length} evaluations</span></td>
                      <td>—</td>
                      <td style={dueColor(nearest.report_due_date)}>{fmtDate(nearest.report_due_date)}</td>
                      <td style={dueColor(nearest.report_due_date)}>{daysLeft(nearest.report_due_date) ?? '—'}</td>
                      <td>{groupPending ? <span className="badge-s s-scheduled">Pending Approval</span> : <span className="badge-s s-drafting">In Progress</span>}</td>
                    </tr>
                    {expanded[g.name] && g.items.map(a => (
                      <tr key={a.id} style={{ background: '#f8fafc' }}>
                        <td></td>
                        <td></td>
                        <td style={{ paddingLeft: 24 }}><span className="tbl-link" onClick={() => openCaseById(a.case_id)}>↳ {a.Cases?.case_number || a.case_id} · {a.eval_type || '—'}</span></td>
                        <td>{a.Contractors?.name || <span className="badge-s s-unassigned">Unassigned</span>}</td>
                        <td style={dueColor(a.report_due_date)}>{fmtDate(a.report_due_date)}</td>
                        <td style={dueColor(a.report_due_date)}>{daysLeft(a.report_due_date) ?? '—'}</td>
                        <td>{statusBadge(a)}</td>
                      </tr>
                    ))}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

// Base64-encode a byte array in chunks (btoa on a huge binary string overflows the stack)
function bytesToBase64(bytes) {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(bin)
}

function NewReferral({ onCreated }) {
  const empty = {
    Student_name: '', student_dob: '', grade: '', Language: '', School_district: '', County: '',
    district_contact: '', case_manager_name: '', case_manager_email: '', case_manager_phone: '', parents_name: '',
    parents_phone: '', parents_email: '', home_address: '', evaluation_type: '', testing_materials: '',
    reason_for_referral: '', Report_Due_date: '', referral_source: '',
  }
  const [f, setF] = useState(empty)
  const [evalTypes, setEvalTypes] = useState([])
  const [msg, setMsg] = useState(null)
  const [parsing, setParsing] = useState(false)
  const [parsedFrom, setParsedFrom] = useState(null)
  const [referralFile, setReferralFile] = useState(null)  // original uploaded form, stored on create
  const [dragActive, setDragActive] = useState(false)
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }))

  async function create() {
    if (!f.Student_name || !f.School_district || !f.Report_Due_date) {
      setMsg({ kind: 'warn', text: 'Student name, district, and report due date are required.' }); return
    }
    setBusy(true); setMsg(null)
    // case_number is assigned automatically by the set_case_number trigger
    const phoneDigits = f.parents_phone.replace(/\D/g, '')
    const row = {
      Student_name: f.Student_name || null,
      student_dob: f.student_dob || null,
      'grade level': f.grade || null,
      Language: f.Language || null,
      School_district: f.School_district || null,
      County: f.County || null,
      district_contact: f.district_contact || null,
      case_manager_name: f.case_manager_name || null,
      case_manager_email: f.case_manager_email || null,
      case_manager_phone: f.case_manager_phone || null,
      parents_name: f.parents_name || null,
      parents_phone: phoneDigits ? Number(phoneDigits) : null,
      parents_email: f.parents_email || null,
      home_address: f.home_address || null,
      evaluation_type: evalTypes.join(', ') || null,
      testing_materials: f.testing_materials || null,
      reason_for_referral: f.reason_for_referral || null,
      Report_Due_date: f.Report_Due_date || null,
      referral_source: f.referral_source || null,
      Status: 'Unassigned',
      created_date: new Date().toISOString().slice(0, 10),
    }
    const { data, error } = await supabase.from('Cases').insert(row).select().single()
    if (error) { setMsg({ kind: 'danger', text: error.message }); setBusy(false); return }

    // Store the original referral form so admins and contractors can proofread it.
    // Non-blocking: if the upload fails, the case is still created.
    if (referralFile) {
      const path = `${data.id}/${referralFile.name}`
      const { error: upErr } = await supabase.storage.from('referrals').upload(path, referralFile, { upsert: true })
      if (!upErr) {
        await supabase.from('Cases').update({ referral_file_path: path, referral_file_name: referralFile.name }).eq('id', data.id)
        data.referral_file_path = path; data.referral_file_name = referralFile.name
      }
    }
    onCreated(data)
    setBusy(false)
  }

  // Grade values coming back from the parser may be "3" or "3rd" — map to our options
  function normalizeGrade(g) {
    if (g === null || g === undefined || g === '') return ''
    const s = String(g).trim()
    const options = ['Pre-K', 'K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']
    if (options.includes(s)) return s
    if (/pre.?k/i.test(s)) return 'Pre-K'
    if (/^k/i.test(s)) return 'K'
    const m = s.match(/\d+/)
    return m && options.includes(m[0]) ? m[0] : ''
  }

  async function parseDocument(file) {
    if (!file) return
    setReferralFile(file)   // keep the original so it can be stored on the case for proofreading
    setParsing(true); setMsg(null); setParsedFrom(null)
    const ext = file.name.split('.').pop()?.toLowerCase()
    let text = ''
    try {
      text = await extractTextFromFile(file)
    } catch (err) {
      // A scanned PDF may throw or return nothing here — we can still OCR it below.
      if (ext !== 'pdf') { setMsg({ kind: 'danger', text: err.message }); setParsing(false); return }
    }

    let invokeBody
    if (text && text.trim().length >= 20) {
      invokeBody = { text }
    } else if (ext === 'pdf') {
      // No embedded text (scanned/image PDF) — send the PDF itself for AI OCR.
      setMsg({ kind: 'info', text: 'No text layer found — reading the scanned document with AI. This can take a little longer…' })
      try {
        const buf = await file.arrayBuffer()
        invokeBody = { pdf_base64: bytesToBase64(new Uint8Array(buf)) }
      } catch (err) {
        setMsg({ kind: 'danger', text: `Could not read the PDF: ${err.message}` }); setParsing(false); return
      }
    } else {
      setMsg({ kind: 'warn', text: 'Could not read any text from that file. Please enter the fields manually.' })
      setParsing(false); return
    }

    const { data, error } = await supabase.functions.invoke('parse-referral', { body: invokeBody })
    if (error || !data?.success) {
      setMsg({ kind: 'danger', text: `Could not parse the document: ${data?.error || error?.message || 'unknown error'}` })
      setParsing(false); return
    }

    const p = data.fields || {}
    // Only fill fields the parser actually found; leave the rest for manual entry
    setF(prev => ({
      ...prev,
      Student_name: p.Student_name ?? prev.Student_name,
      student_dob: p.student_dob ?? prev.student_dob,
      grade: p.grade_level != null ? normalizeGrade(p.grade_level) : prev.grade,
      Language: p.Language ?? prev.Language,
      School_district: p.School_district ?? prev.School_district,
      County: p.County ?? prev.County,
      district_contact: p.district_contact ?? prev.district_contact,
      case_manager_name: p.case_manager_name ?? prev.case_manager_name,
      case_manager_email: p.case_manager_email ?? prev.case_manager_email,
      case_manager_phone: p.case_manager_phone ?? prev.case_manager_phone,
      parents_name: p.parents_name ?? prev.parents_name,
      parents_phone: p.parents_phone ?? prev.parents_phone,
      parents_email: p.parents_email ?? prev.parents_email,
      home_address: p.home_address ?? prev.home_address,
      testing_materials: p.testing_materials ?? prev.testing_materials,
      reason_for_referral: p.reason_for_referral ?? prev.reason_for_referral,
      Report_Due_date: p.Report_Due_date ? toISODate(p.Report_Due_date) : prev.Report_Due_date,
      referral_source: p.referral_source ?? prev.referral_source,
    }))
    if (Array.isArray(p.evaluation_types) && p.evaluation_types.length) {
      const map = { Psych: 'Psych', Ed: 'Educational', Speech: 'Speech', Social: 'Social', OT: 'OT', PT: 'PT' }
      setEvalTypes(p.evaluation_types.map(t => map[t]).filter(Boolean))
    }
    setParsedFrom(file.name)
    setParsing(false)
  }

  const SectionHead = ({ children }) => (
    <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--accent)', margin: '14px 0 8px', paddingBottom: 5, borderBottom: '1px solid #e5e7eb', textTransform: 'uppercase', letterSpacing: '.05em' }}>{children}</div>
  )

  return (
    <div className="card" style={{ maxWidth: 720 }}>
      <div className="card-title">📥 New Referral Intake</div>
      {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}
      <div className="alert alert-info">A case number is assigned automatically. After creating the case you can assign contractors.</div>

      <label className="upload-zone"
        style={{
          display: 'block', marginBottom: 14, opacity: parsing ? 0.6 : 1,
          cursor: parsing ? 'default' : 'pointer',
          borderColor: dragActive ? 'var(--accent)' : undefined,
          background: dragActive ? 'var(--accent-light)' : undefined,
        }}
        onDragEnter={e => { e.preventDefault(); e.stopPropagation(); if (!parsing) setDragActive(true) }}
        onDragOver={e => { e.preventDefault(); e.stopPropagation(); if (!parsing) setDragActive(true) }}
        onDragLeave={e => { e.preventDefault(); e.stopPropagation(); setDragActive(false) }}
        onDrop={e => {
          e.preventDefault(); e.stopPropagation(); setDragActive(false)
          if (parsing) return
          const file = e.dataTransfer?.files?.[0]
          if (file) parseDocument(file)
        }}>
        <div style={{ fontSize: 22, marginBottom: 4, pointerEvents: 'none' }}>📄</div>
        <div style={{ pointerEvents: 'none' }}>
          <strong>{parsing ? 'Reading document…' : dragActive ? 'Drop the referral to read it' : 'Drag & drop or click to auto-fill from a referral form'}</strong>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, pointerEvents: 'none' }}>
          PDF or Word (.docx) — fields below fill in automatically. Review before creating.
        </div>
        <input type="file" accept=".pdf,.docx" style={{ display: 'none' }} disabled={parsing}
          onChange={e => { parseDocument(e.target.files[0]); e.target.value = '' }} />
      </label>
      {parsedFrom && (
        <div className="alert alert-success">✅ Filled from <strong>{parsedFrom}</strong>. Please review every field — especially dates and testing materials — before creating the case.</div>
      )}

      <SectionHead>District Information</SectionHead>
      <div className="form-row">
        <div className="form-group"><label>District Name *</label><input value={f.School_district} onChange={e => set('School_district', e.target.value)} /></div>
        <div className="form-group"><label>County</label><input value={f.County} onChange={e => set('County', e.target.value)} /></div>
      </div>
      <div className="form-row">
        <div className="form-group"><label>District Contact</label><input value={f.district_contact} onChange={e => set('district_contact', e.target.value)} /></div>
        <div className="form-group"><label>Case Manager</label><input value={f.case_manager_name} onChange={e => set('case_manager_name', e.target.value)} /></div>
      </div>
      <div className="form-row">
        <div className="form-group"><label>Case Manager Email</label><input value={f.case_manager_email} onChange={e => set('case_manager_email', e.target.value)} /></div>
        <div className="form-group"><label>Case Manager Phone</label><input value={f.case_manager_phone} onChange={e => set('case_manager_phone', e.target.value)} /></div>
      </div>

      <SectionHead>Student Information</SectionHead>
      <div className="form-row">
        <div className="form-group"><label>Student Name *</label><input value={f.Student_name} onChange={e => set('Student_name', e.target.value)} /></div>
        <div className="form-group"><label>Date of Birth</label><input type="date" value={f.student_dob} onChange={e => set('student_dob', e.target.value)} /></div>
      </div>
      <div className="form-row">
        <div className="form-group"><label>Grade</label>
          <select value={f.grade} onChange={e => set('grade', e.target.value)}>
            <option value="">Select…</option>
            {['Pre-K', 'K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'].map(g => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>
        <div className="form-group"><label>Language(s)</label><input placeholder="e.g. Spanish" value={f.Language} onChange={e => set('Language', e.target.value)} /></div>
      </div>

      <SectionHead>Parent / Guardian</SectionHead>
      <div className="form-row">
        <div className="form-group"><label>Parent Name</label><input value={f.parents_name} onChange={e => set('parents_name', e.target.value)} /></div>
        <div className="form-group"><label>Parent Phone</label><input value={f.parents_phone} onChange={e => set('parents_phone', e.target.value)} /></div>
      </div>
      <div className="form-row">
        <div className="form-group"><label>Parent Email</label><input value={f.parents_email} onChange={e => set('parents_email', e.target.value)} /></div>
        <div className="form-group"><label>Home Address</label><input value={f.home_address} onChange={e => set('home_address', e.target.value)} /></div>
      </div>

      <SectionHead>Evaluation Request</SectionHead>
      <div className="form-group"><label>Evaluation Type(s)</label>
        <div className="check-group" style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {EVAL_TYPES.map(t => (
            <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={evalTypes.includes(t)}
                onChange={e => setEvalTypes(p => e.target.checked ? [...p, t] : p.filter(x => x !== t))} /> {t}
            </label>
          ))}
        </div>
      </div>
      <div className="form-group"><label>Testing Materials Requested</label>
        <textarea rows={3} placeholder="e.g. WISC-V Spanish, CELF-5 Spanish, BESA, Vineland-3…" value={f.testing_materials} onChange={e => set('testing_materials', e.target.value)} />
      </div>
      <div className="form-group"><label>Reason for Referral</label>
        <textarea rows={2} value={f.reason_for_referral} onChange={e => set('reason_for_referral', e.target.value)} />
      </div>
      <div className="form-row">
        <div className="form-group"><label>Report Due Date *</label><input type="date" value={f.Report_Due_date} onChange={e => set('Report_Due_date', e.target.value)} /></div>
        <div className="form-group"><label>Referral Source</label><input value={f.referral_source} onChange={e => set('referral_source', e.target.value)} /></div>
      </div>

      <button className="btn btn-primary" disabled={busy} onClick={create}>✅ Create Case</button>
    </div>
  )
}

function CaseList({ cases, assignments, contractors = [], earnings = [], loading, onOpen, onChanged }) {
  const [q, setQ] = useState('')
  const [chip, setChip] = useState('all')
  const [expanded, setExpanded] = useState({})
  const toggle = id => setExpanded(p => ({ ...p, [id]: !p[id] }))
  const [reassignId, setReassignId] = useState(null)
  const [reassignTo, setReassignTo] = useState('')
  const [confirmRemoveId, setConfirmRemoveId] = useState(null)
  const [rowBusy, setRowBusy] = useState(false)
  const [rowMsg, setRowMsg] = useState(null)

  function startReassign(a) { setReassignId(a.id); setReassignTo(String(a.contractor_id ?? '')); setConfirmRemoveId(null); setRowMsg(null) }

  async function saveReassign(a) {
    if (!reassignTo) { setRowMsg({ kind: 'warn', text: 'Pick a contractor to reassign to.' }); return }
    if (String(reassignTo) === String(a.contractor_id)) { setReassignId(null); return }
    setRowBusy(true); setRowMsg(null)
    const { error } = await supabase.from('Assignments').update({
      contractor_id: Number(reassignTo),
      acceptance_status: 'pending', accepted_at: null, declined_at: null, decline_reason: null, status: 'Assigned',
    }).eq('id', a.id)
    if (error) { setRowMsg({ kind: 'danger', text: error.message }); setRowBusy(false); return }
    let text = 'Assignment reassigned.'
    try {
      const { data: em } = await supabase.functions.invoke('notify-assignment', { body: { assignment_id: a.id } })
      if (em?.success && em.sent_to) text = `Reassigned — notification emailed to ${em.sent_to}.`
      else if (em?.skipped_no_email) text = 'Reassigned. New contractor has no email on file, so no notice was sent.'
    } catch { /* email is best-effort */ }
    setReassignId(null); setRowMsg({ kind: 'success', text }); onChanged && onChanged(); setRowBusy(false)
  }

  async function removeAssignment(a) {
    setRowBusy(true); setRowMsg(null)
    const { error } = await supabase.rpc('admin_delete_assignment', { p_assignment_id: a.id })
    if (error) { setRowMsg({ kind: 'danger', text: error.message }); setRowBusy(false); return }
    setConfirmRemoveId(null); setRowMsg({ kind: 'success', text: 'Assignment removed.' }); onChanged && onChanged(); setRowBusy(false)
  }

  // Remove an unassigned/mistaken evaluation type from the case's requested list
  async function removeEvalType(c, evalType) {
    if (!window.confirm(`Remove "${evalType}" from the requested evaluations on ${c.case_number || c.id}?`)) return
    setRowBusy(true); setRowMsg(null)
    const remaining = (c.evaluation_type || '').split(',').map(t => t.trim()).filter(Boolean)
      .filter(t => t.toLowerCase() !== evalType.toLowerCase())
    const { error } = await supabase.from('Cases').update({ evaluation_type: remaining.join(', ') || null }).eq('id', c.id)
    if (error) setRowMsg({ kind: 'danger', text: error.message })
    else setRowMsg({ kind: 'success', text: `Removed "${evalType}" from ${c.case_number || c.id}.` })
    onChanged && onChanged(); setRowBusy(false)
  }

  const byCase = useMemo(() => {
    const m = {}
    for (const a of assignments) { m[a.case_id] = m[a.case_id] || []; m[a.case_id].push(a) }
    return m
  }, [assignments])
  // Assignment ids whose evaluation has been approved/completed (an earning was created)
  const completedSet = useMemo(() => new Set(earnings.map(e => e.assignment_id)), [earnings])

  // ── Per-column sort + filter ──
  const [sortCol, setSortCol] = useState(null)
  const [sortDir, setSortDir] = useState('asc')
  const [colFilters, setColFilters] = useState({})
  const [colChecks, setColChecks] = useState({})
  const [openMenu, setOpenMenu] = useState(null)
  useEffect(() => {
    if (!openMenu) return
    const h = () => setOpenMenu(null)
    document.addEventListener('click', h)
    return () => document.removeEventListener('click', h)
  }, [openMenu])

  const COLS = [
    ['case_number', 'Case #'], ['Student_name', 'Student'], ['School_district', 'District'],
    ['evaluation_type', 'Eval Types'], ['Report_Due_date', 'Due Date'], ['assignments', 'Assignments'], ['status', 'Status'],
  ]
  // District + Eval Types filter by multi-select checkboxes of the distinct values in the data
  const CHECKBOX_COLS = { School_district: true, evaluation_type: true }
  const districtOptions = useMemo(() => [...new Set(cases.map(c => (c.School_district || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [cases])
  const evalOptions = useMemo(() => {
    const s = new Set()
    for (const c of cases) for (const t of (c.evaluation_type || '').split(',').map(x => x.trim()).filter(Boolean)) s.add(t)
    return [...s].sort((a, b) => a.localeCompare(b))
  }, [cases])
  const optionsFor = key => key === 'School_district' ? districtOptions : evalOptions
  const toggleCheck = (key, val) => setColChecks(p => {
    const cur = new Set(p[key] || [])
    cur.has(val) ? cur.delete(val) : cur.add(val)
    return { ...p, [key]: [...cur] }
  })
  function statusLabel(c, asg) {
    if (caseFullyComplete(c, asg, completedSet)) return 'Completed'
    if ((c.Status || '').toLowerCase() === 'completed') return 'In Progress'
    return c.Status || ''
  }
  function colSortVal(col, c) {
    const asg = byCase[c.id] || []
    switch (col) {
      case 'Report_Due_date': return c.Report_Due_date || ''       // ISO date sorts lexically
      case 'assignments': return asg.length                        // numeric
      case 'status': return statusLabel(c, asg).toLowerCase()
      case 'case_number': return (c.case_number || '').toLowerCase()
      case 'Student_name': return (c.Student_name || '').toLowerCase()
      case 'School_district': return (c.School_district || '').toLowerCase()
      case 'evaluation_type': return (c.evaluation_type || '').toLowerCase()
      default: return ''
    }
  }
  function colFilterVal(col, c) {
    const asg = byCase[c.id] || []
    if (col === 'assignments') return asg.map(a => `${a.eval_type || ''} ${a.Contractors?.name || ''}`).join(' ').toLowerCase()
    if (col === 'Report_Due_date') return `${c.Report_Due_date || ''} ${fmtDate(c.Report_Due_date)}`.toLowerCase()
    return String(colSortVal(col, c)).toLowerCase()
  }

  let rows = cases.filter(c => {
    const asg = byCase[c.id] || []
    // "Done" = every evaluation approved (not merely submitted) — so a case with a
    // submitted-but-unapproved report stays in Active until it's approved/sent.
    const done = caseFullyComplete(c, asg, completedSet)
    if (chip === 'active' && done) return false
    if (chip === 'completed' && !done) return false
    if (chip === 'due') {
      const soon = asg.some(a => { const n = daysLeft(a.report_due_date); return n !== null && n <= 7 && (a.status || '').toLowerCase() !== 'submitted' })
      const caseSoon = (() => { const n = daysLeft(c.Report_Due_date); return n !== null && n <= 7 })()
      if (!soon && !caseSoon) return false
    }
    const hay = `${c.case_number || ''} ${c.Student_name || ''} ${c.School_district || ''} ${c.evaluation_type || ''}`.toLowerCase()
    return hay.includes(q.toLowerCase())
  })
  for (const [key, text] of Object.entries(colFilters)) {
    if (CHECKBOX_COLS[key]) continue
    const t = (text || '').trim().toLowerCase()
    if (t) rows = rows.filter(c => colFilterVal(key, c).includes(t))
  }
  const distSel = colChecks.School_district || []
  if (distSel.length) rows = rows.filter(c => distSel.includes((c.School_district || '').trim()))
  const evalSel = colChecks.evaluation_type || []
  if (evalSel.length) rows = rows.filter(c => {
    const toks = (c.evaluation_type || '').split(',').map(t => t.trim())
    return evalSel.some(v => toks.includes(v))
  })
  if (sortCol) {
    rows = [...rows].sort((a, b) => {
      const va = colSortVal(sortCol, a), vb = colSortVal(sortCol, b)
      const cmp = (typeof va === 'number' && typeof vb === 'number') ? va - vb : String(va).localeCompare(String(vb))
      return sortDir === 'desc' ? -cmp : cmp
    })
  }

  return (
    <div className="card">
      <div className="sec-head">
        <h3>{rows.length} case{rows.length === 1 ? '' : 's'}</h3>
        <div className="filter-bar" style={{ margin: 0 }}>
          <input type="text" placeholder="🔍 Search case #, student, district…" value={q} onChange={e => setQ(e.target.value)} />
          {[['active', 'Active'], ['due', 'Due Soon'], ['completed', 'Completed'], ['all', 'All']].map(([id, label]) => (
            <span key={id} className={`filter-chip ${chip === id ? 'active' : ''}`} onClick={() => setChip(id)}>{label}</span>
          ))}
          <button className="btn btn-secondary btn-sm" title="Download all cases and assignments as an Excel workbook"
            disabled={cases.length === 0}
            onClick={() => exportCasesToExcel(cases, assignments)}>
            ⬇ Export to Excel
          </button>
        </div>
      </div>
      {rowMsg && <div className={`alert alert-${rowMsg.kind}`}>{rowMsg.text}</div>}
      <div className="tbl-wrap">
        <table>
          <thead><tr>
            {COLS.map(([key, label]) => (
              <th key={key} style={{ position: 'relative', whiteSpace: 'nowrap' }}>
                <span style={{ cursor: 'pointer', userSelect: 'none' }}
                  onClick={e => { e.stopPropagation(); setOpenMenu(openMenu === key ? null : key) }}>
                  {label}{sortCol === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}{(colFilters[key]?.trim() || (colChecks[key] || []).length) ? ' •' : ''} <span style={{ color: 'var(--muted)' }}>▾</span>
                </span>
                {openMenu === key && (
                  <div onClick={e => e.stopPropagation()}
                    style={{ position: 'absolute', top: '100%', left: 0, zIndex: 20, background: '#fff', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,.18)', padding: 8, minWidth: 200, textAlign: 'left', textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
                    <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => { setSortCol(key); setSortDir('asc') }}>↑ Ascending</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => { setSortCol(key); setSortDir('desc') }}>↓ Descending</button>
                    </div>
                    {CHECKBOX_COLS[key] ? (
                      <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 5, padding: '4px 6px' }}>
                        {optionsFor(key).length === 0 && <div style={{ fontSize: 12, color: '#888' }}>No values</div>}
                        {optionsFor(key).map(opt => (
                          <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, padding: '2px 0', cursor: 'pointer' }}>
                            <input type="checkbox" checked={(colChecks[key] || []).includes(opt)} onChange={() => toggleCheck(key, opt)} /> {opt}
                          </label>
                        ))}
                      </div>
                    ) : (
                      <input type="text" autoFocus placeholder="Filter text…" value={colFilters[key] || ''}
                        onChange={e => setColFilters(p => ({ ...p, [key]: e.target.value }))}
                        onKeyDown={e => { if (e.key === 'Enter') setOpenMenu(null) }}
                        style={{ width: '100%', padding: '5px 8px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 5 }} />
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
                      <span className="tbl-link" style={{ fontSize: 12 }} onClick={() => { setColFilters(p => ({ ...p, [key]: '' })); setColChecks(p => ({ ...p, [key]: [] })); if (sortCol === key) setSortCol(null) }}>Clear</span>
                      <span className="tbl-link" style={{ fontSize: 12 }} onClick={() => setOpenMenu(null)}>Close</span>
                    </div>
                  </div>
                )}
              </th>
            ))}
          </tr></thead>
          <tbody>
            {loading && <tr><td colSpan={7} style={{ color: '#888' }}>Loading…</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={7} style={{ color: '#888' }}>No cases match.</td></tr>}
            {rows.slice(0, 200).map(c => {
              const asg = byCase[c.id] || []
              const breakdown = expanded[c.id] ? buildEvalBreakdown(c, asg, completedSet) : null
              const canExpand = asg.length > 0 || (c.evaluation_type || '').trim().length > 0
              const complete = caseFullyComplete(c, asg, completedSet)
              // Row-level status is "Pending Approval" while any assigned evaluator hasn't accepted yet
              const anyPending = asg.some(a => a.contractor_id != null && (a.acceptance_status || 'pending').toLowerCase() === 'pending')
              // "Report Submitted" only when EVERY evaluation on the case is submitted (not partial)
              const reqTypes = (c.evaluation_type || '').split(',').map(t => t.trim()).filter(Boolean)
              const coveredTypes = new Set(asg.map(a => (a.eval_type || '').toLowerCase()))
              const allSubmitted = asg.length > 0
                && reqTypes.every(t => coveredTypes.has(t.toLowerCase()))
                && asg.every(a => a.contractor_id != null && (a.status || '').toLowerCase() === 'submitted')
              return (
                <Fragment key={c.id}>
                  <tr style={complete ? { background: 'var(--gray-bg)', color: 'var(--muted)' } : undefined} title={complete ? 'Completed case' : undefined}>
                    <td><span className="tbl-link" onClick={() => onOpen(c)}>{c.case_number || c.id}</span></td>
                    <td>{c.Student_name || '—'}</td>
                    <td>{c.School_district || '—'}</td>
                    <td>{c.evaluation_type || '—'}</td>
                    <td style={dueColor(c.Report_Due_date)}>{fmtDate(c.Report_Due_date)}</td>
                    <td>
                      {asg.length === 0 && !canExpand
                        ? <span className="badge-s s-unassigned">None</span>
                        : <span className="tbl-link" title="Show evaluation types & evaluators" onClick={() => toggle(c.id)} style={{ whiteSpace: 'nowrap' }}>
                            <span style={{ display: 'inline-block', width: 12 }}>{expanded[c.id] ? '▾' : '▸'}</span>
                            {asg.length === 0 ? 'Unassigned' : `${asg.filter(a => (a.status || '').toLowerCase() === 'submitted').length}/${asg.length} submitted`}
                          </span>}
                    </td>
                    <td>
                      {complete
                        ? <Badge status="Completed" />
                        : anyPending
                          ? <span className="badge-s s-scheduled">Pending Approval</span>
                          : allSubmitted
                            ? <Badge status="Report Submitted" />
                            : asg.length === 0
                              ? <Badge status={c.Status || 'Unassigned'} />
                              : <span className="badge-s s-drafting">In Progress</span>}
                    </td>
                  </tr>
                  {expanded[c.id] && breakdown.map((r, i) => (
                    <Fragment key={`${c.id}-e-${i}`}>
                      <tr style={{ background: '#f8fafc' }}>
                        <td></td>
                        <td></td>
                        <td></td>
                        <td style={{ paddingLeft: 24, fontWeight: 600 }}>↳ {r.evalType}</td>
                        <td></td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {r.evaluator || <span style={{ color: '#888' }}>— not assigned —</span>}
                          {r.a && <>
                            {' '}<button className="btn btn-ghost btn-sm" title="Reassign to a different contractor" disabled={rowBusy} onClick={() => startReassign(r.a)}>✏️</button>
                            {' '}<button className="btn btn-danger-outline btn-sm" title="Remove this assignment" disabled={rowBusy} onClick={() => { setConfirmRemoveId(r.a.id); setReassignId(null); setRowMsg(null) }}>🗑</button>
                          </>}
                          {!r.a && <>{' '}<button className="btn btn-danger-outline btn-sm" title="Remove this evaluation type from the case" disabled={rowBusy} onClick={() => removeEvalType(c, r.evalType)}>🗑</button></>}
                        </td>
                        <td><span className={`badge-s ${r.status.cls}`}>{r.status.label}</span></td>
                      </tr>
                      {r.a && reassignId === r.a.id && (
                        <tr>
                          <td colSpan={7} style={{ background: 'var(--accent-light)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingLeft: 40 }}>
                              <strong style={{ fontSize: 13 }}>Reassign {r.evalType} to:</strong>
                              <select value={reassignTo} onChange={e => setReassignTo(e.target.value)} style={{ padding: '6px 10px', minWidth: 240 }}>
                                <option value="">Select contractor…</option>
                                {contractors.map(k => (
                                  <option key={k.identifier} value={k.identifier}>
                                    {k.name}{[k.field, [k.language, k.language_2].filter(Boolean).join('/')].filter(Boolean).length ? ` — ${[k.field, [k.language, k.language_2].filter(Boolean).join('/')].filter(Boolean).join(' · ')}` : ''}
                                  </option>
                                ))}
                              </select>
                              <button className="btn btn-primary btn-sm" disabled={rowBusy} onClick={() => saveReassign(r.a)}>Save &amp; notify</button>
                              <button className="btn btn-ghost btn-sm" disabled={rowBusy} onClick={() => setReassignId(null)}>Cancel</button>
                            </div>
                          </td>
                        </tr>
                      )}
                      {r.a && confirmRemoveId === r.a.id && (
                        <tr>
                          <td colSpan={7} style={{ background: 'var(--red-bg)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingLeft: 40 }}>
                              <span style={{ fontSize: 13, color: 'var(--red)' }}>Remove <strong>{r.evalType}</strong>{r.evaluator ? ` — ${r.evaluator}` : ''}? Deletes just this assignment, not the case.</span>
                              <button className="btn btn-danger btn-sm" disabled={rowBusy} onClick={() => removeAssignment(r.a)}>Yes, remove</button>
                              <button className="btn btn-ghost btn-sm" disabled={rowBusy} onClick={() => setConfirmRemoveId(null)}>Cancel</button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      {rows.length > 200 && <div style={{ marginTop: 8, fontSize: 12, color: '#888' }}>Showing first 200 — refine your search to see more.</div>}
    </div>
  )
}

function CaseDetail({ caseRow, assignments, allAssignments, contractors, onBack, onChanged }) {
  // Local mirror of the case so edits show immediately (the parent's selectedCase
  // isn't refreshed by load()). Resyncs whenever a different case is opened.
  const [c, setC] = useState(caseRow)
  useEffect(() => { setC(caseRow); setEditing(false); setConfirmDelete(false) }, [caseRow])

  const [msg, setMsg] = useState(null)
  const [newAsg, setNewAsg] = useState({ contractor_id: '', eval_type: '', report_due_date: caseRow.Report_Due_date || '' })
  const [contractorQuery, setContractorQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editAsgId, setEditAsgId] = useState(null)   // assignment being reassigned
  const [reassignTo, setReassignTo] = useState('')
  const [confirmRemoveId, setConfirmRemoveId] = useState(null)
  const [form, setForm] = useState({})
  const [evalTypes, setEvalTypes] = useState([])   // checked standard types
  const [extraEvals, setExtraEvals] = useState([]) // non-standard tokens, preserved as-is
  const setF = (k, v) => setForm(prev => ({ ...prev, [k]: v }))

  function startEdit() {
    // Split the stored eval-type string into the standard checkboxes + any legacy extras
    const tokens = (c.evaluation_type || '').split(',').map(t => t.trim()).filter(Boolean)
    const isStd = (tok) => EVAL_TYPES.find(et => et.toLowerCase() === tok.toLowerCase())
    setEvalTypes(EVAL_TYPES.filter(et => tokens.some(t => t.toLowerCase() === et.toLowerCase())))
    setExtraEvals(tokens.filter(t => !isStd(t)))
    setForm({
      case_number: c.case_number || '',
      Student_name: c.Student_name || '', student_dob: c.student_dob || '', grade: c['grade level'] || '',
      Language: c.Language || '', School_district: c.School_district || '', County: c.County || '',
      district_contact: c.district_contact || '', case_manager_name: c.case_manager_name || '', case_manager_email: c.case_manager_email || '', case_manager_phone: c.case_manager_phone || '',
      parents_name: c.parents_name || '', parents_phone: c.parents_phone != null ? String(c.parents_phone) : '', parents_email: c.parents_email || '',
      home_address: c.home_address || '', evaluation_type: c.evaluation_type || '', testing_materials: c.testing_materials || '',
      reason_for_referral: c.reason_for_referral || '', Report_Due_date: c.Report_Due_date || '', referral_source: c.referral_source || '',
      Status: c.Status || '',
    })
    setMsg(null); setConfirmDelete(false); setEditing(true)
  }

  async function saveEdit() {
    if (!form.Student_name || !form.School_district) { setMsg({ kind: 'warn', text: 'Student name and district are required.' }); return }
    if (!(form.case_number || '').trim()) { setMsg({ kind: 'warn', text: 'Case # is required.' }); return }
    setBusy(true); setMsg(null)
    const phone = (form.parents_phone || '').replace(/\D/g, '')
    const patch = {
      case_number: form.case_number.trim(),
      Student_name: form.Student_name || null, student_dob: form.student_dob || null, 'grade level': form.grade || null,
      Language: form.Language || null, School_district: form.School_district || null, County: form.County || null,
      district_contact: form.district_contact || null, case_manager_name: form.case_manager_name || null, case_manager_email: form.case_manager_email || null, case_manager_phone: form.case_manager_phone || null,
      parents_name: form.parents_name || null, parents_phone: phone ? Number(phone) : null, parents_email: form.parents_email || null,
      home_address: form.home_address || null, evaluation_type: [...evalTypes, ...extraEvals].join(', ') || null, testing_materials: form.testing_materials || null,
      reason_for_referral: form.reason_for_referral || null, Report_Due_date: form.Report_Due_date || null, referral_source: form.referral_source || null,
      Status: form.Status || null,
    }
    const { error } = await supabase.from('Cases').update(patch).eq('id', c.id)
    if (error) setMsg({ kind: 'danger', text: error.message })
    else {
      setC(prev => ({ ...prev, ...patch }))   // reflect edits immediately
      setEditing(false)
      setMsg({ kind: 'success', text: 'Case updated.' })
      onChanged()
    }
    setBusy(false)
  }

  async function deleteCase() {
    setBusy(true); setMsg(null)
    const { error } = await supabase.rpc('admin_delete_case', { p_case_id: c.id })
    setBusy(false)
    if (error) { setMsg({ kind: 'danger', text: error.message }); setConfirmDelete(false); return }
    onChanged()
    onBack()   // case is gone — return to the list
  }

  const filteredContractors = contractors.filter(k =>
    `${k.name || ''} ${k.field || ''} ${k.language || ''} ${k.language_2 || ''} ${k.county || ''}`.toLowerCase().includes(contractorQuery.toLowerCase()))

  const recommendations = useMemo(() => {
    if (!newAsg.eval_type) return []
    const activeCounts = new Map()
    for (const a of allAssignments) {
      if (a.contractor_id == null || (a.status || '').toLowerCase() === 'submitted') continue
      activeCounts.set(a.contractor_id, (activeCounts.get(a.contractor_id) || 0) + 1)
    }
    return scoreContractors(contractors, activeCounts, newAsg.eval_type, c.Language, c.County).slice(0, 8)
  }, [newAsg.eval_type, contractors, allAssignments, c])

  async function assign() {
    if (!newAsg.contractor_id || !newAsg.eval_type) { setMsg({ kind: 'warn', text: 'Pick a contractor and evaluation type.' }); return }
    setBusy(true); setMsg(null)
    const { data: inserted, error } = await supabase.from('Assignments').insert({
      case_id: c.id,
      contractor_id: Number(newAsg.contractor_id),
      eval_type: newAsg.eval_type,
      report_due_date: newAsg.report_due_date || null,
      status: 'Assigned',
      acceptance_status: 'pending',
    }).select('id').single()
    if (error) { setMsg({ kind: 'danger', text: error.message }); setBusy(false); return }

    if ((c.Status || '').toLowerCase() === 'unassigned') {
      await supabase.from('Cases').update({ Status: 'Assigned' }).eq('id', c.id)
    }

    // Email the contractor. The assignment is already saved, so email trouble
    // is only a warning — never blocks the assignment.
    let note = { kind: 'success', text: 'Contractor assigned — notification emailed.' }
    try {
      const { data: em, error: emErr } = await supabase.functions.invoke('notify-assignment', { body: { assignment_id: inserted.id } })
      if (emErr || !em?.success) note = { kind: 'warn', text: `Contractor assigned, but the email notice couldn't be sent (${em?.error || emErr?.message || 'unknown error'}).` }
      else if (em.skipped_no_email) note = { kind: 'warn', text: 'Contractor assigned. No email is on file for this contractor, so no notice was sent.' }
      else note = { kind: 'success', text: `Contractor assigned — notification emailed to ${em.sent_to}.` }
    } catch (e) {
      note = { kind: 'warn', text: `Contractor assigned, but the email notice failed: ${e.message}` }
    }

    setMsg(note)
    setNewAsg({ contractor_id: '', eval_type: '', report_due_date: c.Report_Due_date || '' })
    onChanged()
    setBusy(false)
  }

  async function viewReport(path) {
    const { data, error } = await supabase.storage.from('reports').createSignedUrl(path, 300)
    if (!error && data?.signedUrl) window.open(data.signedUrl, '_blank')
  }

  async function viewReferral() {
    if (!c.referral_file_path) return
    const { data, error } = await supabase.storage.from('referrals').createSignedUrl(c.referral_file_path, 300)
    if (!error && data?.signedUrl) window.open(data.signedUrl, '_blank')
  }

  function startReassign(a) {
    setEditAsgId(a.id); setReassignTo(String(a.contractor_id ?? '')); setConfirmRemoveId(null); setMsg(null)
  }

  async function saveReassign(a) {
    if (!reassignTo) { setMsg({ kind: 'warn', text: 'Pick a contractor to reassign to.' }); return }
    if (String(reassignTo) === String(a.contractor_id)) { setEditAsgId(null); return }
    setBusy(true); setMsg(null)
    const { error } = await supabase.from('Assignments').update({
      contractor_id: Number(reassignTo),
      acceptance_status: 'pending', accepted_at: null, declined_at: null, decline_reason: null,
      status: 'Assigned',
    }).eq('id', a.id)
    if (error) { setMsg({ kind: 'danger', text: error.message }); setBusy(false); return }
    // Notify the newly-assigned contractor (non-blocking)
    let text = 'Assignment reassigned.'
    try {
      const { data: em } = await supabase.functions.invoke('notify-assignment', { body: { assignment_id: a.id } })
      if (em?.success && em.sent_to) text = `Reassigned — notification emailed to ${em.sent_to}.`
      else if (em?.skipped_no_email) text = 'Reassigned. New contractor has no email on file, so no notice was sent.'
    } catch { /* email is best-effort */ }
    setEditAsgId(null); setMsg({ kind: 'success', text }); onChanged(); setBusy(false)
  }

  async function removeAssignment(a) {
    setBusy(true); setMsg(null)
    const { error } = await supabase.rpc('admin_delete_assignment', { p_assignment_id: a.id })
    if (error) { setMsg({ kind: 'danger', text: error.message }); setBusy(false); return }
    setConfirmRemoveId(null); setMsg({ kind: 'success', text: 'Assignment removed from this case.' }); onChanged(); setBusy(false)
  }

  async function uploadReferral(file) {
    if (!file) return
    setBusy(true); setMsg(null)
    const path = `${c.id}/${file.name}`
    const { error: upErr } = await supabase.storage.from('referrals').upload(path, file, { upsert: true })
    if (upErr) { setMsg({ kind: 'danger', text: `Upload failed: ${upErr.message}` }); setBusy(false); return }
    const { error } = await supabase.from('Cases').update({ referral_file_path: path, referral_file_name: file.name }).eq('id', c.id)
    if (error) { setMsg({ kind: 'danger', text: error.message }); setBusy(false); return }
    setC(prev => ({ ...prev, referral_file_path: path, referral_file_name: file.name }))
    setMsg({ kind: 'success', text: 'Referral form saved.' })
    onChanged()
    setBusy(false)
  }

  return (
    <>
      <div style={{ marginBottom: 10 }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← Back to Cases</button>
      </div>
      {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}

      {confirmDelete && (
        <div className="alert alert-danger" style={{ flexDirection: 'column', gap: 8 }}>
          <div><strong>⚠️ Delete case {c.case_number || c.id}?</strong> This permanently removes the case and its {assignments.length} assignment{assignments.length === 1 ? '' : 's'} (plus any reviews, earnings, and invoices for it). This cannot be undone.</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-danger btn-sm" disabled={busy} onClick={deleteCase}>Yes, delete permanently</button>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</button>
          </div>
        </div>
      )}

      {editing ? (
        <div className="card" style={{ marginBottom: 14, border: '2px solid var(--accent)' }}>
          <div className="sec-head">
            <h3>✏️ Editing Case {c.case_number || c.id}</h3>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={saveEdit}>💾 Save Changes</button>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setEditing(false); setMsg(null) }}>Cancel</button>
            </div>
          </div>
          <div className="form-row-3">
            <div className="form-group"><label>Case # *</label><input value={form.case_number} onChange={e => setF('case_number', e.target.value)} /></div>
            <div className="form-group"><label>Student Name *</label><input value={form.Student_name} onChange={e => setF('Student_name', e.target.value)} /></div>
            <div className="form-group"><label>Status</label>
              <select value={form.Status} onChange={e => setF('Status', e.target.value)}>
                {!CASE_STATUSES.includes(form.Status) && form.Status && <option value={form.Status}>{form.Status}</option>}
                {CASE_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="form-row-3">
            <div className="form-group"><label>Date of Birth</label><input type="date" value={form.student_dob} onChange={e => setF('student_dob', e.target.value)} /></div>
            <div className="form-group"><label>Grade</label>
              <select value={form.grade} onChange={e => setF('grade', e.target.value)}>
                <option value="">Select…</option>
                {GRADES.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
            <div className="form-group"><label>Language(s)</label><input value={form.Language} onChange={e => setF('Language', e.target.value)} /></div>
          </div>
          <div className="form-row">
            <div className="form-group"><label>District *</label><input value={form.School_district} onChange={e => setF('School_district', e.target.value)} /></div>
            <div className="form-group"><label>County</label><input value={form.County} onChange={e => setF('County', e.target.value)} /></div>
          </div>
          <div className="form-row-3">
            <div className="form-group"><label>District Contact</label><input value={form.district_contact} onChange={e => setF('district_contact', e.target.value)} /></div>
            <div className="form-group"><label>Case Manager</label><input value={form.case_manager_name} onChange={e => setF('case_manager_name', e.target.value)} /></div>
            <div className="form-group"><label>Case Manager Email</label><input value={form.case_manager_email} onChange={e => setF('case_manager_email', e.target.value)} /></div>
            <div className="form-group"><label>Case Manager Phone</label><input value={form.case_manager_phone} onChange={e => setF('case_manager_phone', e.target.value)} /></div>
          </div>
          <div className="form-row">
            <div className="form-group"><label>Parent / Guardian</label><input value={form.parents_name} onChange={e => setF('parents_name', e.target.value)} /></div>
            <div className="form-group"><label>Parent Phone</label><input value={form.parents_phone} onChange={e => setF('parents_phone', e.target.value)} /></div>
          </div>
          <div className="form-row">
            <div className="form-group"><label>Parent Email</label><input value={form.parents_email} onChange={e => setF('parents_email', e.target.value)} /></div>
            <div className="form-group"><label>Home Address</label><input value={form.home_address} onChange={e => setF('home_address', e.target.value)} /></div>
          </div>
          <div className="form-row">
            <div className="form-group"><label>Evaluation Type(s)</label>
              <div className="check-group" style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {EVAL_TYPES.map(t => (
                  <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                    <input type="checkbox" checked={evalTypes.includes(t)}
                      onChange={e => setEvalTypes(p => e.target.checked ? [...p, t] : p.filter(x => x !== t))} /> {t}
                  </label>
                ))}
              </div>
              {extraEvals.length > 0 && (
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>Also on file: {extraEvals.join(', ')}</div>
              )}
            </div>
            <div className="form-group"><label>Report Due Date</label><input type="date" value={form.Report_Due_date} onChange={e => setF('Report_Due_date', e.target.value)} /></div>
          </div>
          <div className="form-group"><label>Testing Materials</label><textarea rows={2} value={form.testing_materials} onChange={e => setF('testing_materials', e.target.value)} /></div>
          <div className="form-group"><label>Reason for Referral</label><textarea rows={2} value={form.reason_for_referral} onChange={e => setF('reason_for_referral', e.target.value)} /></div>
          <div className="form-group"><label>Referral Source</label><input value={form.referral_source} onChange={e => setF('referral_source', e.target.value)} /></div>
        </div>
      ) : (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, alignItems: 'flex-start' }}>
            <h2 style={{ fontSize: 17, fontWeight: 800 }}>Case {c.case_number || c.id} — {c.Student_name || 'Student'}</h2>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Badge status={c.Status} />
              <button className="btn btn-secondary btn-sm" onClick={startEdit}>✏️ Edit</button>
              <button className="btn btn-danger-outline btn-sm" onClick={() => { setConfirmDelete(true); setMsg(null) }}>🗑 Delete</button>
            </div>
          </div>
          <div className="meta-grid" style={{ marginTop: 14 }}>
            <Meta k="District" v={c.School_district} />
            <Meta k="County" v={c.County} />
            <Meta k="Report Due" v={fmtDate(c.Report_Due_date)} style={dueColor(c.Report_Due_date)} />
            <Meta k="Language" v={c.Language} />
            <Meta k="Grade" v={c['grade level']} />
            <Meta k="DOB" v={c.student_dob ? fmtDate(c.student_dob) : null} />
            <Meta k="Eval Types Requested" v={c.evaluation_type} />
            <Meta k="Case Manager" v={c.case_manager_name} />
            <Meta k="Case Mgr Phone" v={c.case_manager_phone} />
            <Meta k="Referral Source" v={c.referral_source} />
          </div>
          <div className="alert alert-info" style={{ marginTop: 14, marginBottom: 0, alignItems: 'center', flexWrap: 'wrap' }}>
            📎 <span style={{ flex: 1, minWidth: 200 }}>
              {c.referral_file_path
                ? <>Original referral form: <span className="tbl-link" onClick={viewReferral}>{c.referral_file_name || 'View'}</span> — open it to proofread the details above.</>
                : <>No referral form on file for this case.</>}
            </span>
            <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer', margin: 0 }}>
              {busy ? 'Uploading…' : (c.referral_file_path ? '↻ Replace' : '⬆ Upload referral form')}
              <input type="file" accept=".pdf,.doc,.docx" style={{ display: 'none' }} disabled={busy} onChange={e => uploadReferral(e.target.files[0])} />
            </label>
          </div>
        </div>
      )}

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card">
            <div className="card-title">Assignments on this Case</div>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Contractor</th><th>Eval Type</th><th>Accepted?</th><th>Due</th><th>Testing</th><th>Status</th><th>Report</th><th></th></tr></thead>
                <tbody>
                  {assignments.length === 0 && <tr><td colSpan={8} style={{ color: '#888' }}>No contractors assigned yet.</td></tr>}
                  {assignments.map(a => (
                    <Fragment key={a.id}>
                      <tr>
                        <td>{a.Contractors?.name || '—'}</td>
                        <td>{a.eval_type || '—'}</td>
                        <td><AcceptBadge status={a.acceptance_status} /></td>
                        <td style={dueColor(a.report_due_date)}>{fmtDate(a.report_due_date)}</td>
                        <td>{a.testing_date ? fmtDate(a.testing_date) : '—'}</td>
                        <td><Badge status={a.status} /></td>
                        <td>{(() => {
                          const files = Array.isArray(a.report_files) && a.report_files.length
                            ? a.report_files
                            : (a.report_url ? [{ path: a.report_url, name: a.report_url.split('/').pop() }] : [])
                          if (!files.length) return '—'
                          return files.map((f, i) => (
                            <div key={f.path || i}><span className="tbl-link" onClick={() => viewReport(f.path)}>📄 {files.length > 1 ? (f.name || f.path.split('/').pop()) : 'View'}</span></div>
                          ))
                        })()}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button className="btn btn-ghost btn-sm" title="Reassign to a different contractor" disabled={busy} onClick={() => startReassign(a)}>✏️</button>{' '}
                          <button className="btn btn-danger-outline btn-sm" title="Remove this assignment" disabled={busy} onClick={() => { setConfirmRemoveId(a.id); setEditAsgId(null); setMsg(null) }}>🗑</button>
                        </td>
                      </tr>
                      {editAsgId === a.id && (
                        <tr>
                          <td colSpan={8} style={{ background: 'var(--accent-light)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <strong style={{ fontSize: 13 }}>Reassign {a.eval_type || 'evaluation'} to:</strong>
                              <select value={reassignTo} onChange={e => setReassignTo(e.target.value)} style={{ padding: '6px 10px', minWidth: 240 }}>
                                <option value="">Select contractor…</option>
                                {contractors.map(k => (
                                  <option key={k.identifier} value={k.identifier}>
                                    {k.name}{[k.field, [k.language, k.language_2].filter(Boolean).join('/')].filter(Boolean).length ? ` — ${[k.field, [k.language, k.language_2].filter(Boolean).join('/')].filter(Boolean).join(' · ')}` : ''}
                                  </option>
                                ))}
                              </select>
                              <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => saveReassign(a)}>Save & notify</button>
                              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setEditAsgId(null)}>Cancel</button>
                              <span style={{ fontSize: 12, color: 'var(--muted)' }}>Resets acceptance to “Awaiting” and emails the new contractor.</span>
                            </div>
                          </td>
                        </tr>
                      )}
                      {confirmRemoveId === a.id && (
                        <tr>
                          <td colSpan={8} style={{ background: 'var(--red-bg)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 13, color: 'var(--red)' }}>Remove <strong>{a.eval_type || 'this evaluation'}</strong>{a.Contractors?.name ? ` — ${a.Contractors.name}` : ''} from this case? This deletes just this assignment (and its review/earning), not the case.</span>
                              <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => removeAssignment(a)}>Yes, remove</button>
                              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setConfirmRemoveId(null)}>Cancel</button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {!editing && (
            <div className="card">
              <div className="card-title">👪 Parent / Guardian</div>
              <div className="meta-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <Meta k="Name" v={c.parents_name} />
                <Meta k="Phone" v={c.parents_phone ? String(c.parents_phone) : null} />
                <Meta k="Email" v={c.parents_email} />
                <Meta k="Address" v={c.home_address} />
              </div>
            </div>
          )}

          {!editing && (
            <div className="card">
              <div className="card-title">🧪 Testing Materials / Referral Reason</div>
              <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{c.testing_materials || '—'}</div>
              {c.reason_for_referral && <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', marginTop: 8, color: '#555' }}>{c.reason_for_referral}</div>}
            </div>
          )}
        </div>

        <div className="card" style={{ border: '2px solid var(--accent)' }}>
          <div className="card-title">👤 Assign a Contractor</div>
          <div className="form-group">
            <label>Filter Contractors ({filteredContractors.length})</label>
            <input placeholder="🔍 Name, field, language, county…" value={contractorQuery} onChange={e => setContractorQuery(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Contractor</label>
            <select value={newAsg.contractor_id} onChange={e => setNewAsg(p => ({ ...p, contractor_id: e.target.value }))}>
              <option value="">Select contractor…</option>
              {filteredContractors.map(k => (
                <option key={k.identifier} value={k.identifier}>
                  {k.name}{k.field ? ` — ${k.field}` : ''}{k.language ? ` (${[k.language, k.language_2].filter(Boolean).join('/')})` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Evaluation Type</label>
              <select value={newAsg.eval_type} onChange={e => setNewAsg(p => ({ ...p, eval_type: e.target.value }))}>
                <option value="">Select…</option>
                {EVAL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Report Due Date</label>
              <input type="date" value={newAsg.report_due_date || ''} onChange={e => setNewAsg(p => ({ ...p, report_due_date: e.target.value }))} />
            </div>
          </div>
          <button className="btn btn-primary" disabled={busy} onClick={assign}>Assign Contractor</button>

          {newAsg.eval_type && (
            <div style={{ marginTop: 14, borderTop: '1px solid #e5e7eb', paddingTop: 12 }}>
              <div className="card-title" style={{ marginBottom: 8 }}>⭐ Recommended for {newAsg.eval_type}{c.Language ? ` · ${c.Language}` : ''}{c.County ? ` · ${c.County}` : ''}</div>
              {recommendations.length === 0 && <div style={{ fontSize: 12, color: '#888' }}>No matching contractors (field{c.Language ? ' + language' : ''} filter). Pick manually above.</div>}
              {recommendations.map(r => (
                <div key={r.contractor.identifier}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 5, cursor: 'pointer', background: String(newAsg.contractor_id) === String(r.contractor.identifier) ? 'var(--accent-light)' : 'transparent' }}
                  onClick={() => setNewAsg(p => ({ ...p, contractor_id: String(r.contractor.identifier) }))}>
                  <span className={`badge-s ${r.tier === 'Best' ? 's-completed' : 's-scheduled'}`}>{r.tier} · {r.score}</span>
                  <div style={{ flex: 1, fontSize: 13 }}>
                    <strong>{r.contractor.name}</strong>
                    <span style={{ color: '#888' }}> — {[r.contractor.field, [r.contractor.language, r.contractor.language_2].filter(Boolean).join('/'), r.contractor.county].filter(Boolean).join(' · ')}</span>
                  </div>
                  <span style={{ fontSize: 11, color: '#888' }}>{r.activeCaseCount} open</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function ContractorList({ contractors, assignments, onChanged }) {
  const [q, setQ] = useState('')
  const [msg, setMsg] = useState(null)
  const [inviting, setInviting] = useState(null)
  const [editing, setEditing] = useState(null)   // the contractor being edited, or null
  const [form, setForm] = useState({})
  const [busy, setBusy] = useState(false)
  const setF = (k, v) => setForm(p => ({ ...p, [k]: v }))

  async function invite(k) {
    if (!k.email) { setMsg({ kind: 'warn', text: `${k.name} has no email on file — add one before inviting.` }); return }
    if (k.user_id && !window.confirm(`Send ${k.name} a NEW temporary password? This replaces their current password.`)) return
    setInviting(k.identifier); setMsg(null)
    const { data, error } = await supabase.functions.invoke('invite-contractor', { body: { email: k.email } })
    if (error || !data?.success) { setMsg({ kind: 'danger', text: `Failed for ${k.name}: ${data?.error || error?.message || 'unknown error'}` }); setInviting(null); return }
    const base = `${k.name} — login: ${k.email} · temporary password: ${data.password}`
    setMsg({
      kind: 'success',
      text: data.sent
        ? `${base}. Emailed to them; they can change it after logging in (Profile → Change Password).`
        : `${base}. Email not sent (${data.warning || 'no email'}) — share this password with them directly.`,
    })
    onChanged()
    setInviting(null)
  }

  // Set a password directly (bypasses email links entirely — needed for AOL/Yahoo/Outlook
  // scanners that consume one-time set-password links before the contractor can click them)
  async function setPassword(k) {
    if (!k.user_id) { setMsg({ kind: 'warn', text: `${k.name} has no portal login yet — send an invite first.` }); return }
    const pw = window.prompt(`Set a temporary password for ${k.name}.\nThey'll log in at portal.learningtreenj.org with:\n  Email: ${k.email}\n  Password: (what you enter below)\n\nMinimum 6 characters:`)
    if (pw === null) return
    if (pw.trim().length < 6) { setMsg({ kind: 'warn', text: 'Password must be at least 6 characters.' }); return }
    setInviting(k.identifier); setMsg(null)
    const { data, error } = await supabase.functions.invoke('set-contractor-password', { body: { user_id: k.user_id, password: pw.trim() } })
    if (error || !data?.success) setMsg({ kind: 'danger', text: `Couldn't set password for ${k.name}: ${data?.error || error?.message || 'unknown error'}` })
    else setMsg({ kind: 'success', text: `Password set for ${k.name}. Tell them to log in at portal.learningtreenj.org with ${k.email} and the password you just entered — no email link needed.` })
    setInviting(null)
  }

  function startEdit(k) {
    setForm({
      name: k.name || '', email: k.email || '', phone: k.phone || '', company_name: k.company_name || '',
      field: k.field || '', language: k.language || '', language_2: k.language_2 || '', county: k.county || '',
      address: k.address || '', zip_code: k.zip_code != null ? String(k.zip_code) : '', current_rate: k.current_rate || '',
      w9_on_file: !!k.w9_on_file, criminal_history_done: !!k.criminal_history_done, NJDOE_submitted: k.NJDOE_submitted || '',
    })
    setMsg(null); setEditing(k)
  }

  async function saveEdit() {
    if (!form.name.trim()) { setMsg({ kind: 'warn', text: 'Name is required.' }); return }
    setBusy(true); setMsg(null)
    const zip = String(form.zip_code || '').replace(/\D/g, '')
    const patch = {
      name: form.name.trim(), email: form.email || null, phone: form.phone || null, company_name: form.company_name || null,
      field: form.field || null, language: form.language || null, language_2: form.language_2 || null, county: form.county || null,
      address: form.address || null, zip_code: zip ? Number(zip) : null, current_rate: form.current_rate || null,
      w9_on_file: !!form.w9_on_file, criminal_history_done: !!form.criminal_history_done, NJDOE_submitted: form.NJDOE_submitted || null,
    }
    const { error } = await supabase.from('Contractors').update(patch).eq('identifier', editing.identifier)
    setBusy(false)
    if (error) { setMsg({ kind: 'danger', text: error.message }); return }
    setEditing(null); setMsg({ kind: 'success', text: `${patch.name} updated.` }); onChanged()
  }

  const openBy = useMemo(() => {
    const m = {}
    for (const a of assignments) {
      if ((a.status || '').toLowerCase() === 'submitted') continue
      m[a.contractor_id] = (m[a.contractor_id] || 0) + 1
    }
    return m
  }, [assignments])

  const rows = contractors.filter(k =>
    `${k.name || ''} ${k.email || ''} ${k.field || ''} ${k.language || ''} ${k.language_2 || ''} ${k.county || ''}`.toLowerCase().includes(q.toLowerCase()))

  // ── Edit form ──
  if (editing) {
    return (
      <div className="card" style={{ border: '2px solid var(--accent)', maxWidth: 760 }}>
        <div className="sec-head">
          <h3>✏️ Edit Contractor — {editing.name}</h3>
          <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>← Back to list</button>
        </div>
        {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}
        <div className="form-group"><label>Name *</label><input value={form.name} onChange={e => setF('name', e.target.value)} /></div>
        <div className="form-row">
          <div className="form-group"><label>Email</label><input type="email" value={form.email} onChange={e => setF('email', e.target.value)} /></div>
          <div className="form-group"><label>Phone</label><input value={form.phone} onChange={e => setF('phone', e.target.value)} /></div>
        </div>
        <div className="form-group"><label>Company Name</label><input value={form.company_name} onChange={e => setF('company_name', e.target.value)} /></div>
        <div className="form-row">
          <div className="form-group"><label>Field / Specialty</label>
            <ChoiceSelect value={form.field} options={CONTRACTOR_FIELDS} onChange={v => setF('field', v)} /></div>
          <div className="form-group"><label>Rate</label><input value={form.current_rate} onChange={e => setF('current_rate', e.target.value)} placeholder="e.g. $880" /></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label>Primary Language</label>
            <ChoiceSelect value={form.language} options={LANGUAGES} onChange={v => setF('language', v)} /></div>
          <div className="form-group"><label>Second Language</label>
            <ChoiceSelect value={form.language_2} options={LANGUAGES} onChange={v => setF('language_2', v)} /></div>
        </div>
        <div className="form-group"><label>Address</label><input value={form.address} onChange={e => setF('address', e.target.value)} /></div>
        <div className="form-row">
          <div className="form-group"><label>County</label><input value={form.county} onChange={e => setF('county', e.target.value)} /></div>
          <div className="form-group"><label>Zip Code</label><input value={form.zip_code} onChange={e => setF('zip_code', e.target.value)} /></div>
        </div>
        <div className="form-group"><label>NJDOE Submitted Date</label><input type="date" value={form.NJDOE_submitted} onChange={e => setF('NJDOE_submitted', e.target.value)} /></div>
        <div className="form-group">
          <label>Compliance</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, marginTop: 4 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, textTransform: 'none', letterSpacing: 0, fontWeight: 400, cursor: 'pointer' }}>
              <input type="checkbox" checked={form.w9_on_file} onChange={e => setF('w9_on_file', e.target.checked)} /> W-9 on file
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, textTransform: 'none', letterSpacing: 0, fontWeight: 400, cursor: 'pointer' }}>
              <input type="checkbox" checked={form.criminal_history_done} onChange={e => setF('criminal_history_done', e.target.checked)} /> Criminal history check done
            </label>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn btn-primary" disabled={busy} onClick={saveEdit}>{busy ? 'Saving…' : 'Save Changes'}</button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
        </div>
      </div>
    )
  }

  // ── List ──
  return (
    <div className="card">
      <div className="sec-head">
        <h3>{rows.length} contractor{rows.length === 1 ? '' : 's'}</h3>
        <div className="filter-bar" style={{ margin: 0 }}>
          <input type="text" placeholder="🔍 Name, field, language, county…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
      </div>
      {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Name</th><th>Field</th><th>Languages</th><th>County</th><th>Rate</th><th>W-9</th><th>Open Cases</th><th>Portal Login</th><th></th></tr></thead>
          <tbody>
            {rows.map(k => (
              <tr key={k.identifier}>
                <td style={{ fontWeight: 600 }}>{k.name}<div style={{ fontWeight: 400, fontSize: 11, color: '#888' }}>{k.email}</div></td>
                <td>{k.field || '—'}</td>
                <td>{[k.language, k.language_2].filter(Boolean).join(', ') || '—'}</td>
                <td>{k.county || '—'}</td>
                <td>{k.current_rate || '—'}</td>
                <td>{k.w9_on_file ? '✓' : <span style={{ color: 'var(--red)' }}>✗</span>}</td>
                <td>{openBy[k.identifier] || 0}</td>
                <td>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    {k.user_id && <span className="badge-s s-completed">Linked</span>}
                    <button className="btn btn-secondary btn-sm" title={k.user_id ? 'Email a new temporary password (replaces the current one)' : 'Create login & email a temporary password'} disabled={inviting === k.identifier} onClick={() => invite(k)}>
                      {inviting === k.identifier ? 'Sending…' : (k.user_id ? '↻ New temp password' : '✉ Invite')}
                    </button>
                    {k.user_id && <button className="btn btn-ghost btn-sm" title="Set a specific password yourself (to read out over the phone)" disabled={inviting === k.identifier} onClick={() => setPassword(k)}>🔑 Set password</button>}
                  </span>
                </td>
                <td><button className="btn btn-ghost btn-sm" onClick={() => startEdit(k)}>✏️ Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function InvoiceList({ invoices, cases, onChanged }) {
  const [f, setF] = useState({ case_id: '', district_name: '', amount: '', issued_date: '', due_date: '', status: 'Draft' })
  const [msg, setMsg] = useState(null)

  async function create() {
    if (!f.district_name || !f.amount) { setMsg({ kind: 'warn', text: 'District and amount are required.' }); return }
    const { error } = await supabase.from('Invoices').insert({
      case_id: f.case_id ? Number(f.case_id) : null,
      district_name: f.district_name,
      amount: Number(f.amount),
      issued_date: f.issued_date || null,
      due_date: f.due_date || null,
      status: f.status,
    })
    if (error) setMsg({ kind: 'danger', text: error.message })
    else { setMsg({ kind: 'success', text: 'Invoice created.' }); setF({ case_id: '', district_name: '', amount: '', issued_date: '', due_date: '', status: 'Draft' }); onChanged() }
  }

  async function setStatus(inv, status) {
    await supabase.from('Invoices').update({ status }).eq('id', inv.id)
    onChanged()
  }

  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <div className="card">
        <div className="card-title">Invoices</div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>#</th><th>District</th><th>Amount</th><th>Issued</th><th>Due</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {invoices.length === 0 && <tr><td colSpan={7} style={{ color: '#888' }}>No invoices yet.</td></tr>}
              {invoices.map(inv => (
                <tr key={inv.id}>
                  <td>{inv.id}</td>
                  <td>{inv.district_name}</td>
                  <td>${Number(inv.amount || 0).toLocaleString()}</td>
                  <td>{fmtDate(inv.issued_date)}</td>
                  <td>{fmtDate(inv.due_date)}</td>
                  <td><Badge status={inv.status} /></td>
                  <td>
                    {(inv.status || '').toLowerCase() !== 'paid' && (
                      <button className="btn btn-ghost btn-sm" onClick={() => setStatus(inv, 'Paid')}>Mark Paid</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card" style={{ border: '2px solid var(--accent)' }}>
        <div className="card-title">➕ New Invoice</div>
        {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}
        <div className="form-group"><label>District *</label><input value={f.district_name} onChange={e => setF(p => ({ ...p, district_name: e.target.value }))} /></div>
        <div className="form-group"><label>Case (optional)</label>
          <select value={f.case_id} onChange={e => setF(p => ({ ...p, case_id: e.target.value }))}>
            <option value="">— none —</option>
            {cases.slice(0, 400).map(c => <option key={c.id} value={c.id}>{c.case_number} — {c.Student_name}</option>)}
          </select>
        </div>
        <div className="form-row">
          <div className="form-group"><label>Amount ($) *</label><input type="number" value={f.amount} onChange={e => setF(p => ({ ...p, amount: e.target.value }))} /></div>
          <div className="form-group"><label>Status</label>
            <select value={f.status} onChange={e => setF(p => ({ ...p, status: e.target.value }))}>
              {['Draft', 'Sent', 'Paid'].map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
        </div>
        <div className="form-row">
          <div className="form-group"><label>Issued Date</label><input type="date" value={f.issued_date} onChange={e => setF(p => ({ ...p, issued_date: e.target.value }))} /></div>
          <div className="form-group"><label>Due Date</label><input type="date" value={f.due_date} onChange={e => setF(p => ({ ...p, due_date: e.target.value }))} /></div>
        </div>
        <button className="btn btn-primary" onClick={create}>Create Invoice</button>
      </div>
    </div>
  )
}

function Payroll({ assignments, earnings, batches, contractors, onChanged }) {
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  const contractorById = useMemo(() => new Map(contractors.map(k => [k.identifier, k])), [contractors])
  const assignmentById = useMemo(() => new Map(assignments.map(a => [a.id, a])), [assignments])

  const unbatched = earnings.filter(e => e.status === 'pending' && !e.payment_batch_id)
  const unbatchedTotal = unbatched.reduce((n, e) => n + Number(e.amount || 0), 0)

  async function createBatch() {
    setBusy(true); setMsg(null)
    const month = new Date().toISOString().slice(0, 7)
    const { data: batch, error } = await supabase.from('payment_batches')
      .insert({ batch_month: month, total_amount: unbatchedTotal, status: 'draft' })
      .select().single()
    if (error) { setMsg({ kind: 'danger', text: error.message }); setBusy(false); return }
    const { error: linkErr } = await supabase.from('contractor_earnings')
      .update({ payment_batch_id: batch.id })
      .eq('status', 'pending').is('payment_batch_id', null)
    setMsg(linkErr ? { kind: 'danger', text: linkErr.message }
      : { kind: 'success', text: `Batch ${month} created with ${unbatched.length} earnings ($${unbatchedTotal.toLocaleString()}).` })
    onChanged(); setBusy(false)
  }

  async function setBatchStatus(batch, action) {
    setBusy(true); setMsg(null)
    if (action === 'approve') {
      await supabase.from('payment_batches').update({ status: 'approved', approved_at: new Date().toISOString() }).eq('id', batch.id)
      await supabase.from('contractor_earnings').update({ status: 'approved' }).eq('payment_batch_id', batch.id).eq('status', 'pending')
    } else {
      await supabase.from('payment_batches').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('id', batch.id)
      await supabase.from('contractor_earnings').update({ status: 'paid' }).eq('payment_batch_id', batch.id)
    }
    onChanged(); setBusy(false)
  }

  function exportBatchCsv(batch) {
    const items = earnings.filter(e => e.payment_batch_id === batch.id)
    const byContractor = {}
    for (const e of items) {
      byContractor[e.contractor_id] = byContractor[e.contractor_id] || []
      byContractor[e.contractor_id].push(e)
    }
    const lines = [['Contractor', 'Email', 'Evaluations', 'Total Amount', 'Cases'].join(',')]
    for (const [cid, list] of Object.entries(byContractor)) {
      const k = contractorById.get(Number(cid))
      const total = list.reduce((n, e) => n + Number(e.amount || 0), 0)
      const caseList = list.map(e => {
        const a = assignmentById.get(e.assignment_id)
        return `${a?.Cases?.case_number || e.assignment_id} (${a?.eval_type || ''})`
      }).join('; ')
      lines.push([`"${k?.name || 'Unknown'}"`, k?.email || '', list.length, total, `"${caseList}"`].join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const el = document.createElement('a')
    el.href = url; el.download = `payment-batch-${batch.batch_month}-${batch.id}.csv`; el.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="sec-head" style={{ marginBottom: 0 }}>
          <h3>Ready for Payroll</h3>
          <button className="btn btn-primary btn-sm" disabled={busy || unbatched.length === 0} onClick={createBatch}>
            ➕ Create Payment Batch ({unbatched.length} earnings · ${unbatchedTotal.toLocaleString()})
          </button>
        </div>
        <div style={{ marginTop: 10, fontSize: 13, color: '#555' }}>
          Earnings are created when reports pass QA review. At month end: create a batch, export the CSV
          into your payments provider (e.g. Gusto), then mark the batch approved and paid.
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-title">Payment Batches</div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Month</th><th>Total</th><th>Status</th><th>Approved</th><th>Paid</th><th>Actions</th></tr></thead>
            <tbody>
              {batches.length === 0 && <tr><td colSpan={6} style={{ color: '#888' }}>No batches yet.</td></tr>}
              {batches.map(b => (
                <tr key={b.id}>
                  <td style={{ fontWeight: 600 }}>{b.batch_month} <span style={{ color: '#888', fontWeight: 400 }}>#{b.id}</span></td>
                  <td>${Number(b.total_amount || 0).toLocaleString()}</td>
                  <td><Badge status={b.status} /></td>
                  <td>{b.approved_at ? fmtDate(b.approved_at.slice(0, 10)) : '—'}</td>
                  <td>{b.paid_at ? fmtDate(b.paid_at.slice(0, 10)) : '—'}</td>
                  <td style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => exportBatchCsv(b)}>⬇ CSV</button>
                    {b.status === 'draft' && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setBatchStatus(b, 'approve')}>Approve</button>}
                    {b.status === 'approved' && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => setBatchStatus(b, 'paid')}>Mark Paid</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-title">All Earnings ({earnings.length})</div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Contractor</th><th>Case</th><th>Eval Type</th><th>Date</th><th>Amount</th><th>Status</th><th>Batch</th></tr></thead>
            <tbody>
              {earnings.length === 0 && <tr><td colSpan={7} style={{ color: '#888' }}>No earnings yet — approve submitted reports in Report Review to create them.</td></tr>}
              {earnings.map(e => {
                const k = contractorById.get(e.contractor_id)
                const a = assignmentById.get(e.assignment_id)
                return (
                  <tr key={e.id}>
                    <td style={{ fontWeight: 600 }}>{k?.name || e.contractor_id}</td>
                    <td>{a?.Cases?.case_number || '—'}</td>
                    <td>{a?.eval_type || '—'}</td>
                    <td>{fmtDate(e.billable_date)}</td>
                    <td>${Number(e.amount || 0).toLocaleString()}</td>
                    <td><Badge status={e.status} /></td>
                    <td>{e.payment_batch_id ? `#${e.payment_batch_id}` : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

const QA_CHECKS = [
  ['letterhead_ok', 'Letterhead correct'],
  ['district_name_ok', 'District name correct'],
  ['student_info_ok', 'Student info correct'],
  ['pronouns_ok', 'Pronouns consistent'],
  ['test_scores_ok', 'Test scores complete'],
  ['recommendations_ok', 'Recommendations included'],
  ['signature_ok', 'Signature present'],
  ['formatting_ok', 'Formatting clean'],
]

function QaQueue({ assignments, qaByAssignment, earnings, onChanged }) {
  const [tab, setTab] = useState('all')
  const [selectedId, setSelectedId] = useState(null)
  const [form, setForm] = useState(null)
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState({})
  // Multi-report groups default to expanded; toggle collapses/re-opens
  const isOpen = id => expanded[id] !== false
  const toggle = id => setExpanded(p => ({ ...p, [id]: p[id] === false }))
  const qaBadge = (a) => {
    const s = qaByAssignment.get(a.id)?.qa_status
    return <Badge status={s === 'approved' ? 'Approved' : s === 'needs_revision' ? 'Revision' : 'Pending'} />
  }

  const submitted = assignments.filter(a => a.submitted_at)
  const rows = submitted
    .filter(a => tab === 'all' || qaByAssignment.get(a.id)?.qa_status !== 'approved')
    .sort((a, b) => {
      const ORDER = { needs_revision: 0, '': 1, in_review: 1, approved: 2 }
      const ao = ORDER[qaByAssignment.get(a.id)?.qa_status ?? ''] ?? 1
      const bo = ORDER[qaByAssignment.get(b.id)?.qa_status ?? ''] ?? 1
      if (ao !== bo) return ao - bo
      return (b.submitted_at || '').localeCompare(a.submitted_at || '')
    })

  const selected = submitted.find(a => a.id === selectedId) || null

  // Group the (already sorted) submitted reports by case, preserving order
  const caseGroups = useMemo(() => {
    const out = []
    const idx = new Map()
    for (const a of rows) {
      let g = idx.get(a.case_id)
      if (!g) { g = { case_id: a.case_id, caseRow: a.Cases, items: [] }; idx.set(a.case_id, g); out.push(g) }
      g.items.push(a)
    }
    return out
  }, [rows])

  function openReview(a) {
    const qa = qaByAssignment.get(a.id)
    setSelectedId(a.id)
    setMsg(null)
    setForm({
      ...Object.fromEntries(QA_CHECKS.map(([k]) => [k, qa?.[k] ?? false])),
      qa_notes: qa?.qa_notes ?? '',
    })
  }

  async function viewReport(a) {
    if (!a.report_url) { setMsg({ kind: 'warn', text: 'No report file on this assignment (submitted via the old portal — file is in Retool storage).' }); return }
    const { data, error } = await supabase.storage.from('reports').createSignedUrl(a.report_url, 300)
    if (!error && data?.signedUrl) window.open(data.signedUrl, '_blank')
  }

  // A case is ready to send when every submitted evaluation on it is approved
  function caseAllApproved(caseId) {
    const subs = assignments.filter(a => a.case_id === caseId && a.submitted_at && a.contractor_id != null)
    return subs.length > 0 && subs.every(a => qaByAssignment.get(a.id)?.qa_status === 'approved')
  }

  // Download every report file for a case's evaluations, bundled into one .zip
  async function consolidateReports(caseId, caseRow) {
    setBusy(true); setMsg(null)
    try {
      const items = assignments.filter(a => a.case_id === caseId && a.submitted_at && a.contractor_id != null)
      const zipFiles = {}
      let count = 0
      for (const a of items) {
        const list = Array.isArray(a.report_files) && a.report_files.length
          ? a.report_files
          : (a.report_url ? [{ path: a.report_url, name: a.report_url.split('/').pop() }] : [])
        for (const f of list) {
          const { data, error } = await supabase.storage.from('reports').download(f.path)
          if (error || !data) continue
          const buf = new Uint8Array(await data.arrayBuffer())
          const base = `${a.eval_type || 'Eval'} - ${a.Contractors?.name || 'Contractor'} - ${f.name || f.path.split('/').pop()}`.replace(/[\\/:*?"<>|]+/g, '_')
          zipFiles[`${String(count + 1).padStart(2, '0')} - ${base}`] = buf
          count++
        }
      }
      if (!count) { setMsg({ kind: 'warn', text: 'No report files found to consolidate.' }); setBusy(false); return }
      const zipped = zipSync(zipFiles, { level: 6 })
      const blob = new Blob([zipped], { type: 'application/zip' })
      const url = URL.createObjectURL(blob)
      const el = document.createElement('a')
      el.href = url
      el.download = `${caseRow?.case_number || caseId} ${caseRow?.Student_name || ''} - reports.zip`.trim().replace(/\s+/g, ' ')
      document.body.appendChild(el); el.click(); el.remove()
      URL.revokeObjectURL(url)
      setMsg({ kind: 'success', text: `Consolidated ${count} report file${count === 1 ? '' : 's'} for ${caseRow?.Student_name || 'this student'} into one zip.` })
    } catch (e) {
      setMsg({ kind: 'danger', text: `Consolidation failed: ${e.message}` })
    }
    setBusy(false)
  }

  async function saveReview(status) {
    if (!selected) return
    setBusy(true); setMsg(null)
    const { error } = await supabase.from('qa_reviews').upsert({
      assignment_id: selected.id,
      ...form,
      qa_status: status,
      updated_at: new Date().toISOString(),
    })
    if (error) { setMsg({ kind: 'danger', text: error.message }); setBusy(false); return }

    if (status === 'approved') {
      // Create the contractor earning if it doesn't exist yet
      if (!earnings.some(e => e.assignment_id === selected.id) && selected.contractor_id != null) {
        const amount = parseRate(selected.Contractors?.current_rate)
        await supabase.from('contractor_earnings').insert({
          contractor_id: selected.contractor_id,
          assignment_id: selected.id,
          amount,
          billable_date: (selected.submitted_at || new Date().toISOString()).slice(0, 10),
          status: 'pending',
        })
      }
      // If every submitted assignment on this case is now approved, complete the case
      const siblings = assignments.filter(x => x.case_id === selected.case_id && x.contractor_id != null)
      const allApproved = siblings.every(x =>
        x.id === selected.id || qaByAssignment.get(x.id)?.qa_status === 'approved')
      if (allApproved) {
        await supabase.from('Cases').update({ Status: 'Completed' }).eq('id', selected.case_id)
      }
      setMsg({ kind: 'success', text: 'Approved. Earning created for the contractor; case auto-completes when all its reports are approved.' })
    } else {
      setMsg({ kind: 'info', text: status === 'needs_revision' ? 'Marked as needing revision.' : 'Review saved.' })
    }
    onChanged(); setBusy(false)
  }

  function downloadInvoice() {
    if (!selected) return
    const caseAssignments = assignments.filter(x => x.case_id === selected.case_id && x.contractor_id != null)
    const approved = caseAssignments.filter(x =>
      qaByAssignment.get(x.id)?.qa_status === 'approved' && x.submitted_at)
    const items = (approved.length > 0 ? approved : caseAssignments).map(x => ({
      assignmentId: x.id, evalType: x.eval_type || '', dateOfService: x.submitted_at,
    })).sort((a, b) => a.assignmentId - b.assignmentId)
    const minId = items.reduce((m, l) => Math.min(m, l.assignmentId), items[0]?.assignmentId ?? selected.id)
    generateInvoiceDoc({
      caseNumber: selected.Cases?.case_number || String(selected.case_id),
      studentName: selected.Cases?.Student_name || '',
      districtName: selected.Cases?.School_district || '',
      language: selected.Cases?.Language || null,
      invoiceNumber: `${selected.Cases?.case_number || selected.case_id}-${String(minId).padStart(4, '0')}`,
      lineItems: items.map(l => ({ evalType: l.evalType, dateOfService: l.dateOfService })),
    })
  }

  async function recordInvoice() {
    if (!selected) return
    setBusy(true); setMsg(null)
    const caseAssignments = assignments.filter(x => x.case_id === selected.case_id && x.contractor_id != null)
    const approvedCount = caseAssignments.filter(x => qaByAssignment.get(x.id)?.qa_status === 'approved').length || 1
    const { error } = await supabase.from('Invoices').insert({
      case_id: selected.case_id,
      district_name: selected.Cases?.School_district || null,
      amount: approvedCount * RATE_PER_EVAL,
      issued_date: new Date().toISOString().slice(0, 10),
      status: 'Sent',
    })
    if (!error) {
      await supabase.from('qa_reviews').update({ invoice_sent_at: new Date().toISOString(), invoice_status: 'sent' }).eq('assignment_id', selected.id)
    }
    setMsg(error ? { kind: 'danger', text: error.message } : { kind: 'success', text: `Invoice recorded in Client Invoices ($${(approvedCount * RATE_PER_EVAL).toLocaleString()}).` })
    onChanged(); setBusy(false)
  }

  const selectedQa = selected ? qaByAssignment.get(selected.id) : null

  return (
    <>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {[['all', 'All Submitted'], ['pending', `Pending Review`]].map(([id, label]) => (
          <span key={id} className={`filter-chip ${tab === id ? 'active' : ''}`} onClick={() => { setTab(id); setSelectedId(null) }}>{label}</span>
        ))}
      </div>
      {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="card-title">Submitted Reports ({rows.length})</div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Case</th><th>Student</th><th>Evaluation</th><th>Submitted</th><th>QA Status</th></tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={5} style={{ color: '#888' }}>Nothing awaiting review.</td></tr>}
                {caseGroups.map(g => {
                  if (g.items.length === 1) {
                    const a = g.items[0]
                    return (
                      <tr key={a.id} onClick={() => openReview(a)} style={{ cursor: 'pointer', background: selectedId === a.id ? 'var(--accent-light)' : undefined }}>
                        <td><span className="tbl-link">{a.Cases?.case_number || a.case_id}</span></td>
                        <td>{a.Cases?.Student_name || '—'}</td>
                        <td>{a.eval_type || '—'} — {a.Contractors?.name || '—'}</td>
                        <td>{fmtDate((a.submitted_at || '').slice(0, 10))}</td>
                        <td>{qaBadge(a)}</td>
                      </tr>
                    )
                  }
                  const approved = g.items.filter(x => qaByAssignment.get(x.id)?.qa_status === 'approved').length
                  const allApproved = caseAllApproved(g.case_id)
                  return (
                    <Fragment key={g.case_id}>
                      <tr style={{ cursor: 'pointer' }} onClick={() => toggle(g.case_id)}>
                        <td><span className="tbl-link">{g.caseRow?.case_number || g.case_id}</span></td>
                        <td>{g.caseRow?.Student_name || '—'}</td>
                        <td><span style={{ display: 'inline-block', width: 12 }}>{isOpen(g.case_id) ? '▾' : '▸'}</span>{g.items.length} evaluations</td>
                        <td>—</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <span className={`badge-s ${approved === g.items.length ? 's-completed' : 's-pending'}`}>{approved}/{g.items.length} approved</span>
                          {allApproved && <>{' '}<button className="btn btn-ghost btn-sm" title="Download all reports for this student as one zip" disabled={busy} onClick={e => { e.stopPropagation(); consolidateReports(g.case_id, g.caseRow) }}>📦</button></>}
                        </td>
                      </tr>
                      {isOpen(g.case_id) && g.items.map(a => (
                        <tr key={a.id} onClick={() => openReview(a)} style={{ cursor: 'pointer', background: selectedId === a.id ? 'var(--accent-light)' : '#f8fafc' }}>
                          <td></td>
                          <td></td>
                          <td style={{ paddingLeft: 24 }}>↳ {a.eval_type || '—'} — {a.Contractors?.name || '—'}</td>
                          <td>{fmtDate((a.submitted_at || '').slice(0, 10))}</td>
                          <td>{qaBadge(a)}</td>
                        </tr>
                      ))}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {selected && form ? (
          <div className="card" style={{ border: '2px solid var(--accent)' }}>
            <div className="card-title">
              🔍 Review — {selected.Cases?.case_number} · {selected.eval_type} · {selected.Contractors?.name}
            </div>
            <div style={{ marginBottom: 10 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => viewReport(selected)}>📄 View Report{selected.report_file_name ? ` (${selected.report_file_name})` : ''}</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 10 }}>
              {QA_CHECKS.map(([key, label]) => (
                <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!form[key]}
                    onChange={e => setForm(p => ({ ...p, [key]: e.target.checked }))} /> {label}
                </label>
              ))}
            </div>
            <div className="form-group">
              <label>Reviewer Notes</label>
              <textarea value={form.qa_notes} onChange={e => setForm(p => ({ ...p, qa_notes: e.target.value }))}
                placeholder="Notes for revisions or the record…" />
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => saveReview('approved')}>✅ Approve</button>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => saveReview('needs_revision')}>↩ Needs Revision</button>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => saveReview(selectedQa?.qa_status ?? 'in_review')}>💾 Save</button>
            </div>
            {selectedQa?.qa_status === 'approved' && (
              <div style={{ marginTop: 14, borderTop: '1px solid #e5e7eb', paddingTop: 12 }}>
                <div className="card-title" style={{ marginBottom: 8 }}>🧾 District Invoice</div>
                <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
                  ${RATE_PER_EVAL}/evaluation on Learning Tree letterhead.
                  {selectedQa.invoice_status ? ` Invoice status: ${selectedQa.invoice_status}.` : ''}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn btn-secondary btn-sm" onClick={downloadInvoice}>⬇ Download Invoice (.doc)</button>
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={recordInvoice}>Record in Client Invoices</button>
                </div>
              </div>
            )}
            {caseAllApproved(selected.case_id) && (
              <div style={{ marginTop: 14, borderTop: '1px solid #e5e7eb', paddingTop: 12 }}>
                <div className="card-title" style={{ marginBottom: 6 }}>📦 Consolidated Reports</div>
                <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
                  All evaluations for <strong>{selected.Cases?.Student_name}</strong> are approved — bundle every evaluator's report into one file to send out.
                </div>
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => consolidateReports(selected.case_id, selected.Cases)}>📦 Download all reports (.zip)</button>
              </div>
            )}
          </div>
        ) : (
          <div className="card" style={{ color: '#888' }}>Select a submitted report on the left to review it.</div>
        )}
      </div>
    </>
  )
}

function EmailLog({ emailLog, assignments, onChanged }) {
  const assignmentById = new Map(assignments.map(a => [a.id, a]))
  const [busy, setBusy] = useState(false)
  const [runResult, setRunResult] = useState(null)
  const [msg, setMsg] = useState(null)

  async function runReminders(dryRun) {
    setBusy(true); setMsg(null); setRunResult(null)
    const { data, error } = await supabase.functions.invoke('send-reminders', { body: { dry_run: dryRun } })
    if (error || !data?.success) {
      setMsg({ kind: 'danger', text: data?.error || error?.message || 'Reminder run failed.' })
    } else {
      setRunResult(data)
      if (!dryRun) onChanged()
    }
    setBusy(false)
  }

  return (
    <>
      <div className="card" style={{ marginBottom: 14, border: '2px solid var(--accent)' }}>
        <div className="card-title">🔔 Due-Date Reminders</div>
        <div style={{ fontSize: 13, color: '#555', marginBottom: 10 }}>
          Reminders go out automatically every morning (8am ET) to contractors whose reports are due in
          7 or 3 days. Use <strong>Preview</strong> to see who would get one today without sending anything.
        </div>
        {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => runReminders(true)}>👁 Preview today's reminders</button>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => runReminders(false)}>📤 Send now</button>
        </div>
        {runResult && (
          <div style={{ marginTop: 12 }}>
            {runResult.redirect_active && (
              <div className="alert alert-warn">🧪 Test mode is ON — every email is redirected to <strong>{runResult.redirect_to}</strong> instead of the contractor.</div>
            )}
            <div style={{ fontSize: 13, marginBottom: 6 }}>
              {runResult.dry_run ? 'Would send' : 'Sent'} <strong>{runResult.dry_run ? runResult.matched : runResult.sent}</strong> reminder{(runResult.dry_run ? runResult.matched : runResult.sent) === 1 ? '' : 's'}
              {' '}(windows: {runResult.checked_windows.join(', ')} days; from: {runResult.from})
            </div>
            {runResult.results.length > 0 && (
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th>Case</th><th>Contractor</th><th>Due</th><th>Days</th><th>To</th><th>Status</th></tr></thead>
                  <tbody>
                    {runResult.results.map((r, i) => (
                      <tr key={i}>
                        <td>{r.case_number || r.assignment_id}</td>
                        <td>{r.contractor || '—'}</td>
                        <td>{r.due_date ? fmtDate(r.due_date) : '—'}</td>
                        <td>{r.days}</td>
                        <td style={{ fontSize: 12 }}>{r.actual_to || r.intended_to || '—'}{r.redirected ? ' (redirected)' : ''}</td>
                        <td><Badge status={r.status === 'sent' ? 'Completed' : r.status === 'dry_run' ? 'Pending' : r.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="card">
        <div className="card-title">Sent Emails ({emailLog.length})</div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>When</th><th>To</th><th>Type</th><th>Case</th><th>Status</th></tr></thead>
            <tbody>
              {emailLog.length === 0 && <tr><td colSpan={5} style={{ color: '#888' }}>No emails sent yet.</td></tr>}
              {emailLog.map(e => {
                const a = assignmentById.get(e.assignment_id)
                return (
                  <tr key={e.id}>
                    <td>{new Date(e.sent_at).toLocaleString()}</td>
                    <td>{e.sent_to}</td>
                    <td>{(e.email_type || '').replace(/_/g, ' ')}</td>
                    <td>{a?.Cases?.case_number || '—'}</td>
                    <td><Badge status={e.status === 'delivered' ? 'Completed' : e.status} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

function DueMonitor({ assignments, onOpenCase }) {
  const rows = [...assignments].sort((a, b) => (a.report_due_date || '9999') < (b.report_due_date || '9999') ? -1 : 1)
  return (
    <div className="card">
      <div className="card-title">Upcoming &amp; Overdue Deadlines ({rows.length} open assignments)</div>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Case</th><th>Student</th><th>District</th><th>Eval Type</th><th>Contractor</th><th>Due</th><th>Days Left</th><th>Testing Date</th><th>Status</th></tr></thead>
          <tbody>
            {rows.slice(0, 300).map(a => {
              const n = daysLeft(a.report_due_date)
              return (
                <tr key={a.id}>
                  <td><span className="tbl-link" onClick={() => onOpenCase(a.case_id)}>{a.Cases?.case_number || a.case_id}</span></td>
                  <td>{a.Cases?.Student_name || '—'}</td>
                  <td>{a.Cases?.School_district || '—'}</td>
                  <td>{a.eval_type || '—'}</td>
                  <td>{a.Contractors?.name || <span className="badge-s s-unassigned">Unassigned</span>}</td>
                  <td style={dueColor(a.report_due_date)}>{fmtDate(a.report_due_date)}</td>
                  <td style={dueColor(a.report_due_date)}>{n === null ? '—' : n < 0 ? `${-n} overdue` : n}</td>
                  <td>{a.testing_date ? fmtDate(a.testing_date) : <span style={{ color: 'var(--red)' }}>Not set</span>}</td>
                  <td><Badge status={a.status} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
