require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');

const secretKey = process.env.STRIPE_SECRET_KEY;
if (!secretKey) {
  console.error('Missing STRIPE_SECRET_KEY. Copy .env.example to .env and add your Stripe TEST secret key.');
  process.exit(1);
}

const stripe = new Stripe(secretKey, { apiVersion: '2026-03-25.dahlia' });
const app = express();

// Permit the separately hosted Netlify frontend to call this API when ALLOWED_ORIGIN is set.
app.use((req, res, next) => {
  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  if (allowedOrigin && req.headers.origin === allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Stripe-Signature');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Stripe webhooks need the original raw request body for signature verification.
app.post('/api/stripe-webhook', require('express').raw({ type: 'application/json' }), async (req, res) => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('Stripe webhook rejected: STRIPE_WEBHOOK_SECRET is not configured.');
    return res.status(500).send('Webhook is not configured.');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret);
  } catch (error) {
    console.error('Stripe webhook signature verification failed:', error.message);
    return res.status(400).send('Invalid Stripe webhook signature.');
  }

  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    return res.sendStatus(200);
  }

  try {
    const checkoutSession = event.data.object;
    // Do not send a fulfillment email until Stripe confirms the payment is paid.
    const session = await stripe.checkout.sessions.retrieve(checkoutSession.id, {
      expand: ['line_items']
    });
    if (session.payment_status !== 'paid') {
      console.log('Checkout completed but payment is not paid yet:', session.id, session.payment_status);
      return res.sendStatus(200);
    }

    const requiredMailSettings = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'];
    const missingMailSettings = requiredMailSettings.filter((name) => !process.env[name]);
    if (missingMailSettings.length) {
      console.error('Paid order email not sent. Configure:', missingMailSettings.join(', '));
      // Return an error so Stripe retries the event after mail settings are fixed.
      return res.status(500).send('Order email is not configured yet.');
    }

    const port = Number(process.env.SMTP_PORT || 587);
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });

    const lineItems = session.line_items?.data || [];
    const itemLines = lineItems.map((item) => {
      const amount = new Intl.NumberFormat('en-US', {
        style: 'currency', currency: (item.currency || session.currency || 'usd').toUpperCase()
      }).format((item.amount_total ?? item.amount_subtotal ?? 0) / 100);
      const description = item.description ? `\n    Details: ${item.description}` : '';
      return `- ${item.quantity} × ${item.description || item.price?.product || item.price?.id || 'Item'} — ${amount}${description}`;
    }).join('\n');
    const total = new Intl.NumberFormat('en-US', {
      style: 'currency', currency: (session.currency || 'usd').toUpperCase()
    }).format((session.amount_total || 0) / 100);
    const shipping = session.shipping_details?.address;
    const shippingText = shipping
      ? [session.shipping_details?.name, shipping.line1, shipping.line2, shipping.city, shipping.state, shipping.postal_code, shipping.country].filter(Boolean).join('\n')
      : 'No shipping address returned by Stripe.';
    const orderText = [
      'A paid order was received for Upstate Lax and Dyes.',
      '',
      `Stripe Checkout Session: ${session.id}`,
      `Payment Intent: ${typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || 'Not provided'}`,
      `Customer: ${session.customer_details?.name || 'Not provided'}`,
      `Customer email: ${session.customer_details?.email || 'Not provided'}`,
      `Customer phone: ${session.customer_details?.phone || 'Not provided'}`,
      `Total paid: ${total}`,
      '',
      'ORDER ITEMS:',
      itemLines || '- Stripe did not return line items.',
      '',
      'SHIPPING ADDRESS:',
      shippingText,
      '',
      `Build count: ${session.metadata?.build_count || 'Not provided'}`,
      `Builds with custom stringing: ${session.metadata?.stringing_build_count || 'Not provided'}`,
      '',
      'Confirm the payment in Stripe before starting the order.'
    ].join('\n');

    await transporter.sendMail({
      from: process.env.ORDER_FROM_EMAIL || process.env.SMTP_USER,
      to: process.env.ORDER_EMAIL || 'upstatelax@icloud.com',
      subject: `Paid Upstate Lax and Dyes order — ${total}`,
      text: orderText
    });
    console.log('Paid order notification sent:', session.id);
    return res.sendStatus(200);
  } catch (error) {
    console.error('Stripe order notification failed:', error.message);
    return res.status(500).send('Could not process paid order notification.');
  }
});

