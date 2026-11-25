import { assertConfigured, requireUser, uploadImage, body, send, onlyMethod, fail } from './_lib.js';

// POST /api/upload { dataUrl } -> { url }  (product photo, resized in the browser first)
export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

export default async function handler(req, res) {
  if (!onlyMethod(req, res, 'POST')) return;
  try {
    assertConfigured();
    const uid = requireUser(req, res); if (!uid) return;
    const url = await uploadImage(uid, body(req).dataUrl);
    send(res, 201, { url });
  } catch (e) {
    if (e?.status === 400) return send(res, 400, { error: e.message });
    fail(res, e);
  }
}
