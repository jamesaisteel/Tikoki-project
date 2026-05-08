import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const QUOTE_TTL = 86400; // 24 h
const DEDUP_TTL = 60;    // 60 s

export async function getQuote(slackUserId) {
  const data = await redis.get(`quote:${slackUserId}`);
  console.log('[redis.getQuote] userId:', slackUserId, 'found:', !!data);
  return data ?? null;
}

export async function setQuote(slackUserId, quote) {
  await redis.set(`quote:${slackUserId}`, quote, { ex: QUOTE_TTL });
  console.log('[redis.setQuote] stored quote for userId:', slackUserId, 'filename:', quote.filename);
}

// Atomically marks eventId as seen. Returns true if it was already seen (duplicate).
// Uses SET NX so the check + mark is a single round-trip with no race condition.
export async function isDuplicateEvent(eventId) {
  const result = await redis.set(`dedup:${eventId}`, '1', { nx: true, ex: DEDUP_TTL });
  const duplicate = result === null;
  if (duplicate) console.log('[redis.isDuplicateEvent] duplicate:', eventId);
  return duplicate;
}

// Atomically increments the global quote counter and returns a 4-digit zero-padded string.
export async function nextQuoteNumber() {
  const n = await redis.incr('tikoki:ponuka:counter');
  console.log('[redis.nextQuoteNumber] counter:', n);
  return String(n).padStart(4, '0');
}

const PDF_TTL = 300; // 5 minutes — long enough to upload, short enough not to waste memory

export async function storePdfBuffer(slackUserId, buffer) {
  await redis.set(`tikoki:pdf:${slackUserId}`, buffer.toString('base64'), { ex: PDF_TTL });
  console.log('[redis.storePdfBuffer] stored', buffer.length, 'bytes for userId:', slackUserId);
}

export async function getPdfBuffer(slackUserId) {
  const b64 = await redis.get(`tikoki:pdf:${slackUserId}`);
  if (!b64) return null;
  return Buffer.from(b64, 'base64');
}

export async function deletePdfBuffer(slackUserId) {
  await redis.del(`tikoki:pdf:${slackUserId}`);
  console.log('[redis.deletePdfBuffer] deleted for userId:', slackUserId);
}