app.use(express.json({ limit: '50kb' }));
app.use(express.static(__dirname));

// Prices are controlled by the server, never by values sent from the browser.
// Keep this allowlist in sync with the products and prices shown on the website.
const HEAD_PRICES_CENTS = {
  'StringKing|Mark 3A': 12999,
  'StringKing|Mark 3V': 12999,
  'StringKing|3T LSM': 12999
};
const CUSTOM_STRINGING_PRICE_CENTS = 5000; // $50.00, including the strings

app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const cart = req.body && req.body.cart;
    if (!Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ error: 'Your cart is empty.' });
    }
    if (cart.length > 10) {
      return res.status(400).json({ error: 'Please check out with 10 or fewer builds at a time.' });
    }

    const line_items = [];
    for (const item of cart) {
      const brand = String(item?.brand || '').trim().slice(0, 80);
      const model = String(item?.model || '').trim().slice(0, 100);
      const headKey = `${brand}|${model}`;
      const headPrice = HEAD_PRICES_CENTS[headKey];
      if (!brand || !model || !Number.isInteger(headPrice)) {
        return res.status(400).json({ error: `This head is not configured for checkout yet: ${brand} ${model}.` });
      }

      line_items.push({
        price_data: {
          currency: 'usd',
          unit_amount: headPrice,
          product_data: { name: `${brand} ${model} Lacrosse Head`, description: 'Lacrosse head, ordered unstrung unless custom stringing is selected.' }
        },
        quantity: 1
      });

      if (item?.customStringing === true) {
        const pocket = String(item.pocket || '').trim().slice(0, 40);
        const mesh = String(item.mesh || '').trim().slice(0, 60);
        const meshColor = String(item.meshColor || '').trim().slice(0, 40);
        const stringColor = String(item.stringColor || '').trim().slice(0, 60);
        const instructions = String(item.instructions || '').trim().slice(0, 300);
        const description = [
          `For: ${brand} ${model}`,
          `Pocket: ${pocket || 'Not specified'}`,
          `Mesh: ${mesh || 'Not specified'} (${meshColor || 'color not specified'})`,
          `String color: ${stringColor || 'Not specified'}`,
          instructions ? `Instructions: ${instructions}` : ''
        ].filter(Boolean).join(' · ');
        line_items.push({
          price_data: {
            currency: 'usd',
            unit_amount: CUSTOM_STRINGING_PRICE_CENTS,
            product_data: { name: 'Optional Custom Stringing (includes strings)', description }
          },
          quantity: 1
        });
      }
    }

    const session = await stripe.checkout.sessions.create({
      ui_mode: 'form',
      mode: 'payment',
      line_items,
      billing_address_collection: 'auto',
      phone_number_collection: { enabled: false },
      automatic_tax: { enabled: false },
      submit_type: 'auto',
      shipping_address_collection: { allowed_countries: ['CA', 'MX', 'US'] },
      name_collection: { individual: { enabled: true, optional: true } },
      saved_payment_method_options: { payment_method_save: 'enabled' },
      integration_identifier: 'custom_embedded_web_0001',
      metadata: {
        store: 'Upstate Lax and Dyes',
        build_count: String(cart.length),
        stringing_build_count: String(cart.filter(item => item?.customStringing === true).length)
      }
    });

    return res.json({ client_secret: session.client_secret });
  } catch (error) {
    console.error('Stripe Checkout Session creation failed:', error.message);
    return res.status(400).json({
      error: error.message || 'Stripe could not create a checkout session. Check your test keys and Stripe API configuration.'
    });
  }
});

const port = Number(process.env.PORT || 4242);
app.listen(port, () => console.log(`Upstate Lax and Dyes server listening on port ${port}`));
