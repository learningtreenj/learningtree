// Mirrors of the database rules public.normalize_district / public.normalize_case_language
// (the database applies them on every save; these just make the form show the clean value
// before saving).

const DISTRICT_TAIL = /[\s,-]*\b(public\s+schools?|public\s+school\s+district|school\s+district|schools?|district|charter\s+school|charter|board\s+of\s+education|boe|sd|regional|reg\.?|consolidated|township|twp\.?|borough|boro|high\s+school|unified)\.?$/i

// "Bordentown Regional School District" → "Bordentown", "Mt. Olive" → "Mount Olive".
// "City" is kept (Neptune City, Ocean City) and two-word names stay whole (Mount Holly).
export function cleanDistrict(raw) {
  if (raw == null) return raw
  let s = String(raw).replace(/\s+/g, ' ').trim()
  if (!s) return s
  s = s.replace(/^(the\s+)?(township|borough|boro|town|village|city)\s+of\s+/i, '')
  s = s.replace(/^mt\.?\s+/i, 'Mount ')
  for (;;) {
    const next = s.replace(DISTRICT_TAIL, '').replace(/^[\s,.-]+|[\s,.-]+$/g, '')
    if (next === s) break
    s = next
  }
  if (!s) return String(raw).trim()
  if (s === s.toLowerCase() || s === s.toUpperCase()) s = s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
  return s
}

// Only the bilingual language(s): "English/Spanish" → "Spanish"; English on its own stays "English".
export function cleanLanguage(raw) {
  if (raw == null) return raw
  const s = String(raw).replace(/\s+/g, ' ').trim()
  if (!/\benglish\b/i.test(s)) return s
  const keep = s.split(/\s*(?:\/|&|,|;|\+|\band\b)\s*/i)
    .map(t => t.replace(/^[\s().-]+|[\s().-]+$/g, ''))
    .filter(t => t && !/^english\b/i.test(t) && t.toLowerCase() !== 'eng')
  return keep.length ? keep.join('/') : 'English'
}
