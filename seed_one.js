// seed_one.js — escriu 1 producte de prova a Postgres
import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false
});

async function run() {
  console.log('DB_URL host:', (() => {
    try { const u = new URL(process.env.DATABASE_URL); return u.hostname + ' ' + u.pathname; }
    catch { return '??'; }
  })());

  await pool.query(`
    CREATE TABLE IF NOT EXISTS products(
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS variants(
      id SERIAL PRIMARY KEY,
      product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      option_name TEXT DEFAULT 'variant',
      option_value TEXT NOT NULL,
      price_cents INT NOT NULL,
      cost_cents INT DEFAULT 0,
      stock INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(product_id, option_value)
    );
  `);

  const ins = await pool.query(
    `INSERT INTO products(name, description) VALUES($1,$2) RETURNING id`,
    ['PING_TEST', 'creat per seed_one.js']
  );
  await pool.query(
    `INSERT INTO variants(product_id, option_name, option_value, price_cents, stock)
     VALUES($1,$2,$3,$4,$5)`,
    [ins.rows[0].id, 'variant', 'Única', 999, 1]
  );

  console.log('OK: creat producte PING_TEST amb id', ins.rows[0].id);
}

run().catch(e => console.error('ERROR', e))
     .finally(async () => { try { await pool.end(); } catch {} });
