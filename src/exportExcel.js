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

export function exportCasesToExcel(cases, assignments) {
  const wb = buildCasesWorkbook(cases, assignments)
  const today = new Date().toISOString().slice(0, 10)
  XLSX.writeFile(wb, `learning-tree-cases-${today}.xlsx`)
}
