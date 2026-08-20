import { useMemo, useState } from 'react'

// Dashboard insights: case-volume heatmap by district (grid / NJ-map toggle) on the left,
// a contractor active-caseload snapshot (toggle by language) on the right, and top-5
// district / language rankings full-width below. All driven by Cases + Assignments.

// NJ outline + projection precomputed from us-atlas states-10m (geoMercator fit to a
// 340×430 box). The projection is analytic mercator, so any [lon,lat] maps correctly —
// add a district to DISTRICT_COORDS and it plots automatically.
const NJ_PATH = 'M65.734,300.469L72.026,291.387L76.071,286.913L78.318,278.381L83.711,272.502L91.351,266.34L108.429,262.837L119.665,256.529L119.665,246.851L126.856,243.342L130.002,238.708L145.282,228.593L153.371,226.484L158.764,219.312L163.259,220.437L170.899,214.95L164.607,204.953L155.619,199.177L152.473,191.846L143.035,184.228L139.889,174.627L128.653,171.943L126.856,165.584L127.754,152.146L123.26,146.908L115.62,147.616L111.575,145.634L110.676,133.873L113.822,129.62L110.227,126.499L114.272,112.304L119.215,113.014L129.552,96.952L118.766,79.869L124.608,73.029L132.698,68.894L139.889,60.905L138.091,57.479L145.731,52.481L150.675,45.481L156.967,27.745L166.854,17.863L174.045,16L213.594,40.763L272.917,75.879L274.266,78.587L265.277,105.199L259.884,114.434L258.086,123.661L255.39,126.783L252.244,131.605L235.615,136.567L233.818,148.466L229.773,150.731L228.425,157.806L228.425,163.887L236.964,167.845L244.154,165.301L254.941,171.519L261.232,172.791L263.03,166.573L264.828,179.287L263.48,194.384L257.188,220.015L251.345,254.706L249.098,278.94L231.121,312.613L226.178,319.307L222.133,320.562L223.481,325.022L218.987,332.684L209.998,341.455L209.549,344.098L195.617,351.747L181.236,366.752L171.798,383.124L161.91,403.764L152.922,412.064L144.383,414L139.439,412.064L142.136,399.888L148.877,386.451L150.225,376.884L140.788,371.75L132.698,371.195L130.002,367.724L121.912,368.141L118.766,373.137L114.721,369.807L113.822,363.281L105.733,358.141L104.385,353.972L99.89,355.639L93.149,346.185L90.003,347.298L81.914,339.228L77.419,331.431L68.88,327.949L71.577,308.427L66.184,304.379Z'
const MAP_W = 340, MAP_H = 430
const PROJ = { k: 7174.089017921845, tx: 9526.752853468037, ty: 5713.346553527831 }
function project(lon, lat) {
  const R = Math.PI / 180
  return [PROJ.tx + PROJ.k * (lon * R), PROJ.ty - PROJ.k * Math.log(Math.tan(Math.PI / 4 + (lat * R) / 2))]
}

// Normalize a district name to a lookup key (drop "SD", "township", punctuation, etc.).
function normDistrict(d) {
  return String(d || '').toLowerCase()
    .replace(/school district|public schools|regional|\bsd\b|\bboe\b|township|\btwp\b|borough|\bboro\b/g, '')
    .replace(/[^a-z]/g, '')
}
// [lon, lat] of the district's town. Add entries here as new districts appear.
const DISTRICT_COORDS = {
  matawan: [-74.2291, 40.4126], manville: [-74.5885, 40.5407], oldbridge: [-74.3654, 40.4126],
  randolph: [-74.5757, 40.8484], cherryhill: [-75.0307, 39.9348], mountolive: [-74.7385, 40.8501],
  pemberton: [-74.6829, 39.9718], warren: [-74.5143, 40.6237], woodridge: [-74.0876, 40.8451],
  woodbridge: [-74.2846, 40.5576], edison: [-74.4121, 40.5187], northbrunswick: [-74.4821, 40.4501],
  eastbrunswick: [-74.4160, 40.4276], newbrunswick: [-74.4518, 40.4862], perthamboy: [-74.2654, 40.5068],
  sayreville: [-74.3610, 40.4593], plainfield: [-74.4074, 40.6337], elizabeth: [-74.2107, 40.6640],
  newark: [-74.1724, 40.7357], paterson: [-74.1718, 40.9168], trenton: [-74.7429, 40.2171],
  bridgewater: [-74.6091, 40.5940], franklin: [-74.5321, 40.5015], hillsborough: [-74.6180, 40.5065],
}
function coordsFor(district) { return DISTRICT_COORDS[normDistrict(district)] || null }

