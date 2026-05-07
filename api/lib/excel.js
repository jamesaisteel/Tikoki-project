import * as XLSX from 'xlsx';

// ── Download ──────────────────────────────────────────────────────────────────

export async function downloadSlackFile(urlPrivate) {
  console.log('[excel.download] fetching', urlPrivate.slice(0, 60));

  const res = await fetch(urlPrivate, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    // Do not follow redirects — a redirect usually means auth failed and we'd
    // silently receive an HTML login page instead of the binary file.
    redirect: 'follow',
  });

  const contentType = res.headers.get('content-type') ?? '';
  console.log('[excel.download] status:', res.status, '| content-type:', contentType);

  if (!res.ok) {
    const snippet = await res.text();
    console.error('[excel.download] error body:', snippet.slice(0, 300));
    throw new Error(`Slack vrátil HTTP ${res.status} pri sťahovaní súboru.`);
  }

  if (contentType.includes('text/html')) {
    const snippet = await res.text();
    console.error('[excel.download] got HTML instead of binary — auth issue? Snippet:', snippet.slice(0, 300));
    throw new Error(
      'Bot nemá oprávnenie stiahnuť súbor. Skontroluj, či má bot scope "files:read" v Slack App nastaveniach.'
    );
  }

  const arrayBuf = await res.arrayBuffer();
  const buf = Buffer.from(arrayBuf);
  console.log('[excel.download] downloaded', buf.length, 'bytes');

  // xlsx files are ZIP archives — magic bytes must be PK (0x50 0x4B)
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4B) {
    console.error('[excel.download] bad magic bytes:', buf.slice(0, 4).toString('hex'));
    throw new Error(
      'Stiahnutý súbor nie je platný .xlsx súbor. Uisti sa, že ukladáš v novom Excel formáte (nie .xls alebo .csv).'
    );
  }

  return buf;
}

// ── Sheet lookup (case-insensitive, diacritic-tolerant) ───────────────────────

