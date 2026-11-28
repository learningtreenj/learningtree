// Recommended-contractor scoring — ported from the Retool portal
// (getRecommendedContractors.ts). Field match is a hard filter worth 40 pts,
// language quality adds 45 (primary) / 25 (secondary), county proximity 0–15.
// Tiers: Best ≥ 70, Good ≥ 40.

const NJ_ADJACENCY = {
  Atlantic: ['Burlington', 'Cape May', 'Cumberland', 'Ocean'],
  Bergen: ['Essex', 'Hudson', 'Passaic'],
  Burlington: ['Atlantic', 'Camden', 'Gloucester', 'Mercer', 'Monmouth', 'Ocean'],
  Camden: ['Burlington', 'Gloucester', 'Salem'],
  'Cape May': ['Atlantic', 'Cumberland'],
  Cumberland: ['Atlantic', 'Cape May', 'Gloucester', 'Salem'],
  Essex: ['Bergen', 'Hudson', 'Morris', 'Passaic', 'Somerset', 'Union'],
  Gloucester: ['Burlington', 'Camden', 'Cumberland', 'Salem'],
  Hudson: ['Bergen', 'Essex', 'Union'],
  Hunterdon: ['Mercer', 'Morris', 'Somerset', 'Warren'],
  Mercer: ['Burlington', 'Hunterdon', 'Middlesex', 'Monmouth', 'Somerset'],
  Middlesex: ['Mercer', 'Monmouth', 'Ocean', 'Somerset', 'Union'],
  Monmouth: ['Burlington', 'Mercer', 'Middlesex', 'Ocean'],
  Morris: ['Essex', 'Hunterdon', 'Passaic', 'Somerset', 'Sussex', 'Warren'],
  Ocean: ['Atlantic', 'Burlington', 'Middlesex', 'Monmouth'],
  Passaic: ['Bergen', 'Essex', 'Morris', 'Sussex'],
  Salem: ['Camden', 'Cumberland', 'Gloucester'],
  Somerset: ['Essex', 'Hunterdon', 'Mercer', 'Middlesex', 'Morris', 'Union'],
  Sussex: ['Morris', 'Passaic', 'Warren'],
  Union: ['Essex', 'Hudson', 'Middlesex', 'Somerset'],
  Warren: ['Hunterdon', 'Morris', 'Sussex'],
}

function normaliseCounty(raw) {
  if (!raw) return ''
  return raw.replace(/\s*county\s*/i, '').trim()
}

function countyDistance(from, to) {
  const a = normaliseCounty(from)
  const b = normaliseCounty(to)
  if (!a || !b) return 99
  if (a.toLowerCase() === b.toLowerCase()) return 0

  const keys = Object.keys(NJ_ADJACENCY)
  const nodeA = keys.find(k => k.toLowerCase() === a.toLowerCase())
  const nodeB = keys.find(k => k.toLowerCase() === b.toLowerCase())
  if (!nodeA || !nodeB) return 99

  const visited = new Set([nodeA])
  const queue = [[nodeA, 0]]
  while (queue.length) {
    const [cur, d] = queue.shift()
    for (const nb of NJ_ADJACENCY[cur] || []) {
      if (nb === nodeB) return d + 1
      if (!visited.has(nb)) { visited.add(nb); queue.push([nb, d + 1]) }
    }
  }
  return 99
}

const FIELD_MAP = [
  { keys: ['psych'], fields: ['Psychologist', 'Psychologist/LD'] },
  { keys: ['ed', 'educational', 'learning'], fields: ['Learning Consultant', 'Psychologist/LD'] },
  { keys: ['speech', 'slp', 'language patholog'], fields: ['Speech Pathologist', 'Speech Language Pathologist', 'SLP', 'Speech Language'] },
  { keys: ['social'], fields: ['Social Worker'] },
  { keys: ['ot', 'occupational'], fields: ['OT', 'Occupational Therapist'] },
  { keys: ['pt', 'physical'], fields: ['Physical Therapist'] },
]

function calcFieldScore(evalType, contractorField) {
  if (!contractorField) return 0
  const et = (evalType || '').toLowerCase()
  const cf = contractorField.toLowerCase()
  for (const { keys, fields } of FIELD_MAP) {
    if (keys.some(k => et.includes(k))) {
      if (fields.some(f => cf.includes(f.toLowerCase()) || f.toLowerCase().includes(cf))) return 40
    }
  }
  return 0
}

