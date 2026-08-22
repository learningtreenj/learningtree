import { Fragment, useEffect, useMemo, useState } from 'react'
import { supabase, fetchAll, STATUSES, fmtDate, daysLeft, dueColor, parseRate, toISODate } from './supabase.js'
import { Shell, Badge, StatCard, Meta } from './ui.jsx'
import { generateInvoiceDoc, RATE_PER_EVAL } from './invoice.js'
import { getRate, invalidateRates } from './rates.js'
import DistrictHeatmap from './DistrictHeatmap.jsx'
import { contractorLanguages, contractorSpeaks } from './contractorLangs.js'
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
function caseStatusCls(label) {
  const l = (label || '').toLowerCase()
  if (l === 'complete') return 's-completed'          // green
  if (l === 'report received') return 's-drafting'    // purple
  if (l === 'assigned') return 's-assigned'           // blue
  if (l === 'pending assignment') return 's-unassigned' // red
  return 's-assigned'
}

// Shows whether the contractor has accepted/declined an assignment
function AcceptBadge({ status }) {
  const s = (status || 'pending').toLowerCase()
  if (s === 'accepted') return <span className="badge-s s-completed">✓ Accepted</span>
  if (s === 'declined') return <span className="badge-s s-overdue">✕ Declined</span>
  return <span className="badge-s s-pending">Awaiting</span>
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
      fetchAll(() => supabase.from('Assignments').select('*, Contractors(identifier, name, current_rate, email), Cases(id, case_number, Student_name, School_district, Language, County, district_paid)').order('report_due_date', { ascending: true, nullsFirst: false }).order('id')),
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
      { id: 'rates', icon: '💵', label: 'Rate Table' },
    ]},
    { label: 'Monitoring', items: [
      { id: 'due', icon: '⏰', label: 'Due Date Monitor' },
      { id: 'emaillog', icon: '📧', label: 'Email Log' },
    ]},
  ]

  const titles = { dashboard: 'Dashboard', referral: 'New Referral Intake', cases: 'Cases', casedetail: 'Case Detail', contractors: 'Contractors', qa: 'Report Review & QA', invoices: 'Client Invoices', payroll: 'Payroll & Payment Batches', rates: 'Language Rate Table', due: 'Due Date Monitor', emaillog: 'Email Log' }

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
        allAssignments={assignments} contractors={contractors} onBack={() => setScreen('cases')} onChanged={load} />}
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
          <span>Upcoming Due Dates</span>
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
                if (g.items.length === 1) {
                  const a = g.items[0]
                  return (
                    <tr key={g.name}>
                      <td><span className="tbl-link" onClick={() => openCaseById(a.case_id)}>{a.Cases?.case_number || a.case_id}</span></td>
                      <td style={{ fontWeight: 600 }}>{g.name}</td>
                      <td>{a.eval_type ? abbrevEval(a.eval_type) : '—'}</td>
                      <td>{a.Contractors?.name || <span className="badge-s s-unassigned">Unassigned</span>}</td>
                      <td style={dueColor(a.report_due_date)}>{fmtDate(a.report_due_date)}</td>
                      <td style={dueColor(a.report_due_date)}>{daysLeft(a.report_due_date) ?? '—'}</td>
                      <td>{statusBadge(a)}</td>
                    </tr>
                  )
                }
                const nearest = g.items[0]
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
                      <td><span className="badge-s s-assigned">Assigned</span></td>
                    </tr>
                    {expanded[g.name] && g.items.map(a => (
                      <tr key={a.id} style={{ background: '#f8fafc' }}>
                        <td></td>
                        <td></td>
                        <td style={{ paddingLeft: 24 }}><span className="tbl-link" onClick={() => openCaseById(a.case_id)}>↳ {a.Cases?.case_number || a.case_id} · {a.eval_type ? abbrevEval(a.eval_type) : '—'}</span></td>
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
    // Auto-numbering is paused — a case number must be entered manually for now.
    if (!(f.case_number || '').trim()) {
      setMsg({ kind: 'warn', text: 'Case # is required (auto-numbering is paused). Enter it manually, e.g. 26-0389.' }); return
    }
    setBusy(true); setMsg(null)
    const phoneDigits = f.parents_phone.replace(/\D/g, '')
    const row = {
      case_number: f.case_number.trim(),
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
      setMsg({ kind: 'danger', text: dup ? `Case # ${f.case_number.trim()} already exists — choose a different number.` : error.message })
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
      <div className="alert alert-info">Enter the case number manually (auto-numbering is paused). After creating the case you can assign contractors.</div>

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
          <label>Case # *</label>
          <input value={f.case_number} onChange={e => set('case_number', e.target.value)} placeholder="e.g. 26-0389" />
          <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>Auto-numbering is paused — enter the case number manually.</div>
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

// Click-to-edit popover for one eval-type cell: reassign/remove existing evaluators,
// or assign one to a requested-but-empty eval. Positioned at the click point (fixed).
function CellEditor({ anchor, caseRow, col, token, cellAsg, contractors, busy, onReassign, onRemove, onAssign, onClose }) {
  const [addTo, setAddTo] = useState('')
  const [reSel, setReSel] = useState({})
  const left = Math.max(8, Math.min(anchor.x, (typeof window !== 'undefined' ? window.innerWidth : 1000) - 320))
  const top = Math.max(8, Math.min(anchor.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 300))
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 49 }} />
      <div onClick={e => e.stopPropagation()} style={{ position: 'fixed', left, top, zIndex: 50, background: '#fff', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 8px 28px rgba(0,0,0,.22)', padding: 12, width: 300, fontSize: 13 }}>
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
            <div style={{ marginBottom: 5, color: '#555' }}>{cellAsg.length ? 'Add another for' : 'Assign'} {col}:</div>
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

  // Manually mark whether the school district has paid Learning Tree for a case.
  async function setDistrictPaid(c, paid) {
    setRowBusy(true); setRowMsg(null)
    const { error } = await supabase.from('Cases')
      .update({ district_paid: paid, district_paid_at: paid ? new Date().toISOString() : null })
      .eq('id', c.id)
    if (error) setRowMsg({ kind: 'danger', text: error.message })
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

  // Non-eval columns keep the sort/filter menus. Eval types are their own fixed columns.
  const LEFT_COLS = [['case_number', 'Case #'], ['Student_name', 'Student'], ['School_district', 'District']]
  const RIGHT_COLS = [['Report_Due_date', 'Due Date'], ['status', 'Status'], ['district_paid', 'District Paid']]
  const CHECKBOX_COLS = { School_district: true, status: true }
  const districtOptions = useMemo(() => [...new Set(cases.map(c => (c.School_district || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [cases])
  // Case-level status is now just In Progress / Complete (Complete = all reports received).
  const caseProgressText = (c, asg) => {
    const lbl = caseStatusLabel(c, asg)
    return (lbl === 'Report Received' || lbl === 'Complete') ? 'Complete' : 'In Progress'
  }
  const statusOptions = ['In Progress', 'Complete']
  const optionsFor = key => key === 'School_district' ? districtOptions : statusOptions
  // Contents of one eval-type cell for a case: matching assignments + the requested token.
  const cellFor = (c, col) => {
    const asg = (byCase[c.id] || []).filter(a => evalCol(a.eval_type) === col)
    const token = (c.evaluation_type || '').split(',').map(t => t.trim()).filter(Boolean).find(t => evalCol(t) === col) || asg[0]?.eval_type || null
    return { asg, token }
  }
  // Per-evaluator status label shown inside an eval cell.
  const evalStatus = a => (a.status || '').toLowerCase() === 'submitted'
    ? { t: "Report Rec'd", cls: 's-completed' }
    : { t: 'Assigned', cls: 's-assigned' }
  const toggleCheck = (key, val) => setColChecks(p => {
    const cur = new Set(p[key] || [])
    cur.has(val) ? cur.delete(val) : cur.add(val)
    return { ...p, [key]: [...cur] }
  })
  function colSortVal(col, c) {
    const asg = byCase[c.id] || []
    switch (col) {
      case 'Report_Due_date': return c.Report_Due_date || ''       // ISO date sorts lexically
      case 'assignments': return asg.length                        // numeric
      case 'status': return caseProgressText(c, asg).toLowerCase()
      case 'district_paid': return c.district_paid ? 'yes' : 'no'
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
    if (col === 'district_paid') return c.district_paid ? 'yes' : 'no'
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
    if (chip === 'due') {
      const soon = asg.some(a => { const n = daysLeft(a.report_due_date); return n !== null && n <= 7 && (a.status || '').toLowerCase() !== 'submitted' })
      const caseSoon = (() => { const n = daysLeft(c.Report_Due_date); return n !== null && n <= 7 })()
      if (!soon && !caseSoon) return false
    }
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
  const statusSel = colChecks.status || []
  if (statusSel.length) rows = rows.filter(c => statusSel.includes(caseProgressText(c, byCase[c.id] || [])))
  if (sortCol) {
    rows = [...rows].sort((a, b) => {
      const va = colSortVal(sortCol, a), vb = colSortVal(sortCol, b)
      const cmp = (typeof va === 'number' && typeof vb === 'number') ? va - vb : String(va).localeCompare(String(vb))
      return sortDir === 'desc' ? -cmp : cmp
    })
  }

  // A sortable/filterable header cell (used for the non-eval columns).
  const menuTh = (key, label) => (
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
  )
  const COLSPAN = LEFT_COLS.length + EVAL_COLS.length + RIGHT_COLS.length

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
      </div>
      <div className="tbl-wrap">
        <table>
          <thead><tr>
            {LEFT_COLS.map(([key, label]) => menuTh(key, label))}
            {EVAL_COLS.map(col => <th key={col} style={{ whiteSpace: 'nowrap', background: '#f3f6f9', textAlign: 'left' }}>{col}</th>)}
            {RIGHT_COLS.map(([key, label]) => menuTh(key, label))}
          </tr></thead>
          <tbody>
            {loading && <tr><td colSpan={COLSPAN} style={{ color: '#888' }}>Loading…</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={COLSPAN} style={{ color: '#888' }}>No cases match.</td></tr>}
            {rows.slice(0, 200).map(c => {
              const asg = byCase[c.id] || []
              const statusLbl = caseStatusLabel(c, asg)
              const complete = statusLbl === 'Complete'
              const allReceived = statusLbl === 'Report Received' // every evaluation submitted
              const progress = caseProgressText(c, asg)           // In Progress | Complete
              const dl = daysLeft(c.Report_Due_date)
              const pastDue = !complete && !allReceived && dl !== null && dl < 0 // overdue, reports not all in
              const dueSoon = !complete && !allReceived && dl !== null && dl >= 0 && dl < 7 // not all in, due within a week
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
                  <td style={dueColor(c.Report_Due_date)}>{fmtDate(c.Report_Due_date)}</td>
                  <td><span className={`badge-s ${progress === 'Complete' ? 's-completed' : 's-drafting'}`}>{progress}</span></td>
                  <td style={{ whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
                    <button type="button" disabled={rowBusy} onClick={() => setDistrictPaid(c, true)}
                      title="School district has paid Learning Tree"
                      style={paidBtnStyle(true, c.district_paid === true)}>Yes</button>
                    {' '}
                    <button type="button" disabled={rowBusy} onClick={() => setDistrictPaid(c, false)}
                      title="Not yet paid by the school district"
                      style={paidBtnStyle(false, !c.district_paid)}>No</button>
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
          cellAsg={editCell.cellAsg} contractors={contractors} busy={rowBusy}
          onReassign={reassignInline} onRemove={removeInline}
          onAssign={(tok, toId) => assignInline(editCell.caseRow, tok, toId)} onClose={() => setEditCell(null)} />
      )}
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

  // Auto-fills the district invoice from the case's submitted evaluations (student, date,
  // invoice #, dates/types of service, rate by language, sum).
  async function downloadCaseInvoice() {
    const submitted = assignments.filter(a => a.contractor_id != null && (a.status || '').toLowerCase() === 'submitted')
    const src = submitted.length ? submitted : assignments.filter(a => a.contractor_id != null)
    if (!src.length) { setMsg({ kind: 'warn', text: 'No submitted evaluations yet to invoice.' }); return }
    const items = src.map(a => ({ assignmentId: a.id, evalType: a.eval_type || '', dateOfService: a.submitted_at || a.testing_date }))
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
    const { error } = await supabase.from('Cases').update({ sent_to_district_at: val }).eq('id', c.id)
    if (error) { setMsg({ kind: 'danger', text: error.message }); setBusy(false); return }
    setC(prev => ({ ...prev, sent_to_district_at: val }))
    setMsg({ kind: 'success', text: sending ? 'Marked as sent to the district — case is now Complete.' : 'Reopened — case is no longer marked Complete.' })
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
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {(() => { const lbl = caseStatusLabel(c, assignments); return <span className={`badge-s ${caseStatusCls(lbl)}`}>{lbl}</span> })()}
              <button className="btn btn-secondary btn-sm" onClick={startEdit}>✏️ Edit</button>
              {assignments.some(a => a.contractor_id != null && (a.status || '').toLowerCase() === 'submitted') &&
                <button className="btn btn-secondary btn-sm" onClick={downloadCaseInvoice} title="Download the district invoice for this case">⬇ Invoice</button>}
              {c.sent_to_district_at
                ? <button className="btn btn-ghost btn-sm" disabled={busy} onClick={markSent} title="Reopen — undo sent-to-district">↩ Reopen</button>
                : <button className="btn btn-primary btn-sm" disabled={busy} onClick={markSent} title="Mark this case sent to the school district (sets status to Complete)">✅ Mark sent to district</button>}
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

function ContractorList({ contractors, assignments, onChanged, languageFilter = null, onClearLanguageFilter }) {
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
    const uniq = arr => [...new Set(arr)]
    const fields = uniq((k.field || '').split(',').map(t => t.trim()).filter(Boolean))
    const languages = uniq([k.language, k.language_2].filter(Boolean).flatMap(s => s.split(',').map(t => t.trim())).filter(Boolean))
    setForm({
      name: k.name || '', email: k.email || '', phone: k.phone || '', company_name: k.company_name || '',
      fields, languages, county: k.county || '',
      address: k.address || '', zip_code: k.zip_code != null ? String(k.zip_code) : '', current_rate: k.current_rate || '',
      w9_on_file: !!k.w9_on_file, criminal_history_done: !!k.criminal_history_done, NJDOE_submitted: k.NJDOE_submitted || '',
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

  const rows = contractors
    .filter(k => !languageFilter || contractorSpeaks(k, languageFilter))
    .filter(k =>
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
        <div className="form-group"><label>Field / Specialty (select all that apply)</label>
          <MultiCheck selected={form.fields || []} options={CONTRACTOR_FIELDS} onToggle={v => toggleMulti('fields', v)} /></div>
        <div className="form-group"><label>Languages (select all that apply)</label>
          <MultiCheck selected={form.languages || []} options={LANGUAGES} onToggle={v => toggleMulti('languages', v)} /></div>
        <div className="form-group"><label>Rate</label><input value={form.current_rate} onChange={e => setF('current_rate', e.target.value)} placeholder="e.g. $880" /></div>
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
      {languageFilter && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontSize: 13 }}>
          <span style={{ color: '#555' }}>Showing contractors who speak</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#E6F1FB', color: '#185FA5', border: '1px solid #b9d6f2', borderRadius: 999, padding: '3px 10px', fontWeight: 600 }}>
            {languageFilter}
            <span style={{ cursor: 'pointer' }} title="Clear filter" onClick={() => onClearLanguageFilter && onClearLanguageFilter()}>✕</span>
          </span>
        </div>
      )}
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
  const batchById = useMemo(() => new Map(batches.map(b => [b.id, b])), [batches])
  // Batch month is stored as YYYY-MM; show it as MM/YYYY.
  const monthMMYYYY = ym => { const [y, m] = String(ym || '').split('-'); return (m && y) ? `${m}/${y}` : (ym || '—') }

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
    // Group by contractor → by case, summing amounts and collecting the eval types.
    const byContractor = new Map()
    for (const e of items) {
      if (!byContractor.has(e.contractor_id)) byContractor.set(e.contractor_id, new Map())
      const caseMap = byContractor.get(e.contractor_id)
      const a = assignmentById.get(e.assignment_id)
      const caseKey = a?.Cases?.id ?? a?.case_id ?? `a${e.assignment_id}`
      if (!caseMap.has(caseKey)) caseMap.set(caseKey, { a, evals: [], amount: 0 })
      const row = caseMap.get(caseKey)
      if (a?.eval_type) row.evals.push(a.eval_type)
      row.amount += Number(e.amount || 0)
    }

    const csv = v => `"${String(v ?? '').replace(/"/g, '""')}"`
    const header = ['Contractor', 'Email', 'Student', 'School District', 'Case #', 'Evaluations', 'Amount', 'School District Payment Received']
    const lines = [header.map(csv).join(',')]
    let grandTotal = 0, caseCount = 0
    const contractorIds = [...byContractor.keys()].sort((x, y) =>
      (contractorById.get(Number(x))?.name || '').localeCompare(contractorById.get(Number(y))?.name || ''))
    for (const cid of contractorIds) {
      const k = contractorById.get(Number(cid))
      const caseRows = [...byContractor.get(cid).values()].sort((r1, r2) =>
        (r1.a?.Cases?.case_number || '').localeCompare(r2.a?.Cases?.case_number || ''))
      for (const r of caseRows) {
        const kase = r.a?.Cases || {}
        const evalTypes = [...new Set(r.evals.map(t => t.trim()).filter(Boolean))].join(', ')
        lines.push([
          csv(k?.name || 'Unknown'), csv(k?.email || ''), csv(kase.Student_name || ''),
          csv(kase.School_district || ''), csv(kase.case_number || ''), csv(evalTypes),
          r.amount, csv(kase.district_paid ? 'Yes' : 'No'),
        ].join(','))
        grandTotal += r.amount; caseCount += 1
      }
    }
    // Subtotal: number of cases + total owed to contractors.
    lines.push([csv('TOTAL'), '', '', '', '', csv(`${caseCount} case${caseCount === 1 ? '' : 's'}`), grandTotal, ''].join(','))

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
            <thead><tr><th>Contractor</th><th>Case</th><th>Student</th><th>Eval Type</th><th>Date</th><th>Amount</th><th>Status</th><th>Invoice Month</th></tr></thead>
            <tbody>
              {earnings.length === 0 && <tr><td colSpan={8} style={{ color: '#888' }}>No earnings yet — approve submitted reports in Report Review to create them.</td></tr>}
              {earnings.map(e => {
                const k = contractorById.get(e.contractor_id)
                const a = assignmentById.get(e.assignment_id)
                return (
                  <tr key={e.id}>
                    <td style={{ fontWeight: 600 }}>{k?.name || e.contractor_id}</td>
                    <td>{a?.Cases?.case_number || '—'}</td>
                    <td>{a?.Cases?.Student_name || '—'}</td>
                    <td>{a?.eval_type || '—'}</td>
                    <td>{fmtDate(e.billable_date)}</td>
                    <td>${Number(e.amount || 0).toLocaleString()}</td>
                    <td><Badge status={e.status} /></td>
                    <td>{e.payment_batch_id ? monthMMYYYY(batchById.get(e.payment_batch_id)?.batch_month) : '—'}</td>
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

  async function downloadInvoice() {
    if (!selected) return
    const caseAssignments = assignments.filter(x => x.case_id === selected.case_id && x.contractor_id != null)
    const approved = caseAssignments.filter(x =>
      qaByAssignment.get(x.id)?.qa_status === 'approved' && x.submitted_at)
    const items = (approved.length > 0 ? approved : caseAssignments).map(x => ({
      assignmentId: x.id, evalType: x.eval_type || '', dateOfService: x.submitted_at,
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

  async function recordInvoice() {
    if (!selected) return
    setBusy(true); setMsg(null)
    const caseAssignments = assignments.filter(x => x.case_id === selected.case_id && x.contractor_id != null)
    const approvedCount = caseAssignments.filter(x => qaByAssignment.get(x.id)?.qa_status === 'approved').length || 1
    const rate = await getRate(selected.Cases?.Language)
    const { error } = await supabase.from('Invoices').insert({
      case_id: selected.case_id,
      district_name: selected.Cases?.School_district || null,
      amount: approvedCount * rate,
      issued_date: new Date().toISOString().slice(0, 10),
      status: 'Sent',
    })
    if (!error) {
      await supabase.from('qa_reviews').update({ invoice_sent_at: new Date().toISOString(), invoice_status: 'sent' }).eq('assignment_id', selected.id)
    }
    setMsg(error ? { kind: 'danger', text: error.message } : { kind: 'success', text: `Invoice recorded in Client Invoices ($${(approvedCount * rate).toLocaleString()}).` })
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