const TILE_DARK = '#185FA5', TILE_MID = '#378ADD', TILE_LIGHT = '#B5D4F4'
function fillFor(n, max) { const r = max ? n / max : 0; return r >= 0.67 ? TILE_DARK : r >= 0.34 ? TILE_MID : TILE_LIGHT }
function inkFor(n, max) { const r = max ? n / max : 0; return r >= 0.34 ? '#ffffff' : '#0C447C' }

// Fixed categorical palette for language colors (assigned in stable sorted order).
const CAT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']

export default function DistrictHeatmap({ cases = [], assignments = [] }) {
  const [view, setView] = useState('grid')

  const { districts, languages, total, unmapped, completeIds } = useMemo(() => {
    const dc = new Map(), lc = new Map(), completeIds = new Set()
    for (const c of cases) {
      if (c.sent_to_district_at) completeIds.add(c.id)
      const d = (c.School_district || '').trim()
      if (d) dc.set(d, (dc.get(d) || 0) + 1)
      const l = (c.Language || '').trim()
      if (l) lc.set(l, (lc.get(l) || 0) + 1)
    }
    const districts = [...dc.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    const languages = [...lc.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    const unmapped = districts.filter(d => !coordsFor(d.name))
    return { districts, languages, total: cases.length, unmapped, completeIds }
  }, [cases])

  const dMax = districts[0]?.n || 1
  const lMax = languages[0]?.n || 1

  const bar = (name, n, max, color) => (
    <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <span style={{ flex: '0 0 120px', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={name}>{name}</span>
      <span style={{ flex: 1, height: 14, background: 'var(--gray-bg, #eef1f4)', borderRadius: 4, overflow: 'hidden' }}>
        <span style={{ display: 'block', height: '100%', width: `${Math.round((n / max) * 100)}%`, background: color }} />
      </span>
      <span style={{ flex: '0 0 22px', textAlign: 'right', fontSize: 13, fontWeight: 700 }}>{n}</span>
    </div>
  )

  return (
    <>
      <div className="grid-2" style={{ alignItems: 'start', marginBottom: 14 }}>
        {/* ── Left: case volume by district ── */}
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <span>Case Volume by District</span>
            <div style={{ display: 'flex', gap: 4, fontWeight: 400 }}>
              <button className={`btn btn-sm ${view === 'grid' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('grid')}>▦ Grid</button>
              <button className={`btn btn-sm ${view === 'map' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('map')}>🗺 Map</button>
            </div>
          </div>

          {districts.length === 0 && <div style={{ color: '#888', fontSize: 13 }}>No cases with a district yet.</div>}

          {districts.length > 0 && view === 'grid' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 7 }}>
              {districts.map(d => (
                <div key={d.name} style={{ background: fillFor(d.n, dMax), color: inkFor(d.n, dMax), borderRadius: 8, padding: '10px 10px 12px' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.2 }}>{d.name}</div>
                  <div style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>{d.n}</div>
                </div>
              ))}
            </div>
          )}

          {districts.length > 0 && view === 'map' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} width="100%" style={{ maxWidth: MAP_W, height: 'auto' }} role="img" aria-label="New Jersey map of case volume by district">
                <path d={NJ_PATH} fill="var(--gray-bg, #f1efe8)" stroke="var(--border, #d3d1c7)" strokeWidth="1" />
                {districts.map(d => {
                  const co = coordsFor(d.name); if (!co) return null
                  const [x, y] = project(co[0], co[1])
                  const r = 5 + Math.sqrt(d.n) * 5.5
                  return (
                    <g key={d.name}>
                      <circle cx={x} cy={y} r={r} fill={fillFor(d.n, dMax)} fillOpacity="0.9" stroke="#fff" strokeWidth="1.2" />
                      <text x={x} y={y} dy="0.35em" textAnchor="middle" fontSize="11" fontWeight="600" fill={inkFor(d.n, dMax)}>{d.n}</text>
                    </g>
                  )
                })}
              </svg>
              {unmapped.length > 0 && (
                <div style={{ fontSize: 12, color: '#888', marginTop: 4, textAlign: 'center' }}>
                  Not shown on map (no location on file): {unmapped.map(d => `${d.name} (${d.n})`).join(', ')}
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0 2px', fontSize: 12, color: '#666' }}>
            <span>Fewer</span>
            <span style={{ width: 24, height: 12, borderRadius: 3, background: TILE_LIGHT }} />
            <span style={{ width: 24, height: 12, borderRadius: 3, background: TILE_MID }} />
            <span style={{ width: 24, height: 12, borderRadius: 3, background: TILE_DARK }} />
            <span>More</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 12 }}>
            <StatMini num={total} label="Total Cases" />
            <StatMini num={districts.length} label="Districts" />
            <StatMini num={languages.length} label="Languages" />
          </div>
        </div>

        {/* ── Right: contractor snapshot ── */}
        <ContractorSnapshot assignments={assignments} completeIds={completeIds} />
      </div>

      {/* ── Full-width: top-5 rankings ── */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="grid-2" style={{ alignItems: 'start' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#555', marginBottom: 10 }}>Top 5 districts by volume</div>
            {districts.slice(0, 5).map(d => bar(d.name, d.n, dMax, TILE_DARK))}
            {districts.length === 0 && <div style={{ color: '#888', fontSize: 13 }}>No district data yet.</div>}
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#555', marginBottom: 10 }}>Top 5 languages by volume</div>
            {languages.slice(0, 5).map(l => bar(l.name, l.n, lMax, '#1baf7a'))}
            {languages.length === 0 && <div style={{ color: '#888', fontSize: 13 }}>No language data yet.</div>}
          </div>
        </div>
      </div>
    </>
  )
}

// Active caseload per evaluator, broken down by language, with a language toggle.
// "Active" = an assignment the evaluator holds that isn't submitted and whose case
// hasn't been sent to the district.
function ContractorSnapshot({ assignments = [], completeIds }) {
  const [active, setActive] = useState('All')

  const { evaluators, langColor, langOrder } = useMemo(() => {
    const byEval = new Map()
    const langSet = new Set()
    for (const a of assignments) {
      if (a.contractor_id == null) continue
      if ((a.status || '').toLowerCase() === 'submitted') continue
      if (completeIds && completeIds.has(a.case_id)) continue
      const name = a.Contractors?.name || `#${a.contractor_id}`
      const lang = (a.Cases?.Language || '').trim() || '(none)'
      langSet.add(lang)
      if (!byEval.has(name)) byEval.set(name, {})
      const m = byEval.get(name)
      m[lang] = (m[lang] || 0) + 1
    }
    const langOrder = [...langSet].sort((a, b) => a.localeCompare(b))
    const langColor = {}
    langOrder.forEach((l, i) => { langColor[l] = CAT[i % CAT.length] })
    const evaluators = [...byEval.entries()].map(([name, byLang]) => ({
      name, byLang, total: Object.values(byLang).reduce((s, n) => s + n, 0),
    }))
    return { evaluators, langColor, langOrder }
  }, [assignments, completeIds])

  const rows = evaluators
    .map(e => ({ ...e, shown: active === 'All' ? e.total : (e.byLang[active] || 0) }))
    .filter(r => r.shown > 0)
    .sort((a, b) => b.shown - a.shown || a.name.localeCompare(b.name))
  const max = Math.max(1, ...rows.map(r => r.shown))
  const activeTotal = rows.reduce((s, r) => s + r.shown, 0)

  const chip = (label, color) => {
    const on = active === label
    return (
      <span key={label} onClick={() => setActive(label)}
        style={{
          cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12,
          padding: '4px 10px', borderRadius: 999, border: `1px solid ${on ? '#185FA5' : 'var(--border, #dfe3e8)'}`,
          background: on ? '#E6F1FB' : 'transparent', color: on ? '#185FA5' : '#666',
        }}>
        {color && <span style={{ width: 8, height: 8, borderRadius: 2, background: color, display: 'inline-block' }} />}
        {label}
      </span>
    )
  }

  return (
    <div className="card" style={{ marginBottom: 0 }}>
      <div className="card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Contractor Snapshot</span>
        <span style={{ fontSize: 12, color: '#888', fontWeight: 400 }}>{activeTotal} active {activeTotal === 1 ? 'case' : 'cases'}</span>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {chip('All', null)}
        {langOrder.map(l => chip(l, langColor[l]))}
      </div>

      {rows.length === 0 && (
        <div style={{ color: '#888', fontSize: 13 }}>
          {evaluators.length === 0 ? 'No active caseloads right now.' : `No active cases in ${active}.`}
        </div>
      )}

      {rows.map(({ name, byLang, shown }) => {
        const segs = active === 'All' ? Object.entries(byLang) : [[active, byLang[active] || 0]]
        return (
          <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span style={{ flex: '0 0 30px', height: 30, borderRadius: '50%', background: '#E6F1FB', color: '#185FA5', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase()}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
                <span style={{ fontWeight: 600, marginLeft: 8 }}>{shown}</span>
              </span>
              <span style={{ display: 'flex', height: 12, background: 'var(--gray-bg, #eef1f4)', borderRadius: 4, overflow: 'hidden' }}>
                {segs.map(([l, n]) => (
                  <span key={l} title={`${l}: ${n}`} style={{ display: 'block', height: '100%', width: `${Math.round((n / max) * 100)}%`, background: langColor[l] || '#888' }} />
                ))}
              </span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

function StatMini({ num, label }) {
  return (
    <div style={{ background: 'var(--gray-bg, #f4f6f8)', borderRadius: 8, padding: '10px 12px' }}>
      <div style={{ fontSize: 12, color: '#666', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700 }}>{num}</div>
    </div>
  )
}
