import { assertConfigured, getUser, saveUser, hashPassword, readResetToken, resetTokenMatches, setSession, deliver, body, send, onlyMethod, fail } from '../_lib.js';

// POST /api/reset-password { token, password }  — sets a new password from an emailed link, then logs the owner in.
// POST { token, check: true } only checks the link (so the page can say early if it has expired).
export default async function handler(req, res) {
  if (!onlyMethod(req, res, 'POST')) return;
  try {
    assertConfigured();
    const b = body(req);
    const t = readResetToken(b.token);
    const expiredMsg = 'This reset link has expired or was already used. Ask for a new one from the login page.';
    if (!t || t.expired) return send(res, 400, { error: expiredMsg, expired: true });
    const rec = await getUser(t.u);
    if (!resetTokenMatches(t, rec)) return send(res, 400, { error: expiredMsg, expired: true });
    if (b.check) return send(res, 200, { ok: true, userId: rec.userId });

    const password = String(b.password || '');
    if (password.length < 8 || password.length > 128) return send(res, 400, { error: 'Password must be at least 8 characters.' });
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return send(res, 400, { error: 'Password needs at least one letter and one number.' });

    rec.passwordHash = await hashPassword(password);
    rec.passwordChangedAt = new Date().toISOString();
    delete rec.resetSentAt;
    rec.updatedAt = rec.passwordChangedAt;
    await saveUser(rec);
    setSession(res, rec.userId);
    if (rec.email) {
      await deliver({ action: 'password_changed', email: { to: rec.email, fromName: 'Craftifix', subject: 'Your Craftifix password was changed',
        text: `Hi ${rec.name || rec.userId},\n\nThe password for your Craftifix account (user ID: ${rec.userId}) was just changed.\n\nIf this wasn't you, reset it again right away from the login page and reply to this email.\n\nCraftifix` } });
    }
    send(res, 200, { ok: true, userId: rec.userId });
  } catch (e) { fail(res, e); }
}
