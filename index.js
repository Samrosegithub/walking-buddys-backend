require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const STRIPE_SECRET = process.env.STRIPE_SECRET;
const ACUITY_USER = process.env.ACUITY_USER || '15437659';
const ACUITY_KEY  = process.env.ACUITY_KEY  || '43e89866544edc9f13b6105f2bac9c1d';

const stripeHeaders = {
  Authorization: `Bearer ${STRIPE_SECRET}`,
  'Content-Type': 'application/x-www-form-urlencoded',
};

// Health check
app.get('/', (_req, res) => res.json({ ok: true, service: "Walking Buddy's API" }));

// ── Stripe ────────────────────────────────────────────────────────────────────

// Create/find Stripe customer and return a SetupIntent client secret
app.post('/stripe/setup-intent', async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });

    // Find or create customer
    const search = await fetch(
      `https://api.stripe.com/v1/customers/search?query=email:'${encodeURIComponent(email)}'&limit=1`,
      { headers: stripeHeaders }
    );
    const searchData = await search.json();
    let customerId = searchData.data?.[0]?.id;

    if (!customerId) {
      const create = await fetch('https://api.stripe.com/v1/customers', {
        method: 'POST',
        headers: stripeHeaders,
        body: new URLSearchParams({ email, name: name || email }),
      });
      const created = await create.json();
      customerId = created.id;
    }

    // Create SetupIntent
    const siRes = await fetch('https://api.stripe.com/v1/setup_intents', {
      method: 'POST',
      headers: stripeHeaders,
      body: new URLSearchParams({ customer: customerId, 'payment_method_types[]': 'card' }),
    });
    const si = await siRes.json();
    res.json({ clientSecret: si.client_secret, customerId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List saved payment methods for an email
app.get('/stripe/payment-methods', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email required' });

    const search = await fetch(
      `https://api.stripe.com/v1/customers/search?query=email:'${encodeURIComponent(email)}'&limit=1`,
      { headers: stripeHeaders }
    );
    const searchData = await search.json();
    const customerId = searchData.data?.[0]?.id;
    if (!customerId) return res.json([]);

    const pmRes = await fetch(
      `https://api.stripe.com/v1/customers/${customerId}/payment_methods?type=card`,
      { headers: stripeHeaders }
    );
    const pmData = await pmRes.json();
    res.json(pmData.data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Acuity ────────────────────────────────────────────────────────────────────

const acuityAuth = 'Basic ' + Buffer.from(`${ACUITY_USER}:${ACUITY_KEY}`).toString('base64');

// Fetch appointments for an email
app.get('/acuity/appointments', async (req, res) => {
  try {
    const { email } = req.query;
    const url = email
      ? `https://acuityscheduling.com/api/v1/appointments?email=${encodeURIComponent(email)}&max=50`
      : `https://acuityscheduling.com/api/v1/appointments?max=50`;

    const r = await fetch(url, { headers: { Authorization: acuityAuth, Accept: 'application/json' } });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch appointment types
app.get('/acuity/appointment-types', async (_req, res) => {
  try {
    const r = await fetch('https://acuityscheduling.com/api/v1/appointment-types', {
      headers: { Authorization: acuityAuth, Accept: 'application/json' },
    });
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8248;
app.listen(PORT, () => console.log(`Walking Buddy's backend running on port ${PORT}`));
