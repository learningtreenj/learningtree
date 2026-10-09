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
  const [langView, setLangView] = useState('grid')
  const [lang, setLang] = useState('')            // '' = all languages (dominant per district)
  const [showAllD, setShowAllD] = useState(false)
  const [showAllL, setShowAllL] = useState(false)

  const { districts, languages, total, unmapped, completeIds, distLang } = useMemo(() => {
    const dc = new Map(), lc = new Map(), dl = new Map(), completeIds = new Set()
    for (const c of cases) {
      if (c.sent_to_district_at) completeIds.add(c.id)
      const d = (c.School_district || '').trim()
      if (d) dc.set(d, (dc.get(d) || 0) + 1)
      const l = (c.Language || '').trim()
      if (l) lc.set(l, (lc.get(l) || 0) + 1)
      if (d && l) { const m = dl.get(d) || new Map(); m.set(l, (m.get(l) || 0) + 1); dl.set(d, m) }
    }
    const districts = [...dc.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    const languages = [...lc.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    const unmapped = districts.filter(d => !coordsFor(d.name))
    return { districts, languages, total: cases.length, unmapped, completeIds, distLang: dl }
  }, [cases])

  const dMax = districts[0]?.n || 1
  const lMax = languages[0]?.n || 1

  // Stable color per language (by overall rank) for the language map/grid.
  const langColor = useMemo(() => { const m = new Map(); languages.forEach((l, i) => m.set(l.name, CAT[i % CAT.length])); return m }, [languages])
  // Per-district language breakdown; `n` is the count for the chosen language (or all).
  const langRows = useMemo(() => districts.map(d => {
    const m = distLang.get(d.name) || new Map()
    const list = [...m.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    return { name: d.name, total: d.n, list, top: list[0] || null, n: lang ? (m.get(lang) || 0) : d.n }
  }).filter(r => r.n > 0).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)), [districts, distLang, lang])
  const lrMax = langRows[0]?.n || 1
  const langUnmapped = langRows.filter(r => !coordsFor(r.name))
  const dot = color => <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: color, marginRight: 5, verticalAlign: 'middle' }} />

  // "All languages" grid = a district × language heat table (top languages as columns, rest in "Other").
  const [showAllRows, setShowAllRows] = useState(false)
  const [rowQuery, setRowQuery] = useState('')
  const MATRIX_LANGS = 8, MATRIX_ROWS = 15
  const matrixLangs = languages.slice(0, MATRIX_LANGS).map(l => l.name)
  const matrixRows = useMemo(() => {
    const q = rowQuery.trim().toLowerCase()
    return districts
      .filter(d => !q || d.name.toLowerCase().includes(q))
      .map(d => {
        const m = distLang.get(d.name) || new Map()
        const cells = matrixLangs.map(l => m.get(l) || 0)
        const other = [...m.entries()].filter(([l]) => !matrixLangs.includes(l)).reduce((n, [, v]) => n + v, 0)
        return { name: d.name, total: d.n, cells, other }
      })
  }, [districts, distLang, rowQuery, languages])
  const matrixShown = showAllRows || rowQuery.trim() ? matrixRows : matrixRows.slice(0, MATRIX_ROWS)
  const matrixMax = Math.max(1, ...matrixRows.flatMap(r => [...r.cells, r.other]))
  const heat = (v, color) => v ? { background: `${color}${Math.round((0.18 + 0.72 * Math.sqrt(v / matrixMax)) * 255).toString(16).padStart(2, '0')}`, color: v / matrixMax >= 0.45 ? '#fff' : '#1c2330', fontWeight: 700 } : { color: '#c9ccd1' }

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

      {/* ── Full-width: language need by district ── */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <span>Languages by District{lang ? ` — ${lang}` : ''}</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400, flexWrap: 'wrap' }}>
            <select value={lang} onChange={e => setLang(e.target.value)} style={{ padding: '4px 8px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 5, background: '#fff' }} title="Pick a language to see where its cases are">
              <option value="">All languages (top language per district)</option>
              {languages.map(l => <option key={l.name} value={l.name}>{l.name} ({l.n})</option>)}
            </select>
            <div style={{ display: 'flex', gap: 4 }}>
              <button className={`btn btn-sm ${langView === 'grid' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setLangView('grid')}>▦ Grid</button>
              <button className={`btn btn-sm ${langView === 'map' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setLangView('map')}>🗺 Map</button>
            </div>
          </div>
        </div>
        <div style={{ fontSize: 12, color: '#777', marginBottom: 10 }}>
          {lang
            ? <>Cases in <strong>{lang}</strong> by district — {langRows.reduce((n, r) => n + r.n, 0)} case{langRows.reduce((n, r) => n + r.n, 0) === 1 ? '' : 's'} across {langRows.length} district{langRows.length === 1 ? '' : 's'}.</>
            : <>Each district's languages, most-requested first. Pick a language above to map just that one.</>}
        </div>

        {langRows.length === 0 && <div style={{ color: '#888', fontSize: 13 }}>No cases{lang ? ` in ${lang}` : ''} with a district yet.</div>}

        {langRows.length > 0 && langView === 'grid' && (lang ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 7 }}>
            {langRows.map(r => (
              <div key={r.name} style={{ background: fillFor(r.n, lrMax), color: inkFor(r.n, lrMax), borderRadius: 8, padding: '10px 10px 12px' }}>
                <div style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.2 }}>{r.name}</div>
                <div style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>{r.n}</div>
                <div style={{ fontSize: 11, opacity: .85 }}>of {r.total} case{r.total === 1 ? '' : 's'}</div>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
              <input type="text" value={rowQuery} onChange={e => setRowQuery(e.target.value)} placeholder="🔍 Find a district…"
                style={{ padding: '5px 9px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 5, width: 200 }} />
              <span style={{ fontSize: 12, color: '#777' }}>
                Showing {matrixShown.length} of {matrixRows.length} districts · darker = more cases · the {matrixLangs.length} most-requested languages are columns, everything else is “Other”
              </span>
            </div>
            <div className="tbl-wrap" style={{ maxHeight: 520, overflow: 'auto' }}>
              <table style={{ fontSize: 12.5 }}>
                <thead>
                  <tr>
                    <th style={{ position: 'sticky', top: 0, left: 0, zIndex: 3, background: '#f0f2f5' }}>District</th>
                    <th style={{ position: 'sticky', top: 0, zIndex: 2, background: '#f0f2f5', textAlign: 'right' }}>Cases</th>
                    {matrixLangs.map(l => <th key={l} style={{ position: 'sticky', top: 0, zIndex: 2, background: '#f0f2f5', textAlign: 'center', whiteSpace: 'nowrap' }}>{dot(langColor.get(l))}{l}</th>)}
                    <th style={{ position: 'sticky', top: 0, zIndex: 2, background: '#f0f2f5', textAlign: 'center' }}>Other</th>
                  </tr>
                </thead>
                <tbody>
                  {matrixShown.length === 0 && <tr><td colSpan={matrixLangs.length + 3} style={{ color: '#888' }}>No district matches.</td></tr>}
                  {matrixShown.map(r => (
                    <tr key={r.name}>
                      <td style={{ position: 'sticky', left: 0, background: '#fff', fontWeight: 600, whiteSpace: 'nowrap' }}>{r.name}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{r.total}</td>
                      {r.cells.map((v, i) => <td key={i} style={{ textAlign: 'center', fontVariantNumeric: 'tabular-nums', ...heat(v, langColor.get(matrixLangs[i])) }}>{v || '·'}</td>)}
                      <td style={{ textAlign: 'center', fontVariantNumeric: 'tabular-nums', ...heat(r.other, '#6b7480') }} title={r.other ? [...(distLang.get(r.name) || new Map()).entries()].filter(([l]) => !matrixLangs.includes(l)).map(([l, v]) => `${l} ${v}`).join(', ') : undefined}>{r.other || '·'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700, background: '#f0f2f5' }}>
                    <td style={{ position: 'sticky', left: 0, background: '#f0f2f5' }}>All districts</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{matrixRows.reduce((n, r) => n + r.total, 0)}</td>
                    {matrixLangs.map((l, i) => <td key={l} style={{ textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{matrixRows.reduce((n, r) => n + r.cells[i], 0)}</td>)}
                    <td style={{ textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{matrixRows.reduce((n, r) => n + r.other, 0)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {matrixRows.length > MATRIX_ROWS && !rowQuery.trim() && (
              <div style={{ marginTop: 8 }}>
                <span className="tbl-link" style={{ fontSize: 12 }} onClick={() => setShowAllRows(v => !v)}>{showAllRows ? 'Show top 15 districts' : `Show all ${matrixRows.length} districts`}</span>
              </div>
            )}
          </>
        ))}

        {langRows.length > 0 && langView === 'map' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} width="100%" style={{ maxWidth: MAP_W, height: 'auto' }} role="img" aria-label={lang ? `New Jersey map of ${lang} cases by district` : 'New Jersey map of the top language per district'}>
              <path d={NJ_PATH} fill="var(--gray-bg, #f1efe8)" stroke="var(--border, #d3d1c7)" strokeWidth="1" />
              {langRows.map(r => {
                const co = coordsFor(r.name); if (!co) return null
                const [x, y] = project(co[0], co[1])
                const rad = 5 + Math.sqrt(r.n) * 5.5
                const color = lang ? (langColor.get(lang) || TILE_DARK) : (langColor.get(r.top?.name) || '#999')
                return (
                  <g key={r.name}>
                    <title>{r.name}: {lang ? `${r.n} ${lang} case${r.n === 1 ? '' : 's'}` : r.list.slice(0, 4).map(l => `${l.name} ${l.n}`).join(', ')}</title>
                    <circle cx={x} cy={y} r={rad} fill={color} fillOpacity="0.9" stroke="#fff" strokeWidth="1.2" />
                    <text x={x} y={y} dy="0.35em" textAnchor="middle" fontSize="11" fontWeight="600" fill="#fff">{r.n}</text>
                  </g>
                )
              })}
            </svg>
            {!lang && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', justifyContent: 'center', fontSize: 12, color: '#555', marginTop: 6 }}>
                {languages.slice(0, 8).map(l => <span key={l.name}>{dot(langColor.get(l.name))}{l.name}</span>)}
                {languages.length > 8 && <span style={{ color: '#888' }}>+{languages.length - 8} more</span>}
                <span style={{ color: '#888' }}>· color = district's most-requested language · size = {lang ? 'cases' : 'total cases'}</span>
              </div>
            )}
            {langUnmapped.length > 0 && (
              <div style={{ fontSize: 12, color: '#888', marginTop: 4, textAlign: 'center' }}>
                Not shown on map (no location on file): {langUnmapped.map(r => `${r.name} (${r.n})`).join(', ')}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Full-width: top-5 rankings ── */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="grid-2" style={{ alignItems: 'start' }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#555' }}>{showAllD ? `All ${districts.length} districts by volume` : 'Top 5 districts by volume'}</span>
              {districts.length > 5 && <span className="tbl-link" style={{ fontSize: 12 }} onClick={() => setShowAllD(v => !v)}>{showAllD ? 'Show top 5' : `Show all ${districts.length}`}</span>}
            </div>
            <div style={showAllD ? { maxHeight: 420, overflowY: 'auto', paddingRight: 4 } : undefined}>
              {(showAllD ? districts : districts.slice(0, 5)).map(d => bar(d.name, d.n, dMax, TILE_DARK))}
            </div>
            {districts.length === 0 && <div style={{ color: '#888', fontSize: 13 }}>No district data yet.</div>}
          </div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#555' }}>{showAllL ? `All ${languages.length} languages by volume` : 'Top 5 languages by volume'}</span>
              {languages.length > 5 && <span className="tbl-link" style={{ fontSize: 12 }} onClick={() => setShowAllL(v => !v)}>{showAllL ? 'Show top 5' : `Show all ${languages.length}`}</span>}
            </div>
            <div style={showAllL ? { maxHeight: 420, overflowY: 'auto', paddingRight: 4 } : undefined}>
              {(showAllL ? languages : languages.slice(0, 5)).map(l => bar(l.name, l.n, lMax, '#1baf7a'))}
            </div>
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
