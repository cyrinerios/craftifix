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
