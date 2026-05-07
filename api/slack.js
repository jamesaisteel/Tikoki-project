import crypto from 'crypto';

// Disable Vercel's automatic body parsing so we can read the raw body
// needed for Slack signature verification
export const config = {
  api: {
    bodyParser: false,
  },
};

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
    const event = payload.event;
    console.log('[handler] event type:', event.type, '| subtype:', event.subtype ?? 'none', '| channel_type:', event.channel_type, '| bot_id:', event.bot_id ?? 'none');

    // Only handle direct messages sent by humans (not bot echoes)
    if (
      event.type === 'message' &&
      !event.bot_id &&
      !event.subtype &&
      event.channel_type === 'im'
    ) {
      console.log('[handler] replying to DM in channel:', event.channel);
      // postMessage runs BEFORE ack — Vercel terminates the function once res is sent,
      // so any await after res.json() would never execute.
      await postMessage(event.channel, 'Tikoki Agent is online! 🟢');
    } else {
      console.log('[handler] event skipped (not a human DM)');
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(200).json({ ok: true });
}
