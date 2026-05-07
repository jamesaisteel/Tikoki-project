import { google } from 'googleapis';

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

// Drive PDF upload is disabled — service accounts cannot upload to regular Gmail Drive
// folders without Google Workspace. Re-enable when a Workspace account is available.
// eslint-disable-next-line no-unused-vars
/* export async function uploadPdfToDrive(pdfBuffer, filename) {
  let auth;
  try {
    auth = getAuthClient();
  } catch (err) {
    console.error('[drive.upload] auth setup failed:', err.message);
    throw err;
  }

  // Obtain a short-lived OAuth2 access token from the JWT client
  const { token } = await auth.getAccessToken();
  if (!token) throw new Error('Drive auth: failed to obtain access token');

  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  console.log('[drive.upload] uploading', filename, pdfBuffer.length, 'bytes to folder:', folderId);

  // Build a multipart/related body — two parts: JSON metadata + binary PDF.
  // We use a direct fetch instead of the googleapis client because the client
  // routes the upload through the service account's own Drive root when the
  // googleapis stream wrapper is involved, triggering "storage quota" errors
  // even when supportsAllDrives is set. A raw HTTP upload with the parent
  // folder ID in the metadata is unambiguous.
  const boundary = '-------tikoki_upload_boundary';
  const metadata = JSON.stringify({
    name: filename,
    parents: [folderId],
    mimeType: 'application/pdf',
  });

  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
      `--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`
    ),
    pdfBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const uploadUrl = new URL('https://www.googleapis.com/upload/drive/v3/files');
  uploadUrl.searchParams.set('uploadType', 'multipart');
  uploadUrl.searchParams.set('supportsAllDrives', 'true');
  uploadUrl.searchParams.set('fields', 'id,webViewLink');

  const uploadRes = await fetch(uploadUrl.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  });

  const uploadData = await uploadRes.json();
  if (!uploadRes.ok) {
    console.error('[drive.upload] upload failed:', JSON.stringify(uploadData));
    throw new Error(`Drive upload HTTP ${uploadRes.status}: ${JSON.stringify(uploadData?.error ?? uploadData)}`);
  }

  const fileId = uploadData.id;
  const webViewLink = uploadData.webViewLink;
  console.log('[drive.upload] uploaded ok, fileId:', fileId);

  // Set anyoneWithLink reader permission via googleapis (permissions API has no upload quirks)
  try {
    const drive = google.drive({ version: 'v3', auth });
    await drive.permissions.create({
      fileId,
      supportsAllDrives: true,
      requestBody: { role: 'reader', type: 'anyone' },
    });
  } catch (err) {
    const detail = err.response?.data?.error ?? err.message;
    console.error('[drive.upload] permissions.create failed (non-fatal):', JSON.stringify(detail));
  }

  return { fileId, driveLink: webViewLink };
} */

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
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
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
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
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
    { fileId: fileInfo.id, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' }
  );

  const base64 = Buffer.from(response.data).toString('base64');
  console.log('[drive.fetchImage] fetched', base64.length, 'base64 chars');
  return { base64, mimeType: fileInfo.mimeType ?? 'image/jpeg' };
}