function normalize(str) {
  return String(str ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function findSheet(wb, candidates) {
  for (const name of wb.SheetNames) {
    if (candidates.includes(normalize(name))) return wb.Sheets[name];
  }
  return null;
}

// ── Price parsing ─────────────────────────────────────────────────────────────

function parsePriceToCents(val) {
  if (typeof val === 'number') return Math.round(val * 100);
  let s = String(val ?? '').trim().replace(/[€$£]/g, '').replace(/EUR/gi, '').trim();
  if (!s) return 0;

  // European decimal: ends with ",NN" → comma is decimal separator
  if (/,\d{1,2}$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/,/g, ''); // strip thousands commas
  }

  const num = parseFloat(s);
  return isNaN(num) ? 0 : Math.round(num * 100);
}

// ── Column index lookup ───────────────────────────────────────────────────────

function findColIdx(headers, aliases) {
  for (let i = 0; i < headers.length; i++) {
    if (aliases.includes(normalize(headers[i]))) return i;
  }
  return -1;
}

// ── Key-value sheet parser (col A = label, col B = value) ────────────────────

function parseKeyValue(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const map = {};
  for (const row of rows) {
    const key = normalize(row[0]);
    const val = String(row[1] ?? '').trim();
    if (key && val) map[key] = val;
  }
  return map;
}

// ── Zakaznik sheet → customer fields ─────────────────────────────────────────

const CUSTOMER_ALIASES = {
  customerName:    ['zakaznik', 'customer', 'nazov', 'firma', 'company', 'meno', 'name', 'klient'],
  customerAddress: ['adresa', 'address', 'sidlo', 'ulica'],
  language:        ['jazyk', 'language', 'lang'],
  salesPersonName: ['obchodnik', 'salesperson', 'predajca', 'vypracoval', 'meno obchodnika'],
};

function extractCustomer(kvMap) {
  const find = (aliases) => {
    for (const alias of aliases) {
      if (kvMap[alias]) return kvMap[alias];
    }
    return null;
  };

  const lang = find(CUSTOMER_ALIASES.language);
  const normalizedLang = lang ? normalize(lang) : null;
  const resolvedLang = ['sk', 'cz', 'en'].includes(normalizedLang) ? normalizedLang : 'sk';

  return {
    customerName:    find(CUSTOMER_ALIASES.customerName) ?? 'Neznámy zákazník',
    customerAddress: find(CUSTOMER_ALIASES.customerAddress),
    language:        resolvedLang,
    salesPersonName: find(CUSTOMER_ALIASES.salesPersonName),
  };
}

// ── Polozky sheet → items ─────────────────────────────────────────────────────

const PRODUCT_ALIASES  = ['popis', 'produkt', 'product', 'name', 'item', 'tovar', 'nazov'];
const QTY_ALIASES      = ['mnozstvo', 'qty', 'ks', 'pocet', 'quantity', 'mnoz'];
const PRICE_ALIASES    = ['cena_za_kus', 'cena/ks', 'cena', 'price', 'jednotkova_cena', 'jednotkova cena', 'unit price', 'jedn. cena'];
const IMAGE_ALIASES    = ['obrazok', 'foto', 'image', 'filename', 'subor', 'obrazok/foto'];

function parseItems(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (rows.length < 2) throw new Error('Hárok Polozky neobsahuje žiadne riadky s položkami.');

  const headers = rows[0].map(h => normalize(h));

  const productIdx = findColIdx(headers, PRODUCT_ALIASES);
  const qtyIdx     = findColIdx(headers, QTY_ALIASES);
  const priceIdx   = findColIdx(headers, PRICE_ALIASES);
  const imageIdx   = findColIdx(headers, IMAGE_ALIASES);

  const missing = [];
  if (productIdx === -1) missing.push('popis/produkt');
  if (qtyIdx === -1)     missing.push('mnozstvo/qty/ks');
  if (priceIdx === -1)   missing.push('cena_za_kus/cena/price');
  if (missing.length > 0) {
    throw new Error(`Chýbajúce stĺpce v hárku Polozky: ${missing.join(', ')}.\nNájdené hlavičky: ${rows[0].join(', ')}`);
  }

  const items = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const productName = String(row[productIdx] ?? '').trim();
    if (!productName) continue; // skip empty rows

    const qtyRaw = row[qtyIdx];
    const quantity = typeof qtyRaw === 'number'
      ? Math.round(qtyRaw)
      : parseInt(String(qtyRaw).replace(/\D/g, ''), 10) || 1;

    const unitPriceEurCents = parsePriceToCents(row[priceIdx]);
    const imageFilename = imageIdx !== -1 ? (String(row[imageIdx] ?? '').trim() || null) : null;

    items.push({ productName, quantity, unitPriceEurCents, imageFilename });
  }

  if (items.length === 0) throw new Error('Hárok Polozky neobsahuje žiadne vyplnené položky.');
  return items;
}

// ── Nastavenia sheet → notes ──────────────────────────────────────────────────

function extractNotes(kvMap) {
  return kvMap['poznamky'] ?? kvMap['poznamka'] ?? kvMap['notes'] ?? kvMap['note'] ?? null;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function parseExcelFile(slackFile) {
  const buffer = await downloadSlackFile(slackFile.url_private_download);
  // Pass as Uint8Array with type:'array' — more reliable than type:'buffer' across xlsx versions
  const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });

  console.log('[excel.parse] sheets found:', wb.SheetNames.join(', '));

  const polozkySheet  = findSheet(wb, ['polozky', 'polozky', 'items', 'produkty', 'tovar']);
  const zakaznikSheet = findSheet(wb, ['zakaznik', 'customer', 'klient', 'odberatel']);
  const nastavSheet   = findSheet(wb, ['nastavenia', 'nastavenie', 'settings', 'poznamky']);

  if (!polozkySheet) {
    const available = wb.SheetNames.join(', ');
    throw new Error(`Nenašiel som hárok "Polozky" s položkami.\nDostupné hárky: ${available}`);
  }

  const customer = zakaznikSheet ? extractCustomer(parseKeyValue(zakaznikSheet)) : {
    customerName: 'Neznámy zákazník', customerAddress: null, language: 'sk', salesPersonName: null,
  };

  const items = parseItems(polozkySheet);

  const notes = nastavSheet ? extractNotes(parseKeyValue(nastavSheet)) : null;

  const quoteInput = { ...customer, items, notes };
  console.log('[excel.parse] parsed ok — customer:', quoteInput.customerName, '| items:', items.length);
  return quoteInput;
}
