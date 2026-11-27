// Shipping fees for Craftifix shops.
// Owners choose: off (fee arranged later), per km from the shop address, or per region (their own list).
// Optional: free delivery above an order amount, and free self-pickup from the shop.
// Addresses are located with OpenStreetMap (Nominatim) and road distance comes from the OSRM routing service;
// if routing is unavailable, straight-line distance × 1.3 is used and the fee is marked approximate.

const UA = 'Craftifix/1.0 (crochet shop platform; https://craftifix-app.vercel.app)';
const r2 = (v) => Math.round(v * 100) / 100;
const num = (v, max = 1e6) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : 0; };
const txt = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export const UAE_REGIONS = ['Sharjah', 'Dubai', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah', 'Abu Dhabi', 'Al Ain'];

export function defaultShipping(currency = 'AED') {
  return { mode: 'off', km: { base: 0, perKm: 0, maxKm: 0 }, regions: currency === 'AED' ? UAE_REGIONS.map((name) => ({ name, fee: null })) : [], freeOver: 0, pickup: { enabled: false, note: '' } };
}

export function cleanShipping(b = {}, currency = 'AED') {
  const d = defaultShipping(currency);
  const mode = ['off', 'km', 'region'].includes(b.mode) ? b.mode : 'off';
  const regions = (Array.isArray(b.regions) ? b.regions : d.regions).slice(0, 40)
    .map((r) => ({ name: txt(r?.name, 60), fee: r?.fee === null || r?.fee === '' || r?.fee === undefined ? null : r2(num(r.fee, 1e5)) }))
    .filter((r) => r.name);
  return {
    mode,
    km: { base: r2(num(b.km?.base, 1e5)), perKm: r2(num(b.km?.perKm, 1e4)), maxKm: Math.round(num(b.km?.maxKm, 5000)) },
    regions,
    freeOver: r2(num(b.freeOver, 1e7)),
    pickup: { enabled: !!b.pickup?.enabled, note: txt(b.pickup?.note, 160) }
  };
}

// What the shop page may show customers (no coordinates).
export function publicShipping(owner) {
  const s = owner.shipping ? cleanShipping(owner.shipping, owner.currency) : defaultShipping(owner.currency);
  return {
    mode: s.mode,
    km: s.mode === 'km' ? s.km : null,
    regions: s.mode === 'region' ? s.regions.filter((r) => r.fee !== null) : [],
    freeOver: s.freeOver,
    pickup: s.pickup.enabled ? { enabled: true, note: s.pickup.note, address: owner.shopAddress?.text || '' } : { enabled: false },
    located: !!(owner.shopAddress?.lat && owner.shopAddress?.lng)
  };
}

// ---------- maps ----------
const geoCache = new Map();
export async function geocode(address) {
  const q = txt(address, 300);
  if (q.length < 4) return null;
  if (geoCache.has(q)) return geoCache.get(q);
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    const hit = Array.isArray(j) && j[0] ? { lat: Number(j[0].lat), lng: Number(j[0].lon), label: j[0].display_name } : null;
    geoCache.set(q, hit);
    return hit;
  } catch { return null; }
}
const validLL = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
export const coords = (lat, lng) => { const a = Number(lat), b = Number(lng); return validLL(a, b) ? { lat: r2(a * 1e4) / 1e4, lng: r2(b * 1e4) / 1e4 } : null; };

function haversine(a, b) {
  const R = 6371, rad = (x) => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export async function distanceKm(from, to) {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`, { headers: { 'User-Agent': UA }, signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    const m = j?.routes?.[0]?.distance;
    if (j.code === 'Ok' && Number.isFinite(m)) return { km: Math.round(m / 100) / 10, road: true };
  } catch { /* fall back */ }
  return { km: Math.round(haversine(from, to) * 1.3 * 10) / 10, road: false };
}

// ---------- the fee ----------
// req: { method: 'delivery'|'pickup', region, address, lat, lng, subtotal }
export async function quoteShipping(owner, req = {}) {
  const s = owner.shipping ? cleanShipping(owner.shipping, owner.currency) : defaultShipping(owner.currency);
  const subtotal = num(req.subtotal, 1e8);
  if (req.method === 'pickup') {
    if (!s.pickup.enabled) return { ok: false, error: 'This shop does not offer pickup.' };
    return { ok: true, method: 'pickup', fee: 0, label: 'Self-pickup from the shop (free)' };
  }
  const free = s.freeOver > 0 && subtotal >= s.freeOver;
  if (s.mode === 'off') return { ok: true, method: 'delivery', fee: 0, pending: true, label: 'Delivery fee to be confirmed by the shop' };

  if (s.mode === 'region') {
    const name = txt(req.region, 60);
    const reg = s.regions.find((r) => r.fee !== null && r.name.toLowerCase() === name.toLowerCase());
    if (!reg) return { ok: false, error: 'Please choose your delivery area.', field: 'region' };
    const fee = free ? 0 : reg.fee;
    return { ok: true, method: 'delivery', fee, region: reg.name, free, label: free ? `Free delivery to ${reg.name}` : `Delivery to ${reg.name}` };
  }

  // per km
  const shop = owner.shopAddress;
  if (!shop?.lat || !shop?.lng) return { ok: true, method: 'delivery', fee: 0, pending: true, label: 'Delivery fee to be confirmed by the shop' };
  let to = coords(req.lat, req.lng);
  if (!to) { const g = await geocode(req.address); to = g && { lat: g.lat, lng: g.lng }; }
  if (!to) return { ok: false, error: 'We couldn’t find that address on the map. Add the area and city, or tap “Use my location”.', field: 'address' };
  const d = await distanceKm(shop, to);
  if (s.km.maxKm > 0 && d.km > s.km.maxKm) return { ok: false, error: `Sorry, this shop delivers up to ${s.km.maxKm} km and your address is about ${d.km} km away. Choose pickup or contact the shop.`, field: 'address', km: d.km };
  const fee = free ? 0 : r2(s.km.base + s.km.perKm * d.km);
  return { ok: true, method: 'delivery', fee, km: d.km, road: d.road, free, to, label: free ? `Free delivery (${d.km} km)` : `Delivery · ${d.km} km${d.road ? '' : ' (approx.)'}` };
}