// True when a contractor's field can do this evaluation type (Speech → speech pathologists, etc.).
export function fieldMatches(evalType, contractorField) {
  return calcFieldScore(evalType, contractorField) > 0
}

function isEnglishOrEmpty(lang) {
  const l = (lang || '').toLowerCase().trim()
  return !l || l === 'english' || l === 'en'
}

function calcLanguageScore(caseLanguage, contrLang, contrLang2) {
  if (isEnglishOrEmpty(caseLanguage)) return 0
  const cl = caseLanguage.toLowerCase()
  const aliases = {
    'haitian creole': ['creole', 'haitian'],
    creole: ['haitian creole', 'creole'],
    hindi: ['india', 'hindi'],
    tagalog: ['tagalog', 'filipino', 'pilipino'],
    urdu: ['urdu', 'india'],
    arabic: ['arabic'],
  }
  const clVariants = [cl, ...(aliases[cl] || [])]

  const primary = (contrLang || '').toLowerCase()
  if (primary && clVariants.some(v => primary.includes(v) || v.includes(primary))) return 45

  const secondary = (contrLang2 || '').toLowerCase()
  if (secondary && clVariants.some(v => secondary.includes(v) || v.includes(secondary))) return 25

  return 0
}

function calcProximityScore(caseCounty, contrCounty) {
  if (!caseCounty || !contrCounty) return 0
  const d = countyDistance(caseCounty, contrCounty)
  if (d === 0) return 15
  if (d === 1) return 12
  if (d === 2) return 8
  if (d === 3) return 4
  return 0
}

// Office rules about individual evaluators (public.evaluator_rules):
//   avoid_district — never recommend them for that district
//   prefer         — +10 (e.g. a new evaluator the office wants to try out)
//   travels        — full distance credit wherever the case is (goes anywhere)
//   note           — shown next to their name, no score change
const sameDistrict = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase() && !!String(a || '').trim()

export function evaluatorRuleInfo(contractorId, rules = [], { district = '' } = {}) {
  const mine = rules.filter(r => String(r.contractor_id) === String(contractorId))
  const avoided = mine.find(r => r.kind === 'avoid_district' && sameDistrict(r.district, district)) || null
  let bonus = 0
  let travels = false
  const reasons = []
  for (const r of mine) {
    if (r.kind === 'travels') {
      travels = true; reasons.push(r.note || 'Travels anywhere')
    } else if (r.kind === 'prefer') {
      bonus += 10; reasons.push(r.note || 'Office preference')
    } else if (r.kind === 'note' && r.note) {
      reasons.push(r.note)
    }
  }
  return { avoided, bonus, travels, reasons }
}

/**
 * Score contractors for a case. activeCounts: Map(contractor_id → open case count).
 * opts: { rules, district } — office rules from evaluator_rules.
 * Returns [{contractor, score, tier, languageScore, fieldScore, proximityScore, ruleBonus, reasons, activeCaseCount}]
 * sorted best-first. Field mismatch (and language mismatch on non-English cases) are excluded,
 * as are evaluators the office has ruled out for this district.
 */
export function scoreContractors(contractors, activeCounts, evalType, language, county, opts = {}) {
  const { rules = [], district = '' } = opts
  const requireLanguage = !isEnglishOrEmpty(language)
  const scored = []
  for (const c of contractors) {
    if (!c.name) continue
    const fs = calcFieldScore(evalType, c.field)
    if (fs === 0) continue
    const ls = calcLanguageScore(language || '', c.language, c.language_2)
    if (requireLanguage && ls === 0) continue
    const info = evaluatorRuleInfo(c.identifier, rules, { district })
    if (info.avoided) continue
    const ps = info.travels ? 15 : calcProximityScore(county || '', c.county)
    const score = fs + ls + ps + info.bonus
    scored.push({
      contractor: c,
      score,
      tier: score >= 70 ? 'Best' : 'Good',
      languageScore: ls,
      fieldScore: fs,
      proximityScore: ps,
      ruleBonus: info.bonus,
      reasons: info.reasons,
      activeCaseCount: activeCounts.get(c.identifier) || 0,
    })
  }
  return scored.sort((a, b) =>
    b.score - a.score ||
    a.activeCaseCount - b.activeCaseCount ||
    a.contractor.name.localeCompare(b.contractor.name))
}
