export const VAT_RATE = 0.23;

export function buildQuote(quoteInput, slackUserId) {
  const now = new Date();
  const validUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const items = quoteInput.items.map((item, i) => ({
    index: i + 1,
    productName: item.productName,
    quantity: item.quantity,
    unitPriceEurCents: item.unitPriceEurCents,
    lineTotalCents: item.quantity * item.unitPriceEurCents,
    imageFilename: item.imageFilename ?? null,
    imageAvailable: false,
  }));

  const subtotalCents = items.reduce((sum, item) => sum + item.lineTotalCents, 0);
  const vatCents = Math.round(subtotalCents * VAT_RATE);
  const totalCents = subtotalCents + vatCents;

  // Stage 3: hardcoded quote number — replaced by Redis INCR in Stage 4
  const quoteNumber = '0001';
  const slug = slugify(quoteInput.customerName);

  return {
    quoteNumber,
    version: 1,
    language: quoteInput.language ?? 'sk',
    createdAt: now.toISOString(),
    validUntil: validUntil.toISOString(),
    customer: {
      name: quoteInput.customerName,
      address: quoteInput.customerAddress ?? null,
    },
    salesPerson: {
      name: quoteInput.salesPersonName ?? 'Tikoki',
      slackUserId,
    },
    items,
    subtotalCents,
    vatCents,
    totalCents,
    filename: `${quoteNumber}-${slug}-v1.pdf`,
    slackUserId,
    notes: quoteInput.notes ?? null,
  };
}

export function centsToEur(cents) {
  const eur = (cents / 100).toFixed(2);
  const [int, dec] = eur.split('.');
  return `€${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`;
}

export function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
}

export function formatDate(isoString) {
  const d = new Date(isoString);
  return `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}`;
}
