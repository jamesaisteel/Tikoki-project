# Tikoki AI Quote Agent — Full Project Specification

## 1. Business Context

**Client**: Tikoki s.r.o. — custom sneaker manufacturer (Slovakia/Czechia)  
**Problem**: Salespeople manually create PDF quotes, which is slow and inconsistently formatted.  
**Solution**: A Slack bot that accepts natural language or Excel input, produces a branded PDF quote, saves it to Google Drive, and returns the link — all in under 30 seconds.

---

## 2. System Architecture

```
Salesperson (Slack)
    │  message / Excel file
    ▼
Slack Events API  ──►  Vercel Function /api/slack.js
                            │
                ┌───────────┼───────────────┐
                ▼           ▼               ▼
          Claude API    Upstash Redis   Google Drive API
          (parse/edit)  (state/dedup)   (images/save PDF)
                │
                ▼
          Puppeteer (PDF)
                │
                ▼
          Google Drive  ──►  Slack reply (PDF + Drive link)
```

### Request Lifecycle

1. Slack sends POST to `/api/slack.js` (event_callback or url_verification)
2. Signature verified using `SLACK_SIGNING_SECRET`
3. Dedup check: if `dedup:{event_id}` exists in Redis → return 200 immediately
4. Set `dedup:{event_id}` in Redis with TTL 60 s
5. Detect input type: plain text, file attachment (Excel), or short edit command
6. **Plain text / Excel**: call Claude to extract quote data → build Quote object → generate PDF → upload to Drive → reply to Slack
7. **Edit command**: load last quote from Redis → call Claude to apply edit → regenerate PDF → upload → reply
8. Always return HTTP 200 to Slack before async work completes (use `res.json({ok:true})` then process)

---

## 3. Functional Requirements

### 3.1 Input Handling

| Input type | Example | Handling |
|---|---|---|
| Natural language | "Quote for Nike, 50 pairs Air Max €120, 30 pairs Dunk €95" | Claude extraction |
| Excel attachment | `.xlsx` file with product/qty/price columns | `xlsx` parse → same Claude normalization |
| Edit command | "change price of Air Max to €115" | Claude edit on stored quote |
| Edit command | "add 10 pairs Jordan €200" | Claude edit on stored quote |
| Edit command | "send to Marek Novák" | Update customer name field |

### 3.2 Quote Extraction (Claude)

Claude receives the raw input and returns a `QuoteInput` JSON object. Prompt instructs Claude to:
- Extract `customerName`, `customerAddress` (if present), `language`
- Extract array of line items: `productName`, `quantity`, `unitPriceEurCents`
- Infer language from customer name locale or explicit instruction (SK default)
- Return **only** valid JSON, no prose

### 3.3 Quote Editing

Short commands trigger edit mode:
- "change", "update", "set", "add", "remove", "rename" keywords → edit mode
- Load `quote:{slack_user_id}` from Redis
- Pass current quote JSON + edit command to Claude → returns updated quote JSON
- Increment version number (`v1` → `v2`) in filename
- Regenerate PDF and re-upload to Drive

### 3.4 PDF Generation

**Engine**: Puppeteer with `puppeteer-core` + `@sparticuz/chromium`  
**Input**: `Quote` object (see DATA.md)  
**Process**:
1. Render `templates/quote.html` with quote data injected as a JSON variable
2. HTML template uses inline CSS (no external stylesheets — Puppeteer limitation on Vercel)
3. Call `page.pdf({ format: 'A4', printBackground: true })`
4. Return Buffer

**Template sections**:
- **Header**: Tikoki logo (base64 embedded), company name/address/ICO/DIC
- **Quote metadata**: Quote number, date, validity date (+30 days), salesperson
- **Customer block**: Bill-to name and address
- **Line items table**: columns — `#`, Product, Image thumbnail, Qty, Unit price, Line total
- **Totals block**: Subtotal (bez DPH), VAT 23%, **Celkom / Celkem / Total**
- **Fotodokumentacia pages**: one full-width image per page with product caption and Drive filename
- **Footer**: Quote number, page N/M, Tikoki contact info

### 3.5 Multilingual Support

| Language | Trigger | Labels |
|---|---|---|
| SK (default) | Slovak customer name detected, or explicit "po slovensky" | Ponuka, Množstvo, Cena, Celkom, DPH |
| CZ | Czech customer name, or "česky" | Nabídka, Množství, Cena, Celkem, DPH |
| EN | English name, or "in English" | Quote, Quantity, Price, Total, VAT |

Label maps stored in `lib/quote.js` as `LABELS.sk`, `LABELS.cz`, `LABELS.en`.

### 3.6 VAT Calculation

```
lineTotal      = quantity × unitPriceEurCents
subtotalCents  = Σ lineTotal
vatCents       = round(subtotalCents × 0.23)
totalCents     = subtotalCents + vatCents
```

All intermediate values stored as integers (euro cents). Displayed as `€X.XX`.

