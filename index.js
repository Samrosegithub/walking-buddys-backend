require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { pool, init } = require('./db');

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

const acuityAuth = 'Basic ' + Buffer.from(`${ACUITY_USER}:${ACUITY_KEY}`).toString('base64');

// Health check
app.get('/', (_req, res) => res.json({ ok: true, service: "Walking Buddy's API" }));

// ── Customers ─────────────────────────────────────────────────────────────────

app.post('/customers', async (req, res) => {
  try {
    const { first_name, last_name, email, phone } = req.body;
    const result = await pool.query(
      `INSERT INTO customers (first_name, last_name, email, phone)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (email) DO UPDATE SET first_name=$1, last_name=$2, phone=$4
       RETURNING *`,
      [first_name, last_name, email, phone || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/customers', async (req, res) => {
  try {
    const { email } = req.query;
    const result = email
      ? await pool.query('SELECT * FROM customers WHERE email=$1', [email])
      : await pool.query('SELECT * FROM customers ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Dogs ──────────────────────────────────────────────────────────────────────

app.post('/dogs', async (req, res) => {
  try {
    const { customer_id, name, breed, age, notes, avatar } = req.body;
    const result = await pool.query(
      `INSERT INTO dogs (customer_id, name, breed, age, notes, avatar)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [customer_id, name, breed, age, notes, avatar]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/dogs/:customer_id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM dogs WHERE customer_id=$1', [req.params.customer_id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Walks ─────────────────────────────────────────────────────────────────────

app.post('/walks', async (req, res) => {
  try {
    const { customer_id, acuity_id, date, time, duration, price, miles, status, notes, source } = req.body;
    const result = await pool.query(
      `INSERT INTO walks (customer_id, acuity_id, date, time, duration, price, miles, status, notes, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT DO NOTHING RETURNING *`,
      [customer_id, acuity_id, date, time, duration, price, miles||0, status||'upcoming', notes, source||'acuity']
    );
    res.json(result.rows[0] || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/walks/:customer_id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM walks WHERE customer_id=$1 ORDER BY date DESC',
      [req.params.customer_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stripe ────────────────────────────────────────────────────────────────────

app.post('/stripe/setup-intent', async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });

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

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8248;
init().then(() => {
  app.listen(PORT, () => console.log(`Walking Buddy's backend running on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err.message);
  app.listen(PORT, () => console.log(`Running without DB on port ${PORT}`));
});
