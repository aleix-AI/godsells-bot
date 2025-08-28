// scrape_platanos.js — Importa productes de platanosneaker.com a Postgres (Railway)
// Ús: crea un servei Railway temporal amb Start Command = "node scrape_platanos.js"
import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import pkg from 'pg';
const { Pool } = pkg;

/* ─────────────────────────────────────────
   Config
   ───────────────────────────────────────── */
const BASE = 'https://platanosneaker.com';
const MAX_PAGES_TO_VISIT = 300;     // límit de seguretat per no arrasar
const CONCURRENCY = 4;              // # descarregues simultànies
const DEFAULT_STOCK = 999;          // stock per defecte si no hi ha info
const DEFAULT_OPTION_NAME = 'Talla';// nom de variant per defecte

/* ─────────────────────────────────────────
   Postgres
   ───────────────────────────────────────── */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false
});

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS variants (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      option_name TEXT DEFAULT 'variant',
      option_value TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      cost_cents INTEGER DEFAULT 0,
      stock INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(product_id, option_value)
    );
  `);
}

async function upsertProduct({ name, description }) {
  const r = await pool.query('SELECT id FROM products WHERE name=$1', [name]);
  if (r.rows[0]) return r.rows[0].id;
  const ins = await pool.query(
    'INSERT INTO products(name, description) VALUES($1,$2) RETURNING id',
    [name, description || '']
  );
  return ins.rows[0].id;
}

async function upsertVariant({ product_id, option_name, option_value, price_cents, stock }) {
  await pool.query(
    `INSERT INTO variants(product_id, option_name, option_value, price_cents, stock)
     VALUES($1,$2,$3,$4,$5)
     ON CONFLICT (product_id, option_value)
     DO UPDATE SET price_cents=EXCLUDED.price_cents, stock=EXCLUDED.stock`,
    [product_id, option_name, option_value, price_cents ?? 0, stock ?? 0]
  );
}

/* ─────────────────────────────────────────
   Helpers scraper
   ───────────────────────────────────────── */
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

function priceToCents(txt) {
  if (!txt) return null;
  const n = parseFloat(
    txt.replace(/\s/g,'').replace(/\./g,'').replace(',', '.').replace(/[^\d.]/g, '')
  );
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

async function fetchHtml(url) {
  const { data } = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ImportBot/1.0)' },
    timeout: 20000
  });
  return cheerio.load(data);
}

/* ─────────────────────────────────────────
   Detecció i parse de PRODUCTE
   ───────────────────────────────────────── */
function isProductUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.includes('platanosneaker.com') && u.pathname.startsWith('/products/');
  } catch { return false; }
}

async function parseProduct(url) {
  const $ = await fetchHtml(url);

  // NOM del producte (WooCommerce sovint usa h1.product_title; si no, agafem el primer h1)
  const name =
    $('h1.product_title').first().text().trim() ||
    $('h1').first().text().trim();

  // DESCRIPCIÓ (breu, si existeix)
  const description =
    $('.woocommerce-product-details__short-description').text().trim() ||
    $('.summary .woocommerce-product-details__short-description').text().trim() ||
    '';

  // PREU (p.price o .summary .price) — agafem el preu "actual"
  let priceTxt =
    $
