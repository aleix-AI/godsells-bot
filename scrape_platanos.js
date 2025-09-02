// scrape_platanos.js — WooCommerce importer (preus + imatges) per platanosneaker.com
import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import pkg from 'pg';
const { Pool } = pkg;

/* ───────── Config ───────── */
const ROOT = (process.env.TARGET_URL || 'https://platanosneaker.com').replace(/\/+$/, '');
const MAX_PAGES = Number(process.env.MAX_PAGES || 600);
const CONCURRENCY = 4;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false
});

/* ───────── DB ───────── */
async function ensureSchema() {
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS brand TEXT;`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT;`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS base_price_cents INT;`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS source_url TEXT;`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS products_source_url_idx ON products(source_url);`);
}

async function upsertProduct(p) {
  const sql = `
    INSERT INTO products (name, description, brand, category, image_url, base_price_cents, source_url)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (source_url) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      brand = EXCLUDED.brand,
      category = EXCLUDED.category,
      image_url = EXCLUDED.image_url,
      base_price_cents = EXCLUDED.base_price_cents
  `;
  const vals = [
    p.name,
    p.description || '',
    p.brand || '',
    p.category || '',
    p.image_url || '',
    p.base_price_cents ?? null,
    p.source_url
  ];
  await pool.query(sql, vals);
}

/* ───────── Utils ───────── */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function abs(u) {
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u.split('?')[0];
  if (u.startsWith('//')) return 'https:' + u.split('?')[0];
  if (u.startsWith('/')) return ROOT + u.split('?')[0];
  return (ROOT + '/' + u).replace(/\/{2,}/g, '/').replace('https:/', 'https://').split('?')[0];
}
function sameHost(u) { try { return new URL(u).host === new URL(ROOT).host; } catch { return false; } }
function first(...a){ for (const x of a) if (x && String(x).trim()) return String(x).trim(); return ''; }

function parsePriceCents(str) {
  if (typeof str === 'number') return Math.round(str);
  if (!str) return null;
  const s = String(str).replace(/\s/g, '');
  // última xifra amb decimals coma/punt o enter
  const m = s.match(/(\d{1,6}[.,]\d{1,2}|\d{1,6})/g);
  if (!m) return null;
  const raw = m[m.length - 1].replace('.', ',');
  const [eu, dec = '0'] = raw.split(',');
  const cents = parseInt(eu, 10) * 100 + parseInt(dec.padEnd(2, '0').slice(0, 2), 10);
  return Number.isFinite(cents) ? cents : null;
}

async function get(url) {
  const res = await axios.get(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (ImporterBot; +https://railway.app)',
      'accept-language': 'es-ES,ca-ES;q=0.9'
    },
    timeout: 30000,
    validateStatus: s => s >= 200 && s < 400
  });
  return res.data;
}

/* ───────── Parse llistes ───────── */
function parseListing(html) {
  const $ = cheerio.load(html);
  const out = new Set();

  // Targete producte WooCommerce
  $('a.woocommerce-LoopProduct-link, a[href*="/products/"]').each((_, a) => {
    const u = abs($(a).attr('href'));
    if (u && sameHost(u) && /\/products\//.test(u)) out.add(u);
  });

  // enllaços navegació/collections
  $('a[href], link[rel="next"], a[rel="next"]').each((_, a) => {
    const u = abs($(a).attr('href'));
    if (!u || !sameHost(u)) return;
    if (!/\/cart|\/account|\/checkout|\/wp\-login/.test(u)) out.add(u);
  });

  return Array.from(out);
}

/* ───────── Parse producte WooCommerce ───────── */
function parseWooProduct(html, url) {
  const $ = cheerio.load(html);

  // Títol
  const name = first(
    $('h1.product_title').first().text(),
    $('meta[property="og:title"]').attr('content'),
    $('title').text()
  );

  // Preu (WooCommerce: p.price, span.woocommerce-Price-amount bdi, meta product:price:amount, JSON-LD)
  let price =
    parsePriceCents($('p.price').text()) ??
    parsePriceCents($('span.woocommerce-Price-amount').first().text()) ??
    parsePriceCents($('meta[property="product:price:amount"]').attr('content'));

  if (price == null) {
    $('script[type="application/ld+json"]').each((_, s) => {
      try {
        const j = JSON.parse($(s).contents().text());
        const arr = Array.isArray(j) ? j : [j];
        for (const o of arr) {
          if (o && (o['@type'] === 'Product' || o['@type']?.includes?.('Product'))) {
            const offers = o.offers || o.aggregateOffer || o.aggregateOffers;
            const list = Array.isArray(offers) ? offers : [offers];
            for (const ofr of list) {
              if (ofr?.price && price == null) price = parsePriceCents(ofr.price);
            }
          }
        }
      } catch {}
    });
  }

  // Imatge (og:image, twitter:image, galeria WooCommerce)
  let image =
    abs($('meta[property="og:image"]').attr('content')) ||
    abs($('meta[name="twitter:image"]').attr('content'));

  if (!image) {
    const img =
      $('.woocommerce-product-gallery__wrapper img').first().attr('data-large_image') ||
      $('.woocommerce-product-gallery__wrapper img').first().attr('data-src') ||
      $('.woocommerce-product-gallery__wrapper img').first().attr('src') ||
      $('.woocommerce-product-gallery__image a').first().attr('href');
    image = abs(img);
  }

  // Descripció curta/llarga
  const desc = first(
    $('div.woocommerce-product-details__short-description').text(),
    $('div.product-short-description').text(),
    $('meta[name="description"]').attr('content')
  ).replace(/\s+/g, ' ').trim();

  // Categoria (breadcrumb)
  let category = '';
  const crumbs = $('nav.woocommerce-breadcrumb a').map((_, a) => $(a).text().trim()).get();
  if (crumbs.length) category = crumbs[crumbs.length - 1];
  if (/sneaker|zapat|sabat|calzado/i.test(category)) category = 'Sabates';
  if (/ropa|hood|sudadera|camis|pantal|apparel/i.test(category)) category = 'Roba';

  // Brand: prova a extreure de títol o primer breadcrumb
  const brand = (name.split(' ')[0] || '').replace(/[^A-Za-z0-9\-]/g, '');

  return {
    name: name || '(sense nom)',
    description: desc || '',
    brand,
    category,
    image_url: image || '',
    base_price_cents: price ?? null,
    source_url: url
  };
}

/* ───────── Crawler ───────── */
async function crawl() {
  await ensureSchema();

  const seen = new Set();
  const queue = [ROOT, `${ROOT}/shop`, `${ROOT}/collections`, `${ROOT}/collections/all`];
  const productUrls = new Set();

  while (queue.length && seen.size < MAX_PAGES) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);

    try {
      const html = await get(url);
      const links = parseListing(html);
      for (const u of links) {
        if (!sameHost(u)) continue;
        if (/\/products\//.test(u)) productUrls.add(u);
        else if (!seen.has(u) && !/\/product\-category\/uncategorized/i.test(u)) queue.push(u);
      }
    } catch (e) {
      console.error('Fetch listing error:', url, e.message);
    }
    await sleep(150);
  }

  console.log(`Trobats ${productUrls.size} productes. Processant…`);

  const urls = Array.from(productUrls);
  let ok = 0, fail = 0;

  async function worker(slice) {
    for (const url of slice) {
      try {
        const html = await get(url);
        const prod = parseWooProduct(html, url);
        await upsertProduct(prod);
        ok++;
      } catch (e) {
        fail++;
        console.error('Product error:', url, e.message);
      }
      await sleep(120);
    }
  }

  const chunk = Math.ceil(urls.length / CONCURRENCY);
  const tasks = [];
  for (let i = 0; i < CONCURRENCY; i++) tasks.push(worker(urls.slice(i * chunk, (i + 1) * chunk)));
  await Promise.all(tasks);

  console.log(`Imports OK: ${ok} | Errors: ${fail}`);
}

crawl()
  .then(() => pool.end())
  .catch(err => { console.error('Importer crash:', err); pool.end(); process.exit(1); });
