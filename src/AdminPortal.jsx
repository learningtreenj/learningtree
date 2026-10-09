import { Fragment, useEffect, useMemo, useState } from 'react'
import { supabase, fetchAll, STATUSES, fmtDate, daysLeft, dueColor, parseRate, toISODate } from './supabase.js'
import { Shell, Badge, StatCard, Meta } from './ui.jsx'
import { generateInvoiceDoc, RATE_PER_EVAL } from './invoice.js'
import { getRate, invalidateRates, loadRates, rateForLanguage } from './rates.js'
import DistrictHeatmap from './DistrictHeatmap.jsx'
import { contractorLanguages, contractorSpeaks } from './contractorLangs.js'
import { scoreContractors } from './smartAssign.js'
import { extractTextFromFile } from './extractDocumentText.js'
import { exportCasesToExcel, exportPayrollToExcel } from './exportExcel.js'
import { zipSync } from 'fflate'

const EVAL_TYPES = ['Speech', 'Educational', 'Psych', 'Social', 'OT', 'PT']
const CASE_STATUSES = ['Unassigned', 'Assigned', 'In Progress', 'Report Submitted', 'Pending Approval', 'Completed']
const GRADES = ['Pre-K', 'K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']

// Canonical picklists for the contractor editor
const CONTRACTOR_FIELDS = ['Speech Pathologist', 'Psychologist', 'Learning Consultant', 'Social Worker', 'Occupational Therapist', 'Physical Therapist', 'Translator', 'Interpreter']
const LANGUAGES = ['English', 'Spanish', 'Portuguese', 'Arabic', 'Creole', 'Russian', 'Chinese', 'Mandarin', 'Cantonese', 'Hebrew', 'Polish', 'Korean', 'Italian', 'French', 'Turkish', 'Vietnamese', 'Urdu', 'Hindi', 'Punjabi', 'Gujarati', 'Bengali', 'Tamil', 'Telugu', 'Marathi', 'Malayalam', 'Kannada', 'Tagalog', 'Japanese', 'Ukrainian', 'Persian', 'Greek', 'Indonesian']


// ---------------------------------------------------------------------------
// Client Invoices — auto-recording
// A district invoice is recorded the moment every report on a case clears QA.
// It lands as Draft (the work is billable but not yet out the door) and flips
// to Sent when the case is marked sent to the district. Repeat calls are safe:
// the invoice number is unique in the database, so a case can only ever
// produce one auto-recorded invoice.
// ---------------------------------------------------------------------------
const INVOICE_TERMS_DAYS = 30 // Net 30

// Local-calendar date helpers. Deliberately not routed through the shared
// toISODate(), which normalises via UTC and can land a day early in the evening.
function localISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function todayISO() { return localISO(new Date()) }

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00`)
  d.setDate(d.getDate() + days)
  return localISO(d)
}

// caseRow needs: id, case_number, Student_name, School_district, Language
async function autoRecordInvoice(caseRow, approvedCount) {
  if (!caseRow?.id) return { skipped: 'no case' }
  // Reuse the suffix already printed on the invoice document, or allocate it now.
  const { data: seq, error: seqErr } = await supabase.rpc('allocate_invoice_seq', { p_case_id: caseRow.id })
  if (seqErr) return { error: seqErr.message }
  const invoice_number = `${caseRow.case_number || caseRow.id}-${seq}`

  const { data: existing } = await supabase.from('Invoices').select('id').eq('invoice_number', invoice_number).maybeSingle()
  if (existing) return { skipped: 'already recorded', invoice_number }

  const rate = await getRate(caseRow.Language)
  const amount = Math.max(Number(approvedCount) || 0, 1) * rate
  const issued_date = todayISO()
  const { error } = await supabase.from('Invoices').insert({
    case_id: caseRow.id,
    invoice_number,
    student_name: caseRow.Student_name || null,
    district_name: caseRow.School_district || null,
    amount,
    issued_date,
    due_date: addDays(issued_date, INVOICE_TERMS_DAYS),
    status: 'Draft',
  })
  return error ? { error: error.message } : { created: true, invoice_number, amount }
}

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

// Multi-select checkbox group; preserves any existing values not in the standard option list
function MultiCheck({ selected, options, onToggle }) {
  const extras = (selected || []).filter(s => !options.includes(s))
  const all = [...options, ...extras]
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, border: '1px solid var(--border)', borderRadius: 5, padding: '7px 9px' }}>
      {all.map(o => (
        <label key={o} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={(selected || []).includes(o)} onChange={() => onToggle(o)} /> {options.includes(o) ? o : `${o} (existing)`}
        </label>
      ))}
    </div>
  )
}

// Four-status model (case-level and per-eval):
//   Pending Assignment → Assigned → Report Received → Complete
// "Complete" = admin marked the case sent to the district (Cases.sent_to_district_at).
function evalTypeStatus(a, caseRow) {
  if (caseRow?.sent_to_district_at) return { label: 'Complete', cls: 's-completed' }
  if (!a || a.contractor_id == null) return { label: 'Pending Assignment', cls: 's-unassigned' }
  if ((a.status || '').toLowerCase() === 'submitted') return { label: 'Report Received', cls: 's-drafting' }
  return { label: 'Assigned', cls: 's-assigned' }
}

// Short display labels for evaluation types (Cases + Dashboard). Non-standard types
// (OT, PT, etc.) pass through unchanged.
function abbrevEval(t) {
  const s = (t || '').toLowerCase()
  if (s.includes('psych')) return 'Psych'
  if (s.includes('speech') || s.includes('language')) return 'Sp.'
  if (s.includes('educ')) return 'Ed.'
  if (s.includes('social')) return 'Soc.'
  return t
}
function abbrevEvals(str) {
  return (str || '').split(',').map(t => abbrevEval(t.trim())).filter(Boolean).join(', ')
}

// Dashboard evaluation-type pills — abbreviated, each a unique color.
const DASH_EVAL_LEGEND = [
  { label: 'Spch', bg: '#e2eefb', fg: '#1a56a0' },   // blue
  { label: 'Psych', bg: '#efe9fb', fg: '#5b3fa3' },  // purple
  { label: 'Ed', bg: '#e5f3e2', fg: '#2c6b2f' },     // green
  { label: 'Soc.', bg: '#fdeede', fg: '#9a5b12' },   // amber
  { label: 'OT/Other', bg: '#e0f2f0', fg: '#0f6e56' }, // teal
]
function evalPillInfo(evalType) {
  const s = (evalType || '').toLowerCase()
  if (s.includes('speech') || s.includes('language')) return DASH_EVAL_LEGEND[0]
  if (s.includes('psych')) return DASH_EVAL_LEGEND[1]
  if (s.includes('educ')) return DASH_EVAL_LEGEND[2]
  if (s.includes('social')) return DASH_EVAL_LEGEND[3]
  return DASH_EVAL_LEGEND[4]
}
function EvalPill({ evalType }) {
  const p = evalPillInfo(evalType)
  return <span title={evalType || ''} style={{ display: 'inline-block', fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 6, background: p.bg, color: p.fg }}>{p.label}</span>
}

// Fixed evaluation-type columns for the Cases table. Everything that isn't one of the
// four standard types (OT, PT, etc.) buckets into "Other".
const EVAL_COLS = ['Psych', 'Sp.', 'Ed.', 'Soc.', 'Other']
function evalCol(t) {
  const s = (t || '').toLowerCase()
  if (s.includes('psych')) return 'Psych'
  if (s.includes('speech') || s.includes('language')) return 'Sp.'
  if (s.includes('educ')) return 'Ed.'
  if (s.includes('social')) return 'Soc.'
  return 'Other'
}

// Build one expanded sub-row per requested eval type: matched assignment (evaluator + status) or unassigned
function buildEvalBreakdown(caseRow, asgs) {
  const requested = (caseRow.evaluation_type || '').split(',').map(t => t.trim()).filter(Boolean)
  const rows = []
  const covered = new Set()
  for (const a of asgs) {
    rows.push({ evalType: a.eval_type || '—', evaluator: a.Contractors?.name || null, status: evalTypeStatus(a, caseRow), a })
    if (a.eval_type) covered.add(a.eval_type.toLowerCase())
  }
  for (const t of requested) {
    if (!covered.has(t.toLowerCase())) rows.push({ evalType: t, evaluator: null, status: evalTypeStatus(null, caseRow), a: null })
  }
  return rows
}

// Single source of truth for a case's row-level status (display, sort, filter). One of:
// Pending Assignment / Assigned / Report Received / Complete.
function caseStatusLabel(c, asg) {
  if (c.sent_to_district_at) return 'Complete'
  if (!asg || asg.length === 0) return 'Pending Assignment'
  const reqTypes = (c.evaluation_type || '').split(',').map(t => t.trim()).filter(Boolean)
  const covered = new Set(asg.map(a => (a.eval_type || '').toLowerCase()))
  const allSubmitted = reqTypes.every(t => covered.has(t.toLowerCase()))
    && asg.every(a => a.contractor_id != null && (a.status || '').toLowerCase() === 'submitted')
  if (allSubmitted) return 'Report Received'
  return 'Assigned'
}
// A case is "due soon" when reports are still outstanding (not Complete, not all received)
// and it is due within 7 days or already overdue. The sidebar "Cases" badge and the Cases
// page "Due Soon" chip both use this, so the two numbers always agree.
function caseDueSoon(c, asg) {
  const lbl = caseStatusLabel(c, asg)
  if (lbl === 'Complete' || lbl === 'Report Received') return false
  const soon = d => { const n = daysLeft(d); return n !== null && n <= 7 }
  return soon(c.Report_Due_date) || (asg || []).some(a => (a.status || '').toLowerCase() !== 'submitted' && soon(a.report_due_date))
}
function caseStatusCls(label) {
  const l = (label || '').toLowerCase()
  if (l === 'complete') return 's-completed'          // green
  if (l === 'report received') return 's-drafting'    // purple
  if (l === 'assigned') return 's-assigned'           // blue
  if (l === 'pending assignment') return 's-unassigned' // red
  return 's-assigned'
}

// How contractors can be paid (Contractors.preferred_payment_method).
const PAYMENT_METHODS = ['Direct Deposit', 'Zelle', 'Check', 'Other']

// Calendar day (YYYY-MM-DD) a report was received. Imported legacy rows were stored
// date-only at midnight UTC — keep that day as-is; real uploads use the local day.
function receivedISO(ts) {
  if (!ts) return ''
  const s = String(ts)
  if (/T00:00:00(\.0+)?(Z|[+-]00(:?00)?)?$/.test(s)) return s.slice(0, 10)
  const d = new Date(s)
  if (isNaN(d)) return s.slice(0, 10)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Payroll cutoff: reports received through the 25th are paid in that month's payroll;
// anything received on the 26th or later rolls into the next month's payroll.
const PAYROLL_CUTOFF_DAY = 25
function payrollMonthOf(isoDate) {
  const [y, m, d] = String(isoDate || '').slice(0, 10).split('-').map(Number)
  if (!y || !m) return ''
  const dt = d > PAYROLL_CUTOFF_DAY ? new Date(y, m, 1) : new Date(y, m - 1, 1)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`
}
// The receiving window behind a payroll month ('YYYY-MM'), e.g. "Sep 26 – Oct 25, 2026".
function payrollPeriodLabel(ym) {
  const [y, m] = String(ym || '').split('-').map(Number)
  if (!y || !m) return ''
  const start = new Date(y, m - 2, PAYROLL_CUTOFF_DAY + 1), end = new Date(y, m - 1, PAYROLL_CUTOFF_DAY)
  const f = (dt, withYear) => dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) })
  return `${f(start, start.getFullYear() !== end.getFullYear())} – ${f(end, true)}`
}

// Whole days an assignment has been awaiting the contractor's acceptance
// (since they were emailed the assignment). Null if we don't have that timestamp.
function daysWaiting(a) {
  const since = a?.assignment_email_sent_at
  if (!since) return null
  return Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 86400000))
}

// Shows whether the contractor has accepted/declined an assignment
function AcceptBadge({ a }) {
  const s = (a?.acceptance_status || 'pending').toLowerCase()
  if (s === 'accepted') return <span className="badge-s s-completed">✓ Accepted</span>
  if (s === 'declined') return <span className="badge-s s-overdue">✕ Declined</span>
  const d = daysWaiting(a)
  return <span className="badge-s s-pending">Awaiting{d !== null ? ` · ${d}d` : ''}</span>
}

