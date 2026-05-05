# Tikoki AI Quote Agent — Data Structures

All data structures used internally across `lib/` modules and stored in Redis.

---

## QuoteInput

Returned by Claude after parsing raw salesperson input. Used to build a `Quote`.

```typescript
interface QuoteInput {
  customerName: string;           // "Nike Slovakia s.r.o."
  customerAddress?: string;       // Optional: "Mlynské Nivy 12, Bratislava"
  language: "sk" | "cz" | "en";  // Detected from input, default "sk"
  items: QuoteInputItem[];
  salesPersonName?: string;       // If mentioned in input
  notes?: string;                 // Any free-text notes from input
}

interface QuoteInputItem {
  productName: string;            // "Air Max 90"
  quantity: number;               // 50
  unitPriceEurCents: number;      // 12000  (= €120.00)
  imageFilename?: string;         // "air-max-90.jpg" if mentioned
}
```

---

## Quote

The canonical quote object. Built from `QuoteInput` by `lib/quote.js:buildQuote()`. Stored in Redis and passed to the PDF generator.

```typescript
interface Quote {
  // Identity
  quoteNumber: string;            // "0042"
  version: number;                // 1, 2, 3 ... (increments on edit)
  language: "sk" | "cz" | "en";

  // Dates
  createdAt: string;              // ISO 8601: "2026-05-05T14:32:00Z"
  validUntil: string;             // createdAt + 30 days

  // Parties
  customer: Customer;
  salesPerson: SalesPerson;

  // Line items
  items: QuoteLineItem[];

  // Totals (all in euro cents)
  subtotalCents: number;          // Sum of all lineTotalCents
  vatCents: number;               // round(subtotalCents * 0.23)
  totalCents: number;             // subtotalCents + vatCents

  // Output
  filename: string;               // "0042-NikeSlovakia-v1.pdf"
  driveFileId?: string;           // Set after Drive upload
  driveLink?: string;             // Set after Drive upload

  // Internal
  slackUserId: string;            // The Slack user who created this quote
  notes?: string;
}
```

---

## QuoteLineItem

One row in the quote table.

```typescript
interface QuoteLineItem {
  index: number;                  // 1-based row number
  productName: string;            // "Air Max 90"
  quantity: number;               // 50
  unitPriceEurCents: number;      // 12000
  lineTotalCents: number;         // quantity * unitPriceEurCents = 600000
  imageFilename?: string;         // "air-max-90.jpg"
  imageBase64?: string;           // Populated by lib/drive.js before PDF render
  imageAvailable: boolean;        // false if Drive fetch failed
}
```

---

## Customer

```typescript
interface Customer {
  name: string;                   // "Nike Slovakia s.r.o."
  address?: string;               // "Mlynské Nivy 12\n820 09 Bratislava"
}
```

---

## SalesPerson

```typescript
interface SalesPerson {
  name: string;                   // From Slack profile or input
  slackUserId: string;
  email?: string;                 // From Slack profile
}
```

---

## Redis Key Schema

| Key | Type | Value | TTL |
|---|---|---|---|
| `quote:{slackUserId}` | JSON string | Serialized `Quote` object | 86400 s (24 h) |
| `dedup:{eventId}` | String | `"1"` | 60 s |
| `quote:counter` | Integer | Current quote counter (e.g. `42`) | None (permanent) |

### Examples

```
quote:U012AB3CD    →  { "quoteNumber": "0042", "version": 1, ... }
dedup:Ev123xyz     →  "1"
quote:counter      →  42
```

### Redis Operations

```javascript
// Get last quote for a user
const raw = await redis.get(`quote:${slackUserId}`)
const quote = JSON.parse(raw)

// Save quote (24h TTL)
await redis.set(`quote:${slackUserId}`, JSON.stringify(quote), { ex: 86400 })

// Get next quote number (atomic increment)
const counter = await redis.incr('quote:counter')
const quoteNumber = String(counter).padStart(4, '0')  // "0042"

// Dedup check + set
const exists = await redis.get(`dedup:${eventId}`)
if (exists) return  // duplicate
await redis.set(`dedup:${eventId}`, '1', { ex: 60 })
```

---

## Claude API Payloads

### Extraction Request

```javascript
{
  model: "claude-sonnet-4-20250514",
  max_tokens: 1024,
  temperature: 0,
  system: [
    {
      type: "text",
      text: "You are a quote extraction assistant for Tikoki s.r.o., ...",
      cache_control: { type: "ephemeral" }   // Prompt caching
    }
  ],
  messages: [
    {
      role: "user",
      content: rawInputText
    }
  ]
}
```

### Extraction Response (Claude output)

Claude must return **only** a JSON object matching `QuoteInput`. No prose, no markdown fences.

