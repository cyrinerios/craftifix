// Shared helpers for the CrochetHub account API.
// Files starting with "_" are not exposed as routes by Vercel.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { put, head, BlobNotFoundError } from '@vercel/blob';

const scrypt = promisify(crypto.scrypt);
const SECRET = process.env.AUTH_SECRET || '';
const COOKIE = 'ch_session';
const SESSION_DAYS = 7;

export const PLANS = {
  starter: {
    id: 'starter', name: 'Starter', price: 29,
    limits: { products: 20, quotationsPerMonth: 10, invoicesPerMonth: 10, staff: 0 },
    features: { dashboard: 'Basic', pricingCalculator: 'Basic', onlineStore: 'Basic', customers: 'Basic', inventory: 'Limited', salesReports: 'Basic', productionTracking: 'No', staffAccounts: 'No' }
  },
  professional: {
    id: 'professional', name: 'Professional', price: 59,
    limits: { products: null, quotationsPerMonth: null, invoicesPerMonth: null, staff: 0 },
    features: { dashboard: 'Advanced', pricingCalculator: 'Advanced', onlineStore: 'Customizable', customers: 'Full', inventory: 'Full', salesReports: 'Full', productionTracking: 'Basic', staffAccounts: 'No' }
  },
  business: {
    id: 'business', name: 'Business', price: 99,
    limits: { products: null, quotationsPerMonth: null, invoicesPerMonth: null, staff: null },
    features: { dashboard: 'Advanced', pricingCalculator: 'Advanced', onlineStore: 'Customizable', customers: 'Full', inventory: 'Advanced', salesReports: 'Advanced', productionTracking: 'Full', staffAccounts: 'Multiple' }
  }
};

export function assertConfigured() {
  if (!SECRET || SECRET.length < 32) throw new Error('AUTH_SECRET is not configured');
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('BLOB_READ_WRITE_TOKEN is not configured');
}

/* ---------- validation ---------- */
export const normId = (v) => String(v || '').trim().toLowerCase();
export const validId = (v) => /^[a-z0-9][a-z0-9._-]{2,19}$/.test(v);
export const validEmail = (v) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(v);
export const clean = (v, max = 80) => String(v || '').trim().slice(0, max);

/* ---------- passwords ---------- */
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
  const [alg, s, k] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !s || !k) return false;
  const expected = Buffer.from(k, 'base64');
  const got = await scrypt(pw, Buffer.from(s, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, got);
}

/* ---------- encrypted record storage (Vercel Blob) ---------- */
const encKey = () => crypto.createHash('sha256').update('crochethub-records:' + SECRET).digest();
const pathFor = (uid) => 'users/' + crypto.createHmac('sha256', SECRET).update(uid).digest('hex') + '.json';

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') });
}
function decrypt(text) {
  const { iv, tag, data } = JSON.parse(text);
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8'));
}

export async function getUser(uid) {
  let meta;
  try { meta = await head(pathFor(uid)); }
  catch (e) { if (e instanceof BlobNotFoundError || e?.name === 'BlobNotFoundError') return null; throw e; }
  const r = await fetch(meta.url + '?v=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) return null;
  return decrypt(await r.text());
}

export async function saveUser(rec, { create = false } = {}) {
  await put(pathFor(rec.userId), encrypt(rec), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: !create,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
}

export function publicUser(rec) {
  const { passwordHash, ...rest } = rec;
  return { ...rest, planDetails: PLANS[rec.plan] || PLANS.starter };
}

/* ---------- sessions (HMAC-signed cookie) ---------- */
const b64u = (b) => Buffer.from(b).toString('base64url');
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');

export function setSession(res, uid) {
  const payload = b64u(JSON.stringify({ u: uid, exp: Date.now() + SESSION_DAYS * 864e5 }));
  const token = payload + '.' + sign(payload);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
}
export function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}
export function readSession(req) {
  const raw = String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [payload, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!payload || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(sign(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return exp > Date.now() ? u : null;
  } catch { return null; }
}

/* ---------- request helpers ---------- */
export function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}
export function send(res, status, data) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(data);
}
export function onlyMethod(req, res, method) {
  if (req.method !== method) { res.setHeader('Allow', method); send(res, 405, { error: 'Method not allowed' }); return false; }
  return true;
}
export function fail(res, e) {
  console.error(e);
  send(res, 500, { error: 'Something went wrong on our side. Please try again.' });
}
