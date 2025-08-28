// scrape_platanos.js — Importa productes de platanosneaker.com a Postgres (Railway)
// Start Command del servei: node scrape_platanos.js
import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import pkg from 'pg';

const { Pool } = pkg;

/* ─────────────────────────────
   Config bàsica
   ───────────────────────────── */
const BASE = 'https://platanosneaker.com';
const MAX_PAGES = 300;          // límit de seguretat
const CONCURRENCY = 4;          // fitxes en paral·lel
const DEFAULT_STOCK = 999;
const DEFAULT_OPTION_NAME = 'Talla';

/* ─────────────────────────────
   Postgres
   ───────────────────────────── */
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

/* ─────────────────────────────
   Helpers scraper
   ───────────────────────────── */
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

function isProductUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.includes('platanosneaker.com') && u.pathname.startsWith('/products/');
  } catch { return false; }
}

/* ─────────────────────────────
   Parse d’una fitxa de producte
   ───────────────────────────── */
async function parseProduct(url) {
  const $ = await fetchHtml(url);

  const name =
    $('h1.product_title').first().text().trim() ||
    $('h1').first().text().trim();

  const description =
    $('.woocommerce-product-details__short-description').text().trim() ||
    $('.summary .woocommerce-product-details__short-description').text().trim() ||
    '';

  let priceTxt =
    $('.summary .price').first().text().trim() ||
    $('p.price').first().text().trim() ||
    ($('body').text().match(/€\s?\d+[.,]\d{2}/)?.[0] || '');

  const price_cents = priceToCents(priceTxt) ?? 0;

  // variants (talles): select/llista/botons
  const variantOptions = new Set();

  $('select').each((_, el) => {
    const nameAttr = ($(el).attr('name') || '').toLowerCase();
    const idAttr = ($(el).attr('id') || '').toLowerCase();
    const labelTxt = $(`label[for="${$(el).attr('id') || ''}"]`).text().toLowerCase();
    if ([nameAttr, idAttr, labelTxt].some(s => s.includes('talla') || s.includes('size'))) {
      $(el).find('option').each((__, op) => {
        const val = $(op).text().trim();
        if (val && !/elige|selecciona|limpiar/i.test(val)) variantOptions.add(val);
      });
    }
  });

  $('[class*="variations"] button, [class*="variations"] li, [class*="pa_talla"] li, [class*="pa_size"] li').each((_, el) => {
    const t = $(el).text().trim();
    if (t) variantOptions.add(t);
  });

  const variants = variantOptions.size ? Array.from(variantOptions) : ['Única'];

  return { name, description, price_cents, variants };
}

/* ─────────────────────────────
   Crawler: recull enllaços de producte
   ───────────────────────────── */
async function crawlAllProductLinks() {
  const seed = [
    BASE + '/',
    BASE + '/collections/',
    BASE + '/collections/adidas/',
    BASE + '/collections/dunk-low/',
    BASE + '/collections/jordan-13/',
    BASE + '/collections/nike-shox-tl/'
  ];
  const toVisit = new Set(seed);
  const visited = new Set();
  const productLinks = new Set();

  while (toVisit.size && visited.size < MAX_PAGES) {
    const url = Array.from(toVisit)[0];
    toVisit.delete(url);
    visited.add(url);

    try {
      const $ = await fetchHtml(url);

      $('a[href]').each((_, a) => {
        let href = $(a).attr('href') || '';
        if (!href) return;
        if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
        if (!href.startsWith('http')) {
          try { href = new URL(href, url).toString(); } catch { return; }
        }
        if (!href.includes('platanosneaker.com')) return;

        if (isProductUrl(href)) {
          productLinks.add(href);
        } else {
          const p = new URL(href);
          if (p.pathname.startsWith('/collections/') || p.pathname === '/' || p.pathname === '/collections/') {
            if (!visited.has(href)) toVisit.add(href);
          }
        }
      });

      await sleep(150);
    } catch (e) {
      console.warn('Error carregant', url, e.message);
    }
  }

  return Array.from(productLinks);
}

/* ─────────────────────────────
   Execució principal
   ───────────────────────────── */
async function run() {
  console.log('→ Inici import des de', BASE);
  await ensureSchema();

  const links = await crawlAllProductLinks();
  console.log(`→ Productes detectats: ${links.length}`);

  let done = 0;
  let ok = 0;
  const queue = links.slice();

  async function worker
