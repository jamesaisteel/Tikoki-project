import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { centsToEur, formatDate } from './quote.js';

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHtml(quote) {
  const hasImages = quote.items.some(i => i.imageBase64);
  const fotoItems = quote.items.filter(i => i.imageBase64);

  const itemRows = quote.items.map(item => `
    <tr>
      <td class="num">${item.index}</td>
      ${hasImages ? `<td class="img-cell">${
        item.imageBase64
          ? `<img src="data:${item.imageMimeType ?? 'image/jpeg'};base64,${item.imageBase64}" class="thumb" />`
          : ''
      }</td>` : ''}
      <td>${escHtml(item.productName)}</td>
      <td class="num">${item.quantity}</td>
      <td class="num">${centsToEur(item.unitPriceEurCents)}</td>
      <td class="num bold">${centsToEur(item.lineTotalCents)}</td>
    </tr>`).join('');

  const fotoPages = fotoItems.map(item => `
    <div class="foto-page">
      <div class="foto-caption">${escHtml(item.productName)}</div>
      ${item.imageFilename ? `<div class="foto-filename">${escHtml(item.imageFilename)}</div>` : ''}
      <img
        src="data:${item.imageMimeType ?? 'image/jpeg'};base64,${item.imageBase64}"
        class="foto-img"
        alt="${escHtml(item.productName)}"
      />
    </div>`).join('');

  return `<!DOCTYPE html>
<html lang="sk">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #1a1a1a; background: #fff; font-size: 13px; }

  /* ── Header ── */
  .header {
    background: #111827;
    color: #fff;
    padding: 28px 48px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .logo { font-size: 34px; font-weight: 900; letter-spacing: 6px; color: #fff; }
  .logo span { color: #60a5fa; }
  .header-right { text-align: right; }
  .doc-title { font-size: 17px; font-weight: 700; color: #fff; letter-spacing: 1px; margin-bottom: 4px; }
  .header-right p { font-size: 12px; color: #9ca3af; line-height: 1.6; }

  /* ── Body ── */
  .body { padding: 36px 48px 100px; }

  /* ── Quote meta row ── */
  .meta-row {
    display: flex;
    gap: 40px;
    margin-bottom: 32px;
    padding-bottom: 24px;
    border-bottom: 1px solid #e5e7eb;
  }
  .meta-item .label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    color: #6b7280;
    margin-bottom: 3px;
  }
  .meta-item .value { font-size: 14px; font-weight: 600; }

  /* ── Customer block ── */
  .customer-block {
    background: #f9fafb;
    border-left: 4px solid #111827;
    padding: 16px 20px;
    margin-bottom: 32px;
    display: inline-block;
    min-width: 280px;
  }
  .customer-block .label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    color: #6b7280;
    margin-bottom: 6px;
  }
  .customer-block .name { font-size: 16px; font-weight: 700; margin-bottom: 3px; }
  .customer-block .address { font-size: 12px; color: #4b5563; white-space: pre-line; }

  /* ── Items table ── */
  table { width: 100%; border-collapse: collapse; margin-bottom: 28px; }
  thead tr { background: #111827; }
  thead th {
    padding: 11px 14px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: #d1d5db;
    font-weight: 600;
    text-align: left;
  }
  thead th.num { text-align: right; }
  tbody tr { border-bottom: 1px solid #e5e7eb; }
  tbody tr:nth-child(even) { background: #f9fafb; }
  tbody td { padding: 11px 14px; vertical-align: middle; }
  td.num { text-align: right; }
  td.bold { font-weight: 700; }
  td.img-cell { width: 80px; padding: 6px 14px; }
  img.thumb { max-height: 50px; max-width: 65px; object-fit: contain; display: block; }

  /* ── Totals ── */
  .totals-wrapper { display: flex; justify-content: flex-end; }
  .totals { width: 300px; }
  .totals-row {
    display: flex;
    justify-content: space-between;
    padding: 8px 0;
    font-size: 13px;
    border-bottom: 1px solid #e5e7eb;
  }
  .totals-row.grand {
    border-top: 2px solid #111827;
    border-bottom: none;
    padding-top: 12px;
    margin-top: 4px;
    font-size: 17px;
    font-weight: 800;
  }
  .totals-row .amt { font-weight: 600; }
  .totals-row.grand .amt { font-weight: 800; }

  /* ── Notes ── */
  .notes { margin-top: 28px; font-size: 12px; color: #4b5563; }
  .notes .label { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #9ca3af; margin-bottom: 4px; }

  /* ── Fotodokumentácia ── */
  .foto-section {
    break-before: page;
    padding: 40px 48px 100px;
  }
  .foto-section-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 2px;
    font-weight: 800;
    color: #6b7280;
    margin-bottom: 32px;
    padding-bottom: 12px;
    border-bottom: 2px solid #111827;
  }
  .foto-page {
    margin-bottom: 0;
    break-before: page;
    padding: 0 0 80px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
  }
  .foto-page:first-of-type { break-before: avoid; }
  .foto-caption {
    font-size: 16px;
    font-weight: 700;
    margin-bottom: 6px;
    color: #111827;
  }
  .foto-filename {
    font-size: 11px;
    color: #9ca3af;
    margin-bottom: 16px;
    font-family: monospace;
  }
  .foto-img {
    max-width: 100%;
    max-height: 660px;
    object-fit: contain;
    display: block;
  }

  /* ── Footer (fixed, appears on every page) ── */
  .footer {
    position: fixed;
    bottom: 0; left: 0; right: 0;
    background: #f3f4f6;
    border-top: 1px solid #e5e7eb;
    padding: 12px 48px;
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: #6b7280;
  }
</style>
</head>
<body>

<div class="header">
  <div class="logo">TIK<span>O</span>KI</div>
  <div class="header-right">
    <div class="doc-title">CENOVÁ PONUKA</div>
    <p>Tikoki s.r.o.<br>info@tikoki.sk | www.tikoki.sk</p>
  </div>
</div>

<div class="body">

  <div class="meta-row">
    <div class="meta-item">
      <div class="label">Číslo ponuky</div>
      <div class="value">#${escHtml(quote.quoteNumber)}</div>
    </div>
    <div class="meta-item">
      <div class="label">Dátum</div>
      <div class="value">${formatDate(quote.createdAt)}</div>
    </div>
    <div class="meta-item">
      <div class="label">Platnosť do</div>
      <div class="value">${formatDate(quote.validUntil)}</div>
    </div>
    <div class="meta-item">
      <div class="label">Vypracoval</div>
      <div class="value">${escHtml(quote.salesPerson.name)}</div>
    </div>
  </div>

  <div class="customer-block">
    <div class="label">Zákazník / Bill To</div>
    <div class="name">${escHtml(quote.customer.name)}</div>
    ${quote.customer.address ? `<div class="address">${escHtml(quote.customer.address)}</div>` : ''}
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:32px">#</th>
        ${hasImages ? '<th style="width:80px">Foto</th>' : ''}
        <th>Produkt</th>
        <th class="num" style="width:80px">Množstvo</th>
        <th class="num" style="width:110px">Jedn. cena</th>
        <th class="num" style="width:120px">Spolu</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows}
    </tbody>
  </table>

  <div class="totals-wrapper">
    <div class="totals">
      <div class="totals-row">
        <span>Medzisúčet (bez DPH)</span>
        <span class="amt">${centsToEur(quote.subtotalCents)}</span>
      </div>
      <div class="totals-row">
        <span>DPH 23 %</span>
        <span class="amt">${centsToEur(quote.vatCents)}</span>
      </div>
      <div class="totals-row grand">
        <span>CELKOM</span>
        <span class="amt">${centsToEur(quote.totalCents)}</span>
      </div>
    </div>
  </div>

  ${quote.notes ? `<div class="notes"><div class="label">Poznámky</div>${escHtml(quote.notes)}</div>` : ''}

</div>

${fotoItems.length > 0 ? `
<div class="foto-section">
  <div class="foto-section-title">Fotodokumentácia</div>
  ${fotoPages}
</div>` : ''}

<div class="footer">
  <span>Ponuka č. ${escHtml(quote.quoteNumber)} | Platnosť 30 dní od dátumu vystavenia</span>
  <span>Tikoki s.r.o. &nbsp;|&nbsp; info@tikoki.sk &nbsp;|&nbsp; www.tikoki.sk</span>
</div>

</body>
</html>`;
}

export async function generatePdf(quote) {
  console.log('[pdf.generatePdf] starting for quote:', quote.quoteNumber, '| foto pages:', quote.items.filter(i => i.imageBase64).length);

  const executablePath =
    process.env.PUPPETEER_EXECUTABLE_PATH || (await chromium.executablePath());

  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless: chromium.headless,
  });

  try {
    const page = await browser.newPage();
    await page.setContent(buildHtml(quote), { waitUntil: 'networkidle0' });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });

    console.log('[pdf.generatePdf] done, size:', pdfBuffer.length, 'bytes');
    return Buffer.from(pdfBuffer);
  } finally {
    await browser.close();
  }
}
