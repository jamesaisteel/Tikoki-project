import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Extracts the first complete {...} block from a string.
// Handles responses where Claude adds a preamble, markdown fences, or a trailing note
// despite being instructed not to.
function extractJson(raw) {
  console.log('[claude] full raw response:\n---\n' + raw + '\n---');

  // Fast path: the whole string is already valid JSON
  try {
    return JSON.parse(raw);
  } catch {}

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(stripped);
  } catch {}

  // Find the outermost { ... } by tracking brace depth
  let start = -1;
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (raw[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidate = raw.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          // Keep scanning — maybe there's a valid block further in
          start = -1;
        }
      }
    }
  }

  throw new Error(`No valid JSON object found in Claude response. Raw (first 500 chars): ${raw.slice(0, 500)}`);
}

// ── System prompts ────────────────────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are a quote extraction assistant for Tikoki s.r.o., a custom sneaker manufacturer based in Slovakia.

Salespeople send you natural language messages or transcribed data describing a sales quote. Extract all relevant information and return it as a JSON object.

CRITICAL: Your entire response must be a single raw JSON object. No markdown. No code fences. No explanation before or after. No "Here is the JSON:" preamble. Start your response with { and end with }.

Return exactly this shape:

{
  "customerName": string,
  "customerAddress": string | null,
  "language": "sk" | "cz" | "en",
  "salesPersonName": string | null,
  "items": [
    {
      "productName": string,
      "quantity": number,
      "unitPriceEurCents": number,
      "imageFilename": string | null
    }
  ],
  "notes": string | null
}

Rules:
- prices may appear as "€120", "120 EUR", "120.00", "120,00" — always convert to integer euro cents
- if a price is missing for an item, set unitPriceEurCents to 0
- if quantity is missing, set to 1
- language: Slovak/Czech suffixes (s.r.o., a.s., spol.) → "sk"; Czech city names or "česky" → "cz"; English names or "in English" → "en"; default "sk"
- customerName: full company name including legal suffix
- Your response must begin with { and contain nothing else outside the JSON`;

const EDIT_SYSTEM_PROMPT = `You are a quote editing assistant for Tikoki s.r.o., a custom sneaker manufacturer.

You receive a Quote JSON object and an edit command. Apply the edit and return the updated Quote JSON.

CRITICAL: Your entire response must be a single raw JSON object. No markdown. No code fences. No explanation. Start your response with { and end with }.

Recalculation rules (always apply after any price or quantity change):
- lineTotalCents = quantity × unitPriceEurCents  (per item)
- subtotalCents  = sum of all lineTotalCents
- vatCents       = Math.round(subtotalCents × 0.23)
- totalCents     = subtotalCents + vatCents

Rules:
- Preserve all fields not mentioned in the edit command (quoteNumber, version, createdAt, validUntil, slackUserId, salesPerson, language, filename, etc.)
- If a new item is added, assign the next sequential index value
- Prices follow the same format rules as extraction (€120 → 12000 cents)
- Your response must begin with { and contain nothing else outside the JSON`;

// ── Exported functions ────────────────────────────────────────────────────────

export async function extractQuote(text) {
  console.log('[claude.extractQuote] input length:', text.length);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    temperature: 0,
    system: [
      {
        type: 'text',
        text: EXTRACTION_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: text }],
  });

  const raw = response.content[0].text.trim();
  const parsed = extractJson(raw);
  console.log('[claude.extractQuote] parsed ok, items:', parsed.items?.length ?? 0);
  return parsed;
}

export async function editQuote(currentQuote, command) {
  console.log('[claude.editQuote] command:', command.slice(0, 100));

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    temperature: 0,
    system: [
      {
        type: 'text',
        text: EDIT_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Quote:\n${JSON.stringify(currentQuote, null, 2)}\n\nEdit command: ${command}`,
      },
    ],
  });

  const raw = response.content[0].text.trim();
  const updated = extractJson(raw);
  console.log('[claude.editQuote] updated ok, items:', updated.items?.length ?? 0);
  return updated;
}
