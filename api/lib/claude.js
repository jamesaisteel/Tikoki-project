import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EXTRACTION_SYSTEM_PROMPT = `You are a quote extraction assistant for Tikoki s.r.o., a custom sneaker manufacturer based in Slovakia.

Salespeople send you natural language messages or transcribed data describing a sales quote. Your job is to extract all relevant information and return a single JSON object — no prose, no markdown fences, no explanation.

Return exactly this shape:

{
  "customerName": string,           // Full company name, e.g. "Nike Slovakia s.r.o."
  "customerAddress": string | null, // Street, city — null if not mentioned
  "language": "sk" | "cz" | "en",  // Detect from customer name locale or explicit instruction; default "sk"
  "salesPersonName": string | null, // If mentioned in the message
  "items": [
    {
      "productName": string,           // Sneaker model or product name
      "quantity": number,              // Integer
      "unitPriceEurCents": number,     // Price in euro cents (€120 → 12000)
      "imageFilename": string | null   // e.g. "air-max-90.jpg" if explicitly mentioned
    }
  ],
  "notes": string | null             // Any special instructions, delivery notes, etc.
}

Rules:
- prices may appear as "€120", "120 EUR", "120.00", "120,00" — always convert to integer euro cents
- if a price is missing for an item, set unitPriceEurCents to 0
- if quantity is missing, set to 1
- language detection: Slovak/Czech company suffixes (s.r.o., a.s., spol.) → "sk" by default; Czech city names or "česky" instruction → "cz"; English names or "in English" → "en"
- return ONLY the JSON object, nothing else`;

export async function extractQuote(text) {
  console.log('[claude.extractQuote] input length:', text.length);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    temperature: 0,
    system: [
      {
        type: 'text',
        text: EXTRACTION_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: text,
      },
    ],
  });

  const raw = response.content[0].text.trim();
  console.log('[claude.extractQuote] raw response:', raw.slice(0, 200));

  // Strip markdown code fences if Claude wraps the JSON despite instructions
  const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  const parsed = JSON.parse(json);
  console.log('[claude.extractQuote] parsed ok, items:', parsed.items?.length ?? 0);
  return parsed;
}