```json
{
  "customerName": "Nike Slovakia s.r.o.",
  "customerAddress": "Mlynské Nivy 12, Bratislava",
  "language": "sk",
  "items": [
    { "productName": "Air Max 90", "quantity": 50, "unitPriceEurCents": 12000 },
    { "productName": "Dunk Low",   "quantity": 30, "unitPriceEurCents": 9500  }
  ]
}
```

### Edit Request

```javascript
{
  model: "claude-sonnet-4-20250514",
  max_tokens: 1024,
  temperature: 0,
  system: [
    {
      type: "text",
      text: "You are a quote editing assistant. You receive a Quote JSON object and an edit command. Return the updated Quote JSON only. Do not change fields that are not mentioned. Recalculate lineTotalCents, subtotalCents, vatCents, totalCents after any price or quantity change.",
      cache_control: { type: "ephemeral" }
    }
  ],
  messages: [
    {
      role: "user",
      content: `Quote:\n${JSON.stringify(currentQuote)}\n\nEdit command: ${editCommand}`
    }
  ]
}
```

---

## PDF Template Data Object

The HTML template receives a single `window.QUOTE` variable injected as a `<script>` tag.

```typescript
interface QuoteTemplateData {
  quoteNumber: string;
  version: number;
  dateFormatted: string;          // "5. mája 2026" / "5. května 2026" / "May 5, 2026"
  validUntilFormatted: string;
  language: "sk" | "cz" | "en";
  labels: LanguageLabels;

  customer: {
    name: string;
    address: string;              // Newlines converted to <br>
  };

  salesPerson: {
    name: string;
    email: string;
  };

  items: {
    index: number;
    productName: string;
    quantity: string;             // Formatted integer "50"
    unitPrice: string;            // "€120.00"
    lineTotal: string;            // "€6,000.00"
    imageBase64?: string;         // data:image/jpeg;base64,...
    imageAvailable: boolean;
  }[];

  subtotal: string;               // "€17,850.00"
  vat: string;                    // "€4,105.50"
  total: string;                  // "€21,955.50"

  fotodokumentacia: {
    caption: string;              // Product name
    imageBase64: string;
  }[];

  logoBase64: string;             // Tikoki logo as data URI
}
```

---

## LanguageLabels

```typescript
interface LanguageLabels {
  documentTitle: string;     // "PONUKA" / "NABÍDKA" / "QUOTE"
  quoteNumber: string;       // "Číslo ponuky" / "Číslo nabídky" / "Quote Number"
  date: string;              // "Dátum" / "Datum" / "Date"
  validUntil: string;        // "Platnosť do" / "Platnost do" / "Valid Until"
  billTo: string;            // "Zákazník" / "Zákazník" / "Bill To"
  preparedBy: string;        // "Vypracoval" / "Vypracoval" / "Prepared By"
  product: string;           // "Produkt" / "Produkt" / "Product"
  qty: string;               // "Množstvo" / "Množství" / "Qty"
  unitPrice: string;         // "Jednotková cena" / "Jednotková cena" / "Unit Price"
  lineTotal: string;         // "Spolu" / "Celkem" / "Total"
  subtotal: string;          // "Medzisúčet" / "Mezisoučet" / "Subtotal"
  vat: string;               // "DPH 23%" / "DPH 23%" / "VAT 23%"
  total: string;             // "CELKOM" / "CELKEM" / "TOTAL"
  fotodokumentacia: string;  // "Fotodokumentácia" / "Fotodokumentace" / "Photo Documentation"
  validity: string;          // "Platnosť ponuky: 30 dní" / ...
}
```

---

## Slack Event Payload (inbound)

Relevant fields extracted from Slack's `event_callback` payload:

```typescript
interface SlackEventPayload {
  event_id: string;               // For dedup: "Ev123abc"
  event: {
    type: "message" | "app_mention";
    user: string;                  // Slack user ID "U012AB3CD"
    text: string;                  // Message text
    files?: SlackFile[];           // Attached files
    channel: string;               // Channel ID
    ts: string;                    // Message timestamp
  };
}

interface SlackFile {
  id: string;
  name: string;                    // "quotes.xlsx"
  mimetype: string;                // "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  url_private_download: string;    // Authenticated download URL
}
```

---

## Excel Input Schema

Expected column headers in uploaded `.xlsx` files (case-insensitive, order flexible):

| Column | Aliases | Required |
|---|---|---|
| Product / Produkt | name, item, tovar | Yes |
| Quantity / Množstvo | qty, ks, počet | Yes |
| Unit Price / Cena | price, cena/ks, jednotková cena | Yes |
| Image / Obrázok | foto, image filename | No |

Row 1 is assumed to be headers. Rows with empty product name are skipped.

Prices may be formatted as `€120`, `120 EUR`, `120.00`, or `120,00` — all normalized to integer euro cents.
