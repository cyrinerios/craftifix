import { clearSession, send, onlyMethod } from '../_lib.js';

export default function handler(req, res) {
  if (!onlyMethod(req, res, 'POST')) return;
  clearSession(res);
  send(res, 200, { ok: true });
}
