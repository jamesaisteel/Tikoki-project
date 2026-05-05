# Tikoki AI Quote Agent — Claude Code Instructions

## Project Overview

This is a Slack bot for Tikoki s.r.o., a custom sneaker manufacturer. It automates sales quote generation: salespeople send natural language or Excel input via Slack, and the agent produces a branded PDF quote, saves it to Google Drive, and replies with a link.

## Tech Stack

- **Runtime**: Node.js 20
- **Deployment**: Vercel serverless functions (`/api/*.js`)
- **Slack**: Slack Bolt SDK (`@slack/bolt`) or raw HTTP event handling
- **AI**: Claude API via `@anthropic-ai/sdk` — model `claude-sonnet-4-20250514`
- **PDF**: `puppeteer-core` + `@sparticuz/chromium` (Vercel-compatible headless Chrome)
- **Storage**: Upstash Redis (`@upstash/redis`) — quote state, dedup, counter
- **Google Drive**: `googleapis` — save PDFs, fetch product images
- **Excel parsing**: `xlsx` package

## Repository Layout

```
/api
  slack.js          # Slack event webhook entry point (Vercel function)
  /lib
    claude.js       # Claude API calls (parse input, edit quotes)
    pdf.js          # Puppeteer PDF generation
    redis.js        # Upstash Redis helpers
    drive.js        # Google Drive upload/fetch helpers
    quote.js        # Quote business logic (VAT, numbering, formatting)
    excel.js        # Excel file parsing
/templates
  quote.html        # Puppeteer HTML template (Tikoki branding)
/assets
  logo.png          # Tikoki logo (embedded as base64 in template)
CLAUDE.md
SPEC.md
DATA.md
package.json
vercel.json
.env.example
```

## Environment Variables

```
SLACK_BOT_TOKEN
SLACK_SIGNING_SECRET
ANTHROPIC_API_KEY
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
GOOGLE_SERVICE_ACCOUNT_EMAIL
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
GOOGLE_DRIVE_FOLDER_ID        # TiKoki-Ponuky/ folder ID
```

## Development Stages

Work through these in order. After each stage, commit and push — Vercel auto-deploys.

1. **Basic Slack integration** — receive events, verify signature, echo reply
2. **Claude parsing** — extract structured JSON (customer, items, prices) from message
3. **PDF generation** — Puppeteer with Tikoki HTML template, VAT 23%, multilingual
4. **Persistent memory** — Redis stores last quote per Slack user, editable via short commands
5. **Excel input** — parse `.xlsx` attachments the same way as text
6. **Images + Drive** — Fotodokumentacia pages from Drive, save final PDF to Drive
7. **Robustness** — Slack dedup, retry 3x, quote numbering, error messages

## Key Conventions

- All monetary values stored as integers in euro cents internally; display as `€X.XX`
- VAT rate constant `VAT_RATE = 0.23` in `lib/quote.js`
- Quote numbers: 4-digit zero-padded, stored in Redis key `quote:counter`
- File naming: `NNNN-ClientName-v1.pdf` (increment `vN` on edits to same quote)
- Language detection: Claude infers SK/CZ/EN from customer name or salesperson instruction
- Redis TTL: quote state 24 h (`86400`), dedup event IDs 60 s (`60`)
- Slack dedup: check `dedup:{event_id}` in Redis before processing; set with TTL 60 s

## Claude API Usage

- Always use `claude-sonnet-4-20250514`
- Use prompt caching (`cache_control`) on the system prompt to reduce cost
- Extraction call returns JSON only — set `temperature: 0`
- Edit call receives current quote JSON + user command, returns updated quote JSON

## PDF Template Requirements

- Tikoki logo top-left, company details top-right
- Customer name, address block
- Line-item table: product name | image thumbnail | qty | unit price | line total
- Subtotal, VAT 23%, **Total** row
- Fotodokumentacia section: full-width product images with captions
- Footer: quote number, date, validity (30 days), salesperson name
- Colors: Tikoki brand palette (confirm with `assets/brand.json` once provided)

## Error Handling Rules

- Retry any external API call (Claude, Drive, Redis) up to 3 times with exponential backoff
- If a product image is not found in Drive, reply with list of available image names
- If required fields are missing after Claude parse, ask the user for the missing info instead of failing
- Wrap every Vercel function in try/catch; always return HTTP 200 to Slack (even on error) to prevent retries, then send error message to the Slack channel

## Testing

- Use `ngrok` or `vercel dev` for local Slack webhook testing
- Keep a `test/` directory with sample inputs: plain text, Excel file, edit commands
- Unit test `lib/quote.js` (VAT calc, numbering, formatting) with Jest
