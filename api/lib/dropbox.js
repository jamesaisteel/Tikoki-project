const FOLDER = '/TiKoki-Ponuky';

export async function uploadPdfToDropbox(buffer, filename) {
  const token = process.env.DROPBOX_ACCESS_TOKEN;
  if (!token) throw new Error('DROPBOX_ACCESS_TOKEN env var not set');

  const path = `${FOLDER}/${filename}`;

  // Step 1 — upload the file
  console.log('[dropbox.upload] uploading', filename, buffer.length, 'bytes to', path);
  const uploadRes = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path, mode: 'add', autorename: true }),
      'Content-Type': 'application/octet-stream',
    },
    body: buffer,
  });

  if (!uploadRes.ok) {
    const text = await uploadRes.text().catch(() => '');
    throw new Error(`Dropbox upload HTTP ${uploadRes.status}: ${text.slice(0, 200)}`);
  }

  const uploadData = await uploadRes.json();
  const uploadedPath = uploadData.path_lower;
  console.log('[dropbox.upload] uploaded ok, path:', uploadedPath);

  // Step 2 — create a public shared link
  const linkRes = await fetch('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      path: uploadedPath,
      settings: { requested_visibility: 'public' },
    }),
  });

  if (!linkRes.ok) {
    const errData = await linkRes.json().catch(() => ({}));
    const summary = errData?.error_summary ?? '';

    // Dropbox returns this error when a shared link already exists for the path
    if (summary.startsWith('shared_link_already_exists')) {
      const existingUrl = errData?.error?.['.tag'] === 'shared_link_already_exists'
        ? errData.error?.metadata?.url
        : null;
      if (existingUrl) {
        console.log('[dropbox.share] shared link already exists:', existingUrl);
        return existingUrl;
      }
    }

    throw new Error(`Dropbox sharing HTTP ${linkRes.status}: ${summary || JSON.stringify(errData).slice(0, 200)}`);
  }

  const linkData = await linkRes.json();
  console.log('[dropbox.share] shared link:', linkData.url);
  return linkData.url;
}
