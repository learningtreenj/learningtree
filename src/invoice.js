// District invoice generator — matches the official Learning Tree Invoice Template.docx.
// Produces an MHTML ("single-file web page") .doc so Word reliably renders the embedded
// tree logo and signature images.
import { LOGO_B64, SIG_B64 } from './invoiceAssets.js'

export const RATE_PER_EVAL = 880

function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d)) return ''
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`
}

function fmtEvalType(evalType, language) {
  const prefix = language ? 'Bilingual ' : ''
  const t = (evalType || '').toLowerCase()
  if (t.includes('psych')) return `${prefix}Psychological Evaluation`
  if (t.includes('speech') || t.includes('language')) return `${prefix}Speech/Language Evaluation`
  if (t.includes('social')) return `${prefix}Social History Evaluation`
  if (t.includes('ed')) return `${prefix}Educational Evaluation`
  if (t.includes('ot') || t.includes('occupational')) return `${prefix}Occupational Therapy Evaluation`
  if (t.includes('pt') || t.includes('physical')) return `${prefix}Physical Therapy Evaluation`
  const capitalised = (evalType || 'Evaluation').replace(/\b\w/g, c => c.toUpperCase())
  return `${prefix}${capitalised} Evaluation`
}

function fmtMoney(n) {
  return `$${n.toLocaleString('en-US')}.00`
}

function esc(s) {
  return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}

function invoiceHtml(data) {
  const today = new Date()
  const invoiceDate = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`
  const total = data.lineItems.length * RATE_PER_EVAL

  const rows = data.lineItems.map((item, i) => {
    const last = i === data.lineItems.length - 1
    return `<tr>
      <td class=cell>${fmtDate(item.dateOfService)}</td>
      <td class=cell>${esc(fmtEvalType(item.evalType, data.language))}</td>
      <td class="cell rt">$${RATE_PER_EVAL}</td>
      <td class="cell rt"${last ? ' style="font-weight:bold"' : ''}>${last ? fmtMoney(total) : ''}</td>
    </tr>`
  }).join('')

  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<style>
 @page { margin: 0.9in 1in; }
 body { font-family: 'Times New Roman', serif; font-size: 12pt; color: #000; }
 p { margin: 0 0 3pt; }
 .rule { border-top: 1.5pt solid #000; line-height: 0; margin: 9pt 0; }
 table.items { border-collapse: collapse; width: 100%; margin: 4pt 0 2pt; }
 table.items td, table.items th { border: 1px solid #000; padding: 5pt 8pt; font-size: 11pt; vertical-align: top; }
 table.items th { background: #eeeeee; text-align: left; font-weight: bold; }
 .rt { text-align: right; }
</style></head>
<body>
<table width="100%" style="border-collapse:collapse;margin-bottom:2pt"><tr>
  <td style="width:64pt;vertical-align:top"><img src="logo.jpeg" width="52" height="60" style="width:52pt;height:60pt"></td>
  <td style="vertical-align:top;font-weight:bold;font-size:12pt">Learning Tree Multicultural/Multilingual</td>
  <td style="vertical-align:middle;text-align:center;font-size:20pt;font-weight:bold;letter-spacing:2pt">INVOICE</td>
  <td style="vertical-align:top;text-align:right;font-size:12pt">Evaluation and Consulting, Inc.</td>
</tr></table>
<p>238 West End Ave.</p>
<p>Green Brook, NJ 08812</p>
<p>Phone: (908) 754-8593 &nbsp;&nbsp;&nbsp; E-mail: office@learningtreenj.org</p>
<div class="rule"></div>
<p style="margin-bottom:8pt"><b>SERVICE FOR:</b> &nbsp;&nbsp; ${esc(data.studentName)}</p>
<p><b>BILL TO:</b> &nbsp; ${esc(data.districtName)}</p>
<p style="margin-bottom:8pt;padding-left:54pt">Special Services Department</p>
<p><b>Provider:</b> &nbsp; Learning Tree</p>
<p><b>Invoice Date:</b> &nbsp; ${invoiceDate}</p>
<p><b>Invoice Number:</b> &nbsp; ${esc(data.invoiceNumber)}</p>
<p><b>Tax ID Number:</b> &nbsp; 60-0000860</p>
<div class="rule"></div>
<table class="items">
  <tr>
    <th style="width:16%">Date of Service</th>
    <th style="width:54%">Type of Service</th>
    <th class="rt" style="width:15%">Rate</th>
    <th class="rt" style="width:15%">Total</th>
  </tr>
  ${rows}
</table>
<div class="rule"></div>
<table width="100%" style="margin-top:26pt"><tr>
  <td style="width:50%;vertical-align:bottom;font-size:12pt">Signature by</td>
  <td style="width:50%;text-align:right;vertical-align:bottom">
    <img src="sig.png" width="63" height="34" style="width:63pt;height:34pt"><br>
    <span style="border-top:1px solid #000;padding-top:2pt;font-size:12pt">Ling Chen &nbsp;&nbsp;&nbsp; President</span><br>
    <span style="font-size:10pt">Official Position</span>
  </td>
</tr></table>
</body></html>`
}

// Word "single-file web page" (MHTML) so the embedded images render reliably in Word.
function buildInvoiceMhtml(data) {
  const CRLF = '\r\n'
  const b = '----=_NextPart_LearningTreeInvoice'
  const base = 'file:///C:/LT/'
  const wrap = s => s.match(/.{1,76}/g).join(CRLF)
  return [
    'MIME-Version: 1.0',
    `Content-Type: multipart/related; type="text/html"; boundary="${b}"`,
    '',
    `--${b}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: 8bit',
    `Content-Location: ${base}invoice.htm`,
    '',
    invoiceHtml(data),
    '',
    `--${b}`,
    'Content-Type: image/jpeg',
    'Content-Transfer-Encoding: base64',
    `Content-Location: ${base}logo.jpeg`,
    '',
    wrap(LOGO_B64),
    '',
    `--${b}`,
    'Content-Type: image/png',
    'Content-Transfer-Encoding: base64',
    `Content-Location: ${base}sig.png`,
    '',
    wrap(SIG_B64),
    '',
    `--${b}--`,
    '',
  ].join(CRLF)
}

export function generateInvoiceDoc(data) {
  const mhtml = buildInvoiceMhtml(data)
  const blob = new Blob([mhtml], { type: 'application/msword' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `Invoice-${data.invoiceNumber}.doc`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
