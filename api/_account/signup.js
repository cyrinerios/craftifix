import { stripeEnabled } from '../_stripe.js';
import { geocode, coords, defaultShipping } from '../_shipping.js';
import { PLANS, BASE_CURRENCY, trialEndFrom, pricingFor, assertConfigured, normId, validId, validEmail, clean, normWhatsApp, normSocial, validCurrency, uploadImage, hashPassword, getUser, saveUser, publicUser, setSession, body, send, onlyMethod, fail , syncAccount } from '../_lib.js';

export default async function handler(req, res) {
  if (!onlyMethod(req, res, 'POST')) return;
  try {
    assertConfigured();
    const b = body(req);
    const userId = normId(b.userId);
    const password = String(b.password || '');
    const name = clean(b.name);
    const business = clean(b.business);
    const email = clean(b.email, 254).toLowerCase();
    // New shops don't pick a plan at sign-up: the free trial unlocks everything (Premium), and the owner chooses
    // Standard or Premium in the last week of the trial. Without Stripe (no trial) a sent plan is used, else Standard.
    const plan = stripeEnabled() ? 'premium' : (PLANS[String(b.plan || '').toLowerCase()] ? String(b.plan).toLowerCase() : 'standard');
    const whatsapp = normWhatsApp(b.whatsapp);
    const shopAddressText = clean(b.shopAddress, 300);
    const currency = validCurrency(b.currency || 'AED');
    if (!currency) return send(res, 400, { error: 'Please choose your shop currency.', field: 'currency' });
    const social = {};
    for (const k of ['instagram', 'facebook', 'tiktok']) {
      const v = normSocial(k, b[k]);
      if (v === null) return send(res, 400, { error: `That ${k === 'tiktok' ? 'TikTok' : k[0].toUpperCase() + k.slice(1)} link doesn't look right. Paste your profile link or just your username.`, field: k });
      if (v) social[k] = v;
    }

    if (!validId(userId)) return send(res, 400, { error: 'User ID must be 3–20 characters: letters, numbers, dot, dash or underscore, starting with a letter or number.', field: 'userId' });
    if (password.length < 8 || password.length > 128) return send(res, 400, { error: 'Password must be at least 8 characters.', field: 'password' });
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return send(res, 400, { error: 'Password needs at least one letter and one number.', field: 'password' });
    if (!name) return send(res, 400, { error: 'Please enter your name.', field: 'name' });
    if (!business) return send(res, 400, { error: 'Please enter your business name.', field: 'business' });
    if (!validEmail(email)) return send(res, 400, { error: 'Please enter a valid email address.', field: 'email' });
    if (!whatsapp) return send(res, 400, { error: 'Please enter a valid WhatsApp number with country code, e.g. +971 55 123 4567.', field: 'whatsapp' });
    if (shopAddressText.length < 10) return send(res, 400, { error: 'Please enter your full shop address (building, street, area, city).', field: 'shopAddress' });

    if (await getUser(userId)) return send(res, 409, { error: 'That user ID is already taken. Please choose another.', field: 'userId' });

    const now = new Date().toISOString();
    const pricing = await pricingFor(currency);
    const pin = coords(b.shopLat, b.shopLng) || await geocode(shopAddressText);
    const rec = {
      userId, name, business, email, whatsapp, plan, social, currency,
      shopAddress: { text: shopAddressText, ...(pin ? { lat: pin.lat, lng: pin.lng } : {}) },
      shipping: defaultShipping(currency),
      passwordHash: await hashPassword(password),
      // With Stripe set up, every new shop starts on a 30-day free trial — no card needed. Billing details are
      // asked for when the trial ends (or earlier if the owner chooses). Without Stripe, payment is skipped.
      subscription: stripeEnabled()
        ? { status: 'trial', billing: 'monthly', provider: 'stripe', paymentStatus: 'trial', startedAt: now, trialEndsAt: trialEndFrom(now), planChosen: false,
          currency: pricing.currency, amount: pricing.plans[plan].amount, basePrice: pricing.plans[plan].base, baseCurrency: BASE_CURRENCY, rate: pricing.rate }
        : { status: 'active', billing: 'monthly', paymentStatus: 'skipped', startedAt: now,
        currency: pricing.currency, amount: pricing.plans[plan].amount, basePrice: pricing.plans[plan].base, baseCurrency: BASE_CURRENCY, rate: pricing.rate },
      createdAt: now, updatedAt: now
    };
    try { await saveUser(rec, { create: true }); }
    catch (e) {
      if (/already exists/i.test(String(e?.message))) return send(res, 409, { error: 'That user ID is already taken. Please choose another.', field: 'userId' });
      throw e;
    }
    // Logo is optional; if it fails to upload the account is still created.
    if (b.logo) {
      try { rec.logo = await uploadImage(userId, b.logo); await saveUser(rec); }
      catch (e) { if (e?.status !== 400) console.error('logo upload failed', e); }
    }
    await syncAccount(rec);
    setSession(res, userId);
    send(res, 201, { user: publicUser(rec), checkoutUrl: null });
  } catch (e) { fail(res, e); }
}
