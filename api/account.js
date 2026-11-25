// One function for all account actions (keeps the deployment within Vercel's function limit).
// vercel.json rewrites /api/signup, /api/login, /api/logout, /api/me, /api/plan and /api/profile here.
import signup from './_account/signup.js';
import login from './_account/login.js';
import logout from './_account/logout.js';
import me from './_account/me.js';
import plan from './_account/plan.js';
import profile from './_account/profile.js';

const ACTIONS = { signup, login, logout, me, plan, profile };

export default function handler(req, res) {
  const fn = ACTIONS[String(req.query?.action || '')];
  if (!fn) { res.setHeader('Cache-Control', 'no-store'); return res.status(404).json({ error: 'Not found' }); }
  return fn(req, res);
}
