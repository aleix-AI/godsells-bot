/**
 * db.js
 * Connexió bàsica a Postgres i helpers per ordres
 *
 * IMPORTANT:
 * - Assegura't que la taula `orders` existeix amb un esquema compatible:
 *
 * CREATE TABLE IF NOT EXISTS orders (
 *   id SERIAL PRIMARY KEY,
 *   user_id TEXT,
 *   username TEXT,
 *   items JSONB,
 *   total_cents INTEGER,
 *   total_cost_cents INTEGER,
 *   customer_name TEXT,
 *   address_text TEXT,
 *   status TEXT,
 *   payment_provider TEXT,
 *   payment_status TEXT,
 *   payment_id TEXT,
 *   created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
 *   notified_at TIMESTAMP WITH TIME ZONE NULL
 * );
 *
 */

require('dotenv').config();
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Falta DATABASE_URL a les env vars');
  // No throw per permetre debugging local; però recomano aturar si és en producció.
}

const pool = new Pool({
  connectionString,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false,
});

/** Útil per queries generals */
async function query(text, params = []) {
  const res = await pool.query(text, params);
  return res;
}

/** Insertar una comanda i retornar-la */
async function insertOrder({
  user_id,
  username,
  items,
  total_cents = 0,
  total_cost_cents = 0,
  customer_name = '',
  address_text = '',
  status = 'PENDING',
  payment_provider = null,
  payment_status = 'UNPAID',
  payment_id = null,
}) {
  // items ha de ser objecte/array; el guardem com JSONB
  const q = `
    INSERT INTO orders (
      user_id, username, items, total_cents, total_cost_cents, customer_name, address_text,
      status, payment_provider, payment_status, payment_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING *
  `;
  const params = [
    user_id,
    username,
    JSON.stringify(items || []),
    total_cents,
    total_cost_cents,
    customer_name,
    address_text,
    status,
    payment_provider,
    payment_status,
    payment_id,
  ];
  const { rows } = await pool.query(q, params);
  return rows[0];
}

/** Recuperar una comanda per id */
async function getOrderById(orderId) {
  const q = `SELECT * FROM orders WHERE id = $1 LIMIT 1`;
  const { rows } = await pool.query(q, [orderId]);
  return rows[0] || null;
}

/** Recuperar comandes encara no notificades (notified_at IS NULL) */
async function getUnnotifiedOrders(limit = 20) {
  const q = `
    SELECT *
    FROM orders
    WHERE notified_at IS NULL
    ORDER BY created_at ASC
    LIMIT $1
  `;
  const { rows } = await pool.query(q, [limit]);
  return rows;
}

/** Marcar com a notificat (notified_at = now()) */
async function markOrderNotified(orderId) {
  const q = `UPDATE orders SET notified_at = NOW() WHERE id = $1`;
  await pool.query(q, [orderId]);
}

/** Actualitzar l'estat d'una comanda (opcional) */
async function updateOrderStatus(orderId, status) {
  const q = `UPDATE orders SET status = $1 WHERE id = $2 RETURNING *`;
  const { rows } = await pool.query(q, [status, orderId]);
  return rows[0] || null;
}

/** Tanquem pool (per shutdown net) */
async function close() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  insertOrder,
  getOrderById,
  getUnnotifiedOrders,
  markOrderNotified,
  updateOrderStatus,
  close,
};
