// Contractor language fields are entered inconsistently: `language` and `language_2`
// often duplicate each other, and either may pack several languages with mixed
// separators (comma, slash, ampersand, the word "and"). This parses both fields into a
// clean, de-duplicated list so the dashboard counts and the Contractors filter agree.

const SPLIT = /\s*(?:,|\/|&|\+|-|\band\b)\s*/i
// Fold obvious spelling variants together so they count as one language.
const ALIAS = { portugese: 'Portuguese', gujurati: 'Gujarati', kanada: 'Kannada', indoniesia: 'Indonesian' }
// Non-language tokens to ignore (e.g. "India" is entered as a prefix before the actual
// languages, like "India, Telugu"). The real languages beside them are still counted.
const STOP = new Set(['india'])

export function contractorLanguages(k) {
  const raw = [k?.language, k?.language_2].filter(Boolean).join(', ')
  const out = new Map() // lowercased key → display form (deduped case-insensitively)
  for (const tok of raw.split(SPLIT)) {
    const t = tok.trim()
    if (!t || STOP.has(t.toLowerCase())) continue
    const title = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()
    const display = ALIAS[title.toLowerCase()] || title
    out.set(display.toLowerCase(), display)
  }
  return [...out.values()]
}

export function contractorSpeaks(k, language) {
  const want = String(language || '').toLowerCase()
  return contractorLanguages(k).some(l => l.toLowerCase() === want)
}