export default function AdminPortal({ user }) {
  const [screen, setScreen] = useState('cases')
  const [cases, setCases] = useState([])
  const [assignments, setAssignments] = useState([])
  const [contractors, setContractors] = useState([])
  const [invoices, setInvoices] = useState([])
  const [qaReviews, setQaReviews] = useState([])
  const [earnings, setEarnings] = useState([])
  const [batches, setBatches] = useState([])
  const [emailLog, setEmailLog] = useState([])
  const [selectedCase, setSelectedCase] = useState(null)
  const [contractorLang, setContractorLang] = useState(null) // language filter from dashboard click
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    const [c, a, k, i, q, e, b, m] = await Promise.all([
      fetchAll(() => supabase.from('Cases').select('*').order('id', { ascending: false })),
      fetchAll(() => supabase.from('Assignments').select('*, Contractors(identifier, name, current_rate, email), Cases(id, case_number, Student_name, School_district, Language, County, district_paid, district_payment_date, invoice_seq, Report_Due_date, sent_to_district_at)').order('report_due_date', { ascending: true, nullsFirst: false }).order('id')),
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

  // Open = not submitted AND the case isn't marked complete (sent to district). A completed
  // case never counts as overdue/due anywhere, even if its reports were never uploaded
  // (e.g. legacy imported cases).
  const openAssignments = assignments.filter(x => (x.status || '').toLowerCase() !== 'submitted' && !x.Cases?.sent_to_district_at)
  const dueThisWeek = openAssignments.filter(x => { const n = daysLeft(x.report_due_date); return n !== null && n <= 7 })
  const qaByAssignment = useMemo(() => new Map(qaReviews.map(q => [q.assignment_id, q])), [qaReviews])
  const awaitingQa = assignments.filter(a => a.submitted_at && qaByAssignment.get(a.id)?.qa_status !== 'approved')
  // Sidebar "Cases" badge = number of CASES due soon / overdue (same list as the Due Soon chip).
  const dueSoonCaseCount = useMemo(() => {
    const by = {}
    for (const a of assignments) { (by[a.case_id] = by[a.case_id] || []).push(a) }
    return cases.filter(c => caseDueSoon(c, by[c.id] || [])).length
  }, [cases, assignments])

  const nav = [
    { label: 'Operations', items: [
      { id: 'dashboard', icon: '📊', label: 'Dashboard' },
      { id: 'referral', icon: '📥', label: 'New Referral' },
      { id: 'cases', icon: '📋', label: 'Cases', badge: dueSoonCaseCount || null },
      { id: 'contractors', icon: '👥', label: 'Contractors' },
      { id: 'interpreters', icon: '🗣️', label: 'Interpreters' },
    ]},
    { label: 'Documents & Finance', items: [
      { id: 'qa', icon: '🔍', label: 'Report Review', badge: awaitingQa.length || null },
      { id: 'invoices', icon: '🧾', label: 'Client Invoices' },
      { id: 'payroll', icon: '💰', label: 'Payroll' },
      { id: 'rates', icon: '💵', label: 'Rate Table' },
    ]},
    { label: 'Monitoring', items: [
      { id: 'due', icon: '⏰', label: 'Due Date Monitor' },
      { id: 'emaillog', icon: '📧', label: 'Email Log' },
    ]},
  ]

  const titles = { dashboard: 'Dashboard', referral: 'New Referral Intake', cases: 'Cases', casedetail: 'Case Detail', contractors: 'Contractors', interpreters: 'Translators & Interpreters', qa: 'Report Review & QA', invoices: 'Client Invoices', payroll: 'Payroll & Payment Batches', rates: 'Language Rate Table', due: 'Due Date Monitor', emaillog: 'Email Log' }

  return (
    <Shell brand="BEval Portal" sub="Admin / Coordinator"
      userName={user.email} userRole="Administrator"
      navSections={nav} active={screen === 'casedetail' ? 'cases' : screen}
      onNav={id => { setScreen(id); setSelectedCase(null); setContractorLang(null) }}
      onLogout={() => supabase.auth.signOut()}
      title={titles[screen]}
      topbarExtra={<button className="btn btn-primary btn-sm" onClick={() => setScreen('referral')}>+ New Referral</button>}>

      {screen === 'dashboard' && <Dashboard assignments={assignments} openAssignments={openAssignments} dueThisWeek={dueThisWeek} loading={loading}
        onOpenCase={c => { setSelectedCase(c); setScreen('casedetail') }} cases={cases} earnings={earnings} contractors={contractors}
        onLanguage={lang => { setContractorLang(lang); setScreen('contractors') }} />}
      {screen === 'referral' && <NewReferral onCreated={c => { load(); setSelectedCase(c); setScreen('casedetail') }} />}
      {screen === 'cases' && <CaseList cases={cases} assignments={assignments} contractors={contractors} earnings={earnings} batches={batches} loading={loading}
        onOpen={c => { setSelectedCase(c); setScreen('casedetail') }} onChanged={load} />}
      {screen === 'casedetail' && selectedCase && <CaseDetail caseRow={selectedCase} assignments={assignments.filter(a => a.case_id === selectedCase.id)}
        allAssignments={assignments} contractors={contractors} qaByAssignment={qaByAssignment} earnings={earnings} onBack={() => setScreen('cases')} onChanged={load} />}
      {screen === 'interpreters' && <InterpreterRequests contractors={contractors} />}
      {screen === 'contractors' && <ContractorList contractors={contractors} assignments={assignments} onChanged={load}
        languageFilter={contractorLang} onClearLanguageFilter={() => setContractorLang(null)} />}
      {screen === 'qa' && <QaQueue assignments={assignments} qaByAssignment={qaByAssignment} earnings={earnings} onChanged={load} />}
      {screen === 'invoices' && <InvoiceList invoices={invoices} cases={cases} onChanged={load} />}
      {screen === 'payroll' && <Payroll assignments={assignments} earnings={earnings} batches={batches} contractors={contractors} onChanged={load} />}
      {screen === 'rates' && <RateTable />}
      {screen === 'due' && <DueMonitor assignments={openAssignments} onOpenCase={id => { const c = cases.find(x => x.id === id); if (c) { setSelectedCase(c); setScreen('casedetail') } }} />}
      {screen === 'emaillog' && <EmailLog emailLog={emailLog} assignments={assignments} onChanged={load} />}
    </Shell>
  )
}

// Editable per-language rate table (backs the invoice rate lookup). Reads/writes the
// Supabase `languages-pay-rates` table (columns LANGUAGE, Rate).
function RateTable() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [edits, setEdits] = useState({})
  const [newLang, setNewLang] = useState('')
  const [newRate, setNewRate] = useState('')

  async function load() {
    setLoading(true)
    const { data, error } = await supabase.from('languages-pay-rates').select('*').order('LANGUAGE')
    if (error) setMsg({ kind: 'danger', text: error.message })
    setRows(data || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  async function saveRate(lang) {
    const val = Math.round(Number(edits[lang]))
    if (!Number.isFinite(val) || val < 0) { setMsg({ kind: 'warn', text: 'Enter a valid rate.' }); return }
    setBusy(true); setMsg(null)
    const { error } = await supabase.from('languages-pay-rates').update({ Rate: val }).eq('LANGUAGE', lang)
    if (error) { setMsg({ kind: 'danger', text: error.message }); setBusy(false); return }
    invalidateRates()
    setEdits(p => { const n = { ...p }; delete n[lang]; return n })
    setMsg({ kind: 'success', text: `Updated ${lang} to $${val}.` })
    await load(); setBusy(false)
  }

  async function addLang() {
    const lang = newLang.trim()
    const val = Math.round(Number(newRate))
    if (!lang) { setMsg({ kind: 'warn', text: 'Enter a language name.' }); return }
    if (!Number.isFinite(val) || val < 0) { setMsg({ kind: 'warn', text: 'Enter a valid rate.' }); return }
    setBusy(true); setMsg(null)
    const { error } = await supabase.from('languages-pay-rates').insert({ LANGUAGE: lang, Rate: val })
    if (error) { setMsg({ kind: 'danger', text: /duplicate|unique/i.test(error.message) ? `${lang} is already in the table.` : error.message }); setBusy(false); return }
    invalidateRates()
    setNewLang(''); setNewRate('')
    setMsg({ kind: 'success', text: `Added ${lang} ($${val}).` })
    await load(); setBusy(false)
  }

  async function removeLang(lang) {
    if (!window.confirm(`Remove ${lang} from the rate table? Invoices for this language will fall back to the $880 default.`)) return
    setBusy(true); setMsg(null)
    const { error } = await supabase.from('languages-pay-rates').delete().eq('LANGUAGE', lang)
    if (error) { setMsg({ kind: 'danger', text: error.message }); setBusy(false); return }
    invalidateRates()
    setMsg({ kind: 'success', text: `Removed ${lang}.` })
    await load(); setBusy(false)
  }

  return (
    <>
      {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="card-title">Language Rates ({rows.length})</div>
          <p style={{ color: '#888', fontSize: 13, marginBottom: 10 }}>
            Per-evaluation rate billed to districts, by language. Used to auto-fill invoice amounts.
            Languages not listed here bill at the $880 default.
          </p>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Language</th><th style={{ width: 140 }}>Rate ($)</th><th style={{ width: 150 }}></th></tr></thead>
              <tbody>
                {loading && <tr><td colSpan={3} style={{ color: '#888' }}>Loading…</td></tr>}
                {!loading && rows.length === 0 && <tr><td colSpan={3} style={{ color: '#888' }}>No languages yet — add one on the right.</td></tr>}
                {rows.map(r => {
                  const lang = r.LANGUAGE
                  const dirty = edits[lang] !== undefined && Math.round(Number(edits[lang])) !== Number(r.Rate)
                  return (
                    <tr key={lang}>
                      <td>{lang}</td>
                      <td>
                        <input type="number" min="0" step="10" style={{ width: 100 }}
                          value={edits[lang] !== undefined ? edits[lang] : r.Rate}
                          onChange={e => setEdits(p => ({ ...p, [lang]: e.target.value }))} />
                      </td>
                      <td>
                        <button className="btn btn-primary btn-sm" disabled={busy || !dirty} onClick={() => saveRate(lang)}>Save</button>
                        {' '}
                        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => removeLang(lang)} title="Remove language">🗑</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-title">Add a Language</div>
          <div className="form-group"><label>Language</label>
            <input value={newLang} onChange={e => setNewLang(e.target.value)} placeholder="e.g. Bengali" /></div>
          <div className="form-group"><label>Rate ($ per evaluation)</label>
            <input type="number" min="0" step="10" value={newRate} onChange={e => setNewRate(e.target.value)} placeholder="880" /></div>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={addLang}>+ Add Language</button>
        </div>
      </div>
    </>
  )
}

// Total contractors per language across the whole database (a contractor is counted
// once per distinct language they speak). Clicking a language opens the Contractors
// page filtered to those who speak it.
function ContractorsByLanguage({ contractors = [], onLanguage }) {
  const langs = useMemo(() => {
    const m = new Map()
    for (const k of contractors) for (const l of contractorLanguages(k)) m.set(l, (m.get(l) || 0) + 1)
    return [...m.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
  }, [contractors])
  const max = langs[0]?.n || 1

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Contractors by Language</span>
        <span style={{ fontSize: 12, color: '#888', fontWeight: 400 }}>{contractors.length} contractors · click to view</span>
      </div>
      {langs.length === 0 && <div style={{ color: '#888', fontSize: 13 }}>No contractor language data yet.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
        {langs.map(l => {
          const r = l.n / max
          const bg = r >= 0.67 ? '#185FA5' : r >= 0.34 ? '#378ADD' : '#B5D4F4'
          const ink = r >= 0.34 ? '#fff' : '#0C447C'
          return (
            <button key={l.name} onClick={() => onLanguage && onLanguage(l.name)}
              title={`View the ${l.n} contractor${l.n === 1 ? '' : 's'} who speak ${l.name}`}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, cursor: 'pointer',
                border: '1px solid var(--border, #e2e6ea)', borderRadius: 8, background: 'var(--gray-bg, #f4f6f8)',
                padding: '9px 12px', textAlign: 'left', font: 'inherit',
              }}>
              <span style={{ fontSize: 13, color: 'var(--text, #222)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.name}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 26, height: 22, padding: '0 7px', borderRadius: 11, background: bg, color: ink, fontSize: 13, fontWeight: 700 }}>{l.n}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Dashboard({ assignments, openAssignments, dueThisWeek, cases, loading, onOpenCase, earnings = [], contractors = [], onLanguage }) {
  const now = new Date().toISOString().slice(0, 7)
  const completedThisMonth = assignments.filter(a => (a.submitted_at || '').slice(0, 7) === now).length
  const awaiting = openAssignments.filter(a => /testing complet|draft/i.test(a.status || '')).length
  const overdue = openAssignments.filter(a => { const n = daysLeft(a.report_due_date); return n !== null && n < 0 })

  const [expanded, setExpanded] = useState({})
  const toggle = name => setExpanded(p => ({ ...p, [name]: !p[name] }))
  const statusBadge = (a) => { const s = evalTypeStatus(a, a.Cases); return <span className={`badge-s ${s.cls}`}>{s.label}</span> }
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

  // Filter the dashboard by evaluator — type a name and/or check names (Excel-style)
  const [cFilter, setCFilter] = useState('')
  const [cChecks, setCChecks] = useState([])
  const [cMenu, setCMenu] = useState(false)
  useEffect(() => {
    if (!cMenu) return
    const h = () => setCMenu(false)
    document.addEventListener('click', h)
    return () => document.removeEventListener('click', h)
  }, [cMenu])
  const contractorOptions = useMemo(() => [...new Set(openAssignments.map(a => a.Contractors?.name).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [openAssignments])
  const filteredGroups = studentGroups.filter(g => {
    const names = g.items.map(a => a.Contractors?.name || '')
    const textOk = !cFilter.trim() || names.some(n => n.toLowerCase().includes(cFilter.trim().toLowerCase()))
    const checkOk = cChecks.length === 0 || names.some(n => cChecks.includes(n))
    return textOk && checkOk
  })

  return (
    <>
      {overdue.length > 0 && <div className="alert alert-danger">⚠️ <span><strong>{overdue.length} assignment{overdue.length > 1 ? 's are' : ' is'} past due.</strong> Check the Due Date Monitor.</span></div>}
      <div className="stat-grid stat-grid-4">
        <StatCard num={dueThisWeek.length} label="Due This Week" color="blue" />
        <StatCard num={openAssignments.length} label="Open Assignments" color="yellow" />
        <StatCard num={completedThisMonth} label="Submitted This Month" color="green" />
        <StatCard num={awaiting} label="Awaiting Reports" color="orange" />
      </div>
      <DistrictHeatmap cases={cases} assignments={assignments} />
      <ContractorsByLanguage contractors={contractors} onLanguage={onLanguage} />
      <div className="card">
        <div className="card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            Upcoming Due Dates
            <span style={{ display: 'inline-flex', gap: 5, fontWeight: 400 }}>
              {DASH_EVAL_LEGEND.map(p => (
                <span key={p.label} style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 6, background: p.bg, color: p.fg }}>{p.label}</span>
              ))}
            </span>
          </span>
          <div style={{ position: 'relative', fontWeight: 400, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="text" placeholder="🔍 Filter by evaluator…" value={cFilter} onChange={e => setCFilter(e.target.value)}
              style={{ padding: '5px 8px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 5, width: 190 }} />
            <button className="btn btn-ghost btn-sm" onClick={e => { e.stopPropagation(); setCMenu(m => !m) }}>
              Evaluators{cChecks.length ? ` (${cChecks.length})` : ''} ▾
            </button>
            {cMenu && (
              <div onClick={e => e.stopPropagation()} style={{ position: 'absolute', right: 0, top: '100%', zIndex: 20, background: '#fff', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,.18)', padding: 8, minWidth: 220, maxHeight: 280, overflowY: 'auto', textAlign: 'left' }}>
                {contractorOptions.length === 0 && <div style={{ fontSize: 12, color: '#888' }}>No evaluators with open cases</div>}
                {contractorOptions.map(n => (
                  <label key={n} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, padding: '2px 0', cursor: 'pointer' }}>
                    <input type="checkbox" checked={cChecks.includes(n)} onChange={() => setCChecks(p => p.includes(n) ? p.filter(x => x !== n) : [...p, n])} /> {n}
                  </label>
                ))}
                {cChecks.length > 0 && <div style={{ marginTop: 6 }}><span className="tbl-link" style={{ fontSize: 12 }} onClick={() => setCChecks([])}>Clear</span></div>}
              </div>
            )}
          </div>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Case #</th><th>Student</th><th>Evaluation</th><th>Contractor</th><th>Due Date</th><th>Days Left</th><th>Status</th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={7} style={{ color: '#888' }}>Loading…</td></tr>}
              {!loading && filteredGroups.length === 0 && <tr><td colSpan={7} style={{ color: '#888' }}>No open assignments.</td></tr>}
              {filteredGroups.slice(0, 15).map(g => {
                const items = g.items
                const nearest = items[0]
                const sameCase = items.every(x => x.case_id === items[0].case_id) ? items[0] : null
                const evaluators = [...new Set(items.map(x => x.Contractors?.name).filter(Boolean))]
                return (
                  <tr key={g.name}>
                    <td>{sameCase
                      ? <span className="tbl-link" onClick={() => openCaseById(sameCase.case_id)}>{sameCase.Cases?.case_number || sameCase.case_id}</span>
                      : <span style={{ color: '#888' }}>multiple</span>}</td>
                    <td style={{ fontWeight: 600 }}>{g.name}</td>
                    <td><span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>{items.map(a => <EvalPill key={a.id} evalType={a.eval_type} />)}</span></td>
                    <td>{evaluators.length ? evaluators.join(', ') : <span className="badge-s s-unassigned">Unassigned</span>}</td>
                    <td style={dueColor(nearest.report_due_date)}>{fmtDate(nearest.report_due_date)}</td>
                    <td style={dueColor(nearest.report_due_date)}>{daysLeft(nearest.report_due_date) ?? '—'}</td>
                    <td>{items.length === 1 ? statusBadge(items[0]) : <span className="badge-s s-assigned">Assigned</span>}</td>
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

// Base64-encode a byte array in chunks (btoa on a huge binary string overflows the stack)
function bytesToBase64(bytes) {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(bin)
}

function NewReferral({ onCreated }) {
  const empty = {
    case_number: '',
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
    const phoneDigits = f.parents_phone.replace(/\D/g, '')
    const row = {
      // Blank → the database trigger auto-generates the next YY-NNNN case number.
      case_number: (f.case_number || '').trim() || null,
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
    if (error) {
      const dup = /case_number/i.test(error.message) && /duplicate|unique/i.test(error.message)
      const entered = (f.case_number || '').trim()
      setMsg({ kind: 'danger', text: dup ? `Case # ${entered || '(entered)'} already exists — choose a different number or leave it blank to auto-number.` : error.message })
      setBusy(false); return
    }

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
    if (ext === 'pdf') {
      // Always send the PDF image so the AI can SEE which boxes are checked — a PDF's
      // text layer doesn't carry checkbox/highlight state. Include the extracted text
      // too (when present) to sharpen field reading.
      setMsg({ kind: 'info', text: 'Reading the referral with AI (checking every box)… this can take a little longer.' })
      try {
        const buf = await file.arrayBuffer()
        invokeBody = { pdf_base64: bytesToBase64(new Uint8Array(buf)) }
        if (text && text.trim().length >= 20) invokeBody.text = text
      } catch (err) {
        setMsg({ kind: 'danger', text: `Could not read the PDF: ${err.message}` }); setParsing(false); return
      }
    } else if (text && text.trim().length >= 20) {
      invokeBody = { text }
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
      <div className="alert alert-info">Leave the case number blank to auto-assign the next number, or enter one manually to override. After creating the case you can assign contractors.</div>

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

      <SectionHead>Case Number</SectionHead>
      <div className="form-row">
        <div className="form-group">
          <label>Case #</label>
          <input value={f.case_number} onChange={e => set('case_number', e.target.value)} placeholder="Auto-assigned if left blank" />
          <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>Leave blank to auto-number (next is 26-0450), or type one to override.</div>
        </div>
        <div className="form-group"></div>
      </div>

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

function contractorOptLabel(k) {
  const spec = [k.field, [k.language, k.language_2].filter(Boolean).join('/')].filter(Boolean)
  return k.name + (spec.length ? ` — ${spec.join(' · ')}` : '')
}

// Maps an eval-type column to the keyword scoreContractors understands.
const EVAL_SCORE_KEY = { Psych: 'psych', 'Sp.': 'speech', 'Ed.': 'ed', 'Soc.': 'social' }

// Click-to-edit popover for one eval-type cell: reassign/remove existing evaluators,
// or assign one to a requested-but-empty eval. The assign picker shows language- and
// field-matched recommendations (same scoring as Case Detail). Positioned at the click.
function CellEditor({ anchor, caseRow, col, token, cellAsg, contractors, assignments = [], busy, onReassign, onRemove, onAssign, onClose }) {
  const [addTo, setAddTo] = useState('')
  const [reSel, setReSel] = useState({})
  const left = Math.max(8, Math.min(anchor.x, (typeof window !== 'undefined' ? window.innerWidth : 1000) - 360))
  const top = Math.max(8, Math.min(anchor.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 320))

  const evalForScore = token || EVAL_SCORE_KEY[col] || ''
  const activeCounts = useMemo(() => {
    const m = new Map()
    for (const a of assignments) {
      if (a.contractor_id == null || (a.status || '').toLowerCase() === 'submitted') continue
      m.set(a.contractor_id, (m.get(a.contractor_id) || 0) + 1)
    }
    return m
  }, [assignments])
  const recs = useMemo(
    () => token ? scoreContractors(contractors, activeCounts, evalForScore, caseRow.Language, caseRow.County).slice(0, 8) : [],
    [token, contractors, activeCounts, evalForScore, caseRow])

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 49 }} />
      <div onClick={e => e.stopPropagation()} style={{ position: 'fixed', left, top, zIndex: 50, background: '#fff', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 8px 28px rgba(0,0,0,.22)', padding: 12, width: 330, fontSize: 13 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>{caseRow.case_number || caseRow.id} · {col}</div>
        {cellAsg.length === 0 && <div style={{ color: '#888', marginBottom: 4 }}>No evaluator assigned yet.</div>}
        {cellAsg.map(a => {
          const sub = (a.status || '').toLowerCase() === 'submitted'
          return (
            <div key={a.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 8 }}>
              <div style={{ marginBottom: 5 }}>{a.Contractors?.name || 'Assigned'} {sub && <span style={{ color: '#1a7a3c' }}>· submitted</span>}</div>
              <select value={reSel[a.id] ?? String(a.contractor_id ?? '')} onChange={e => setReSel(p => ({ ...p, [a.id]: e.target.value }))} style={{ width: '100%', padding: '5px 6px' }}>
                {contractors.map(k => <option key={k.identifier} value={k.identifier}>{contractorOptLabel(k)}</option>)}
              </select>
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => onReassign(a, reSel[a.id] ?? a.contractor_id)}>Reassign</button>
                <button className="btn btn-danger-outline btn-sm" disabled={busy} onClick={() => onRemove(a)}>Remove</button>
              </div>
            </div>
          )
        })}
        {token && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 8 }}>
            <div style={{ marginBottom: 6, color: '#555' }}>
              {cellAsg.length ? 'Add another for' : 'Assign'} {col}{caseRow.Language ? <> · <strong>{caseRow.Language}</strong></> : null}
            </div>
            {recs.length > 0 && (
              <div style={{ maxHeight: 210, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, marginBottom: 8 }}>
                {recs.map(r => (
                  <div key={r.contractor.identifier} title="Assign & notify"
                    onClick={() => { if (!busy) onAssign(token, r.contractor.identifier) }}
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, padding: '6px 8px', cursor: busy ? 'default' : 'pointer', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'inline-block', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 8, background: r.tier === 'Best' ? '#e4f6ea' : '#eef3f8', color: r.tier === 'Best' ? '#1a7a3c' : '#31618e', marginRight: 6 }}>{r.tier} · {r.score}</span>
                      <span style={{ fontWeight: 600 }}>{r.contractor.name}</span>
                      <div style={{ fontSize: 11, color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {[r.contractor.field, [r.contractor.language, r.contractor.language_2].filter(Boolean).join('/'), r.contractor.county && `${r.contractor.county} Co.`].filter(Boolean).join(' · ')}
                      </div>
                    </span>
                    <span style={{ fontSize: 11, color: '#888', whiteSpace: 'nowrap' }}>{r.activeCaseCount} open</span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ fontSize: 11, color: '#999', marginBottom: 4 }}>{recs.length ? 'Or choose anyone:' : 'No language/field match — choose manually:'}</div>
            <select value={addTo} onChange={e => setAddTo(e.target.value)} style={{ width: '100%', padding: '5px 6px' }}>
              <option value="">Select contractor…</option>
              {contractors.map(k => <option key={k.identifier} value={k.identifier}>{contractorOptLabel(k)}</option>)}
            </select>
            <button className="btn btn-primary btn-sm" style={{ marginTop: 6 }} disabled={busy || !addTo} onClick={() => onAssign(token, addTo)}>Assign &amp; notify</button>
          </div>
        )}
        <div style={{ textAlign: 'right', marginTop: 8 }}><span className="tbl-link" style={{ fontSize: 12 }} onClick={onClose}>Close</span></div>
      </div>
    </>
  )
}

// Yes (green) / No (light red) toggle styling for the "District Paid" column.
function paidBtnStyle(isYes, active) {
  const base = { border: '1px solid', borderRadius: 5, padding: '3px 11px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }
  if (isYes) {
    return active
      ? { ...base, background: '#1a7a3c', borderColor: '#1a7a3c', color: '#fff' }
      : { ...base, background: '#fff', borderColor: '#c7e3cf', color: '#8aab95' }
  }
  return active
    ? { ...base, background: '#f6c9cc', borderColor: '#e79aa0', color: '#9b2c2c' }
    : { ...base, background: '#fff', borderColor: '#efd2d4', color: '#c79a9d' }
}

function CaseList({ cases, assignments, contractors = [], earnings = [], batches = [], loading, onOpen, onChanged }) {
  const [q, setQ] = useState('')
  const [chip, setChip] = useState('active')
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

  // Cases due soon / overdue — shown as the red counter on the "Due Soon" chip (and the sidebar).
  const dueSoonCount = useMemo(() => cases.filter(c => caseDueSoon(c, byCase[c.id] || [])).length, [cases, byCase])

  // Manually mark whether the school district has paid Learning Tree for a case.
  // ── Mail Date: Excel-style select / copy / paste across rows ──
  const [mailSel, setMailSel] = useState(new Set()) // selected case ids
  const [mailActive, setMailActive] = useState(null) // anchor case id
  const [mailClip, setMailClip] = useState(null)     // copied date (ISO) or null
  const [editMailId, setEditMailId] = useState(null) // case whose date is being typed
  const [mailOverride, setMailOverride] = useState({}) // instant display after a write
  const mailVal = c => (c.id in mailOverride ? mailOverride[c.id] : (c.mail_date ? String(c.mail_date).slice(0, 10) : ''))

  async function writeMailDates(ids, val) {
    if (!ids.length) return
    setMailOverride(prev => { const n = { ...prev }; ids.forEach(id => { n[id] = val || '' }); return n })
    setRowBusy(true); setRowMsg(null)
    const { error } = await supabase.from('Cases').update({ mail_date: val || null }).in('id', ids)
    if (error) setRowMsg({ kind: 'danger', text: error.message })
    else setRowMsg({ kind: 'success', text: `Mail date ${val ? `set for ${ids.length} case${ids.length === 1 ? '' : 's'}` : 'cleared'}.` })
    onChanged && onChanged(); setRowBusy(false)
  }

  function mailCellClick(e, c, orderedIds) {
    e.stopPropagation()
    if (e.shiftKey && mailActive != null) {
      const a = orderedIds.indexOf(mailActive), b = orderedIds.indexOf(c.id)
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setMailSel(new Set(orderedIds.slice(lo, hi + 1)))
      }
    } else if (e.ctrlKey || e.metaKey) {
      setMailSel(prev => { const n = new Set(prev); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n })
      setMailActive(c.id)
    } else {
      setMailSel(new Set([c.id])); setMailActive(c.id)
    }
  }

  // Keyboard: copy / paste / fill / clear the mail-date selection.
  useEffect(() => {
    function onKey(e) {
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
      if (!mailSel.size) return
      const meta = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (meta && key === 'c') {
        const src = mailActive != null ? cases.find(c => c.id === mailActive) : null
        const v = src ? mailVal(src) : ''
        setMailClip(v); try { navigator.clipboard.writeText(fmtDate(v) || '') } catch { /* ignore */ }
        setRowMsg({ kind: 'info', text: v ? `Copied ${fmtDate(v)}` : 'Copied (blank)' }); e.preventDefault()
      } else if (meta && key === 'v') {
        if (mailClip != null) writeMailDates([...mailSel], mailClip); e.preventDefault()
      } else if (meta && key === 'd') {
        const src = mailActive != null ? cases.find(c => c.id === mailActive) : null
        writeMailDates([...mailSel], src ? mailVal(src) : ''); e.preventDefault()
      } else if (key === 'delete' || key === 'backspace') {
        writeMailDates([...mailSel], ''); e.preventDefault()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [mailSel, mailActive, mailClip, cases, mailOverride])

  // ── Inline due-date editing ──
  const [editDueId, setEditDueId] = useState(null)
  async function saveDueDate(c, val) {
    setEditDueId(null)
    if ((val || '') === (c.Report_Due_date ? String(c.Report_Due_date).slice(0, 10) : '')) return
    setRowBusy(true); setRowMsg(null)
    const { error } = await supabase.from('Cases').update({ Report_Due_date: val || null }).eq('id', c.id)
    if (error) setRowMsg({ kind: 'danger', text: error.message })
    else setRowMsg({ kind: 'success', text: `Due date updated for ${c.case_number || c.id}.` })
    onChanged && onChanged(); setRowBusy(false)
  }

  // ── Click-to-edit eval cell ──
  const [editCell, setEditCell] = useState(null) // { caseRow, col, token, cellAsg, x, y }

  async function reassignInline(a, toId) {
    if (!toId) { setRowMsg({ kind: 'warn', text: 'Pick a contractor.' }); return }
    if (String(toId) === String(a.contractor_id)) { setEditCell(null); return }
    setRowBusy(true); setRowMsg(null)
    const { error } = await supabase.from('Assignments').update({
      contractor_id: Number(toId), acceptance_status: 'pending', accepted_at: null, declined_at: null, decline_reason: null, status: 'Assigned',
    }).eq('id', a.id)
    if (error) { setRowMsg({ kind: 'danger', text: error.message }); setRowBusy(false); return }
    let text = 'Assignment reassigned.'
    try { const { data: em } = await supabase.functions.invoke('notify-assignment', { body: { assignment_id: a.id } }); if (em?.success && em.sent_to) text = `Reassigned — emailed ${em.sent_to}.` } catch { /* email best-effort */ }
    setEditCell(null); setRowMsg({ kind: 'success', text }); onChanged && onChanged(); setRowBusy(false)
  }

  async function removeInline(a) {
    if (!window.confirm(`Remove ${a.Contractors?.name || 'this evaluator'} from ${a.eval_type || 'this evaluation'}? Deletes just this assignment, not the case.`)) return
    setRowBusy(true); setRowMsg(null)
    const { error } = await supabase.rpc('admin_delete_assignment', { p_assignment_id: a.id })
    if (error) { setRowMsg({ kind: 'danger', text: error.message }); setRowBusy(false); return }
    setEditCell(null); setRowMsg({ kind: 'success', text: 'Assignment removed.' }); onChanged && onChanged(); setRowBusy(false)
  }

  async function assignInline(caseRow, evalToken, toId) {
    if (!toId) { setRowMsg({ kind: 'warn', text: 'Pick a contractor.' }); return }
    setRowBusy(true); setRowMsg(null)
    const { data: inserted, error } = await supabase.from('Assignments').insert({
      case_id: caseRow.id, contractor_id: Number(toId), eval_type: evalToken,
      report_due_date: caseRow.Report_Due_date || null, status: 'Assigned', acceptance_status: 'pending',
    }).select('id').single()
    if (error) { setRowMsg({ kind: 'danger', text: error.message }); setRowBusy(false); return }
    let text = 'Contractor assigned — notification emailed.'
    try {
      const { data: em } = await supabase.functions.invoke('notify-assignment', { body: { assignment_id: inserted.id } })
      if (em?.skipped_no_email) text = 'Assigned. No email on file, so no notice was sent.'
      else if (em?.sent_to) text = `Assigned — emailed ${em.sent_to}.`
    } catch { /* email best-effort */ }
    setEditCell(null); setRowMsg({ kind: 'success', text }); onChanged && onChanged(); setRowBusy(false)
  }

  // ── Per-column sort + filter ──
  const [sortCol, setSortCol] = useState('case_number')
  const [sortDir, setSortDir] = useState('desc')
  const [colFilters, setColFilters] = useState({})
  const [colChecks, setColChecks] = useState({})
  const [openMenu, setOpenMenu] = useState(null)
  useEffect(() => {
    if (!openMenu) return
    const h = () => setOpenMenu(null)
    document.addEventListener('click', h)
    return () => document.removeEventListener('click', h)
  }, [openMenu])

  // Non-eval columns keep the sort/filter menus. Eval types are their own fixed columns.
  const LEFT_COLS = [['case_number', 'Case #'], ['Student_name', 'Student'], ['Language', 'Language'], ['School_district', 'District']]
  const RIGHT_COLS = [['created_date', 'Date Added'], ['Report_Due_date', 'Due Date'], ['status', 'Status'], ['mail_date', 'Mail Date']]
  const CHECKBOX_COLS = { School_district: true, Language: true, status: true }
  const districtOptions = useMemo(() => [...new Set(cases.map(c => (c.School_district || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [cases])
  const languageOptions = useMemo(() => [...new Set(cases.map(c => (c.Language || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [cases])
  // Case-level status is now just In Progress / Complete (Complete = all reports received).
  const caseProgressText = (c, asg) => {
    const lbl = caseStatusLabel(c, asg)
    return (lbl === 'Report Received' || lbl === 'Complete') ? 'Complete' : 'In Progress'
  }
  const statusOptions = ['In Progress', 'Complete']
  const optionsFor = key => key === 'School_district' ? districtOptions : key === 'Language' ? languageOptions : statusOptions
  // Contents of one eval-type cell for a case: matching assignments + the requested token.
  const cellFor = (c, col) => {
    const asg = (byCase[c.id] || []).filter(a => evalCol(a.eval_type) === col)
    const token = (c.evaluation_type || '').split(',').map(t => t.trim()).filter(Boolean).find(t => evalCol(t) === col) || asg[0]?.eval_type || null
    return { asg, token }
  }
  // Per-evaluator status label shown inside an eval cell.
  const evalStatus = a => {
    if ((a.status || '').toLowerCase() === 'submitted') return { t: "Report Rec'd", cls: 's-completed' }
    const acc = (a.acceptance_status || 'pending').toLowerCase()
    if (acc === 'declined') return { t: 'Declined', cls: 's-overdue' }
    if (acc !== 'accepted') {
      const d = daysWaiting(a)
      return { t: d !== null ? `Awaiting Acceptance · ${d}d` : 'Awaiting Acceptance', cls: 's-pending' }
    }
    return { t: 'Assigned', cls: 's-assigned' }
  }
  const toggleCheck = (key, val) => setColChecks(p => {
    const cur = new Set(p[key] || [])
    cur.has(val) ? cur.delete(val) : cur.add(val)
    return { ...p, [key]: [...cur] }
  })
  function colSortVal(col, c) {
    const asg = byCase[c.id] || []
    switch (col) {
      case 'created_date': return c.created_date || ''             // ISO date sorts lexically
      case 'Report_Due_date': return c.Report_Due_date || ''       // ISO date sorts lexically
      case 'assignments': return asg.length                        // numeric
      case 'status': return caseProgressText(c, asg).toLowerCase()
      case 'mail_date': return c.mail_date || ''
      case 'case_number': return String(c.case_number ?? '').toLowerCase()
      case 'Student_name': return String(c.Student_name ?? '').toLowerCase()
      case 'Language': return String(c.Language ?? '').toLowerCase()
      case 'School_district': return String(c.School_district ?? '').toLowerCase()
      case 'evaluation_type': return String(c.evaluation_type ?? '').toLowerCase()
      default: return ''
    }
  }
  function colFilterVal(col, c) {
    const asg = byCase[c.id] || []
    if (col === 'assignments') return asg.map(a => `${a.eval_type || ''} ${a.Contractors?.name || ''}`).join(' ').toLowerCase()
    if (col === 'created_date') return `${c.created_date || ''} ${fmtDate(c.created_date)}`.toLowerCase()
    if (col === 'mail_date') return `${c.mail_date || ''} ${fmtDate(c.mail_date)}`.toLowerCase()
    if (col === 'Report_Due_date') return `${c.Report_Due_date || ''} ${fmtDate(c.Report_Due_date)}`.toLowerCase()
    return String(colSortVal(col, c)).toLowerCase()
  }

  let rows = cases.filter(c => {
    const asg = byCase[c.id] || []
    // "Done" = every evaluation approved (not merely submitted) — so a case with a
    // submitted-but-unapproved report stays in Active until it's approved/sent.
    const done = caseStatusLabel(c, asg) === 'Complete'
    if (chip === 'active' && done) return false
    if (chip === 'completed' && !done) return false
    if (chip === 'due' && !caseDueSoon(c, asg)) return false
    const evalNames = (byCase[c.id] || []).map(a => `${a.eval_type || ''} ${a.Contractors?.name || ''}`).join(' ')
    const hay = `${c.case_number || ''} ${c.Student_name || ''} ${c.School_district || ''} ${c.evaluation_type || ''} ${evalNames}`.toLowerCase()
    return hay.includes(q.toLowerCase())
  })
  for (const [key, text] of Object.entries(colFilters)) {
    if (CHECKBOX_COLS[key]) continue
    const t = (text || '').trim().toLowerCase()
    if (t) rows = rows.filter(c => colFilterVal(key, c).includes(t))
  }
  const distSel = colChecks.School_district || []
  if (distSel.length) rows = rows.filter(c => distSel.includes((c.School_district || '').trim()))
  const langSel = colChecks.Language || []
  if (langSel.length) rows = rows.filter(c => langSel.includes((c.Language || '').trim()))
  const statusSel = colChecks.status || []
  if (statusSel.length) rows = rows.filter(c => statusSel.includes(caseProgressText(c, byCase[c.id] || [])))
  if (sortCol) {
    rows = [...rows].sort((a, b) => {
      const va = colSortVal(sortCol, a), vb = colSortVal(sortCol, b)
      const cmp = (typeof va === 'number' && typeof vb === 'number') ? va - vb : String(va).localeCompare(String(vb))
      return sortDir === 'desc' ? -cmp : cmp
    })
  }

  // Visible rows (capped) and their id order — used for shift-click ranges on Mail Date.
  const visibleRows = rows.slice(0, 200)
  const orderedMailIds = visibleRows.map(c => c.id)

  // A sortable/filterable header cell (used for the non-eval columns).
  const menuTh = (key, label) => (
    <th key={key} style={{ whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 6, background: '#f0f2f5' }}>
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
  )
  const COLSPAN = LEFT_COLS.length + EVAL_COLS.length + RIGHT_COLS.length

  return (
    <div className="card">
      <div className="sec-head">
        <h3>{rows.length} case{rows.length === 1 ? '' : 's'}</h3>
        <div className="filter-bar" style={{ margin: 0 }}>
          <input type="text" placeholder="🔍 Search case #, student, district…" value={q} onChange={e => setQ(e.target.value)} />
          {[['active', 'Active'], ['due', 'Due Soon'], ['completed', 'Completed'], ['all', 'All']].map(([id, label]) => (
            <span key={id} className={`filter-chip ${chip === id ? 'active' : ''}`} onClick={() => setChip(id)}
              style={id === 'due' ? { position: 'relative', marginRight: dueSoonCount > 0 ? 6 : undefined } : undefined}>
              {label}
              {id === 'due' && dueSoonCount > 0 && (
                <span title={`${dueSoonCount} case${dueSoonCount === 1 ? '' : 's'} due within 7 days or overdue — same number as the red badge next to "Cases" in the sidebar`}
                  style={{
                    position: 'absolute', top: -9, right: -9, minWidth: 19, height: 19, padding: '0 5px', boxSizing: 'border-box',
                    borderRadius: 10, background: '#e53935', color: '#fff', fontSize: 11, fontWeight: 700, lineHeight: '19px',
                    textAlign: 'center', boxShadow: '0 0 0 2px #fff, 0 1px 3px rgba(0,0,0,.3)', pointerEvents: 'none',
                  }}>{dueSoonCount}</span>
              )}
            </span>
          ))}
          <button className="btn btn-secondary btn-sm" title="Download all cases and assignments as an Excel workbook"
            disabled={cases.length === 0}
            onClick={() => exportCasesToExcel(cases, assignments)}>
            ⬇ Export to Excel
          </button>
        </div>
      </div>
      {rowMsg && <div className={`alert alert-${rowMsg.kind}`}>{rowMsg.text}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', margin: '0 0 12px', fontSize: 12, color: '#555' }}>
        <span style={{ fontWeight: 600 }}>Row colors:</span>
        {[
          ['#e4f6ea', 'All reports received'],
          ['#fff1de', 'Due within 7 days'],
          ['#fde5e5', 'Past due — reports missing'],
          ['var(--gray-bg, #eef1f4)', 'Complete (sent to district)'],
        ].map(([bg, label]) => (
          <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 22, height: 14, borderRadius: 3, background: bg, border: '1px solid var(--border, #d7dbe0)', display: 'inline-block' }} />
            {label}
          </span>
        ))}
        <span style={{ color: 'var(--muted)', marginLeft: 'auto' }}>
          <b style={{ color: '#555' }}>Mail Date:</b> click to select · Shift/Ctrl-click for many · double-click to set · Ctrl+C / Ctrl+V to copy across
        </span>
      </div>
      <div className="tbl-wrap sticky-head">
        <table>
          <thead><tr>
            {LEFT_COLS.map(([key, label]) => menuTh(key, label))}
            {EVAL_COLS.map(col => <th key={col} style={{ whiteSpace: 'nowrap', background: '#f3f6f9', textAlign: 'left', position: 'sticky', top: 0, zIndex: 6 }}>{col}</th>)}
            {RIGHT_COLS.map(([key, label]) => menuTh(key, label))}
          </tr></thead>
          <tbody>
            {loading && <tr><td colSpan={COLSPAN} style={{ color: '#888' }}>Loading…</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={COLSPAN} style={{ color: '#888' }}>No cases match.</td></tr>}
            {visibleRows.map(c => {
              const asg = byCase[c.id] || []
              const statusLbl = caseStatusLabel(c, asg)
              const complete = statusLbl === 'Complete'
              const allReceived = statusLbl === 'Report Received' // every evaluation submitted
              const progress = caseProgressText(c, asg)           // In Progress | Complete
              const dl = daysLeft(c.Report_Due_date)
              const pastDue = !complete && !allReceived && dl !== null && dl < 0 // overdue, reports not all in
              const dueSoon = !complete && !allReceived && dl !== null && dl >= 0 && dl <= 7 // not all in, due within a week
              const rowStyle = complete ? { background: 'var(--gray-bg)', color: 'var(--muted)' }
                : allReceived ? { background: '#e4f6ea' }
                : pastDue ? { background: '#fde5e5' }
                : dueSoon ? { background: '#fff1de' }
                : undefined
              const rowTitle = complete ? 'Completed case'
                : allReceived ? 'All reports received'
                : pastDue ? 'Past due — reports not all received'
                : dueSoon ? 'Reports not all in — due within 7 days'
                : undefined
              return (
                <tr key={c.id} style={rowStyle} title={rowTitle}>
                  <td><span className="tbl-link" onClick={() => onOpen(c)}>{c.case_number || c.id}</span></td>
                  <td><span className="tbl-link" onClick={() => onOpen(c)}>{c.Student_name || '—'}</span></td>
                  <td>{c.Language || '—'}</td>
                  <td>{c.School_district || '—'}</td>
                  {EVAL_COLS.map(col => {
                    const { asg: cAsg, token } = cellFor(c, col)
                    if (cAsg.length === 0 && !token) return <td key={col} style={{ textAlign: 'center', color: '#c9ccd1' }}>·</td>
                    return (
                      <td key={col} style={{ cursor: 'pointer', whiteSpace: 'nowrap', verticalAlign: 'top' }} title="Click to assign / reassign"
                        onClick={e => { e.stopPropagation(); setEditCell({ caseRow: c, col, token, cellAsg: cAsg, x: e.clientX, y: e.clientY }) }}>
                        {cAsg.length === 0
                          ? <span className="badge-s s-unassigned">Pending Assmt</span>
                          : cAsg.map(a => {
                              const st = evalStatus(a)
                              const prefix = col === 'Other' && a.eval_type ? `${a.eval_type}: ` : ''
                              return (
                                <div key={a.id} style={{ marginBottom: cAsg.length > 1 ? 4 : 0 }}>
                                  <div>{prefix}{a.Contractors?.name || 'Assigned'}</div>
                                  <span className={`badge-s ${st.cls}`} style={{ fontSize: 10 }}>{st.t}</span>
                                </div>
                              )
                            })}
                      </td>
                    )
                  })}
                  <td style={{ whiteSpace: 'nowrap' }}>{c.created_date ? fmtDate(c.created_date) : <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                  <td style={{ ...dueColor(c.Report_Due_date), whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
                    {editDueId === c.id
                      ? <input type="date" autoFocus defaultValue={c.Report_Due_date ? String(c.Report_Due_date).slice(0, 10) : ''}
                          disabled={rowBusy}
                          onChange={e => saveDueDate(c, e.target.value)}
                          onBlur={() => setEditDueId(null)}
                          style={{ padding: '2px 4px', fontSize: 12 }} />
                      : <span className="tbl-link" title="Click to edit due date" onClick={() => setEditDueId(c.id)}>{fmtDate(c.Report_Due_date) || 'Set date'}</span>}
                  </td>
                  <td><span className={`badge-s ${progress === 'Complete' ? 's-completed' : 's-drafting'}`}>{progress}</span></td>
                  <td style={{ whiteSpace: 'nowrap', padding: '6px 8px' }}
                    onClick={e => { if (editMailId !== c.id) mailCellClick(e, c, orderedMailIds) }}>
                    {editMailId === c.id ? (
                      <input type="date" autoFocus defaultValue={mailVal(c)} disabled={rowBusy}
                        onClick={e => e.stopPropagation()}
                        onChange={e => { writeMailDates([c.id], e.target.value); setEditMailId(null) }}
                        onBlur={() => setEditMailId(null)}
                        style={{ padding: '2px 4px', fontSize: 12 }} />
                    ) : (
                      <span
                        onDoubleClick={e => { e.stopPropagation(); setEditMailId(c.id) }}
                        title="Click to select · double-click to set a date · copy/paste across selected cells"
                        style={{
                          display: 'inline-block', minWidth: 92, textAlign: 'center', cursor: 'cell',
                          padding: '3px 8px', borderRadius: 6, fontSize: 12.5, fontVariantNumeric: 'tabular-nums',
                          border: `1px solid ${mailSel.has(c.id) ? 'var(--accent)' : 'var(--border)'}`,
                          background: mailSel.has(c.id) ? 'var(--accent-light)' : '#fff',
                          boxShadow: mailActive === c.id ? 'inset 0 0 0 1px var(--accent)' : 'none',
                          color: mailVal(c) ? '#1c2330' : '#9aa1ab',
                        }}>
                        {mailVal(c) ? fmtDate(mailVal(c)) : '— set'}
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {rows.length > 200 && <div style={{ marginTop: 8, fontSize: 12, color: '#888' }}>Showing first 200 — refine your search to see more.</div>}
      {editCell && (
        <CellEditor anchor={{ x: editCell.x, y: editCell.y }} caseRow={editCell.caseRow} col={editCell.col} token={editCell.token}
          cellAsg={editCell.cellAsg} contractors={contractors.filter(k => k.active !== false)} assignments={assignments} busy={rowBusy}
          onReassign={reassignInline} onRemove={removeInline}
          onAssign={(tok, toId) => assignInline(editCell.caseRow, tok, toId)} onClose={() => setEditCell(null)} />
      )}
    </div>
  )
}

function CaseDetail({ caseRow, assignments, allAssignments, contractors, qaByAssignment, earnings = [], onBack, onChanged }) {
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
  const [editTestingId, setEditTestingId] = useState(null)   // assignment whose testing date is being edited
  const [testingVal, setTestingVal] = useState('')
  // Local mirror of assignment testing dates so admin edits show immediately.
  const [testingOverride, setTestingOverride] = useState({})
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

  // Auto-fills the district invoice from the case's submitted evaluations (student, date,
  // invoice #, dates/types of service, rate by language, sum).
  async function downloadCaseInvoice() {
    const submitted = assignments.filter(a => a.contractor_id != null && (a.status || '').toLowerCase() === 'submitted')
    const src = submitted.length ? submitted : assignments.filter(a => a.contractor_id != null)
    if (!src.length) { setMsg({ kind: 'warn', text: 'No submitted evaluations yet to invoice.' }); return }
    const items = src.map(a => ({ assignmentId: a.id, evalType: a.eval_type || '', dateOfService: a.testing_date || a.submitted_at }))
      .sort((x, y) => x.assignmentId - y.assignmentId)
    // Last 4 digits: per-district sequence (1000, 1001, ...) assigned in invoice-creation order.
    const { data: seq, error } = await supabase.rpc('allocate_invoice_seq', { p_case_id: c.id })
    if (error) { setMsg({ kind: 'danger', text: `Could not assign an invoice number: ${error.message}` }); return }
    generateInvoiceDoc({
      caseNumber: c.case_number || String(c.id),
      studentName: c.Student_name || '',
      districtName: c.School_district || '',
      language: c.Language || null,
      rate: await getRate(c.Language),
      invoiceNumber: `${c.case_number || c.id}-${seq}`,
      lineItems: items.map(l => ({ evalType: l.evalType, dateOfService: l.dateOfService })),
    })
  }

  async function markSent() {
    const sending = !c.sent_to_district_at
    setBusy(true); setMsg(null)
    const val = sending ? new Date().toISOString() : null
    const { error } = await supabase.from('Cases').update({ sent_to_district_at: val, Status: sending ? 'Completed' : 'In Progress' }).eq('id', c.id)
    if (error) { setMsg({ kind: 'danger', text: error.message }); setBusy(false); return }
    setC(prev => ({ ...prev, sent_to_district_at: val, Status: sending ? 'Completed' : 'In Progress' }))
    // Keep the Client Invoices register in step: Draft -> Sent on send, and back on reopen.
    await supabase.from('Invoices')
      .update({ status: sending ? 'Sent' : 'Draft' })
      .eq('case_id', c.id)
      .eq('status', sending ? 'Draft' : 'Sent')
    setMsg({ kind: 'success', text: sending ? 'Case marked complete — it no longer shows as due or overdue anywhere. Its invoice (if any) is marked Sent.' : 'Reopened — case is no longer marked complete.' })
    onChanged(); setBusy(false)
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

  function startEditTesting(a) {
    setEditTestingId(a.id)
    setTestingVal((testingOverride[a.id] ?? a.testing_date ?? '').slice(0, 10))
    setEditAsgId(null); setConfirmRemoveId(null); setMsg(null)
  }
  async function saveTestingDate(a) {
    setBusy(true); setMsg(null)
    const val = testingVal || null
    const { error } = await supabase.from('Assignments').update({ testing_date: val }).eq('id', a.id)
    if (error) { setMsg({ kind: 'danger', text: error.message }); setBusy(false); return }
    setTestingOverride(prev => ({ ...prev, [a.id]: val }))
    setEditTestingId(null)
    setMsg({ kind: 'success', text: `Testing date updated for ${a.Contractors?.name || a.eval_type || 'assignment'}.` })
    onChanged(); setBusy(false)
  }

  // Approve a submitted report straight from Case Detail. Mirrors QaQueue.saveReview('approved')
  // so it shows Approved in Report Review too: writes qa_reviews, creates the earning, and
  // completes the case + records the invoice once every report on the case is approved.
  const qaStatusOf = a => qaByAssignment?.get?.(a.id)?.qa_status
  async function approveReport(a) {
    setBusy(true); setMsg(null)
    const { error } = await supabase.from('qa_reviews').upsert({
      assignment_id: a.id,
      ...Object.fromEntries(QA_CHECKS.map(([k]) => [k, true])),
      qa_status: 'approved',
      updated_at: new Date().toISOString(),
    })
    if (error) { setMsg({ kind: 'danger', text: error.message }); setBusy(false); return }

    // Create the contractor earning if it doesn't exist yet.
    if (!earnings.some(e => e.assignment_id === a.id) && a.contractor_id != null) {
      const amount = parseRate(a.Contractors?.current_rate)
      await supabase.from('contractor_earnings').insert({
        contractor_id: a.contractor_id, assignment_id: a.id, amount,
        billable_date: (a.submitted_at || new Date().toISOString()).slice(0, 10), status: 'pending',
      })
    }
    // If every submitted report on this case is now approved, complete it + record the invoice.
    const siblings = assignments.filter(x => x.case_id === c.id && x.contractor_id != null && x.submitted_at)
    const allApproved = siblings.every(x => x.id === a.id || qaStatusOf(x) === 'approved')
    let note = ''
    if (allApproved && siblings.length) {
      await supabase.from('Cases').update({ Status: 'Completed' }).eq('id', c.id)
      const res = await autoRecordInvoice({ id: c.id, ...(c || {}) }, siblings.length)
      if (res.created) note = ` Invoice ${res.invoice_number} ($${Number(res.amount).toLocaleString()}) recorded as Draft.`
      else if (res.skipped === 'already recorded') note = ` Invoice ${res.invoice_number} was already on file.`
    }
    setMsg({ kind: 'success', text: `Report approved for ${a.Contractors?.name || a.eval_type || 'this evaluation'} — now shows Approved in Report Review.${note}` })
    onChanged && onChanged(); setBusy(false)
  }

  async function deleteCase() {
    setBusy(true); setMsg(null)
    const { error } = await supabase.rpc('admin_delete_case', { p_case_id: c.id })
    setBusy(false)
    if (error) { setMsg({ kind: 'danger', text: error.message }); setConfirmDelete(false); return }
    onChanged()
    onBack()   // case is gone — return to the list
  }

  const filteredContractors = contractors.filter(k => k.active !== false).filter(k =>
    `${k.name || ''} ${k.field || ''} ${k.language || ''} ${k.language_2 || ''} ${k.county || ''}`.toLowerCase().includes(contractorQuery.toLowerCase()))

  const recommendations = useMemo(() => {
    if (!newAsg.eval_type) return []
    const activeCounts = new Map()
    for (const a of allAssignments) {
      if (a.contractor_id == null || (a.status || '').toLowerCase() === 'submitted') continue
      activeCounts.set(a.contractor_id, (activeCounts.get(a.contractor_id) || 0) + 1)
    }
    // Only recommend contractors flagged active.
    return scoreContractors(contractors.filter(k => k.active !== false), activeCounts, newAsg.eval_type, c.Language, c.County).slice(0, 8)
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
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {(() => { const lbl = caseStatusLabel(c, assignments); return <span className={`badge-s ${caseStatusCls(lbl)}`}>{lbl}</span> })()}
              <button className="btn btn-secondary btn-sm" onClick={startEdit}>✏️ Edit</button>
              {assignments.some(a => a.contractor_id != null && (a.status || '').toLowerCase() === 'submitted') &&
                <button className="btn btn-secondary btn-sm" onClick={downloadCaseInvoice} title="Download the district invoice for this case">⬇ Invoice</button>}
              {c.sent_to_district_at
                ? <button className="btn btn-ghost btn-sm" disabled={busy} onClick={markSent} title="Reopen — mark this case not complete">↩ Reopen case</button>
                : <button className="btn btn-primary btn-sm" disabled={busy} onClick={markSent} title="Mark this case fully complete — removes it from all due/overdue lists (use for finished or legacy cases even if reports weren't uploaded)">✅ Mark case complete</button>}
              <button className="btn btn-danger-outline btn-sm" onClick={() => { setConfirmDelete(true); setMsg(null) }}>🗑 Delete</button>
            </div>
          </div>
          <div className="meta-grid" style={{ marginTop: 14 }}>
            <Meta k="District" v={c.School_district} />
            <Meta k="County" v={c.County} />
            <Meta k="Referral Recorded" v={c.created_date ? fmtDate(c.created_date) : null} />
            <Meta k="Report Due" v={fmtDate(c.Report_Due_date)} style={dueColor(c.Report_Due_date)} />
            {c.sent_to_district_at && <Meta k="Date Sent to District" v={fmtDate(c.sent_to_district_at)} style={{ color: 'var(--green)' }} />}
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
                <thead><tr><th>Contractor</th><th>Eval Type</th><th>Accepted?</th><th>Due</th><th>Testing</th><th>Status</th><th>Report</th><th>Approve</th><th></th></tr></thead>
                <tbody>
                  {assignments.length === 0 && <tr><td colSpan={9} style={{ color: '#888' }}>No contractors assigned yet.</td></tr>}
                  {assignments.map(a => (
                    <Fragment key={a.id}>
                      <tr>
                        <td>{a.Contractors?.name || '—'}</td>
                        <td>{a.eval_type || '—'}</td>
                        <td><AcceptBadge a={a} /></td>
                        <td style={dueColor(a.report_due_date)}>{fmtDate(a.report_due_date)}</td>
                        <td>{editTestingId === a.id ? (
                          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', whiteSpace: 'nowrap' }}>
                            <input type="date" value={testingVal} onChange={e => setTestingVal(e.target.value)} style={{ padding: '3px 5px', fontSize: 12 }} />
                            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => saveTestingDate(a)}>Save</button>
                            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setEditTestingId(null)}>✕</button>
                          </span>
                        ) : (
                          <span className="tbl-link" title="Click to edit the testing date" onClick={() => startEditTesting(a)}>
                            {(() => { const d = testingOverride[a.id] ?? a.testing_date; return d ? fmtDate(d) : <span style={{ color: 'var(--muted)' }}>— set</span> })()}
                          </span>
                        )}</td>
                        <td><Badge status={a.status} /></td>
                        <td>{(() => {
                          const files = Array.isArray(a.report_files) && a.report_files.length
                            ? a.report_files
                            : (a.report_url ? [{ path: a.report_url, name: a.report_url.split('/').pop() }] : [])
                          const recd = a.submitted_at
                            ? <div style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }} title="Date this evaluator's report was received">Rec'd {fmtDate(receivedISO(a.submitted_at))}</div>
                            : null
                          if (!files.length) return recd || '—'
                          return <>
                            {files.map((f, i) => (
                              <div key={f.path || i}><span className="tbl-link" onClick={() => viewReport(f.path)}>📄 {files.length > 1 ? (f.name || f.path.split('/').pop()) : 'View'}</span></div>
                            ))}
                            {recd}
                          </>
                        })()}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {qaStatusOf(a) === 'approved'
                            ? <span className="badge-s s-completed">✓ Approved</span>
                            : a.submitted_at
                              ? <button className="btn btn-primary btn-sm" disabled={busy} title="Approve this report — marks it Approved in Report Review too" onClick={() => approveReport(a)}>✓ Approve</button>
                              : <span style={{ color: 'var(--muted)', fontSize: 12 }}>—</span>}
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button className="btn btn-ghost btn-sm" title="Reassign to a different contractor" disabled={busy} onClick={() => startReassign(a)}>✏️</button>{' '}
                          <button className="btn btn-danger-outline btn-sm" title="Remove this assignment" disabled={busy} onClick={() => { setConfirmRemoveId(a.id); setEditAsgId(null); setMsg(null) }}>🗑</button>
                        </td>
                      </tr>
                      {editAsgId === a.id && (
                        <tr>
                          <td colSpan={9} style={{ background: 'var(--accent-light)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <strong style={{ fontSize: 13 }}>Reassign {a.eval_type || 'evaluation'} to:</strong>
                              <select value={reassignTo} onChange={e => setReassignTo(e.target.value)} style={{ padding: '6px 10px', minWidth: 240 }}>
                                <option value="">Select contractor…</option>
                                {contractors.filter(k => k.active !== false).map(k => (
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
                          <td colSpan={9} style={{ background: 'var(--red-bg)' }}>
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

function ContractorList({ contractors, assignments, onChanged, languageFilter = null, onClearLanguageFilter }) {
  const [q, setQ] = useState('')
  const [msg, setMsg] = useState(null)
  const [inviting, setInviting] = useState(null)
  const [editing, setEditing] = useState(null)   // the contractor being edited, or null
  const [creating, setCreating] = useState(false) // true when adding a new contractor
  function startCreate() {
    setForm({ name: '', email: '', phone: '', company_name: '', fields: [], languages: [], county: '',
      address: '', zip_code: '', current_rate: '', preferred_payment_method: '', w9_on_file: false, criminal_history_done: false, NJDOE_submitted: '', active: true })
    setMsg(null); setEditing(null); setCreating(true)
  }
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

  // Manually mark a contractor active/inactive. Inactive ones are hidden from
  // assignment recommendations and the assign/reassign pickers.
  async function toggleActive(k, val) {
    setBusy(true); setMsg(null)
    const { error } = await supabase.from('Contractors').update({ active: val }).eq('identifier', k.identifier)
    if (error) setMsg({ kind: 'danger', text: error.message })
    else setMsg({ kind: 'success', text: `${k.name} marked ${val ? 'active' : 'inactive'}.` })
    onChanged()
    setBusy(false)
  }

  // Inline edit of how a contractor prefers to be paid (also shown on the Payroll page).
  async function setPaymentMethod(k, method) {
    setBusy(true); setMsg(null)
    const { error } = await supabase.from('Contractors').update({ preferred_payment_method: method || null }).eq('identifier', k.identifier)
    if (error) setMsg({ kind: 'danger', text: error.message })
    else setMsg({ kind: 'success', text: `${k.name}: payment method ${method ? `set to ${method}` : 'cleared'}.` })
    onChanged()
    setBusy(false)
  }

  function startEdit(k) {
    const uniq = arr => [...new Set(arr)]
    const fields = uniq((k.field || '').split(',').map(t => t.trim()).filter(Boolean))
    const languages = uniq([k.language, k.language_2].filter(Boolean).flatMap(s => s.split(',').map(t => t.trim())).filter(Boolean))
    setForm({
      name: k.name || '', email: k.email || '', phone: k.phone || '', company_name: k.company_name || '',
      fields, languages, county: k.county || '',
      address: k.address || '', zip_code: k.zip_code != null ? String(k.zip_code) : '', current_rate: k.current_rate || '',
      w9_on_file: !!k.w9_on_file, criminal_history_done: !!k.criminal_history_done, NJDOE_submitted: k.NJDOE_submitted || '',
      active: k.active !== false, preferred_payment_method: k.preferred_payment_method || '',
    })
    setMsg(null); setEditing(k)
  }
  const toggleMulti = (key, val) => setForm(p => {
    const cur = p[key] || []
    return { ...p, [key]: cur.includes(val) ? cur.filter(x => x !== val) : [...cur, val] }
  })

  async function saveEdit() {
    if (!form.name.trim()) { setMsg({ kind: 'warn', text: 'Name is required.' }); return }
    setBusy(true); setMsg(null)
    const zip = String(form.zip_code || '').replace(/\D/g, '')
    const patch = {
      name: form.name.trim(), email: form.email || null, phone: form.phone || null, company_name: form.company_name || null,
      field: (form.fields || []).join(', ') || null,
      language: (form.languages || [])[0] || null,
      language_2: (form.languages || []).length > 1 ? form.languages.slice(1).join(', ') : null,
      county: form.county || null,
      address: form.address || null, zip_code: zip ? Number(zip) : null, current_rate: form.current_rate || null,
      w9_on_file: !!form.w9_on_file, criminal_history_done: !!form.criminal_history_done, NJDOE_submitted: form.NJDOE_submitted || null,
      active: form.active !== false,
      preferred_payment_method: form.preferred_payment_method || null,
    }
    const { error } = creating
      ? await supabase.from('Contractors').insert(patch)
      : await supabase.from('Contractors').update(patch).eq('identifier', editing.identifier)
    setBusy(false)
    if (error) { setMsg({ kind: 'danger', text: error.message }); return }
    setEditing(null); setCreating(false)
    setMsg({ kind: 'success', text: creating ? `${patch.name} added.` : `${patch.name} updated.` }); onChanged()
  }

  const openBy = useMemo(() => {
    const m = {}
    for (const a of assignments) {
      if ((a.status || '').toLowerCase() === 'submitted') continue
      m[a.contractor_id] = (m[a.contractor_id] || 0) + 1
    }
    return m
  }, [assignments])

  // Language filter: the dropdown here, or a language clicked on the Dashboard.
  const [langSel, setLangSel] = useState('')
  const activeLang = langSel || languageFilter || ''
  const langOptions = useMemo(() => {
    const m = new Map()
    for (const k of contractors) for (const l of contractorLanguages(k)) m.set(l, (m.get(l) || 0) + 1)
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [contractors])
  const pickLang = v => { setLangSel(v); if (languageFilter && onClearLanguageFilter) onClearLanguageFilter() }

  const rows = contractors
    .filter(k => !activeLang || contractorSpeaks(k, activeLang))
    .filter(k =>
      `${k.name || ''} ${k.email || ''} ${k.field || ''} ${k.language || ''} ${k.language_2 || ''} ${k.county || ''}`.toLowerCase().includes(q.toLowerCase()))

  // ── Edit / create form ──
  if (editing || creating) {
    return (
      <div className="card" style={{ border: '2px solid var(--accent)', maxWidth: 760 }}>
        <div className="sec-head">
          <h3>{creating ? '➕ New Contractor' : `✏️ Edit Contractor — ${editing.name}`}</h3>
          <button className="btn btn-ghost btn-sm" onClick={() => { setEditing(null); setCreating(false) }}>← Back to list</button>
        </div>
        {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}
        <div className="form-group"><label>Name *</label><input value={form.name} onChange={e => setF('name', e.target.value)} /></div>
        <div className="form-row">
          <div className="form-group"><label>Email</label><input type="email" value={form.email} onChange={e => setF('email', e.target.value)} /></div>
          <div className="form-group"><label>Phone</label><input value={form.phone} onChange={e => setF('phone', e.target.value)} /></div>
        </div>
        <div className="form-group"><label>Company Name</label><input value={form.company_name} onChange={e => setF('company_name', e.target.value)} /></div>
        <div className="form-group"><label>Field / Specialty (select all that apply)</label>
          <MultiCheck selected={form.fields || []} options={CONTRACTOR_FIELDS} onToggle={v => toggleMulti('fields', v)} /></div>
        <div className="form-group"><label>Languages (select all that apply)</label>
          <MultiCheck selected={form.languages || []} options={LANGUAGES} onToggle={v => toggleMulti('languages', v)} /></div>
        <div className="form-row">
          <div className="form-group"><label>Rate</label><input value={form.current_rate} onChange={e => setF('current_rate', e.target.value)} placeholder="e.g. $880" /></div>
          <div className="form-group"><label>Preferred Payment Method</label>
            <select value={form.preferred_payment_method || ''} onChange={e => setF('preferred_payment_method', e.target.value)}>
              <option value="">Not set</option>
              {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              {form.preferred_payment_method && !PAYMENT_METHODS.includes(form.preferred_payment_method) && <option value={form.preferred_payment_method}>{form.preferred_payment_method}</option>}
            </select>
          </div>
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
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, textTransform: 'none', letterSpacing: 0, fontWeight: 400, cursor: 'pointer' }}>
              <input type="checkbox" checked={form.active !== false} onChange={e => setF('active', e.target.checked)} /> Active (available for assignments)
            </label>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn btn-primary" disabled={busy} onClick={saveEdit}>{busy ? 'Saving…' : (creating ? 'Add Contractor' : 'Save Changes')}</button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => { setEditing(null); setCreating(false) }}>Cancel</button>
        </div>
      </div>
    )
  }

  // ── List ──
  return (
    <div className="card">
      <div className="sec-head">
        <h3>{rows.length} contractor{rows.length === 1 ? '' : 's'}</h3>
        <div className="filter-bar" style={{ margin: 0, display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="text" placeholder="🔍 Name, field, language, county…" value={q} onChange={e => setQ(e.target.value)} />
          <select value={activeLang} onChange={e => pickLang(e.target.value)} title="Show only contractors who speak this language">
            <option value="">All languages</option>
            {langOptions.map(([l, n]) => <option key={l} value={l}>{l} ({n})</option>)}
            {activeLang && !langOptions.some(([l]) => l === activeLang) && <option value={activeLang}>{activeLang}</option>}
          </select>
          <button className="btn btn-primary btn-sm" onClick={startCreate}>➕ New Contractor</button>
        </div>
      </div>
      {activeLang && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontSize: 13 }}>
          <span style={{ color: '#555' }}>Showing contractors who speak</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#E6F1FB', color: '#185FA5', border: '1px solid #b9d6f2', borderRadius: 999, padding: '3px 10px', fontWeight: 600 }}>
            {activeLang}
            <span style={{ cursor: 'pointer' }} title="Clear filter" onClick={() => pickLang('')}>✕</span>
          </span>
        </div>
      )}
      {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Name</th><th>Field</th><th>Languages</th><th>County</th><th>Rate</th><th>Payment Method</th><th>Open Cases</th><th>Active</th><th>Portal Login</th><th></th></tr></thead>
          <tbody>
            {rows.map(k => {
              const isActive = k.active !== false
              return (
              <tr key={k.identifier} style={isActive ? undefined : { background: 'var(--gray-bg, #f1efe8)', color: 'var(--muted, #888)' }}>
                <td style={{ fontWeight: 600 }}>{k.name}<div style={{ fontWeight: 400, fontSize: 11, color: '#888' }}>{k.email}</div></td>
                <td>{k.field || '—'}</td>
                <td>{[k.language, k.language_2].filter(Boolean).join(', ') || '—'}</td>
                <td>{k.county || '—'}</td>
                <td>{k.current_rate || '—'}</td>
                <td>
                  <select value={k.preferred_payment_method || ''} disabled={busy} onChange={e => setPaymentMethod(k, e.target.value)}
                    title="Preferred payment method — click to change"
                    style={{ padding: '2px 4px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 5, background: '#fff', color: k.preferred_payment_method ? undefined : '#9aa1ab' }}>
                    <option value="">— set</option>
                    {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                    {k.preferred_payment_method && !PAYMENT_METHODS.includes(k.preferred_payment_method) && <option value={k.preferred_payment_method}>{k.preferred_payment_method}</option>}
                  </select>
                </td>
                <td>{openBy[k.identifier] || 0}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button type="button" disabled={busy} onClick={() => toggleActive(k, true)} title="Mark active — available for assignments" style={paidBtnStyle(true, isActive)}>Active</button>
                  {' '}
                  <button type="button" disabled={busy} onClick={() => toggleActive(k, false)} title="Mark inactive — hidden from assignment recommendations" style={paidBtnStyle(false, !isActive)}>Inactive</button>
                </td>
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
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function InvoiceList({ invoices, cases, onChanged }) {
  const [f, setF] = useState({ case_id: '', invoice_number: '', student_name: '', district_name: '', amount: '', issued_date: '', due_date: '', status: 'Draft' })
  const [msg, setMsg] = useState(null)
  const [editId, setEditId] = useState(null)
  const [edit, setEdit] = useState({})
  const [busy, setBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState(null)
  const [q, setQ] = useState('')
  const [districtSel, setDistrictSel] = useState('')

  const caseById = useMemo(() => new Map(cases.map(c => [c.id, c])), [cases])

  // Invoice # / student / district fall back to the linked case for older rows
  // recorded before those columns existed.
  const mapped = useMemo(() => invoices.map(inv => {
    const c = inv.case_id ? caseById.get(inv.case_id) : null
    return {
      ...inv,
      _number: inv.invoice_number || (c?.invoice_seq ? `${c.case_number || c.id}-${c.invoice_seq}` : `—`),
      _student: inv.student_name || c?.Student_name || '—',
      _district: inv.district_name || c?.School_district || '',
    }
  }), [invoices, caseById])

  // Distinct school districts across all invoices, for the filter dropdown.
  const districtOptions = useMemo(
    () => [...new Set(mapped.map(r => r._district).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [mapped])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return mapped.filter(r => {
      if (districtSel && r._district !== districtSel) return false
      if (needle && ![r._number, r._student, r._district, r.status].some(v => String(v || '').toLowerCase().includes(needle))) return false
      return true
    })
  }, [mapped, q, districtSel])

  const totals = useMemo(() => {
    const sum = (pred) => rows.filter(pred).reduce((t, r) => t + Number(r.amount || 0), 0)
    return {
      all: sum(() => true),
      outstanding: sum(r => (r.status || '').toLowerCase() !== 'paid'),
      overdue: sum(r => (r.status || '').toLowerCase() !== 'paid' && r.due_date && r.due_date < todayISO()),
    }
  }, [rows])

  async function create() {
    if (!f.district_name || !f.amount) { setMsg({ kind: 'warn', text: 'District and amount are required.' }); return }
    setBusy(true)
    const { error } = await supabase.from('Invoices').insert({
      case_id: f.case_id ? Number(f.case_id) : null,
      invoice_number: f.invoice_number.trim() || null,
      student_name: f.student_name.trim() || null,
      district_name: f.district_name,
      amount: Number(f.amount),
      issued_date: f.issued_date || null,
      due_date: f.due_date || null,
      status: f.status,
    })
    setBusy(false)
    if (error) setMsg({ kind: 'danger', text: error.message })
    else {
      setMsg({ kind: 'success', text: 'Invoice created.' })
      setF({ case_id: '', invoice_number: '', student_name: '', district_name: '', amount: '', issued_date: '', due_date: '', status: 'Draft' })
      onChanged()
    }
  }

  // Picking a case pre-fills the invoice the same way the automation would.
  function pickCase(id) {
    const c = id ? caseById.get(Number(id)) : null
    setF(p => ({
      ...p,
      case_id: id,
      student_name: c?.Student_name || p.student_name,
      district_name: c?.School_district || p.district_name,
      invoice_number: c?.invoice_seq ? `${c.case_number || c.id}-${c.invoice_seq}` : p.invoice_number,
    }))
  }

  function startEdit(inv) {
    setEditId(inv.id); setMsg(null)
    setEdit({
      invoice_number: inv.invoice_number || '',
      student_name: inv.student_name || '',
      district_name: inv.district_name || '',
      amount: inv.amount ?? '',
      issued_date: inv.issued_date || '',
      due_date: inv.due_date || '',
      status: inv.status || 'Draft',
    })
  }

  async function saveEdit(id) {
    setBusy(true); setMsg(null)
    const { error } = await supabase.from('Invoices').update({
      invoice_number: edit.invoice_number.trim() || null,
      student_name: edit.student_name.trim() || null,
      district_name: edit.district_name.trim() || null,
      amount: edit.amount === '' ? null : Number(edit.amount),
      issued_date: edit.issued_date || null,
      due_date: edit.due_date || null,
      status: edit.status,
    }).eq('id', id)
    setBusy(false)
    if (error) { setMsg({ kind: 'danger', text: error.message }); return }
    setEditId(null); setMsg({ kind: 'success', text: 'Invoice updated.' }); onChanged()
  }

  async function setStatus(inv, status) {
    await supabase.from('Invoices').update({ status }).eq('id', inv.id)
    onChanged()
  }

  async function remove(inv) {
    setBusy(true)
    const { error } = await supabase.from('Invoices').delete().eq('id', inv.id)
    setBusy(false); setConfirmDel(null)
    if (error) setMsg({ kind: 'danger', text: error.message })
    else { setMsg({ kind: 'success', text: `Invoice ${inv.invoice_number || inv.id} deleted.` }); onChanged() }
  }

  const overdue = r => (r.status || '').toLowerCase() !== 'paid' && r.due_date && r.due_date < todayISO()

  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div className="card-title" style={{ marginBottom: 0 }}>Invoices</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select value={districtSel} onChange={e => setDistrictSel(e.target.value)} style={{ maxWidth: 220 }}>
              <option value="">All districts</option>
              {districtOptions.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
            <input placeholder="Search # / student / district…" value={q} onChange={e => setQ(e.target.value)} style={{ maxWidth: 240 }} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 18, margin: '10px 0 4px', fontSize: 13, color: '#555', flexWrap: 'wrap' }}>
          <span>Total <strong>${totals.all.toLocaleString()}</strong></span>
          <span>Outstanding <strong>${totals.outstanding.toLocaleString()}</strong></span>
          {totals.overdue > 0 && <span style={{ color: '#b45309' }}>Overdue <strong>${totals.overdue.toLocaleString()}</strong></span>}
        </div>
        {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}
        <div className="tbl-wrap">
          <table>
            <thead><tr><th style={{ whiteSpace: 'nowrap', minWidth: 120 }}>Invoice #</th><th>Student</th><th>District</th><th>Amount</th><th>Issued</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={7} style={{ color: '#888' }}>{invoices.length === 0 ? 'No invoices yet — one is recorded automatically when every report on a case is approved in QA.' : 'No invoices match that search.'}</td></tr>}
              {rows.map(inv => editId === inv.id ? (
                <tr key={inv.id}>
                  <td><input value={edit.invoice_number} onChange={e => setEdit(p => ({ ...p, invoice_number: e.target.value }))} style={{ width: 130 }} /></td>
                  <td><input value={edit.student_name} onChange={e => setEdit(p => ({ ...p, student_name: e.target.value }))} style={{ width: 130 }} /></td>
                  <td><input value={edit.district_name} onChange={e => setEdit(p => ({ ...p, district_name: e.target.value }))} style={{ width: 130 }} /></td>
                  <td><input type="number" value={edit.amount} onChange={e => setEdit(p => ({ ...p, amount: e.target.value }))} style={{ width: 90 }} /></td>
                  <td><input type="date" value={edit.issued_date} onChange={e => setEdit(p => ({ ...p, issued_date: e.target.value }))} /></td>
                  <td>
                    <select value={edit.status} onChange={e => setEdit(p => ({ ...p, status: e.target.value }))}>
                      {['Draft', 'Sent', 'Paid'].map(s => <option key={s}>{s}</option>)}
                    </select>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => saveEdit(inv.id)}>Save</button>{' '}
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditId(null)}>Cancel</button>
                  </td>
                </tr>
              ) : (
                <Fragment key={inv.id}>
                  <tr>
                    <td style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{inv._number}</td>
                    <td>{inv._student}</td>
                    <td>{inv.district_name || '—'}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>${Number(inv.amount || 0).toLocaleString()}</td>
                    <td>{fmtDate(inv.issued_date)}</td>
                    <td><Badge status={inv.status} /></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-secondary btn-sm" onClick={() => startEdit(inv)}>✏️ Edit</button>{' '}
                      {(inv.status || '').toLowerCase() !== 'paid' && (
                        <button className="btn btn-ghost btn-sm" onClick={() => setStatus(inv, 'Paid')}>Mark Paid</button>
                      )}{' '}
                      <button className="btn btn-ghost btn-sm" title="Delete invoice" onClick={() => { setConfirmDel(inv.id); setMsg(null) }}>🗑</button>
                    </td>
                  </tr>
                  {confirmDel === inv.id && (
                    <tr><td colSpan={7}>
                      <div className="alert alert-danger" style={{ margin: 0 }}>
                        <strong>Delete invoice {inv._number}?</strong> This removes it from the register permanently. The case and its reports are not affected.{' '}
                        <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => remove(inv)}>Delete</button>{' '}
                        <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDel(null)}>Cancel</button>
                      </div>
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card" style={{ border: '2px solid var(--accent)' }}>
        <div className="card-title">➕ New Invoice</div>
        <div style={{ fontSize: 12.5, color: '#666', marginBottom: 10 }}>
          Invoices record themselves when a case clears QA. Use this only for off-cycle billing — interpretation, translation, or a re-issue.
        </div>
        <div className="form-group"><label>Case (optional — pre-fills the rest)</label>
          <select value={f.case_id} onChange={e => pickCase(e.target.value)}>
            <option value="">— none —</option>
            {cases.slice(0, 400).map(c => <option key={c.id} value={c.id}>{c.case_number} — {c.Student_name}</option>)}
          </select>
        </div>
        <div className="form-row">
          <div className="form-group"><label>Invoice #</label><input value={f.invoice_number} onChange={e => setF(p => ({ ...p, invoice_number: e.target.value }))} placeholder="26-001-1000" /></div>
          <div className="form-group"><label>Student</label><input value={f.student_name} onChange={e => setF(p => ({ ...p, student_name: e.target.value }))} /></div>
        </div>
        <div className="form-group"><label>District *</label><input value={f.district_name} onChange={e => setF(p => ({ ...p, district_name: e.target.value }))} /></div>
        <div className="form-row">
          <div className="form-group"><label>Amount ($) *</label><input type="number" value={f.amount} onChange={e => setF(p => ({ ...p, amount: e.target.value }))} /></div>
          <div className="form-group"><label>Status</label>
            <select value={f.status} onChange={e => setF(p => ({ ...p, status: e.target.value }))}>
              {['Draft', 'Sent', 'Paid'].map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
        </div>
        <div className="form-row">
          <div className="form-group"><label>Issued Date</label>
            <input type="date" value={f.issued_date} onChange={e => {
              const v = e.target.value
              setF(p => ({ ...p, issued_date: v, due_date: v && !p.due_date ? addDays(v, INVOICE_TERMS_DAYS) : p.due_date }))
            }} />
          </div>
          <div className="form-group"><label>Due Date <span style={{ color: '#888', fontWeight: 400 }}>(Net 30)</span></label><input type="date" value={f.due_date} onChange={e => setF(p => ({ ...p, due_date: e.target.value }))} /></div>
        </div>
        <button className="btn btn-primary" disabled={busy} onClick={create}>Create Invoice</button>
      </div>
    </div>
  )
}

function Payroll({ assignments, earnings, batches, contractors, onChanged }) {
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  const contractorById = useMemo(() => new Map(contractors.map(k => [k.identifier, k])), [contractors])
  const assignmentById = useMemo(() => new Map(assignments.map(a => [a.id, a])), [assignments])
  // ── All Earnings: permanent running ledger, one row per case/invoice ──
  const [rateMap, setRateMap] = useState({})
  useEffect(() => { loadRates().then(setRateMap) }, [])

  // Group every assigned evaluator by case (a case appears once it has an assignment).
  const caseGroups = useMemo(() => {
    const idx = new Map(); const out = []
    for (const a of assignments) {
      if (a.contractor_id == null) continue
      let g = idx.get(a.case_id)
      if (!g) { g = { case_id: a.case_id, caseRow: a.Cases || {}, items: [] }; idx.set(a.case_id, g); out.push(g) }
      g.items.push(a)
    }
    out.sort((x, y) => String(y.caseRow?.case_number || '').localeCompare(String(x.caseRow?.case_number || '')))
    return out
  }, [assignments])

  const invNo = c => c?.invoice_seq ? `${c.case_number || c.id}-${c.invoice_seq}` : (c?.case_number || '—')
  const evalRate = g => rateForLanguage(g.caseRow?.Language, rateMap)
  const expectedIncome = g => evalRate(g) * g.items.length

  // Flat, stable order of every editable date cell (district payment, then its evaluators).
  const cellOrder = useMemo(() => {
    const keys = []
    for (const g of caseGroups) { keys.push(`d:${g.case_id}`); for (const a of g.items) keys.push(`e:${a.id}`) }
    return keys
  }, [caseGroups])

  const [sel, setSel] = useState(new Set())      // selected cell keys
  const [active, setActive] = useState(null)     // anchor key
  const [clip, setClip] = useState(null)         // copied ISO date or ''
  const [editKey, setEditKey] = useState(null)   // cell being typed
  const [dateOverride, setDateOverride] = useState({}) // key -> ISO for instant display

  const cellVal = key => {
    if (key in dateOverride) return dateOverride[key]
    const [t, id] = key.split(':')
    if (t === 'd') { const g = caseGroups.find(x => String(x.case_id) === id); const d = g?.caseRow?.district_payment_date; return d ? String(d).slice(0, 10) : '' }
    const a = assignmentById.get(Number(id)); const d = a?.paid_date; return d ? String(d).slice(0, 10) : ''
  }

  async function writeDates(keys, val) {
    if (!keys.length) return
    setDateOverride(prev => { const n = { ...prev }; keys.forEach(k => { n[k] = val || '' }); return n })
    setBusy(true); setMsg(null)
    const caseIds = keys.filter(k => k[0] === 'd').map(k => Number(k.slice(2)))
    const asgIds = keys.filter(k => k[0] === 'e').map(k => Number(k.slice(2)))
    let err = null
    if (caseIds.length) { const { error } = await supabase.from('Cases').update({ district_payment_date: val || null }).in('id', caseIds); if (error) err = error }
    if (asgIds.length) { const { error } = await supabase.from('Assignments').update(val ? { paid_date: val } : { paid_date: null, paid_notified_at: null }).in('id', asgIds); if (error) err = error }
    if (err) setMsg({ kind: 'danger', text: err.message })
    else setMsg({ kind: 'success', text: `Date ${val ? 'set' : 'cleared'} for ${keys.length} cell${keys.length === 1 ? '' : 's'}.` })
    onChanged(); setBusy(false)
  }

  function cellClick(e, key) {
    e.stopPropagation()
    if (e.shiftKey && active) {
      const a = cellOrder.indexOf(active), b = cellOrder.indexOf(key)
      if (a !== -1 && b !== -1) { const [lo, hi] = a < b ? [a, b] : [b, a]; setSel(new Set(cellOrder.slice(lo, hi + 1))) }
    } else if (e.ctrlKey || e.metaKey) {
      setSel(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n }); setActive(key)
    } else { setSel(new Set([key])); setActive(key) }
  }

  useEffect(() => {
    function onKey(e) {
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
      if (!sel.size) return
      const meta = e.ctrlKey || e.metaKey; const key = e.key.toLowerCase()
      if (meta && key === 'c') { const v = active ? cellVal(active) : ''; setClip(v); try { navigator.clipboard.writeText(fmtDate(v) || '') } catch { /* ignore */ } setMsg({ kind: 'info', text: v ? `Copied ${fmtDate(v)}` : 'Copied (blank)' }); e.preventDefault() }
      else if (meta && key === 'v') { if (clip != null) writeDates([...sel], clip); e.preventDefault() }
      else if (meta && key === 'd') { writeDates([...sel], active ? cellVal(active) : ''); e.preventDefault() }
      else if (key === 'delete' || key === 'backspace') { writeDates([...sel], ''); e.preventDefault() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [sel, active, clip, caseGroups, dateOverride])

  const dateCell = (key) => {
    if (editKey === key) {
      return <input type="date" autoFocus defaultValue={cellVal(key)} disabled={busy}
        onClick={e => e.stopPropagation()}
        onChange={e => { writeDates([key], e.target.value); setEditKey(null) }}
        onBlur={() => setEditKey(null)}
        style={{ padding: '2px 4px', fontSize: 12 }} />
    }
    const v = cellVal(key); const isSel = sel.has(key); const isActive = active === key
    return (
      <span onClick={e => cellClick(e, key)} onDoubleClick={e => { e.stopPropagation(); setEditKey(key) }}
        title="Click to select · double-click to set a date · Ctrl+C / Ctrl+V to copy across selected cells"
        style={{
          display: 'inline-block', minWidth: 96, textAlign: 'center', cursor: 'cell', userSelect: 'none',
          padding: '3px 8px', borderRadius: 6, fontSize: 12.5, fontVariantNumeric: 'tabular-nums',
          border: `1px solid ${isSel ? 'var(--accent)' : 'var(--border)'}`, background: isSel ? 'var(--accent-light)' : '#fff',
          boxShadow: isActive ? 'inset 0 0 0 1px var(--accent)' : 'none', color: v ? 'var(--green)' : '#9aa1ab', fontWeight: v ? 650 : 400,
        }}>
        {v ? fmtDate(v) : '— set'}
      </span>
    )
  }

  const ledgerTotals = useMemo(() => {
    let income = 0, dPaid = 0, evalPaid = 0, evalCount = 0
    for (const g of caseGroups) {
      income += expectedIncome(g)
      if (cellVal(`d:${g.case_id}`)) dPaid++
      for (const a of g.items) { evalCount++; if (cellVal(`e:${a.id}`)) evalPaid++ }
    }
    return { income, dPaid, evalPaid, evalCount }
  }, [caseGroups, rateMap, dateOverride])

  // ── Monthly payroll: one line per evaluator per case. A report belongs to the payroll month
  // whose window (26th of the prior month → 25th) contains the day it was received. ──
  const earningByAsg = useMemo(() => new Map(earnings.map(e => [e.assignment_id, e])), [earnings])
  const paidOf = id => cellVal(`e:${id}`)
  const payLines = useMemo(() => assignments
    .filter(a => a.contractor_id != null && a.submitted_at)
    .map(a => {
      const k = contractorById.get(a.contractor_id) || a.Contractors || {}
      const e = earningByAsg.get(a.id)
      const received = receivedISO(a.submitted_at)
      return {
        id: a.id, month: payrollMonthOf(received), received, contractor_id: a.contractor_id,
        evaluator: k.name || '—', field: a.eval_type || '—',
        case_number: a.Cases?.case_number || '', student: a.Cases?.Student_name || '',
        method: k.preferred_payment_method || '',
        notified: a.paid_notified_at || null,   // when the evaluator was told this line was paid
        // Approved reports carry a recorded earning; otherwise use the evaluator's current rate.
        amount: e ? Number(e.amount || 0) : parseRate(k.current_rate),
      }
    }), [assignments, contractorById, earningByAsg])
  const lineSort = (x, y) => x.field.localeCompare(y.field) || x.evaluator.localeCompare(y.evaluator) || x.student.localeCompare(y.student)
  const monthLabel = ym => { const [y, m] = String(ym || '').split('-').map(Number); return (y && m) ? new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : (ym || '—') }

  const [archives, setArchives] = useState([])
  async function loadArchives() {
    const { data } = await supabase.from('payroll_archives').select('*').order('month', { ascending: false })
    setArchives(data || [])
  }
  useEffect(() => { loadArchives() }, [])
  const archiveByMonth = useMemo(() => new Map(archives.map(r => [r.month, r])), [archives])

  // Months that have at least one received report, newest first, with unpaid counts.
  const payMonths = useMemo(() => {
    const m = new Map()
    for (const l of payLines) {
      const g = m.get(l.month) || { month: l.month, count: 0, unpaid: 0 }
      g.count++; if (!paidOf(l.id)) g.unpaid++
      m.set(l.month, g)
    }
    return [...m.values()].sort((x, y) => y.month.localeCompare(x.month))
  }, [payLines, dateOverride])

  const [payMonth, setPayMonth] = useState(null)
  const [payEval, setPayEval] = useState('')
  const [payField, setPayField] = useState('')
  const [payStatus, setPayStatus] = useState('all') // all | unpaid | paid
  const [picked, setPicked] = useState(new Set())    // selected assignment ids
  const [payDate, setPayDate] = useState(todayISO())
  const [viewArchive, setViewArchive] = useState(null)
  // Default to the payroll period we're currently in if it has reports, else the newest one.
  const month = payMonth || (payMonths.find(m => m.month === payrollMonthOf(todayISO())) || payMonths[0])?.month || ''
  const monthLines = useMemo(() => payLines.filter(l => l.month === month).sort(lineSort), [payLines, month])
  const visibleLines = monthLines.filter(l =>
    (!payEval || l.evaluator === payEval) && (!payField || l.field === payField) &&
    (payStatus === 'all' || (payStatus === 'paid') === !!paidOf(l.id)))
  // Click-to-sort on Evaluator / Field / Student Name. Default: grouped by field, A→Z.
  const [paySort, setPaySort] = useState({ col: 'field', dir: 'asc' })
  const sortBy = col => setPaySort(p => p.col === col ? { col, dir: p.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' })
  const sortedLines = [...visibleLines].sort((x, y) =>
    (String(x[paySort.col] || '').localeCompare(String(y[paySort.col] || '')) * (paySort.dir === 'asc' ? 1 : -1)) || lineSort(x, y))
  const sortTh = (col, label) => (
    <th onClick={() => sortBy(col)} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
      title={`Sort by ${label.toLowerCase()} — click again to reverse`}>
      {label} <span style={{ color: paySort.col === col ? 'var(--accent)' : '#b6bcc5' }}>{paySort.col === col ? (paySort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
    </th>
  )
  const evalOptions = [...new Set(monthLines.map(l => l.evaluator))].sort((x, y) => x.localeCompare(y))
  const fieldOptions = [...new Set(monthLines.map(l => l.field))].sort((x, y) => x.localeCompare(y))
  const sumOf = arr => arr.reduce((n, l) => n + Number(l.amount || 0), 0)
  const monthUnpaid = monthLines.filter(l => !paidOf(l.id))
  const monthAllPaid = monthLines.length > 0 && monthUnpaid.length === 0
  const monthArchive = archiveByMonth.get(month)
  const pickedVisible = visibleLines.filter(l => picked.has(l.id))
  const visibleUnpaid = visibleLines.filter(l => !paidOf(l.id))
  const allUnpaidPicked = visibleUnpaid.length > 0 && visibleUnpaid.every(l => picked.has(l.id))
  const pickMonth = m => { setPayMonth(m); setPicked(new Set()); setPayEval(''); setPayField('') }
  const togglePick = id => setPicked(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const toggleAll = () => setPicked(allUnpaidPicked ? new Set() : new Set(visibleUnpaid.map(l => l.id)))

  const archiveRowsFor = (m, paidFor = l => paidOf(l.id)) => payLines.filter(l => l.month === m).sort(lineSort).map(l => ({
    evaluator: l.evaluator, field: l.field, case_number: l.case_number, student: l.student,
    payment_method: l.method, amount: l.amount, report_received: l.received, date_paid: paidFor(l) || '',
  }))
  async function archiveMonth(m, paidFor) {
    const rows = archiveRowsFor(m, paidFor)
    const { error } = await supabase.from('payroll_archives').upsert({
      month: m, archived_at: new Date().toISOString(), row_count: rows.length,
      total: rows.reduce((n, r) => n + Number(r.amount || 0), 0), rows,
    })
    if (error) { setMsg({ kind: 'danger', text: `Could not archive ${monthLabel(m)}: ${error.message}` }); return false }
    await loadArchives()
    return true
  }
  async function archiveNow() {
    setBusy(true); setMsg(null)
    if (await archiveMonth(month)) setMsg({ kind: 'success', text: `${monthLabel(month)} payroll archived — it's saved below and can be exported to Excel any time.` })
    setBusy(false)
  }

  // Mark (or clear, with date '') the paid date on a set of evaluator lines. Once every
  // line in the month is paid, the month is archived automatically.
  async function setPaid(ids, date) {
    if (!ids.length) return
    if (date == null) { setMsg({ kind: 'warn', text: 'Pick a paid date first.' }); return }
    setBusy(true); setMsg(null)
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200)
      const { error } = await supabase.from('Assignments').update(date ? { paid_date: date } : { paid_date: null, paid_notified_at: null }).in('id', chunk)
      if (error) { setMsg({ kind: 'danger', text: error.message }); onChanged(); setBusy(false); return }
      // Keep the contractor's "My Earnings" status in step.
      await supabase.from('contractor_earnings').update({ status: date ? 'paid' : 'pending' }).in('assignment_id', chunk)
    }
    setDateOverride(prev => { const n = { ...prev }; ids.forEach(id => { n[`e:${id}`] = date || '' }); return n })
    if (!date) setJustNotified(prev => { const n = new Set(prev); ids.forEach(id => n.delete(id)); return n })
    setPicked(new Set())
    let note = ''
    if (date) {
      const idSet = new Set(ids)
      const paidFor = l => idSet.has(l.id) ? date : paidOf(l.id)
      if (monthLines.length > 0 && monthLines.every(l => paidFor(l)) && await archiveMonth(month, paidFor)) {
        note = ` Every ${monthLabel(month)} evaluation is now paid — the month has been archived below.`
      }
    }
    setMsg({ kind: 'success', text: (date ? `Marked ${ids.length} evaluation${ids.length === 1 ? '' : 's'} paid on ${fmtDate(date)}.` : `Cleared the paid date on ${ids.length} evaluation${ids.length === 1 ? '' : 's'}.`) + note })
    onChanged(); setBusy(false)
  }

  // ── Notify evaluators, inside their portal, about lines that have been marked paid ──
  const [notifyOpen, setNotifyOpen] = useState(false)       // confirmation dialog
  const [justNotified, setJustNotified] = useState(new Set()) // line ids notified this session
  // Paid lines in this payroll month that the evaluator hasn't been told about yet, per evaluator.
  const notifyGroups = (() => {
    const m = new Map()
    for (const l of monthLines) {
      const paid = paidOf(l.id)
      if (!paid || l.notified || justNotified.has(l.id)) continue
      const g = m.get(l.contractor_id) || {
        contractor_id: l.contractor_id, evaluator: l.evaluator, method: l.method,
        hasLogin: !!contractorById.get(l.contractor_id)?.user_id, lines: [],
      }
      g.lines.push({ ...l, paid })
      m.set(l.contractor_id, g)
    }
    return [...m.values()].sort((x, y) => x.evaluator.localeCompare(y.evaluator))
  })()
  const notifyLineCount = notifyGroups.reduce((n, g) => n + g.lines.length, 0)

  async function sendPaidNotifications() {
    if (!notifyGroups.length) { setNotifyOpen(false); return }
    setBusy(true); setMsg(null)
    const rows = notifyGroups.map(g => {
      const total = sumOf(g.lines)
      const dates = [...new Set(g.lines.map(l => l.paid))]
      return {
        contractor_id: g.contractor_id, kind: 'payment',
        title: `Payment sent — ${monthLabel(month)} payroll`,
        body: `You were paid $${total.toLocaleString()} for ${g.lines.length} evaluation${g.lines.length === 1 ? '' : 's'}`
          + (dates.length === 1 ? ` on ${fmtDate(dates[0])}` : '') + (g.method ? ` via ${g.method}` : '') + '.',
        details: {
          month, total,
          lines: g.lines.map(l => ({ case_number: l.case_number, student: l.student, field: l.field, amount: l.amount, date_paid: l.paid })),
        },
      }
    })
    const { error } = await supabase.from('contractor_notifications').insert(rows)
    if (error) { setMsg({ kind: 'danger', text: `Notifications were not sent: ${error.message}` }); setNotifyOpen(false); setBusy(false); return }
    // Stamp the lines so the same payment is never announced twice.
    const ids = notifyGroups.flatMap(g => g.lines.map(l => l.id))
    const stamp = new Date().toISOString()
    for (let i = 0; i < ids.length; i += 200) {
      await supabase.from('Assignments').update({ paid_notified_at: stamp }).in('id', ids.slice(i, i + 200))
    }
    setJustNotified(prev => new Set([...prev, ...ids]))
    setNotifyOpen(false)
    setMsg({ kind: 'success', text: `Notified ${rows.length} evaluator${rows.length === 1 ? '' : 's'} in their portal about ${ids.length} paid evaluation${ids.length === 1 ? '' : 's'}.` })
    onChanged(); setBusy(false)
  }

  async function setMethod(contractorId, method) {
    setBusy(true); setMsg(null)
    const { error } = await supabase.from('Contractors').update({ preferred_payment_method: method || null }).eq('identifier', contractorId)
    if (error) setMsg({ kind: 'danger', text: error.message })
    onChanged(); setBusy(false)
  }

  return (
    <>
      {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="sec-head">
          <h3>Monthly Payroll{month ? ` — ${monthLabel(month)}` : ''}</h3>
          <div className="filter-bar" style={{ margin: 0 }}>
            <select value={month} onChange={e => pickMonth(e.target.value)} title={`Payroll month — covers reports received from the ${PAYROLL_CUTOFF_DAY + 1}th of the prior month through the ${PAYROLL_CUTOFF_DAY}th`}>
              {payMonths.length === 0 && <option value="">No reports received yet</option>}
              {payMonths.map(m => (
                <option key={m.month} value={m.month}>
                  {monthLabel(m.month)} — {m.unpaid ? `${m.unpaid} unpaid` : 'all paid'}{archiveByMonth.has(m.month) ? ' · archived' : ''}
                </option>
              ))}
            </select>
            <select value={payEval} onChange={e => setPayEval(e.target.value)}>
              <option value="">All evaluators</option>
              {evalOptions.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            <select value={payField} onChange={e => setPayField(e.target.value)}>
              <option value="">All fields</option>
              {fieldOptions.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            {[['all', 'All'], ['unpaid', 'Unpaid'], ['paid', 'Paid']].map(([id, label]) => (
              <span key={id} className={`filter-chip ${payStatus === id ? 'active' : ''}`} onClick={() => setPayStatus(id)}>{label}</span>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', fontSize: 13, marginBottom: 10 }}>
          {month && <span><span style={{ color: 'var(--muted)', marginRight: 6 }}>Reports received</span><strong>{payrollPeriodLabel(month)}</strong></span>}
          <span><span style={{ color: 'var(--muted)', marginRight: 6 }}>Evaluations</span><strong>{monthLines.length}</strong></span>
          <span><span style={{ color: 'var(--muted)', marginRight: 6 }}>Month total</span><strong style={{ fontVariantNumeric: 'tabular-nums' }}>${sumOf(monthLines).toLocaleString()}</strong></span>
          <span><span style={{ color: 'var(--muted)', marginRight: 6 }}>Paid</span><strong style={{ color: 'var(--green)', fontVariantNumeric: 'tabular-nums' }}>${(sumOf(monthLines) - sumOf(monthUnpaid)).toLocaleString()}</strong></span>
          <span><span style={{ color: 'var(--muted)', marginRight: 6 }}>Unpaid</span><strong style={{ color: monthUnpaid.length ? 'var(--red)' : undefined, fontVariantNumeric: 'tabular-nums' }}>${sumOf(monthUnpaid).toLocaleString()} ({monthUnpaid.length})</strong></span>
          {monthArchive && <span className="badge-s s-completed">Archived {fmtDate(receivedISO(monthArchive.archived_at))}</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          <label style={{ fontSize: 12, color: '#555', display: 'inline-flex', alignItems: 'center', gap: 6 }}>Date paid
            <input type="date" value={payDate} onChange={e => setPayDate(e.target.value)} style={{ padding: '4px 6px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 5 }} />
          </label>
          <button className="btn btn-primary btn-sm" disabled={busy || !payDate || pickedVisible.length === 0} onClick={() => setPaid(pickedVisible.map(l => l.id), payDate)}>
            ✓ Mark selected paid ({pickedVisible.length})
          </button>
          <button className="btn btn-secondary btn-sm" disabled={busy || !payDate || visibleUnpaid.length === 0}
            title="Marks every unpaid evaluation shown below as paid on the date above"
            onClick={() => { if (window.confirm(`Mark all ${visibleUnpaid.length} unpaid evaluation${visibleUnpaid.length === 1 ? '' : 's'} shown as paid on ${fmtDate(payDate)}?`)) setPaid(visibleUnpaid.map(l => l.id), payDate) }}>
            ✓ Mark all unpaid as paid ({visibleUnpaid.length})
          </button>
          {pickedVisible.some(l => paidOf(l.id)) &&
            <button className="btn btn-ghost btn-sm" disabled={busy} title="Undo — clears the paid date on the selected rows" onClick={() => setPaid(pickedVisible.filter(l => paidOf(l.id)).map(l => l.id), '')}>↩ Clear paid date</button>}
          <span style={{ flex: 1 }} />
          <button className="btn btn-secondary btn-sm" disabled={busy || notifyLineCount === 0}
            title={notifyLineCount === 0 ? 'No paid evaluations in this month are waiting to be announced' : 'Post a "Payment sent" notice in the portal of each evaluator who has been marked paid'}
            onClick={() => setNotifyOpen(true)}>
            🔔 Notify paid evaluators ({notifyGroups.length})
          </button>
          {monthAllPaid && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={archiveNow}>📦 {monthArchive ? 'Update archive' : 'Archive month'}</button>}
          <button className="btn btn-ghost btn-sm" disabled={monthLines.length === 0} onClick={() => exportPayrollToExcel(month, archiveRowsFor(month))}>⬇ Export to Excel</button>
        </div>
        {monthAllPaid && !monthArchive && <div className="alert alert-success">Every evaluation for {monthLabel(month)} is paid. Click <strong>Archive month</strong> to file it below.</div>}
        <div className="tbl-wrap sticky-head">
          <table>
            <thead><tr>
              <th style={{ width: 30 }}><input type="checkbox" checked={allUnpaidPicked} onChange={toggleAll} disabled={visibleUnpaid.length === 0} title="Select all unpaid shown" /></th>
              {sortTh('evaluator', 'Evaluator')}{sortTh('field', 'Field')}<th>Case #</th>{sortTh('student', 'Student Name')}<th>Payment Method</th>
              <th style={{ textAlign: 'right' }}>Earnings</th><th>Report Rec'd</th><th>Date Paid</th>
            </tr></thead>
            <tbody>
              {visibleLines.length === 0 && <tr><td colSpan={9} style={{ color: '#888' }}>{monthLines.length === 0 ? 'No reports received in this payroll period yet.' : 'No evaluations match these filters.'}</td></tr>}
              {sortedLines.map((l, i) => {
                const paid = paidOf(l.id)
                // When sorted by field, start each field with a group header + subtotal.
                const newGroup = paySort.col === 'field' && (i === 0 || sortedLines[i - 1].field !== l.field)
                const groupLines = newGroup ? sortedLines.filter(x => x.field === l.field) : null
                return (
                  <Fragment key={l.id}>
                  {newGroup && (
                    <tr style={{ background: '#e8eef6' }}>
                      <td></td>
                      <td colSpan={5} style={{ fontWeight: 700, fontSize: 12, textTransform: 'uppercase', letterSpacing: '.04em', color: '#3b4a5e' }}>
                        {l.field} <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--muted)' }}>· {groupLines.length} evaluation{groupLines.length === 1 ? '' : 's'}</span>
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>${sumOf(groupLines).toLocaleString()}</td>
                      <td></td><td></td>
                    </tr>
                  )}
                  <tr style={{ background: picked.has(l.id) ? 'var(--accent-light)' : undefined }}>
                    <td><input type="checkbox" checked={picked.has(l.id)} onChange={() => togglePick(l.id)} /></td>
                    <td style={{ fontWeight: 600 }}>{l.evaluator}</td>
                    <td>{l.field}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{l.case_number || '—'}</td>
                    <td>{l.student || '—'}</td>
                    <td>
                      <select value={l.method} disabled={busy} onChange={e => setMethod(l.contractor_id, e.target.value)}
                        title="Saved on the evaluator's profile — applies to all of their rows"
                        style={{ padding: '2px 4px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 5, background: '#fff', color: l.method ? undefined : '#9aa1ab' }}>
                        <option value="">— set</option>
                        {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                        {l.method && !PAYMENT_METHODS.includes(l.method) && <option value={l.method}>{l.method}</option>}
                      </select>
                    </td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>${Number(l.amount || 0).toLocaleString()}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(l.received)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{paid ? <span className="badge-s s-completed">Paid {fmtDate(paid)}</span> : <span className="badge-s s-pending">Unpaid</span>}</td>
                  </tr>
                  </Fragment>
                )
              })}
              {visibleLines.length > 0 && (
                <tr style={{ fontWeight: 700, background: '#f0f2f5' }}>
                  <td></td><td colSpan={5}>Total — {visibleLines.length} evaluation{visibleLines.length === 1 ? '' : 's'} shown</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>${sumOf(visibleLines).toLocaleString()}</td><td></td><td></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-title">📦 Archived Payroll Months</div>
        <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>Each payroll month covers reports received from the {PAYROLL_CUTOFF_DAY + 1}th of the prior month through the {PAYROLL_CUTOFF_DAY}th. A month is filed here automatically once every evaluation in it has been marked paid. Each archive is a frozen copy you can export to Excel as a backup.</div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Month</th><th>Archived</th><th>Evaluations</th><th>Total Paid</th><th></th></tr></thead>
            <tbody>
              {archives.length === 0 && <tr><td colSpan={5} style={{ color: '#888' }}>No months archived yet.</td></tr>}
              {archives.map(r => (
                <Fragment key={r.month}>
                  <tr>
                    <td style={{ fontWeight: 600 }}>{monthLabel(r.month)}</td>
                    <td>{fmtDate(receivedISO(r.archived_at))}</td>
                    <td>{r.row_count}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>${Number(r.total || 0).toLocaleString()}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => setViewArchive(viewArchive === r.month ? null : r.month)}>{viewArchive === r.month ? 'Hide' : 'View'}</button>{' '}
                      <button className="btn btn-secondary btn-sm" onClick={() => exportPayrollToExcel(r.month, r.rows || [])}>⬇ Excel</button>
                    </td>
                  </tr>
                  {viewArchive === r.month && (
                    <tr><td colSpan={5} style={{ background: '#f8fafc', padding: 10 }}>
                      <table>
                        <thead><tr><th>Evaluator</th><th>Field</th><th>Case #</th><th>Student Name</th><th>Payment Method</th><th style={{ textAlign: 'right' }}>Earnings</th><th>Date Paid</th></tr></thead>
                        <tbody>
                          {(r.rows || []).map((x, i) => (
                            <tr key={i}>
                              <td>{x.evaluator}</td><td>{x.field}</td><td>{x.case_number || '—'}</td><td>{x.student || '—'}</td><td>{x.payment_method || '—'}</td>
                              <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>${Number(x.amount || 0).toLocaleString()}</td>
                              <td>{x.date_paid ? fmtDate(x.date_paid) : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="sec-head" style={{ marginBottom: 6 }}>
          <div className="card-title" style={{ marginBottom: 0 }}>All Earnings ({caseGroups.length} case{caseGroups.length === 1 ? '' : 's'})</div>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            Running list — nothing drops off. Click a date · Shift/Ctrl-click for many · double-click to set · Ctrl+C / Ctrl+V to copy across
          </span>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead><tr>
              <th>Invoice #</th><th>Student Name</th><th>School District</th>
              <th style={{ textAlign: 'right' }}>Expected Income</th><th>Evaluators</th>
            </tr></thead>
            <tbody>
              {caseGroups.length === 0 && <tr><td colSpan={5} style={{ color: '#888' }}>No assigned cases yet — assign a contractor to a case and it appears here.</td></tr>}
              {caseGroups.map(g => (
                <tr key={g.case_id}>
                  <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, whiteSpace: 'nowrap' }}>{invNo(g.caseRow)}</td>
                  <td>{g.caseRow?.Student_name || '—'}</td>
                  <td>{g.caseRow?.School_district || '—'}</td>
                  <td style={{ textAlign: 'right', verticalAlign: 'top' }}>
                    <div style={{ fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>${expectedIncome(g).toLocaleString()}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>{g.items.length} eval{g.items.length > 1 ? 's' : ''} × ${evalRate(g).toLocaleString()}</div>
                    <div style={{ marginTop: 8 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', marginBottom: 3 }}>Date Paid</div>
                      {dateCell(`d:${g.case_id}`)}
                    </div>
                  </td>
                  <td>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '2px 14px', alignItems: 'center', minWidth: 320 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', borderBottom: '1px dashed var(--border)', paddingBottom: 4 }}>Evaluator · Evaluation</div>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', borderBottom: '1px dashed var(--border)', paddingBottom: 4, textAlign: 'center' }}>Paid</div>
                      {g.items.map(a => (
                        <Fragment key={a.id}>
                          <div style={{ padding: '3px 0' }}>
                            <span style={{ fontWeight: 650 }}>{a.Contractors?.name || 'Unassigned'}</span>
                            {' '}<span className="badge-s s-assigned" style={{ fontSize: 10 }}>{a.eval_type || '—'}</span>
                          </div>
                          {dateCell(`e:${a.id}`)}
                        </Fragment>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {caseGroups.length > 0 && (
          <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', fontSize: 13 }}>
            <span><span style={{ color: 'var(--muted)', marginRight: 6 }}>Total expected income</span><strong style={{ fontVariantNumeric: 'tabular-nums' }}>${ledgerTotals.income.toLocaleString()}</strong></span>
            <span><span style={{ color: 'var(--muted)', marginRight: 6 }}>District payments received</span><strong>{ledgerTotals.dPaid} / {caseGroups.length}</strong></span>
            <span><span style={{ color: 'var(--muted)', marginRight: 6 }}>Evaluators paid</span><strong>{ledgerTotals.evalPaid} / {ledgerTotals.evalCount}</strong></span>
          </div>
        )}
      </div>
      {notifyOpen && (
        <div onClick={() => { if (!busy) setNotifyOpen(false) }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div className="card" role="dialog" aria-modal="true" aria-label="Notify evaluators?" onClick={e => e.stopPropagation()}
            style={{ maxWidth: 480, width: '100%', boxShadow: '0 12px 40px rgba(0,0,0,.3)' }}>
            <div className="card-title" style={{ fontSize: 16 }}>🔔 Notify evaluators?</div>
            <div style={{ fontSize: 13, color: '#444', marginBottom: 10 }}>
              This posts a <strong>“Payment sent”</strong> notice in the portal of{' '}
              <strong>{notifyGroups.length} evaluator{notifyGroups.length === 1 ? '' : 's'}</strong> covering{' '}
              <strong>{notifyLineCount} paid evaluation{notifyLineCount === 1 ? '' : 's'}</strong> for {monthLabel(month)}. No email is sent.
            </div>
            <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', fontSize: 13, marginBottom: 14 }}>
              {notifyGroups.map(g => (
                <div key={g.contractor_id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0', borderBottom: '1px solid #f0f2f5' }}>
                  <span>{g.evaluator}{!g.hasLogin && <span style={{ color: 'var(--muted)', fontSize: 11 }}> · no portal login yet</span>}</span>
                  <span style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{g.lines.length} · ${sumOf(g.lines).toLocaleString()}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setNotifyOpen(false)}>No, go back</button>
              <button className="btn btn-primary" disabled={busy} onClick={sendPaidNotifications}>{busy ? 'Sending…' : 'Yes, send'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// "13:30:00" -> "1:30 PM"
function fmtTime(t) {
  if (!t) return ''
  const [h, m] = String(t).split(':').map(Number)
  if (isNaN(h)) return String(t)
  return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}
const isInterpreter = k => /translat|interpret/i.test(k?.field || '')

// Appointment requests for translators / interpreters. Sending a request posts a notice in
// the translator's portal, where they accept or decline; their answer shows here.
function InterpreterRequests({ contractors }) {
  const blank = { contractor_id: '', language: '', school_district: '', location: '', appointment_date: '', start_time: '', end_time: '', notes: '' }
  const [f, setF] = useState(blank)
  const set = (k, v) => setF(p => ({ ...p, [k]: v }))
  const [showAll, setShowAll] = useState(false)
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [confirm, setConfirm] = useState(null)   // { kind: 'send' } | { kind: 'cancel', r }
  const [chip, setChip] = useState('open')

  async function load() {
    const { data, error } = await supabase.from('interpreter_requests')
      .select('*, Contractors(identifier, name, email, user_id, field)')
      .order('appointment_date', { ascending: false }).order('id', { ascending: false })
    if (error) setMsg({ kind: 'danger', text: error.message })
    setRequests(data || []); setLoading(false)
  }
  useEffect(() => { load() }, [])

  const roster = contractors.filter(k => k.active !== false && (showAll || isInterpreter(k)))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  const chosen = contractors.find(k => String(k.identifier) === String(f.contractor_id))
  const whenText = r => `${fmtDate(r.appointment_date)}${r.start_time ? ` · ${fmtTime(r.start_time)}` : ''}${r.end_time ? ` – ${fmtTime(r.end_time)}` : ''}`

  function validate() {
    if (!f.contractor_id) return 'Choose a translator or interpreter.'
    if (!f.school_district.trim() && !f.location.trim()) return 'Enter the school district or location.'
    if (!f.appointment_date) return 'Pick the appointment date.'
    if (!f.start_time) return 'Pick the appointment time.'
    return null
  }

  async function send() {
    const err = validate()
    if (err) { setMsg({ kind: 'warn', text: err }); setConfirm(null); return }
    setBusy(true); setMsg(null)
    const row = {
      contractor_id: Number(f.contractor_id), language: f.language || null,
      school_district: f.school_district.trim() || null, location: f.location.trim() || null,
      appointment_date: f.appointment_date, start_time: f.start_time || null, end_time: f.end_time || null,
      notes: f.notes.trim() || null, status: 'sent',
    }
    const { data: req, error } = await supabase.from('interpreter_requests').insert(row).select('id').single()
    if (error) { setMsg({ kind: 'danger', text: error.message }); setBusy(false); setConfirm(null); return }
    // The notice the translator sees in their portal (they accept / decline from there).
    const where = [row.school_district, row.location].filter(Boolean).join(' — ')
    await supabase.from('contractor_notifications').insert({
      contractor_id: row.contractor_id, kind: 'interpreter_request',
      title: `Interpreting request — ${row.school_district || row.location || 'appointment'} on ${fmtDate(row.appointment_date)}`,
      body: `${whenText(row)}${where ? ` at ${where}` : ''}${row.language ? ` (${row.language})` : ''}. Please accept or decline this request under Interpreting Requests.`,
      details: { request_id: req.id },
    })
    setF(blank); setConfirm(null)
    setMsg({ kind: 'success', text: `Request sent to ${chosen?.name || 'the translator'} — it's waiting for their response.${chosen?.user_id ? '' : ' Note: they have no portal login yet, so they won’t see it until one is set up (Contractors page → Invite).'}` })
    await load(); setBusy(false)
  }

  async function cancel(r) {
    setBusy(true); setMsg(null)
    const { error } = await supabase.from('interpreter_requests').update({ status: 'cancelled' }).eq('id', r.id)
    if (error) setMsg({ kind: 'danger', text: error.message })
    else {
      await supabase.from('contractor_notifications').insert({
        contractor_id: r.contractor_id, kind: 'interpreter_request',
        title: `Request cancelled — ${r.school_district || r.location || 'appointment'} on ${fmtDate(r.appointment_date)}`,
        body: `The office has cancelled this interpreting request (${whenText(r)}). No action is needed.`,
        details: { request_id: r.id },
      })
      setMsg({ kind: 'info', text: `Request cancelled — ${r.Contractors?.name || 'the translator'} has been notified.` })
    }
    setConfirm(null); await load(); setBusy(false)
  }

  async function remove(r) {
    if (!window.confirm(`Delete this ${r.status} request for ${r.Contractors?.name || 'the translator'} on ${fmtDate(r.appointment_date)}? This cannot be undone.`)) return
    setBusy(true); setMsg(null)
    const { error } = await supabase.from('interpreter_requests').delete().eq('id', r.id)
    if (error) setMsg({ kind: 'danger', text: error.message })
    await load(); setBusy(false)
  }

  const statusBadge = r => {
    if (r.status === 'accepted') return <span className="badge-s s-completed">✓ Accepted</span>
    if (r.status === 'declined') return <span className="badge-s s-overdue">✕ Declined</span>
    if (r.status === 'cancelled') return <span className="badge-s s-pending">Cancelled</span>
    const d = Math.max(0, Math.floor((Date.now() - new Date(r.sent_at).getTime()) / 86400000))
    return <span className="badge-s s-scheduled">Awaiting response · {d}d</span>
  }
  const counts = { open: requests.filter(r => r.status === 'sent').length, accepted: requests.filter(r => r.status === 'accepted').length, declined: requests.filter(r => r.status === 'declined').length }
  const rows = requests.filter(r => chip === 'all' || (chip === 'open' ? r.status === 'sent' : r.status === chip))

  return (
    <>
      {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="card" style={{ border: '2px solid var(--accent)' }}>
          <div className="card-title">🗓 New Appointment Request</div>
          <div className="form-group">
            <label>Translator / Interpreter *</label>
            <select value={f.contractor_id} onChange={e => set('contractor_id', e.target.value)}>
              <option value="">Select…</option>
              {roster.map(k => <option key={k.identifier} value={k.identifier}>{k.name}{k.field ? ` — ${k.field}` : ''}{[k.language, k.language_2].filter(Boolean).length ? ` · ${[k.language, k.language_2].filter(Boolean).join(', ')}` : ''}{k.user_id ? '' : ' (no portal login)'}</option>)}
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, textTransform: 'none', letterSpacing: 0, fontWeight: 400, marginTop: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> Show all contractors, not just translators / interpreters
            </label>
          </div>
          <div className="form-row">
            <div className="form-group"><label>Language</label>
              <select value={f.language} onChange={e => set('language', e.target.value)}>
                <option value="">—</option>
                {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            <div className="form-group"><label>School District</label><input value={f.school_district} onChange={e => set('school_district', e.target.value)} placeholder="e.g. Edison Township" /></div>
          </div>
          <div className="form-group"><label>Location / Address</label><input value={f.location} onChange={e => set('location', e.target.value)} placeholder="School name, address, or “virtual”" /></div>
          <div className="form-row-3">
            <div className="form-group"><label>Date *</label><input type="date" value={f.appointment_date} onChange={e => set('appointment_date', e.target.value)} /></div>
            <div className="form-group"><label>Start Time *</label><input type="time" value={f.start_time} onChange={e => set('start_time', e.target.value)} /></div>
            <div className="form-group"><label>End Time</label><input type="time" value={f.end_time} onChange={e => set('end_time', e.target.value)} /></div>
          </div>
          <div className="form-group"><label>Notes for the translator</label><textarea rows={2} value={f.notes} onChange={e => set('notes', e.target.value)} placeholder="Meeting type, who to ask for, parking, etc." /></div>
          <button className="btn btn-primary" disabled={busy} onClick={() => { const err = validate(); if (err) setMsg({ kind: 'warn', text: err }); else { setMsg(null); setConfirm({ kind: 'send' }) } }}>📨 Send request</button>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>The translator gets a notice in their portal and must accept or decline. Their answer shows in the list.</div>
        </div>

        <div className="card">
          <div className="sec-head">
            <h3>Requests</h3>
            <div className="filter-bar" style={{ margin: 0 }}>
              {[['open', `Awaiting (${counts.open})`], ['accepted', `Accepted (${counts.accepted})`], ['declined', `Declined (${counts.declined})`], ['all', 'All']].map(([id, label]) => (
                <span key={id} className={`filter-chip ${chip === id ? 'active' : ''}`} onClick={() => setChip(id)}>{label}</span>
              ))}
            </div>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Translator</th><th>Where</th><th>When</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {loading && <tr><td colSpan={5} style={{ color: '#888' }}>Loading…</td></tr>}
                {!loading && rows.length === 0 && <tr><td colSpan={5} style={{ color: '#888' }}>{requests.length === 0 ? 'No requests yet — send one with the form.' : 'Nothing in this view.'}</td></tr>}
                {rows.map(r => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{r.Contractors?.name || '—'}{r.language && <div style={{ fontWeight: 400, fontSize: 11, color: '#888' }}>{r.language}</div>}</td>
                    <td>{r.school_district || '—'}{r.location && <div style={{ fontSize: 11, color: '#888' }}>{r.location}</div>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{whenText(r)}<div style={{ fontSize: 11, color: '#888' }}>sent {fmtDate(receivedISO(r.sent_at))}</div></td>
                    <td>
                      {statusBadge(r)}
                      {r.status === 'declined' && r.decline_reason && <div style={{ fontSize: 11, color: '#888', marginTop: 3 }}>“{r.decline_reason}”</div>}
                      {r.responded_at && r.status !== 'sent' && <div style={{ fontSize: 11, color: '#888', marginTop: 3 }}>{fmtDate(receivedISO(r.responded_at))}</div>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {(r.status === 'sent' || r.status === 'accepted') && <button className="btn btn-ghost btn-sm" disabled={busy} title="Cancel this request (the translator is notified)" onClick={() => setConfirm({ kind: 'cancel', r })}>Cancel</button>}
                      {(r.status === 'declined' || r.status === 'cancelled') && <button className="btn btn-danger-outline btn-sm" disabled={busy} title="Delete this request" onClick={() => remove(r)}>🗑</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {confirm && (
        <div onClick={() => { if (!busy) setConfirm(null) }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div className="card" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()} style={{ maxWidth: 440, width: '100%', boxShadow: '0 12px 40px rgba(0,0,0,.3)' }}>
            {confirm.kind === 'send' ? (
              <>
                <div className="card-title" style={{ fontSize: 16 }}>📨 Send this request?</div>
                <div style={{ fontSize: 13, color: '#444', marginBottom: 12, lineHeight: 1.5 }}>
                  <strong>{chosen?.name}</strong> will get a notice in their portal asking them to accept or decline:<br />
                  <strong>{fmtDate(f.appointment_date)}</strong>{f.start_time ? ` · ${fmtTime(f.start_time)}` : ''}{f.end_time ? ` – ${fmtTime(f.end_time)}` : ''}
                  {(f.school_district || f.location) && <> at <strong>{[f.school_district, f.location].filter(Boolean).join(' — ')}</strong></>}
                  {f.language && <> ({f.language})</>}.
                  {!chosen?.user_id && <div style={{ color: 'var(--yellow)', marginTop: 6 }}>⚠ This person has no portal login yet, so they won’t see the request until one is set up.</div>}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirm(null)}>No, go back</button>
                  <button className="btn btn-primary" disabled={busy} onClick={send}>{busy ? 'Sending…' : 'Yes, send'}</button>
                </div>
              </>
            ) : (
              <>
                <div className="card-title" style={{ fontSize: 16 }}>Cancel this request?</div>
                <div style={{ fontSize: 13, color: '#444', marginBottom: 12 }}>
                  <strong>{confirm.r.Contractors?.name}</strong> — {whenText(confirm.r)}. They will be notified that it was cancelled.
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirm(null)}>No, go back</button>
                  <button className="btn btn-danger" disabled={busy} onClick={() => cancel(confirm.r)}>{busy ? 'Cancelling…' : 'Yes, cancel it'}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
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
  const [tab, setTab] = useState('pending')
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
  // Reports awaiting approval — the red counter on the Pending Review chip (matches the sidebar badge).
  const pendingCount = submitted.filter(a => qaByAssignment.get(a.id)?.qa_status !== 'approved').length
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
    // Default view: newest case numbers first.
    out.sort((x, y) => String(y.caseRow?.case_number || '').localeCompare(String(x.caseRow?.case_number || '')))
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

  async function viewReportPath(path) {
    if (!path) return
    const { data, error } = await supabase.storage.from('reports').createSignedUrl(path, 300)
    if (!error && data?.signedUrl) window.open(data.signedUrl, '_blank')
  }
  // All report files on an assignment (multi-upload aware, falls back to the legacy single report_url)
  function reportFilesOf(a) {
    if (Array.isArray(a?.report_files) && a.report_files.length) return a.report_files
    if (a?.report_url) return [{ path: a.report_url, name: a.report_url.split('/').pop() }]
    return []
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

  // Manually mark a case complete from Report Review. This sets the same field the
  // Cases page reads (sent_to_district_at) so the case shows Complete there too.
  async function markCaseComplete(caseId, caseRow) {
    setBusy(true); setMsg(null)
    const now = new Date().toISOString()
    const { error } = await supabase.from('Cases')
      .update({ sent_to_district_at: now, Status: 'Completed' })
      .eq('id', caseId)
    if (error) { setMsg({ kind: 'danger', text: error.message }); setBusy(false); return }
    setMsg({ kind: 'success', text: `${caseRow?.case_number || 'Case'} marked complete. It now shows as Complete on the Cases page.` })
    onChanged(); setBusy(false)
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
      let invoiceNote = ''
      if (allApproved) {
        await supabase.from('Cases').update({ Status: 'Completed' }).eq('id', selected.case_id)
        // Every report on this case is approved -> record the district invoice.
        const res = await autoRecordInvoice({ id: selected.case_id, ...(selected.Cases || {}) }, siblings.length)
        if (res.created) invoiceNote = ` Invoice ${res.invoice_number} ($${Number(res.amount).toLocaleString()}) recorded in Client Invoices as Draft.`
        else if (res.skipped === 'already recorded') invoiceNote = ` Invoice ${res.invoice_number} was already on file.`
        else if (res.error) invoiceNote = ` (Could not record the invoice automatically: ${res.error})`
      }
      setMsg({ kind: 'success', text: `Approved. Earning created for the contractor; case auto-completes when all its reports are approved.${invoiceNote}` })
    } else {
      setMsg({ kind: 'info', text: status === 'needs_revision' ? 'Marked as needing revision.' : 'Review saved.' })
    }
    onChanged(); setBusy(false)
  }

  async function downloadInvoice() {
    if (!selected) return
    const caseAssignments = assignments.filter(x => x.case_id === selected.case_id && x.contractor_id != null)
    const approved = caseAssignments.filter(x =>
      qaByAssignment.get(x.id)?.qa_status === 'approved' && x.submitted_at)
    const items = (approved.length > 0 ? approved : caseAssignments).map(x => ({
      assignmentId: x.id, evalType: x.eval_type || '', dateOfService: x.testing_date || x.submitted_at,
    })).sort((a, b) => a.assignmentId - b.assignmentId)
    // Last 4 digits: per-district sequence (1000, 1001, ...) assigned in invoice-creation order.
    const { data: seq, error } = await supabase.rpc('allocate_invoice_seq', { p_case_id: selected.case_id })
    if (error) { setMsg({ kind: 'danger', text: `Could not assign an invoice number: ${error.message}` }); return }
    generateInvoiceDoc({
      caseNumber: selected.Cases?.case_number || String(selected.case_id),
      studentName: selected.Cases?.Student_name || '',
      districtName: selected.Cases?.School_district || '',
      language: selected.Cases?.Language || null,
      rate: await getRate(selected.Cases?.Language),
      invoiceNumber: `${selected.Cases?.case_number || selected.case_id}-${seq}`,
      lineItems: items.map(l => ({ evalType: l.evalType, dateOfService: l.dateOfService })),
    })
  }

  // Manual fallback: normally the invoice records itself when the last report
  // on the case is approved. This re-runs the same routine (safe to press twice).
  async function recordInvoice() {
    if (!selected) return
    setBusy(true); setMsg(null)
    const caseAssignments = assignments.filter(x => x.case_id === selected.case_id && x.contractor_id != null)
    const approvedCount = caseAssignments.filter(x => qaByAssignment.get(x.id)?.qa_status === 'approved').length || 1
    const res = await autoRecordInvoice({ id: selected.case_id, ...(selected.Cases || {}) }, approvedCount)
    if (res.error) setMsg({ kind: 'danger', text: res.error })
    else if (res.skipped === 'already recorded') setMsg({ kind: 'info', text: `Invoice ${res.invoice_number} is already in Client Invoices.` })
    else setMsg({ kind: 'success', text: `Invoice ${res.invoice_number} recorded in Client Invoices ($${Number(res.amount).toLocaleString()}).` })
    onChanged(); setBusy(false)
  }

  const selectedQa = selected ? qaByAssignment.get(selected.id) : null

  return (
    <>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {[['all', 'All Submitted'], ['pending', `Pending Review`]].map(([id, label]) => (
          <span key={id} className={`filter-chip ${tab === id ? 'active' : ''}`} onClick={() => { setTab(id); setSelectedId(null) }}
            style={id === 'pending' ? { position: 'relative' } : undefined}>
            {label}
            {id === 'pending' && pendingCount > 0 && (
              <span title={`${pendingCount} submitted report${pendingCount === 1 ? '' : 's'} not yet approved — same number as the red badge next to "Report Review" in the sidebar`}
                style={{
                  position: 'absolute', top: -9, right: -9, minWidth: 19, height: 19, padding: '0 5px', boxSizing: 'border-box',
                  borderRadius: 10, background: '#e53935', color: '#fff', fontSize: 11, fontWeight: 700, lineHeight: '19px',
                  textAlign: 'center', boxShadow: '0 0 0 2px #fff, 0 1px 3px rgba(0,0,0,.3)', pointerEvents: 'none',
                }}>{pendingCount}</span>
            )}
          </span>
        ))}
      </div>
      {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="card-title">Submitted Reports ({rows.length})</div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Case</th><th>Student</th><th>District</th><th>Evaluation</th><th>Submitted</th><th>Due Date</th><th>QA Status</th></tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={7} style={{ color: '#888' }}>Nothing awaiting review.</td></tr>}
                {caseGroups.map(g => {
                  if (g.items.length === 1) {
                    const a = g.items[0]
                    return (
                      <tr key={a.id} onClick={() => openReview(a)} style={{ cursor: 'pointer', background: selectedId === a.id ? 'var(--accent-light)' : undefined }}>
                        <td><span className="tbl-link">{a.Cases?.case_number || a.case_id}</span></td>
                        <td>{a.Cases?.Student_name || '—'}</td>
                        <td>{a.Cases?.School_district || '—'}</td>
                        <td>{a.eval_type || '—'} — {a.Contractors?.name || '—'}</td>
                        <td>{fmtDate((a.submitted_at || '').slice(0, 10))}</td>
                        <td style={dueColor(a.report_due_date || a.Cases?.Report_Due_date)}>{fmtDate(a.report_due_date || a.Cases?.Report_Due_date) || '—'}</td>
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
                        <td>{g.caseRow?.School_district || '—'}</td>
                        <td><span style={{ display: 'inline-block', width: 12 }}>{isOpen(g.case_id) ? '▾' : '▸'}</span>{g.items.length} evaluations</td>
                        <td>—</td>
                        <td style={dueColor(g.caseRow?.Report_Due_date)}>{fmtDate(g.caseRow?.Report_Due_date) || '—'}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <span className={`badge-s ${approved === g.items.length ? 's-completed' : 's-pending'}`}>{approved}/{g.items.length} approved</span>
                          {allApproved && <>{' '}<button className="btn btn-ghost btn-sm" title="Download all reports for this student as one zip" disabled={busy} onClick={e => { e.stopPropagation(); consolidateReports(g.case_id, g.caseRow) }}>📦</button></>}
                        </td>
                      </tr>
                      {isOpen(g.case_id) && g.items.map(a => (
                        <tr key={a.id} onClick={() => openReview(a)} style={{ cursor: 'pointer', background: selectedId === a.id ? 'var(--accent-light)' : '#f8fafc' }}>
                          <td></td>
                          <td></td>
                          <td></td>
                          <td style={{ paddingLeft: 24 }}>↳ {a.eval_type || '—'} — {a.Contractors?.name || '—'}</td>
                          <td>{fmtDate((a.submitted_at || '').slice(0, 10))}</td>
                          <td style={dueColor(a.report_due_date || a.Cases?.Report_Due_date)}>{fmtDate(a.report_due_date || a.Cases?.Report_Due_date) || '—'}</td>
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

        {/* The review box stays pinned while the report list scrolls (it scrolls inside itself if taller than the window). */}
        <div style={{ alignSelf: 'stretch' }}>
        {selected && form ? (
          <div className="card" style={{ border: '2px solid var(--accent)', position: 'sticky', top: 0, maxHeight: 'calc(100vh - 90px)', overflowY: 'auto' }}>
            <div className="card-title">
              🔍 Review — {selected.Cases?.case_number} · {selected.eval_type} · {selected.Contractors?.name}
            </div>
            <div style={{ marginBottom: 10 }}>
              {(() => {
                const files = reportFilesOf(selected)
                if (!files.length) return <span style={{ fontSize: 12, color: '#888' }}>No report file on this assignment.</span>
                return files.map((f, i) => (
                  <button key={f.path || i} className="btn btn-secondary btn-sm" style={{ marginRight: 6, marginBottom: 4 }} onClick={() => viewReportPath(f.path)}>📄 {f.name || f.path.split('/').pop()}</button>
                ))
              })()}
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
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={recordInvoice} title="Normally automatic when the last report is approved — use this to force it">Record invoice now</button>
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
                <div style={{ marginTop: 14, borderTop: '1px solid #e5e7eb', paddingTop: 12 }}>
                  <div className="card-title" style={{ marginBottom: 6 }}>✅ Complete the Case</div>
                  {selected.Cases?.sent_to_district_at ? (
                    <div style={{ fontSize: 12, color: 'var(--green)' }}>
                      ✓ This case is already marked complete (as of {fmtDate(selected.Cases.sent_to_district_at)}). It shows as Complete on the Cases page.
                    </div>
                  ) : (
                    <>
                      <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
                        Once the consolidated reports have been sent to the district, mark this case complete. It will show as Complete on the Cases page too.
                      </div>
                      <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => markCaseComplete(selected.case_id, selected.Cases)}>✅ Mark Case as Complete</button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="card" style={{ color: '#888', position: 'sticky', top: 0 }}>Select a submitted report on the left to review it.</div>
        )}
        </div>
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

  const [acceptBusy, setAcceptBusy] = useState(false)
  const [acceptResult, setAcceptResult] = useState(null)
  const [acceptMsg, setAcceptMsg] = useState(null)
  async function runAcceptance(dryRun) {
    setAcceptBusy(true); setAcceptMsg(null); setAcceptResult(null)
    const { data, error } = await supabase.functions.invoke('send-acceptance-reminders', { body: { dry_run: dryRun } })
    if (error || !data?.success) {
      setAcceptMsg({ kind: 'danger', text: data?.error || error?.message || 'Acceptance reminder run failed.' })
    } else {
      setAcceptResult(data)
      if (!dryRun) onChanged()
    }
    setAcceptBusy(false)
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
      <div className="card" style={{ marginBottom: 14, border: '2px solid var(--accent)' }}>
        <div className="card-title">🤝 Acceptance Reminders</div>
        <div style={{ fontSize: 13, color: '#555', marginBottom: 10 }}>
          A reminder goes out automatically every weekday morning (8am ET) to any contractor who still
          hasn&apos;t accepted or declined an assignment <strong>3 business days</strong> after it was sent.
          Each assignment is reminded once. Use <strong>Preview</strong> to see who would get one today.
        </div>
        {acceptMsg && <div className={`alert alert-${acceptMsg.kind}`}>{acceptMsg.text}</div>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary btn-sm" disabled={acceptBusy} onClick={() => runAcceptance(true)}>👁 Preview</button>
          <button className="btn btn-primary btn-sm" disabled={acceptBusy} onClick={() => runAcceptance(false)}>📤 Send now</button>
        </div>
        {acceptResult && (
          <div style={{ marginTop: 12 }}>
            {acceptResult.redirect_active && (
              <div className="alert alert-warn">🧪 Test mode is ON — every email is redirected to <strong>{acceptResult.redirect_to}</strong> instead of the contractor.</div>
            )}
            <div style={{ fontSize: 13, marginBottom: 6 }}>
              {acceptResult.dry_run ? 'Would send' : 'Sent'} <strong>{acceptResult.dry_run ? acceptResult.matched : acceptResult.sent}</strong> reminder{(acceptResult.dry_run ? acceptResult.matched : acceptResult.sent) === 1 ? '' : 's'}
              {' '}(≥ {acceptResult.threshold_business_days} business days unaccepted; from: {acceptResult.from})
            </div>
            {acceptResult.results.length > 0 && (
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th>Case</th><th>Contractor</th><th>Bus. days</th><th>To</th><th>Status</th></tr></thead>
                  <tbody>
                    {acceptResult.results.map((r, i) => (
                      <tr key={i}>
                        <td>{r.case_number || r.assignment_id}</td>
                        <td>{r.contractor || '—'}</td>
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
