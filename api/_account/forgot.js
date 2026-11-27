import { assertConfigured, getUser, saveUser, findUsersByEmail, makeResetToken, deliver, escHtml, body, send, onlyMethod, fail } from '../_lib.js';

// POST /api/forgot-password { login }  — login is a user ID or the account email.
// Always answers the same way, so nobody can use it to find out which accounts exist.
const OK = { ok: true, message: 'If an account matches, we’ve sent a reset link to its email. It works for 1 hour.' };

export default async function handler(req, res) {
  if (!onlyMethod(req, res, 'POST')) return;
  try {
    assertConfigured();
    const login = String(body(req).login || '').trim();
    if (!login || login.length > 200) return send(res, 400, { error: 'Enter your user ID or email.' });
    const recs = login.includes('@') ? await findUsersByEmail(login) : [await getUser(login.toLowerCase())].filter(Boolean);
    const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
    for (const rec of recs.slice(0, 5)) {
      if (!rec.email) continue;
      // At most one email every 2 minutes per account.
      if (rec.resetSentAt && Date.now() - Date.parse(rec.resetSentAt) < 120e3) continue;
      const link = `${origin}/account.html?reset=${encodeURIComponent(makeResetToken(rec))}`;
      const name = rec.name || rec.business || rec.userId;
      await deliver({
        action: 'password_reset',
        email: {
          to: rec.email, fromName: 'Craftifix',
          subject: 'Reset your Craftifix password',
          text: `Hi ${name},\n\nWe got a request to reset the password for your Craftifix account (user ID: ${rec.userId}).\n\nReset it here (the link works for 1 hour and only once):\n${link}\n\nIf you didn't ask for this, ignore this email — your password stays the same.\n\nCraftifix`,
          html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#2a1430;max-width:520px">
<p>Hi ${escHtml(name)},</p>
<p>We got a request to reset the password for your Craftifix account (user ID: <b>${escHtml(rec.userId)}</b>).</p>
<p><a href="${escHtml(link)}" style="display:inline-block;background:#4a1d4f;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:bold">Reset my password</a></p>
<p style="color:#6d5670;font-size:13px">The link works for 1 hour and only once. If the button doesn't work, copy this link into your browser:<br>${escHtml(link)}</p>
<p style="color:#6d5670;font-size:13px">If you didn't ask for this, ignore this email — your password stays the same.</p>
<p>Craftifix</p></div>`
        }
      });
      rec.resetSentAt = new Date().toISOString();
      await saveUser(rec);
    }
    send(res, 200, OK);
  } catch (e) { fail(res, e); }
}
