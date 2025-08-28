// scrape_platanos.js — Importa productes de platanosneaker.com a Postgres
import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import pkg from 'pg';
const { Pool } = pkg;

/* ── Config ───────────────────────── */
const BASE = 'https://platanosneaker.com';
const MAX_PAGES = 200;
const CONCURRENCY = 4;
const DEFAULT_STOCK = 999;
const DEFAULT_OPTION = 'Talla';

/* ── Postgres ─────────────────────── */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false
});

async function ensureSchema() {
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
}

async function upsertProduct({ name, description }) {
  const r = await pool.query('SELECT id FROM products WHERE name=$1', [name]);
  if (r.rows[0]) return r.rows[0].id;
  const ins = await pool.query('INSERT INTO products(name, description) VALUES($1,$2) RETURNING id', [name, description || '']);
  return ins.rows[0].id;
}

async function upsertVariant({ product_id, option_value, price_cents, stock }) {
  await pool.query(
    `INSERT INTO variants(product_id, option_name, option_value, price_cents, stock)
     VALUES($1,$2,$3,$4,$5)
     ON CONFLICT (product_id, option_value)
     DO UPDATE SET price_cents=EXCLUDED.price_cents, stock=EXCLUDED.stock`,
    [product_id, DEFAULT_OPTION, option_value, price_cents ?? 0, stock ?? 0]
  );
}

/* ── Helpers ──────────────────────── */
const sleep = (ms) => new Promise(r=>setTimeout(r,ms));

function priceToCents(txt) {
  if (!txt) return 0;
  const n = parseFloat(txt.replace(/\s/g,'').replace(/\./g,'').replace(',', '.').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

async function fetchHtml(url) {
  const { data } = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ImportBot/1.0)' },
    timeout: 20000
  });
  return cheerio.load(data);
}

function isProductUrl(url) {
  try { const u = new URL(url); return u.hostname.includes('platanosneaker.com') && u.pathname.startsWith('/products/'); }
  catch { return false; }
}

/* ── Parse producte ───────────────── */
async function parseProduct(url) {
  const $ = await fetchHtml(url);
  const name = $('h1.product_title').first().text().trim() || $('h1').first().text().trim();
  const description = $('.woocommerce-product-details__short-description').text().trim()
                   || $('.summary .woocommerce-product-details__short-description').text().trim() || '';
  const priceTxt = $('.summary .price').first().text().trim() || $('p.price').first().text().trim() || '';
  const price_cents = priceToCents(priceTxt);

  const variants = new Set();
  $('select').each((_, el) => {
    const n = (($(el).attr('name')||'') + ' ' + ($(el).attr('id')||'')).toLowerCase();
    if (n.includes('talla') || n.includes('size')) {
      $(el).find('option').each((__, op) => {
        const v = $(op).text().trim();
        if (v && !/elige|selecciona|limpiar/i.test(v)) variants.add(v);
      });
    }
  });
  $('[class*="variations"] button, [class*="variations"] li, [class*="pa_talla"] li, [class*="pa_size"] li').each((_, el) => {
    const t = $(el).text().trim();
    if (t) variants.add(t);
  });

  const list = variants.size ? Array.from(variants) : ['Única'];
  return { name, description, price_cents, variants: list };
}

/* ── Crawler enllaços ─────────────── */
async function crawlProductLinks() {
  const seeds = [BASE+'/', BASE+'/collections/', BASE+'/collections/adidas/', BASE+'/collections/dunk-low/'];
  const toVisit = new Set(seeds);
  const visited = new Set();
  const out = new Set();

  while (toVisit.size && visited.size < MAX_PAGES) {
    const url = Array.from(toVisit)[0];
    toVisit.delete(url); visited.add(url);

    try {
      const $ = await fetchHtml(url);
      $('a[href]').each((_, a) => {
        let href = $(a).attr('href') || '';
        if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
        if (!href.startsWith('http')) { try { href = new URL(href, url).toString(); } catch { return; } }
        if (!href.includes('platanosneaker.com')) return;

        if (isProductUrl(href)) out.add(href);
        else {
          const p = new URL(href);
          if (p.pathname === '/' || p.pathname.startsWith('/collections/')) {
            if (!visited.has(href)) toVisit.add(href);
          }
        }
      });
      await sleep(120);
    } catch (e) {
      console.warn('Error carregant', url, e.message);
    }
  }
  return Array.from(out);
}

/* ── Main ─────────────────────────── */
async function run() {
  console.log('→ Inici import des de', BASE);
  await ensureSchema();

  const links = await crawlProductLinks();
  console.log('→ Productes detectats:', links.length);

  let done = 0, ok = 0;
  const queue = links.slice();

  async function worker() {
    while (queue.length) {
      const url = queue.pop();
      try {
        const info = await parseProduct(url);
        if (!info.name) { console.log('Sense nom, salto:', url); continue; }
        const product_id = await upsertProduct({ name: info.name, description: info.description });
        for (const v of info.variants) {
          await upsertVariant({ product_id, option_value: v, price_cents: info.price_cents, stock: DEFAULT_STOCK });
        }
        ok++; console.log(`OK (${ok}/${links.length}):`, info.name);
      } catch (e) {
        console.error('ERROR fitxa', url, e.message);
      } finally {
        done++; if (done % 10 === 0) console.log(`→ Progrés: ${done}/${links.length}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log('✔ Import complet. Processats:', done, 'Correctes:', ok);
}

run().catch(e => console.error('ERROR GENERAL:', e))
     .finally(async () => { await pool.end(); });