### 3.7 Quote Numbering

- Redis key: `quote:counter` (integer, starts at 1)
- On each new quote: `INCR quote:counter` → zero-pad to 4 digits → `"0042"`
- Edits do not increment the counter; they increment the file version suffix

### 3.8 File Naming

```
{quoteNumber}-{clientNameSlug}-v{version}.pdf

Examples:
  0042-NikeSlovakia-v1.pdf
  0042-NikeSlovakia-v2.pdf   ← after edit
  0043-AdidasCZ-v1.pdf
```

`clientNameSlug`: lowercase, spaces→hyphens, strip diacritics, max 30 chars.

### 3.9 Google Drive Integration

**Folder**: `TiKoki-Ponuky/` (ID stored in `GOOGLE_DRIVE_FOLDER_ID` env var)  
**Auth**: Service account JSON credentials via env vars  
**Upload**: `drive.files.create` with `media: { mimeType: 'application/pdf', body: pdfBuffer }`  
**Permissions**: Set `anyoneWithLink` reader permission after upload  
**Product images**: Fetched by filename from a `TiKoki-Fotky/` subfolder; listed for error messages

### 3.10 Slack Response Format

After successful quote generation:

```
✅ Ponuka *0042* pre *Nike Slovakia* je pripravená!

📄 <https://drive.google.com/file/d/...| 0042-NikeSlovakia-v1.pdf>

_Platnosť: 30 dní | 3 položky | Celkom: €8,694.00 vr. DPH_
```

On error:
```
⚠️ Nepodarilo sa vygenerovať ponuku: [reason]
Skúste znova alebo kontaktujte správcu.
```

---

## 4. Non-Functional Requirements

| Requirement | Target |
|---|---|
| End-to-end latency | < 30 s (Slack 3 s ack + async processing) |
| PDF file size | < 5 MB |
| Vercel function timeout | 60 s (Pro plan) |
| Redis key TTL — quote state | 24 h |
| Redis key TTL — dedup | 60 s |
| API retry attempts | 3× with exponential backoff (1 s, 2 s, 4 s) |
| Uptime | Vercel managed (99.9%) |

---

## 5. Development Stages (Detailed)

### Stage 1 — Basic Slack Integration
- `vercel.json` routes `/api/slack` to `api/slack.js`
- Handle `url_verification` challenge
- Verify Slack signature on every request
- Reply "Hello from Tikoki bot!" to any message
- **Commit**: `feat: stage 1 - basic slack integration`

### Stage 2 — Claude Parsing
- Implement `lib/claude.js` with `extractQuote(text)` function
- System prompt with Tikoki context, JSON schema instruction, caching enabled
- Return `QuoteInput` object (see DATA.md)
- Log parsed result to console; reply with JSON summary to Slack
- **Commit**: `feat: stage 2 - claude quote parsing`

### Stage 3 — PDF Generation
- Implement `lib/pdf.js` with `generatePdf(quote)` function
- Build `templates/quote.html` with full Tikoki branding
- Implement `lib/quote.js`: `buildQuote()`, VAT calc, label maps, slug util
- Reply with PDF attached directly to Slack (no Drive yet)
- **Commit**: `feat: stage 3 - pdf generation`

### Stage 4 — Persistent Memory + Edit Commands
- Implement `lib/redis.js`: `getQuote(userId)`, `setQuote(userId, quote)`, `nextQuoteNumber()`
- Store built quote in Redis after generation
- Detect edit commands; implement `lib/claude.js:editQuote(quote, command)`
- Increment file version on edit; regenerate PDF
- **Commit**: `feat: stage 4 - redis memory and quote editing`

### Stage 5 — Excel Input
- Implement `lib/excel.js`: download Slack file, parse with `xlsx`, normalize rows
- Pass normalized text to same Claude extraction flow
- Handle malformed Excel gracefully (ask user for correction)
- **Commit**: `feat: stage 5 - excel file input`

### Stage 6 — Images + Google Drive
- Implement `lib/drive.js`: `uploadPdf()`, `listImages()`, `fetchImage(filename)`
- Integrate product image fetching into PDF template (Fotodokumentacia pages)
- Save every generated PDF to Drive; return shareable link in Slack reply
- **Commit**: `feat: stage 6 - google drive and product images`

### Stage 7 — Robustness
- Add `dedup:{event_id}` Redis check at top of handler
- Wrap all external calls in `retry(fn, 3)` helper
- Unknown image → reply with `listImages()` result
- Missing fields → ask user specifically what is missing
- Verify quote counter initializes correctly on first run
- **Commit**: `feat: stage 7 - robustness and error handling`

---

## 6. Security Considerations

- Never log full Slack payloads (may contain user data)
- Service account key stored as env var, never committed
- Slack signing secret verified on every request
- Redis keys namespaced (`quote:`, `dedup:`) to avoid collisions
- Google Drive files set to `reader` (not editor) for anyone-with-link
