import crypto from 'crypto';
import { extractQuote, editQuote } from './lib/claude.js';
import { buildQuote, centsToEur, slugify } from './lib/quote.js';
import { generatePdf } from './lib/pdf.js';
import { getQuote, setQuote, isDuplicateEvent } from './lib/redis.js';

// Disable Vercel's automatic body parsing so we can read the raw body
// needed for Slack signature verification
export const config = {
  api: {
    bodyParser: false,
  },
};

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

// Accepts a Quote object (from Redis / buildQuote).
function formatSummary(quote, header = '✅ *Parsovaná ponuka — prosím skontroluj:*') {
  const langLabel = { sk: '🇸🇰 SK', cz: '🇨🇿 CZ', en: '🇬🇧 EN' }[quote.language] ?? quote.language;

  const itemLines = quote.items.map(item =>
    `  ${item.index}. *${item.productName}* — ${item.quantity} ks @ ${centsToEur(item.unitPriceEurCents)} = ${centsToEur(item.lineTotalCents)}`
  );

  const lines = [
    header,
    ``,
    `*Zákazník:* ${quote.customer.name}`,
    quote.customer.address ? `*Adresa:* ${quote.customer.address}` : null,
    `*Jazyk:* ${langLabel}`,
    ``,
    `*Položky:*`,
    ...itemLines,
    ``,
    `*Medzisúčet:* ${centsToEur(quote.subtotalCents)}`,
    `*DPH 23%:* ${centsToEur(quote.vatCents)}`,
    `*Celkom:* ${centsToEur(quote.totalCents)}`,
    quote.notes ? `\n*Poznámky:* ${quote.notes}` : null,
    ``,
    `_Ak je všetko správne, odpovez "OK" a vygenerujem PDF. Inak oprav čo treba._`,
  ];

  return lines.filter(l => l !== null).join('\n');
}

// Edit commands contain action verbs in SK/CZ/EN — distinct from new quote descriptions.
function isEditCommand(text) {
  const pattern = /\b(change|update|set|add|remove|rename|delete|increase|decrease|modify|edit|adjust|replace|fix|zme[nň]|pridaj|odober|nastav|oprav|uprav|vyma[zž]|zv[yý][šs]|zn[ií][zž]|aktualizuj|zm[eě]n|p[rř]idej|odeber|uber|zl[aá]va|zľava)\b/i;
  return pattern.test(text);
}

// ── DM handlers ───────────────────────────────────────────────────────────────

async function handleOk(event) {
  const { channel, user } = event;
  console.log('[handleOk] user:', user);

  const quote = await getQuote(user);
  if (!quote) {
    await postMessage(channel, '⚠️ Nemám uloženú žiadnu ponuku. Najprv mi pošli detaily ponuky.');
    return;
  }

  await postMessage(channel, '⏳ Generujem PDF, moment...');

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

async function handleEdit(event) {
  const { channel, user, text } = event;
  console.log('[handleEdit] user:', user, 'command:', text.slice(0, 80));

  const currentQuote = await getQuote(user);
  if (!currentQuote) {
    await postMessage(channel, '⚠️ Nemám uloženú žiadnu ponuku. Najprv mi pošli detaily ponuky.');
    return;
  }

  await postMessage(channel, '✏️ Upravujem ponuku...');

  let updatedQuote;
  try {
    updatedQuote = await editQuote(currentQuote, text);
  } catch (err) {
    console.error('[handleEdit] editQuote failed:', err.message);
    await postMessage(channel, `⚠️ Nepodarilo sa upraviť ponuku: ${err.message}`);
    return;
  }

  // Bump version and regenerate filename — never let Claude control these
  updatedQuote.version = (currentQuote.version ?? 1) + 1;
  updatedQuote.filename = `${updatedQuote.quoteNumber}-${slugify(updatedQuote.customer.name)}-v${updatedQuote.version}.pdf`;

  await setQuote(user, updatedQuote);

  const summary = formatSummary(
    updatedQuote,
    `✏️ *Ponuka upravená (v${updatedQuote.version}) — skontroluj zmeny:*`
  );
  await postMessage(channel, summary);
}

async function handleDm(event) {
  const { channel, text, user } = event;

  if (!text || !text.trim()) {
    await postMessage(channel, '⚠️ Správa je prázdna. Pošli mi detaily ponuky a ja ich spracujem.');
    return;
  }

  const trimmed = text.trim();

  // "OK" → generate PDF from stored quote
  if (/^ok[.!]?$/i.test(trimmed)) {
    await handleOk(event);
    return;
  }

  // Edit command → update stored quote via Claude
  if (isEditCommand(trimmed)) {
    await handleEdit(event);
    return;
  }

  // New quote — parse with Claude, build Quote, store in Redis
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

  const quote = buildQuote(quoteInput, user);
  await setQuote(user, quote);
  console.log('[handleDm] stored quote for user:', user, 'filename:', quote.filename);

  await postMessage(channel, formatSummary(quote));
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

    // Redis dedup: atomic SET NX — ignore events seen in the last 60 s
    if (await isDuplicateEvent(payload.event_id)) {
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
