# CrochetHub

Marketing website for **CrochetHub** — the subscription business platform for crocheters and handmade makers (storefront, pricing calculator, quotations, invoices, orders, inventory and reports).

The site is a single self-contained `index.html` (no build step). It includes a working crochet pricing calculator, a dashboard preview, plans (Standard AED 10, Premium AED 30) and a sign-up form preview.

## Deploy
Connected to Vercel: every push to `main` deploys automatically.

## Run locally
Open `index.html` in a browser.

## Accounts
- Sign up on the homepage with name, business, email, **user ID**, **password** and a **plan** (Standard / Premium). Payment is skipped for now; the plan is active straight away.
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

## Google Apps Script (Gmail email + live Google Sheet)
- `apps-script/Code.gs` is pasted into the "CrochetHub database" Google Sheet (Extensions → Apps Script) and deployed as a Web app (Execute as: Me, Who has access: Anyone).
- Vercel env vars: `APPS_SCRIPT_URL` (the web app URL) and `APPS_SCRIPT_SECRET` (must match `SECRET` in the script).
- With these set, products and account details (sign-up, Settings, plan changes) are kept in the Products and Accounts tabs, new orders and custom inquiries are emailed to the shop owner and status updates to the customer from the owner's Gmail, and every order, inquiry (with photo previews in the Inquiries tab) and status change is written to the sheet. Without them, email falls back to Resend if configured.

## Automatic WhatsApp order alerts to the shop owner (CallMeBot)
- Each owner can connect the free CallMeBot service (Account → Edit details → CallMeBot API key). New orders are then sent automatically to the owner's own WhatsApp number, with no tap needed. "Send test" checks it.
- To get a key: save the bot number shown on callmebot.com, send it "I allow callmebot to send me messages" from the shop's WhatsApp, and paste the key it replies with.
- CallMeBot only messages the key owner's own number, so customer status updates still open WhatsApp pre-filled for the owner to send.

## Order tracking
- Shop page → **Track order**: customers enter their order number and the email or WhatsApp number used on the order, and see the status timeline (Order received → Confirmed → Being handmade → Ready for delivery → Completed, or Cancelled), items, total and a WhatsApp button to ask the shop.
- Direct link: `shop.html?u=<userId>&track=<orderNo>`. It is shown after ordering and included in every status update message to the customer.
- API: `POST /api/track { shop, orderNo, contact }`; the contact must match the order.

## Custom inquiries with inspiration photos
- Shop page → **Custom inquiry** page (shop.html?u=<userId>#inquiry, separate from the product listing): customers describe what they want, add up to two inspiration photos with notes (Option 1 and Option 2), optional budget and date, and their name, email, WhatsApp and delivery address. When converting to an order, the address is filled in from the inquiry, or from the customer's latest order (matched by email or WhatsApp).
- The inquiry is saved to the owner's account (Account → Custom inquiries: photos, notes, Reply on WhatsApp / Reply by email, status, delete), emailed to the owner with the photos, and sent to the owner's WhatsApp with photo links when CallMeBot alerts are on.
- API: `POST /api/inquiry` (public; photos resized in the browser, stored in Vercel Blob), `GET/PUT/DELETE /api/inquiries` (owner).

## Inquiry replies and converting inquiries to orders
- Account → Custom inquiries: **Send reply** with an optional quoted price and ready-by date. The reply is emailed to the customer and WhatsApp opens with it ready to send; the reply history is kept on the inquiry; status becomes Replied, or Quoted when a price is given.
- Statuses: New, Replied, Quoted, Customer accepted, Converted to order, Closed.
- **Convert to order** (once the customer confirms): item, qty, agreed price, delivery address and notes. Creates a Confirmed order (tagged "Custom · IQ-…") in Orders, marks the inquiry Converted with the order number, sends the customer the confirmation with a tracking link, and records both in the Google Sheet (Inquiries tab: Last reply, Quoted price, Order no.).
- API: `POST /api/inquiries?id=&action=reply`, `POST /api/inquiries?id=&action=convert`.

## Business logo and social links
- Sign-up (optional): business logo upload and Instagram, Facebook and TikTok links (a full link or just the @username). Existing owners add or change them in Settings → Edit details.
- The logo becomes the shop's icon (header circle, browser tab icon and home-screen icon); the social links show as icons under the shop name.

## Shop currency
- Chosen at sign-up (default AED; GCC currencies, USD, EUR, GBP, PHP, INR, PKR, EGP and more) and changeable in Settings → Edit details.
- Used everywhere in that owner's shop: product prices and the pricing calculator, the shop, cart, orders, tracking, inquiries and quotes, emails, WhatsApp messages and analytics. Changing it relabels existing prices; it does not convert them. CrochetHub subscription prices stay in AED.
