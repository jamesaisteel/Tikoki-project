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
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel, text }),
  });
  const data = await res.json();
  if (!data.ok) console.error('Slack postMessage error:', data.error);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = await getRawBody(req);

  if (!verifySlackSignature(rawBody, req.headers)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // Slack sends this once to verify the endpoint URL
  if (payload.type === 'url_verification') {
    return res.status(200).json({ challenge: payload.challenge });
  }

  if (payload.type === 'event_callback') {
    // Ack immediately — Slack requires a response within 3 seconds
    res.status(200).json({ ok: true });

    const event = payload.event;

    // Only handle direct messages sent by humans (not bot echoes)
    if (
      event.type === 'message' &&
      !event.bot_id &&
      !event.subtype &&
      event.channel_type === 'im'
    ) {
      await postMessage(event.channel, 'Tikoki Agent is online! 🟢');
    }

    return;
  }

  return res.status(200).json({ ok: true });
}
