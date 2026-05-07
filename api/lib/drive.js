import { google } from 'googleapis';
import { Readable } from 'stream';

// Vercel (and other platforms) can store private keys in several broken forms:
//   - literal \n  (most common — pasted from a JSON file or typed manually)
//   - double-escaped \\n  (some CLI tools escape twice)
//   - surrounding quotes  (copy-paste artefact)
//   - CRLF line endings  (Windows editors)
// We normalise all of these before handing the key to the JWT client.
function formatPrivateKey(raw) {
  if (!raw) return null;
  return raw
    .trim()
    .replace(/^["']|["']$/g, '')   // strip accidental surrounding quotes
    .replace(/\\\\n/g, '\n')        // double-escaped \\n → real newline (must come first)
    .replace(/\\n/g, '\n')          // single-escaped \n  → real newline
    .replace(/\r\n/g, '\n');        // CRLF → LF
}

function getAuthClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = formatPrivateKey(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);

  if (!email || !key) {
    throw new Error(
      'Google service account credentials not configured — set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY env vars.'
    );
  }

  // Diagnostic log — shows enough to confirm the key is well-formed without leaking it
  const newlineCount = (key.match(/\n/g) ?? []).length;
  console.log('[drive.auth] email:', email);
  console.log('[drive.auth] key length:', key.length, '| newlines:', newlineCount, '| starts:', key.slice(0, 27));

  if (!key.includes('-----BEGIN')) {
    throw new Error(
      `Private key is malformed — PEM header not found after formatting. ` +
      `Raw value starts with: "${(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ?? '').slice(0, 40)}"`
    );
  }

  return new google.auth.JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
}

// ── PDF upload ────────────────────────────────────────────────────────────────

export async function uploadPdfToDrive(pdfBuffer, filename) {
  let auth, drive;
  try {
    auth = getAuthClient();
    drive = google.drive({ version: 'v3', auth });
  } catch (err) {
    console.error('[drive.upload] auth setup failed:', err.message);
    throw err;
  }

  console.log('[drive.upload] uploading', filename, pdfBuffer.length, 'bytes to folder:', process.env.GOOGLE_DRIVE_FOLDER_ID);

  let file;
  try {
    const res = await drive.files.create({
      requestBody: {
        name: filename,
        parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
      },
      media: {
        mimeType: 'application/pdf',
        body: Readable.from(pdfBuffer),
      },
      fields: 'id,webViewLink',
    });
    file = res.data;
  } catch (err) {
    const detail = err.response?.data?.error ?? err.message;
    console.error('[drive.upload] files.create failed:', JSON.stringify(detail));
    throw new Error(`Drive files.create: ${JSON.stringify(detail)}`);
  }

  try {
    await drive.permissions.create({
      fileId: file.id,
      requestBody: { role: 'reader', type: 'anyone' },
    });
  } catch (err) {
    const detail = err.response?.data?.error ?? err.message;
    console.error('[drive.upload] permissions.create failed:', JSON.stringify(detail));
    // Non-fatal — file is uploaded, just not publicly shared
  }

  console.log('[drive.upload] done, fileId:', file.id);
  return { fileId: file.id, driveLink: file.webViewLink };
}

// ── Image helpers ─────────────────────────────────────────────────────────────

function getImagesFolderId() {
  const id = process.env.GOOGLE_DRIVE_IMAGES_FOLDER_ID;
  if (!id) throw new Error('GOOGLE_DRIVE_IMAGES_FOLDER_ID env var not set');
  return id;
}

export async function listImages() {
  const auth = getAuthClient();
  const drive = google.drive({ version: 'v3', auth });
  const folderId = getImagesFolderId();

  const { data } = await drive.files.list({
    q: `'${folderId}' in parents and mimeType contains 'image/' and trashed=false`,
    fields: 'files(id,name,mimeType)',
    orderBy: 'name',
    pageSize: 200,
  });

  return data.files ?? [];
}

export async function fetchImageAsBase64(filename) {
  const auth = getAuthClient();
  const drive = google.drive({ version: 'v3', auth });
  const folderId = getImagesFolderId();

  // Escape single-quotes in filename for the query
  const safeName = filename.replace(/'/g, "\\'");
  const { data } = await drive.files.list({
    q: `'${folderId}' in parents and name='${safeName}' and trashed=false`,
    fields: 'files(id,name,mimeType)',
  });

  if (!data.files || data.files.length === 0) {
    console.log('[drive.fetchImage] not found:', filename);
    return null;
  }

  const fileInfo = data.files[0];
  console.log('[drive.fetchImage] downloading:', fileInfo.name, fileInfo.id);

  const response = await drive.files.get(
    { fileId: fileInfo.id, alt: 'media' },
    { responseType: 'arraybuffer' }
  );

  const base64 = Buffer.from(response.data).toString('base64');
  console.log('[drive.fetchImage] fetched', base64.length, 'base64 chars');
  return { base64, mimeType: fileInfo.mimeType ?? 'image/jpeg' };
}
