import crypto from 'crypto';
import { extractQuote } from './lib/claude.js';
import { buildQuote, centsToEur } from './lib/quote.js';
import { generatePdf } from './lib/pdf.js';

// Disable Vercel's automatic body parsing so we can read the raw body
// needed for Slack signature verification
export const config = {
  api: {
    bodyParser: false,
  },
};

// In-memory quote store keyed by Slack user ID.
// Replaced by Redis in Stage 4 — warm Vercel instances retain this between requests.
const quoteStore = new Map();

// In-memory event dedup store: eventId → timestamp (ms).
// Replaced by Redis dedup in Stage 7.
const seenEvents = new Map();
const DEDUP_TTL_MS = 60_000;

function isDuplicate(eventId) {
  const now = Date.now();
  // Evict expired entries to prevent unbounded growth
  for (const [id, ts] of seenEvents) {
    if (now - ts > DEDUP_TTL_MS) seenEvents.delete(id);
  }
  if (seenEvents.has(eventId)) return true;
  seenEvents.set(eventId, now);
  return false;
}

// ── Slack helpers ─────────────────────────────────────────────────────────────

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function verifySlackSignature(rawBody, headers) {
  const timestamp = headers['x-slack-request-timestamp'];
  const slackSig = headers['x-slack-signature'];
  const secret = process.env.SLACK_SIGNING_SECRET;

  if (!timestamp || !slackSig || !secret) return false;

  // Reject requests older than 5 minutes to prevent replay attacks
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const sigBase = `v0:${timestamp}:${rawBody}`;
  const expected = 'v0=' + crypto.createHmac('sha256', secret).update(sigBase).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(slackSig));
  } catch {
    return false;
  }
}

async function postMessage(channel, text) {
  console.log('[postMessage] sending to channel:', channel);
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel, text }),
  });
  const data = await res.json();
  if (data.ok) {
    console.log('[postMessage] sent ok, ts:', data.ts);
  } else {
    console.error('[postMessage] error:', data.error);
  }
}

// Uploads a PDF buffer to a Slack channel using the Files v2 API.
async function uploadPdf(channel, pdfBuffer, filename, message) {
  const token = process.env.SLACK_BOT_TOKEN;

  // Step 1 — request an upload URL
  console.log('[uploadPdf] requesting upload URL for', filename, pdfBuffer.length, 'bytes');
  const urlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ filename, length: String(pdfBuffer.length) }),
  });
  const { ok: urlOk, upload_url, file_id, error: urlErr } = await urlRes.json();
  if (!urlOk) throw new Error(`getUploadURLExternal: ${urlErr}`);

  // Step 2 — PUT the file bytes to the pre-signed URL
  console.log('[uploadPdf] uploading to pre-signed URL, file_id:', file_id);
  await fetch(upload_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: pdfBuffer,
  });

  // Step 3 — complete the upload and share into the channel
  console.log('[uploadPdf] completing upload');
  const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: [{ id: file_id, title: filename }],
      channel_id: channel,
      initial_comment: message,
    }),
  });
  const completeData = await completeRes.json();
  if (!completeData.ok) throw new Error(`completeUploadExternal: ${completeData.error}`);
  console.log('[uploadPdf] upload complete');
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function formatSummary(q) {
  const langLabel = { sk: '🇸🇰 SK', cz: '🇨🇿 CZ', en: '🇬🇧 EN' }[q.language] ?? q.language;

  const itemLines = q.items.map((item, i) => {
    const lineTotal = item.quantity * item.unitPriceEurCents;
    return `  ${i + 1}. *${item.productName}* — ${item.quantity} ks @ ${centsToEur(item.unitPriceEurCents)} = ${centsToEur(lineTotal)}`;
  });

  const subtotalCents = q.items.reduce((sum, item) => sum + item.quantity * item.unitPriceEurCents, 0);
  const vatCents = Math.round(subtotalCents * 0.23);
  const totalCents = subtotalCents + vatCents;

  const lines = [
    `✅ *Parsovaná ponuka — prosím skontroluj:*`,
    ``,
    `*Zákazník:* ${q.customerName}`,
    q.customerAddress ? `*Adresa:* ${q.customerAddress}` : null,
    q.salesPersonName ? `*Obchodník:* ${q.salesPersonName}` : null,
    `*Jazyk:* ${langLabel}`,
    ``,
    `*Položky:*`,
    ...itemLines,
    ``,
    `*Medzisúčet:* ${centsToEur(subtotalCents)}`,
    `*DPH 23%:* ${centsToEur(vatCents)}`,
    `*Celkom:* ${centsToEur(totalCents)}`,
    q.notes ? `\n*Poznámky:* ${q.notes}` : null,
    ``,
    `_Ak je všetko správne, odpovez "OK" a vygenerujem PDF. Inak oprav čo treba._`,
  ];

  return lines.filter(l => l !== null).join('\n');
}

