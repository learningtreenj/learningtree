// Export all cases + assignments to a real .xlsx workbook (two sheets).
import * as XLSX from 'xlsx'

function isoDate(d) {
  if (!d) return ''
  const s = String(d)
  return s.length >= 10 ? s.slice(0, 10) : s
}

export function buildCasesWorkbook(cases, assignments) {
  // One row per assignment, grouped under its case
  const asgByCase = {}
  for (const a of assignments) {
    asgByCase[a.case_id] = asgByCase[a.case_id] || []
    asgByCase[a.case_id].push(a)
  }

  // ── Cases sheet ──
  const caseRows = cases.map(c => {
    const asg = asgByCase[c.id] || []
    const submitted = asg.filter(a => (a.status || '').toLowerCase() === 'submitted').length
    return {
      'Case #': c.case_number || '',
      'Student': c.Student_name || '',
      'DOB': isoDate(c.student_dob),
      'Grade': c['grade level'] || '',
      'Language': c.Language || '',
      'District': c.School_district || '',
      'County': c.County || '',
      'Status': c.Status || '',
      'Report Due Date': isoDate(c.Report_Due_date),
      'Eval Types Requested': c.evaluation_type || '',
      'Testing Materials': c.testing_materials || '',
      'Reason for Referral': c.reason_for_referral || '',
      'Parent / Guardian': c.parents_name || '',
      'Parent Phone': c.parents_phone != null ? String(c.parents_phone) : '',
      'Parent Email': c.parents_email || '',
      'Home Address': c.home_address || '',
      'Case Manager': c.case_manager_name || '',
      'Case Manager Email': c.case_manager_email || '',
      'District Contact': c.district_contact || '',
      'Referral Source': c.referral_source || '',
      'Referral Date': isoDate(c.referral_date),
      'Created Date': isoDate(c.created_date),
      'Assignments': asg.length,
      'Submitted': submitted,
    }
  })

  // ── Assignments sheet ──
  const asgRows = assignments.map(a => ({
    'Case #': a.Cases?.case_number || a.case_id || '',
    'Student': a.Cases?.Student_name || '',
    'District': a.Cases?.School_district || '',
    'Contractor': a.Contractors?.name || '',
    'Contractor Email': a.Contractors?.email || '',
    'Eval Type': a.eval_type || '',
    'Status': a.status || '',
    'Acceptance': a.acceptance_status || '',
    'Report Due Date': isoDate(a.report_due_date),
    'Testing Date': isoDate(a.testing_date),
    'Submitted At': isoDate(a.submitted_at),
    'Report File': a.report_file_name || (a.report_url ? a.report_url.split('/').pop() : ''),
    'Decline Reason': a.decline_reason || '',
    'Notes': a.notes || '',
  }))

  const wb = XLSX.utils.book_new()
  const casesSheet = XLSX.utils.json_to_sheet(caseRows.length ? caseRows : [{ 'Case #': '(no cases)' }])
  const asgSheet = XLSX.utils.json_to_sheet(asgRows.length ? asgRows : [{ 'Case #': '(no assignments)' }])

  // Reasonable column widths so it's readable on open
  casesSheet['!cols'] = Object.keys(caseRows[0] || { a: 1 }).map(k =>
    ({ wch: ['Testing Materials', 'Reason for Referral', 'Home Address', 'Eval Types Requested'].includes(k) ? 40 : 16 }))
  asgSheet['!cols'] = Object.keys(asgRows[0] || { a: 1 }).map(k =>
    ({ wch: ['Notes', 'Decline Reason', 'Report File'].includes(k) ? 30 : 16 }))

  XLSX.utils.book_append_sheet(wb, casesSheet, 'Cases')
  XLSX.utils.book_append_sheet(wb, asgSheet, 'Assignments')
  return wb
}

// One month of contractor payroll (month = 'YYYY-MM'; rows = payroll lines / an archive snapshot).
export function exportPayrollToExcel(month, rows) {
  const [y, m] = String(month || '').split('-').map(Number)
  const monthEnd = (y && m) ? `${m}/${new Date(y, m, 0).getDate()}/${y}` : (month || '')
  const out = (rows || []).map((r, i) => ({
    '#': i + 1,
    'Month': monthEnd,
    'Evaluator': r.evaluator || '',
    'Field': r.field || '',
    'Case #': r.case_number || '',
    'Student Name': r.student || '',
    'Earnings': Number(r.amount || 0),
    'Preferred Payment Method': r.payment_method || '',
    'Report Received': isoDate(r.report_received),
    'Date Paid': isoDate(r.date_paid),
  }))
  out.push({ '#': '', 'Month': '', 'Evaluator': 'TOTAL', 'Field': '', 'Case #': '', 'Student Name': `${(rows || []).length} evaluations`,
    'Earnings': (rows || []).reduce((n, r) => n + Number(r.amount || 0), 0), 'Preferred Payment Method': '', 'Report Received': '', 'Date Paid': '' })
  const ws = XLSX.utils.json_to_sheet(out)
  ws['!cols'] = [{ wch: 5 }, { wch: 11 }, { wch: 26 }, { wch: 16 }, { wch: 10 }, { wch: 30 }, { wch: 10 }, { wch: 24 }, { wch: 15 }, { wch: 12 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, (y && m) ? new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long' }) : 'Payroll')
  XLSX.writeFile(wb, `learning-tree-payroll-${month}.xlsx`)
}

export function exportCasesToExcel(cases, assignments) {
  const wb = buildCasesWorkbook(cases, assignments)
  const today = new Date().toISOString().slice(0, 10)
  XLSX.writeFile(wb, `learning-tree-cases-${today}.xlsx`)
}
