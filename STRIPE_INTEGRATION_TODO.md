# Upstate Lax and Dyes — Stripe checkout and order notifications

This project has an embedded Stripe Checkout form and a server-side paid-order email notification. **It is not ready to accept live payments yet.** I cannot verify a live payment or email from this workspace. Complete the setup and test in Stripe test mode first.

## Values to replace

**Files containing placeholders:**
- [`.env.example`](.env.example) — copy to `.env` on your backend host and replace each placeholder.
- [`index.html`](index.html) — replace the publishable-key placeholder.

| Field | Current value | What to set |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_REPLACE_ME` | Your Stripe **test secret key** from https://dashboard.stripe.com/test/apikeys. Keep server-side only. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_REPLACE_ME` | The signing secret for the deployed `/api/stripe-webhook` endpoint from Stripe Workbench > Webhooks. |
| `SMTP_PASS` | `REPLACE_WITH_ICLOUD_APP_SPECIFIC_PASSWORD` | An Apple app-specific password for the iCloud mailbox; never use or share your normal Apple ID password. |
| `index.html` Stripe key | `pk_test_REPLACE_ME` | Your Stripe **test publishable key** from https://dashboard.stripe.com/test/apikeys. |
| `ALLOWED_ORIGIN` | `https://upstatelax.netlify.app` | The exact website origin that will call the backend. |
| `window.UPSTATE_API_BASE_URL` | empty string by default | If the backend is hosted separately from the Netlify website, edit the `window.UPSTATE_API_BASE_URL = "";` line near the top of `index.html` and set it to your backend base URL, e.g. `https://YOUR-BACKEND-DOMAIN` (no trailing slash). Leave it empty only when frontend and backend share the same origin. |

A Stripe test secret key was previously shared in chat. Rotate/revoke that key in Stripe and use a fresh one. Never commit `.env` to a public repository. Because the site owner is under 18, have a parent or guardian help with Stripe account verification and payment setup.

## Configured Checkout parameters

**File:** [`server.js`](server.js)

| Parameter | Value |
|---|---|
| `ui_mode` | `form` |
| `mode` | `payment` (one-time payment) |
| `line_items` | Server-generated product line items; custom stringing is $50.00 per selected build |
| `billing_address_collection` | `auto` |
| `phone_number_collection` | `{ enabled: false }` |
| `automatic_tax` | `{ enabled: false }` |
| `submit_type` | `auto` |
| `shipping_address_collection` | `CA`, `MX`, `US` |
| `name_collection` | Individual name enabled, optional |
| `saved_payment_method_options` | `{ payment_method_save: 'enabled' }` |
| `integration_identifier` | `custom_embedded_web_0001` |
| `payment_method_collection` | Omitted because this is a one-time `payment` session; only include it for subscription mode per the integration rules. |
| `metadata` | Store name, build count, custom-stringing build count |

The server uses Stripe API version `2026-03-25.dahlia` for the embedded form. If Stripe rejects a parameter or API version in your account, check the exact Stripe error before going live.

## How order notifications work

1. The website sends the cart and chosen stringing options to `/api/create-checkout-session`.
2. The server calculates the head and optional $50 stringing prices; it does not trust prices sent by the browser.
3. Stripe collects payment in its embedded Checkout form.
4. Stripe sends a signed event to `/api/stripe-webhook` after checkout. The server verifies the webhook signature and confirms `payment_status` is `paid`.
5. The server retrieves the paid session and emails the customer, line items, shipping details, total, and custom-stringing build count to `upstatelax@icloud.com`.

This sends an email notification; it does not create a permanent order database or admin dashboard. Keep order emails and Stripe Dashboard records until a proper order database is added. Stripe may retry webhook delivery, so duplicate notifications are possible if delivery is retried after an email was sent but before Stripe received the acknowledgement.

## Setup steps

1. Extract this ZIP and install Node.js LTS from https://nodejs.org.
2. In the project folder, run `npm install`.
3. Copy `.env.example` to `.env` and fill in the Stripe **test** secret key, SMTP settings, and allowed website origin. Do not upload `.env` to GitHub.
4. Replace `pk_test_REPLACE_ME` in `index.html` with the Stripe **test publishable** key.
5. Deploy the Node server to a host that runs Node.js and supports environment variables. **Netlify static hosting alone does not run this `server.js`.** Set `window.UPSTATE_API_BASE_URL` in `index.html` to your deployed backend base URL if it is separate from the website.
6. In Stripe Workbench > Webhooks, add `https://YOUR-BACKEND-DOMAIN/api/stripe-webhook` and subscribe to `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Put the endpoint's signing secret in `STRIPE_WEBHOOK_SECRET` on the backend host.
7. Confirm your iCloud app-specific password and mail settings. If SMTP is missing or incorrect, the webhook returns an error so Stripe can retry; order emails will not arrive until mail is configured.
8. Start locally with `npm start` and visit `http://localhost:4242` when you can. Test in Stripe test mode only.

## Test safely

- Use Stripe test mode and a test card such as `4242 4242 4242 4242`, a future expiration date, and any CVC. Never test using a real card while keys are in test mode.
- Confirm the payment appears in Stripe test mode, then check `upstatelax@icloud.com` for an email with the head and stringing choices.
- Check Stripe Workbench > Webhooks for successful deliveries. Do not switch to live keys until the entire flow is tested.

## Current product pricing note

The current server catalog has a limited allowlist of heads and prices. Review `HEAD_PRICES_CENTS` in `server.js` and match it to the final website catalog before accepting orders. Custom stringing is currently $50.00 including strings. Custom dyeing is still a request form and is not charged in this Stripe checkout.

Resources: https://docs.stripe.com, https://support.stripe.com, https://dashboard.stripe.com/test/apikeys
