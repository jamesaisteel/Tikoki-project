import { google } from 'googleapis';
import { Readable } from 'stream';

function getAuthClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  // Env vars store literal \n — replace with real newlines for the PEM key
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Google service account credentials not configured (GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY)');

  return new google.auth.JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
}

// ── PDF upload ────────────────────────────────────────────────────────────────

export async function uploadPdfToDrive(pdfBuffer, filename) {
  const auth = getAuthClient();
  const drive = google.drive({ version: 'v3', auth });

  console.log('[drive.upload] uploading', filename, pdfBuffer.length, 'bytes');

  const { data: file } = await drive.files.create({
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

  // Make readable by anyone with the link (read-only)
  await drive.permissions.create({
    fileId: file.id,
    requestBody: { role: 'reader', type: 'anyone' },
  });

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
