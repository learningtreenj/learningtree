import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_KEY
)

export const STATUSES = [
  'Assigned',
  'Contacted Family',
  'Scheduled',
  'Testing Completed',
  'Draft Report',
  'Submitted',
]

// Supabase caps a single query at 1000 rows — page through everything.
export async function fetchAll(buildQuery) {
  const page = 1000
  let from = 0
  let all = []
  for (;;) {
    const { data, error } = await buildQuery().range(from, from + page - 1)
    if (error) return { data: all, error }
    all = all.concat(data || [])
    if (!data || data.length < page) break
    from += page
  }
  return { data: all, error: null }
}

// "7/15/2026" or "2026-07-15" → "2026-07-15" for <input type=date>; '' if unparseable
export function toISODate(s) {
  if (!s) return ''
  const str = String(s).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) {
    const [, mo, d, y] = m
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  const dt = new Date(str)
  return isNaN(dt) ? '' : dt.toISOString().slice(0, 10)
}

// "$800" / "800 per eval" → 800; returns 0 when no number found
export function parseRate(rate) {
  const m = String(rate || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/)
  return m ? Number(m[1]) : 0
}

export function statusClass(status) {
  const s = (status || '').toLowerCase()
  if (s.includes('approv')) return 's-completed'     // "Approved" → green
  if (s.includes('progress')) return 's-drafting'   // "In Progress" → purple
  if (s.includes('submit')) return 's-submitted'
  if (s.includes('draft')) return 's-drafting'
  if (s.includes('testing complet') || s.includes('complete')) return 's-completed'
  if (s.includes('schedul')) return 's-scheduled'
  if (s.includes('contact')) return 's-contacted'
  if (s.includes('overdue')) return 's-overdue'
  if (s.includes('paid')) return 's-paid'
  if (s.includes('pending')) return 's-pending'
  return 's-assigned'
}

export function fmtDate(d) {
  if (!d) return '—'
  const dt = new Date(d + (d.length === 10 ? 'T00:00:00' : ''))
  if (isNaN(dt)) return d
  return dt.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' })
}

export function daysLeft(due) {
  if (!due) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const d = new Date(due + 'T00:00:00')
  return Math.round((d - today) / 86400000)
}

export function dueColor(due) {
  const n = daysLeft(due)
  if (n === null) return {}
  if (n < 0) return { color: 'var(--red)', fontWeight: 700 }
  if (n <= 7) return { color: 'var(--red)', fontWeight: 700 }
  if (n <= 14) return { color: 'var(--yellow)', fontWeight: 700 }
  return {}
}
