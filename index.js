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

// ── Admin auth middleware ──────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Email notification helper ─────────────────────────────────────────────────
const nodemailer = require('nodemailer');

async function sendEmail(subject, text) {
  const user = process.env.NOTIFY_EMAIL;       // your Gmail address
  const pass = process.env.NOTIFY_EMAIL_PASS;  // Gmail app password
  const to   = process.env.NOTIFY_TO || user;
  if (!user || !pass) return;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
  await transporter.sendMail({ from: user, to, subject, text });
}

// ── Admin routes ──────────────────────────────────────────────────────────────

app.get('/admin/stats', adminAuth, async (_req, res) => {
  try {
    const [customers, walks, revenue] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM customers'),
      pool.query('SELECT COUNT(*) FROM walks'),
      pool.query('SELECT COALESCE(SUM(price),0) as total FROM walks WHERE status=$1', ['completed']),
    ]);
    res.json({
      total_customers: parseInt(customers.rows[0].count),
      total_walks: parseInt(walks.rows[0].count),
      total_revenue: parseFloat(revenue.rows[0].total),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/customers', adminAuth, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*,
        (SELECT row_to_json(d) FROM dogs d WHERE d.customer_id = c.id LIMIT 1) as dog,
        (SELECT COUNT(*) FROM walks w WHERE w.customer_id = c.id) as walk_count,
        (SELECT COALESCE(SUM(price),0) FROM walks w WHERE w.customer_id = c.id AND w.status='completed') as total_spent
      FROM customers c
      ORDER BY c.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/walks', adminAuth, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT w.*, c.first_name, c.last_name, c.email
      FROM walks w
      JOIN customers c ON c.id = w.customer_id
      ORDER BY w.date DESC
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Acuity Webhook ────────────────────────────────────────────────────────────
// Register this URL in Acuity: Integrations → Webhooks → https://walking-buddys-backend.onrender.com/webhooks/acuity
app.post('/webhooks/acuity', async (req, res) => {
  try {
    const { action, id: acuityId, firstName, lastName, email, phone, datetime, duration, price, appointmentTypeID } = req.body;
    if (!email || !acuityId) return res.json({ ok: true });

    // Upsert customer
    const cResult = await pool.query(
      `INSERT INTO customers (first_name, last_name, email, phone)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (email) DO UPDATE SET first_name=$1, last_name=$2, phone=COALESCE($4, customers.phone)
       RETURNING id`,
      [firstName || '', lastName || '', email, phone || null]
    );
    const customerId = cResult.rows[0].id;

    if (action === 'scheduled' || action === 'rescheduled') {
      const dt = datetime ? new Date(datetime) : null;
      const dateStr = dt ? dt.toISOString().split('T')[0] : null;
      const timeStr = dt ? dt.toTimeString().slice(0,5) : null;
      const durationStr = duration ? `${duration} min` : null;
      await pool.query(
        `INSERT INTO walks (customer_id, acuity_id, date, time, duration, price, status, source)
         VALUES ($1,$2,$3,$4,$5,$6,'upcoming','acuity')
         ON CONFLICT (acuity_id) DO UPDATE SET date=$3, time=$4, duration=$5, price=$6, status='upcoming'`,
        [customerId, String(acuityId), dateStr, timeStr, durationStr, price || 0]
      );
    } else if (action === 'cancelled') {
      await pool.query(`UPDATE walks SET status='cancelled' WHERE acuity_id=$1`, [String(acuityId)]);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Notification cron (ping this every 5 min from cron-job.org) ───────────────
// GET https://walking-buddys-backend.onrender.com/cron/notify?key=wb-admin-2024
app.get('/cron/notify', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!process.env.NOTIFY_EMAIL) return res.json({ skipped: 'no NOTIFY_EMAIL set' });

  try {
    const now = new Date();
    // Find upcoming walks whose datetime falls in the next 55-65 min (1hr window) or 10-20 min (15min window)
    const result = await pool.query(`
      SELECT w.*, c.first_name, c.last_name, d.name as dog_name
      FROM walks w
      JOIN customers c ON c.id = w.customer_id
      LEFT JOIN dogs d ON d.customer_id = c.id
      WHERE w.status = 'upcoming' AND w.date IS NOT NULL AND w.time IS NOT NULL
    `);

    const sent = [];
    for (const walk of result.rows) {
      const walkDT = new Date(`${walk.date}T${walk.time}:00`);
      const diffMin = (walkDT - now) / 60000;

      if (diffMin >= 55 && diffMin <= 65) {
        const detail = `${walk.first_name} ${walk.last_name}${walk.dog_name ? ` (${walk.dog_name})` : ''} at ${walk.time}`;
        await sendEmail(`🐾 Walk in 1 HOUR — ${detail}`, `Upcoming walk in about 1 hour:\n\nCustomer: ${walk.first_name} ${walk.last_name}\nDog: ${walk.dog_name || '—'}\nTime: ${walk.time}\nDuration: ${walk.duration || '—'}\nPrice: $${walk.price || 0}`);
        sent.push({ walk: walk.id, type: '1hr' });
      } else if (diffMin >= 10 && diffMin <= 20) {
        const detail = `${walk.first_name} ${walk.last_name}${walk.dog_name ? ` (${walk.dog_name})` : ''} at ${walk.time}`;
        await sendEmail(`🐾 Walk in 15 MIN — ${detail}`, `Walk starting soon:\n\nCustomer: ${walk.first_name} ${walk.last_name}\nDog: ${walk.dog_name || '—'}\nTime: ${walk.time}\nDuration: ${walk.duration || '—'}\nPrice: $${walk.price || 0}`);
        sent.push({ walk: walk.id, type: '15min' });
      }
    }

    res.json({ ok: true, checked: result.rows.length, sent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: manual walk entry + subscription toggle ────────────────────────────
app.post('/admin/walks', adminAuth, async (req, res) => {
  try {
    const { customer_id, date, time, duration, price, notes, status } = req.body;
    const result = await pool.query(
      `INSERT INTO walks (customer_id, date, time, duration, price, notes, status, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'manual') RETURNING *`,
      [customer_id, date, time || null, duration || null, price || 0, notes || null, status || 'upcoming']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/admin/walks/:id', adminAuth, async (req, res) => {
  try {
    const { status, date, time, duration, price, notes } = req.body;
    const result = await pool.query(
      `UPDATE walks SET
        status=COALESCE($1,status), date=COALESCE($2,date), time=COALESCE($3,time),
        duration=COALESCE($4,duration), price=COALESCE($5,price), notes=COALESCE($6,notes)
       WHERE id=$7 RETURNING *`,
      [status, date, time, duration, price, notes, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/admin/customers/:id/subscription', adminAuth, async (req, res) => {
  try {
    const { active } = req.body;
    const result = await pool.query(
      `UPDATE customers SET subscription_active=$1 WHERE id=$2 RETURNING *`,
      [active, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
