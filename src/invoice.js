// District invoice generator — ported from the Retool portal (generateInvoice.ts).
// Produces a Word-compatible .doc on Learning Tree letterhead.

export const RATE_PER_EVAL = 880

function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
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

function buildInvoiceHtml(data) {
  const today = new Date()
  const invoiceDate = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`
  const total = data.lineItems.length * RATE_PER_EVAL

  const lineItemRows = data.lineItems
    .map((item, i) => {
      const isLast = i === data.lineItems.length - 1
      return `
        <tr>
          <td style="border:1px solid #000;padding:5pt 8pt;font-size:11pt">${fmtDate(item.dateOfService)}</td>
          <td style="border:1px solid #000;padding:5pt 8pt;font-size:11pt">${fmtEvalType(item.evalType, data.language)}</td>
          <td style="border:1px solid #000;padding:5pt 8pt;font-size:11pt;text-align:right">$${RATE_PER_EVAL}</td>
          <td style="border:1px solid #000;padding:5pt 8pt;font-size:11pt;text-align:right;font-weight:${isLast ? 'bold' : 'normal'}">${isLast ? fmtMoney(total) : ''}</td>
        </tr>`
    })
    .join('')

  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="UTF-8"/>
<meta name="ProgId" content="Word.Document"/>
<meta name="Generator" content="Microsoft Word 15"/>
<title>Invoice ${data.invoiceNumber}</title>
<style>
  body { font-family: "Times New Roman", serif; font-size: 12pt; margin: 72pt; color: #000; }
  p { margin: 0 0 4pt 0; }
  hr { border: none; border-top: 1.5pt solid #000; margin: 10pt 0; }
  table { border-collapse: collapse; }
  b { font-weight: bold; }
</style>
</head>
<body>

<table width="100%" style="margin-bottom:2pt">
  <tr>
    <td style="font-size:12pt;font-weight:bold;vertical-align:top;width:45%">
      Learning Tree Multicultural/Multilingual
    </td>
    <td style="font-size:16pt;font-weight:bold;text-align:center;vertical-align:middle;width:20%">
      INVOICE
    </td>
    <td style="font-size:12pt;text-align:right;vertical-align:top;width:35%">
      Evaluation and Consulting, Inc.
    </td>
  </tr>
</table>

<p>238 West End Ave.</p>
<p>Green Brook, NJ 08812</p>
<p>Phone: (908) 754-8593 &nbsp;&nbsp;&nbsp; E-mail: office@learningtreenj.org</p>

<hr/>

<p style="margin-bottom:6pt"><b>SERVICE FOR:</b> &nbsp;&nbsp; ${data.studentName}</p>

<p style="margin-bottom:0"><b>BILL TO:</b> &nbsp; ${data.districtName}</p>
<p style="margin-bottom:6pt;padding-left:60pt">Department of Special Services</p>

<p><b>Provider:</b> &nbsp; Learning Tree</p>
<p><b>Invoice Date:</b> &nbsp; ${invoiceDate}</p>
<p><b>Invoice Number:</b> &nbsp; ${data.invoiceNumber}</p>
<p><b>Tax ID Number:</b> &nbsp; 60-0000860</p>

<hr/>

<table width="100%" style="border-collapse:collapse;margin-bottom:4pt">
  <thead>
    <tr>
      <th style="border:1px solid #000;padding:5pt 8pt;font-size:11pt;text-align:left;background:#f0f0f0;width:18%">Date of Service</th>
      <th style="border:1px solid #000;padding:5pt 8pt;font-size:11pt;text-align:left;background:#f0f0f0;width:52%">Type of Service</th>
      <th style="border:1px solid #000;padding:5pt 8pt;font-size:11pt;text-align:right;background:#f0f0f0;width:15%">Rate</th>
      <th style="border:1px solid #000;padding:5pt 8pt;font-size:11pt;text-align:right;background:#f0f0f0;width:15%">Total</th>
    </tr>
  </thead>
  <tbody>
    ${lineItemRows}
  </tbody>
</table>

<hr/>

<table width="100%" style="margin-top:16pt">
  <tr>
    <td style="font-size:11pt;width:50%">Signature by</td>
    <td style="font-size:11pt;text-align:right">Ling Chen &nbsp;&nbsp;&nbsp; President</td>
  </tr>
  <tr>
    <td></td>
    <td style="font-size:11pt;text-align:right">Official Position</td>
  </tr>
</table>

</body>
</html>`
}

export function generateInvoiceDoc(data) {
  const html = buildInvoiceHtml(data)
  const blob = new Blob([html], { type: 'application/msword' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `Invoice-${data.invoiceNumber}.doc`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