// ── DM handlers ───────────────────────────────────────────────────────────────

async function handleOk(event) {
  const { channel, user } = event;
  console.log('[handleOk] user:', user);

  const quoteInput = quoteStore.get(user);
  if (!quoteInput) {
    await postMessage(channel, '⚠️ Nemám uloženú žiadnu ponuku. Najprv mi pošli detaily ponuky.');
    return;
  }

  await postMessage(channel, '⏳ Generujem PDF, moment...');

  let quote;
  try {
    quote = buildQuote(quoteInput, user);
    console.log('[handleOk] quote built:', quote.filename);
  } catch (err) {
    console.error('[handleOk] buildQuote failed:', err.message);
    await postMessage(channel, `⚠️ Chyba pri zostavovaní ponuky: ${err.message}`);
    return;
  }

  let pdfBuffer;
  try {
    pdfBuffer = await generatePdf(quote);
  } catch (err) {
    console.error('[handleOk] generatePdf failed:', err.message);
    await postMessage(channel, `⚠️ Chyba pri generovaní PDF: ${err.message}`);
    return;
  }

  try {
    await uploadPdf(
      channel,
      pdfBuffer,
      quote.filename,
      `📄 Ponuka *${quote.quoteNumber}* pre *${quote.customer.name}* je pripravená! | Celkom: ${centsToEur(quote.totalCents)} vr. DPH`
    );
  } catch (err) {
    console.error('[handleOk] uploadPdf failed:', err.message);
    await postMessage(channel, `⚠️ PDF vygenerované, ale nepodarilo sa odoslať: ${err.message}`);
  }
}

async function handleDm(event) {
  const { channel, text, user } = event;

  if (!text || !text.trim()) {
    await postMessage(channel, '⚠️ Správa je prázdna. Pošli mi detaily ponuky a ja ich spracujem.');
    return;
  }

  // "OK" confirmation → generate PDF from stored quote
  if (/^ok[.!]?$/i.test(text.trim())) {
    await handleOk(event);
    return;
  }

  let quoteInput;
  try {
    quoteInput = await extractQuote(text);
  } catch (err) {
    console.error('[handleDm] Claude extraction failed:', err.message);
    await postMessage(
      channel,
      `⚠️ Nepodarilo sa spracovať vstup: ${err.message}\nSkúste znova alebo kontaktujte správcu.`
    );
    return;
  }

  if (!quoteInput.items || quoteInput.items.length === 0) {
    await postMessage(
      channel,
      '⚠️ Nenašiel som žiadne položky v tvojej správe. Pošli mi zoznam produktov s množstvami a cenami.'
    );
    return;
  }

  // Store parsed quote so "OK" can retrieve it
  quoteStore.set(user, quoteInput);
  console.log('[handleDm] stored quoteInput for user:', user);

  const summary = formatSummary(quoteInput);
  await postMessage(channel, summary);
}

// ── Vercel handler ────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  console.log('[handler] incoming', req.method, req.url);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = await getRawBody(req);
  console.log('[handler] raw body length:', rawBody.length);

  if (!verifySlackSignature(rawBody, req.headers)) {
    console.error('[handler] signature verification failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }
  console.log('[handler] signature ok');

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.error('[handler] JSON parse error');
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  console.log('[handler] payload type:', payload.type);

  // Slack sends this once to verify the endpoint URL
  if (payload.type === 'url_verification') {
    console.log('[handler] url_verification challenge');
    return res.status(200).json({ challenge: payload.challenge });
  }

  if (payload.type === 'event_callback') {
    // Drop Slack retries immediately — we already processed (or are processing) this event
    if (req.headers['x-slack-retry-num']) {
      console.log('[handler] retry request ignored, x-slack-retry-num:', req.headers['x-slack-retry-num']);
      return res.status(200).json({ ok: true });
    }

    // In-memory dedup: ignore the same event_id within 60 s
    if (isDuplicate(payload.event_id)) {
      console.log('[handler] duplicate event_id ignored:', payload.event_id);
      return res.status(200).json({ ok: true });
    }

    const event = payload.event;
    console.log('[handler] event type:', event.type, '| subtype:', event.subtype ?? 'none', '| channel_type:', event.channel_type, '| bot_id:', event.bot_id ?? 'none');

    // Only handle direct messages sent by humans (not bot echoes)
    if (
      event.type === 'message' &&
      !event.bot_id &&
      !event.subtype &&
      event.channel_type === 'im'
    ) {
      console.log('[handler] processing DM in channel:', event.channel);
      await handleDm(event);
    } else {
      console.log('[handler] event skipped (not a human DM)');
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(200).json({ ok: true });
}
