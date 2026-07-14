const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name  TEXT NOT NULL,
      email      TEXT UNIQUE NOT NULL,
      phone      TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS dogs (
      id          SERIAL PRIMARY KEY,
      customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
      name        TEXT,
      breed       TEXT,
      age         TEXT,
      notes       TEXT,
      avatar      TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS walks (
      id          SERIAL PRIMARY KEY,
      customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
      acuity_id   TEXT,
      date        DATE,
      time        TEXT,
      duration    TEXT,
      price       NUMERIC,
      miles       NUMERIC DEFAULT 0,
      status      TEXT DEFAULT 'upcoming',
      notes       TEXT,
      source      TEXT DEFAULT 'acuity',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('DB tables ready');
}

module.exports = { pool, init };
