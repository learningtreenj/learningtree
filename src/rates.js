// Per-language evaluation rates, sourced from the Supabase `languages-pay-rates`
// table (columns LANGUAGE, Rate). Loaded once and cached for the session.
import { supabase } from './supabase.js'

// Fallback when a language isn't found in the table (or the table can't be read).
export const DEFAULT_RATE = 880

let ratesMap = null

// Clears the cached map so the next lookup re-reads the table (call after edits).
export function invalidateRates() { ratesMap = null }

// Loads the rate table into a lowercased { language: rate } map. Cached after first call.
export async function loadRates() {
  if (ratesMap) return ratesMap
  const { data, error } = await supabase.from('languages-pay-rates').select('*')
  if (error || !data) return {} // don't cache a failure; getRate falls back to DEFAULT_RATE
  const map = {}
  for (const r of data) {
    if (r.LANGUAGE != null) map[String(r.LANGUAGE).trim().toLowerCase()] = Number(r.Rate)
  }
  ratesMap = map
  return map
}

// Synchronous lookup against an already-loaded map. Exact match first, then a
// substring match (so "Spanish/English" still resolves), else DEFAULT_RATE.
export function rateForLanguage(language, map = ratesMap) {
  if (!map) return DEFAULT_RATE
  const key = String(language || '').trim().toLowerCase()
  if (map[key] != null) return map[key]
  for (const k of Object.keys(map)) {
    if (key && k && key.includes(k)) return map[k]
  }
  return DEFAULT_RATE
}

// Convenience: ensure the table is loaded, then resolve one language's rate.
export async function getRate(language) {
  const map = await loadRates()
  return rateForLanguage(language, map)
}
