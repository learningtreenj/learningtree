// Client-side text extraction from .docx / .pdf referral forms.
// Ported from the Retool portal (extractDocumentText.ts). Converts form
// checkbox states to ☑/☐ before stripping markup so the AI parser can see
// which testing materials were actually checked.
import { unzipSync } from 'fflate'
import * as pdfjsLib from 'pdfjs-dist'

// Vite resolves the worker as a same-origin static asset
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).href

// ── DOCX ────────────────────────────────────────────────────────────────────
export function extractDocxText(buffer) {
  const bytes = new Uint8Array(buffer)
  const unzipped = unzipSync(bytes)

  const docXmlBytes = unzipped['word/document.xml']
  if (!docXmlBytes) throw new Error('Not a valid Word document (word/document.xml missing)')

  let xml = new TextDecoder('utf-8').decode(docXmlBytes)

  // Legacy FORMCHECKBOX fields (Word 97-2003)
  xml = xml.replace(
    /<w:fldChar\b[^>]*fldCharType="begin"[^>]*>([\s\S]*?)<\/w:fldChar>/g,
    (_m, inner) => {
      if (!inner.includes('<w:checkBox>')) return _m
      const checked = inner.includes('<w:checked') && !inner.includes('w:val="0"')
      return checked ? '☑' : '☐'
    }
  )
  xml = xml
    .replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, '')
    .replace(/<w:fldChar\b[^>]*fldCharType="(?:separate|end)"[^>]*\/?>/g, '')

  // Modern SDT checkboxes (Office 2010+)
  xml = xml.replace(
    /<w:sdt>([\s\S]*?)<\/w:sdt>/g,
    (_m, inner) => {
      if (!inner.includes('w14:checkbox')) return _m
      const checked =
        inner.includes('w14:checked w14:val="1"') ||
        (inner.includes('<w14:checked') && !inner.includes('w14:val="0"'))
      const contentMatch = inner.match(/<w:sdtContent>([\s\S]*?)<\/w:sdtContent>/)
      const label = contentMatch?.[1]
        ? contentMatch[1].replace(/<[^>]+>/g, '').replace(/[☒☐☑✓✗□✔]/g, '').trim()
        : ''
      return (checked ? '☑' : '☐') + (label ? ' ' + label : '')
    }
  )

  // Some referral forms mark a selection by HIGHLIGHTING text (yellow highlighter) instead of
  // checking a box. Detect runs whose run-properties carry a text highlight and wrap their
  // text in ⟦HL⟧…⟦/HL⟧ markers so the AI parser can treat highlighted items as selected.
  xml = xml.replace(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g, (run) => {
    const rprMatch = run.match(/<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>/)
    const rpr = rprMatch ? rprMatch[0] : ''
    const highlighted = /<w:highlight\b[^>]*\bw:val="(?!none)[^"]+"/i.test(rpr)
    if (!highlighted) return run
    return run.replace(/(<w:t\b[^>]*>)([\s\S]*?)(<\/w:t>)/g, (mm, o, t, c) => t.trim() ? `${o}⟦HL⟧${t}⟦/HL⟧${c}` : mm)
  })

  return xml
    .replace(/<w:br[^/]*/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/⟦HL⟧\s*⟦\/HL⟧/g, '')       // drop empty markers
    .replace(/⟦\/HL⟧(\s*)⟦HL⟧/g, '$1')   // merge adjacent highlighted runs
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── PDF ─────────────────────────────────────────────────────────────────────
// Spatially matches AcroForm checkbox widgets to the nearest text label,
// since checkbox field names are usually non-descriptive ("Check1", ...).
function findNearbyLabel(rect, textItems) {
  const x1 = rect[0] ?? 0, y1 = rect[1] ?? 0, x2 = rect[2] ?? 0, y2 = rect[3] ?? 0
  const cbCx = (x1 + x2) / 2
  const cbCy = (y1 + y2) / 2
  const cbH = Math.abs(y2 - y1)
  const yTol = Math.max(cbH * 1.5, 12)

  let bestLabel = ''
  let bestScore = Infinity

  for (const item of textItems) {
    const str = item.str.trim()
    if (str.length === 0) continue
    if (item.x >= x1 - 2 && item.x <= x2 + 2 && item.y >= y1 - 2 && item.y <= y2 + 2) continue

    const dy = Math.abs(item.y - cbCy)
    if (dy > yTol) continue
    const dx = item.x - cbCx

    let score
    if (dx >= 0 && dx <= 300) score = Math.sqrt(dx * dx + dy * dy)
    else if (dx < 0 && dx >= -200) score = Math.sqrt(dx * dx + dy * dy) + 1000
    else continue

    if (score < bestScore) { bestScore = score; bestLabel = str }
  }
  return bestLabel
}

export async function extractPdfText(buffer) {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise

  const pages = []
  const checkedLabels = []
  const uncheckedLabels = []

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()

    const positionedItems = []
    const rawStrings = []
    for (const item of content.items) {
      if (!('str' in item)) continue
      rawStrings.push(item.str)
      positionedItems.push({ str: item.str, x: item.transform[4] ?? 0, y: item.transform[5] ?? 0 })
    }

    const pageText = rawStrings.join(' ')
    if (pageText.trim()) pages.push(pageText)

    try {
      const annotations = await page.getAnnotations()
      for (const a of annotations) {
        if (a.subtype !== 'Widget' || a.fieldType !== 'Btn') continue
        if (a.pushButton === true) continue
        const rect = a.rect
        if (!rect || rect.length < 4) continue

        const fieldValue = typeof a.fieldValue === 'string' ? a.fieldValue : 'Off'
        const isChecked = fieldValue !== 'Off' && fieldValue !== ''
        const label = findNearbyLabel(rect, positionedItems)
        const finalLabel = label || (typeof a.fieldName === 'string' ? a.fieldName : '')
        if (!finalLabel) continue

        if (isChecked) checkedLabels.push(finalLabel)
        else uncheckedLabels.push(finalLabel)
      }
    } catch {
      // annotation layer unavailable — text content alone is used
    }
  }

  let result = pages.join('\n').replace(/[ \t]+/g, ' ').trim()
  if (checkedLabels.length > 0 || uncheckedLabels.length > 0) {
    result += '\n\n=== FORM CHECKBOX STATES ===\n'
    if (checkedLabels.length > 0) result += 'CHECKED: ' + checkedLabels.join(', ') + '\n'
    if (uncheckedLabels.length > 0) result += 'UNCHECKED: ' + uncheckedLabels.join(', ') + '\n'
  }
  return result
}

export async function extractTextFromFile(file) {
  const ext = file.name.split('.').pop()?.toLowerCase()
  const buffer = await file.arrayBuffer()
  if (ext === 'docx') return extractDocxText(buffer)
  if (ext === 'pdf') return await extractPdfText(buffer)
  throw new Error(`Unsupported file type ".${ext}". Please upload a .docx or .pdf file.`)
}
