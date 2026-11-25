# CrochetHub

Marketing website for **CrochetHub** — the subscription business platform for crocheters and handmade makers (storefront, pricing calculator, quotations, invoices, orders, inventory and reports).

The site is a single self-contained `index.html` (no build step). It includes a working crochet pricing calculator, a dashboard preview, plans (Starter AED 29, Professional AED 59, Business AED 99) and a sign-up form preview.

## Deploy
Connected to Vercel: every push to `main` deploys automatically.

## Run locally
Open `index.html` in a browser.

## Accounts
- Sign up on the homepage with name, business, email, **user ID**, **password** and a **plan** (Starter / Professional / Business). Payment is skipped for now; the plan is active straight away.
- `/account.html` — log in, see account details, plan features and limits, switch plan, log out.
- API (Vercel Functions in `/api`): `POST /api/signup`, `POST /api/login`, `POST /api/logout`, `GET /api/me`, `POST /api/plan`.
- Storage: Vercel Blob store `crochethub-accounts`. Each account record is encrypted (AES-256-GCM) at an unguessable path; passwords are hashed with scrypt; sessions use an HMAC-signed HttpOnly cookie.
- Required env vars: `BLOB_READ_WRITE_TOKEN` (added by the Blob store) and `AUTH_SECRET` (random, 32+ chars).

## Products & shop
- `/products.html` (logged in): post crochet products priced with the built-in crochet pricing calculator (materials, accessories, packaging, hours × rate, overhead; markup, gross margin, hourly or wholesale + retail; rounding; optional 5% VAT). Upload a photo, set stock, production time and customisation, then publish or save as draft. Edit, duplicate, unpublish or delete. Plan limits are enforced (Starter: 20 products).
- `/shop.html?u=<userId>`: public shop showing published products and prices (never costs). Shoppers add items and send the order to the shop owner by email.
- API: `GET/POST/PUT/DELETE /api/products`, `POST /api/upload`, `GET /api/shop?u=`. Prices are recalculated on the server.

## Orders (email + WhatsApp)
- Shop customers fill in name, email, WhatsApp number and delivery address, then **Send order**.
- The order is saved to the owner's account (Account page → Orders from your shop, with status updates), emailed to the owner, and WhatsApp opens on the customer's phone with the order addressed to the owner's WhatsApp number (customer taps send).
- WhatsApp number is required at sign-up and editable on the Account page.
- **Email sending** uses [Resend](https://resend.com). Set `RESEND_API_KEY` and `EMAIL_FROM` (e.g. `CrochetHub Orders <orders@yourdomain.com>`, on a domain verified in Resend) in Vercel → Project → Settings → Environment Variables, then redeploy. Without them, orders are still saved and sent by WhatsApp, and the customer is offered an "Also send by email" button instead.

## Customer status updates
- On Account → Orders, changing an order's status (Confirmed, In production, Ready for delivery, Completed, Cancelled) notifies the customer:
  - **Email** to the customer (reply-to = owner's email) when Resend is configured; otherwise a "Send email" button opens a pre-filled email.
  - **WhatsApp**: a new tab opens WhatsApp (app or WhatsApp Web, signed in as the owner's registered number) with the status message to the customer pre-filled; the owner taps send.
- "Send update to customer" re-sends the current status. Each update is recorded in the order's history.
