// scrape_platanos.js — Importador platanosneaker: preus + imatges (Shopify + fallback)
import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import pkg from 'pg';
const { Pool } = pkg;

/* ───────── Config ───────── */
const ROOT = (process.env.TARGET_URL || 'https://platanosneaker.com').replace(/\/+$/, '');
const MAX_PAGES = Number(process.env.MAX_PAGES || 500);
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

/* ───────── Helpers ───────── */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function absolute(url) {
  if (!url) return null;
  if (url.startsWith('http')) return url.split('?')[0];
  if (url.startsWith('//')) return 'https:' + url.split('?')[0];
  if (url.startsWith('/')) return ROOT + url.split('?')[0];
  return (ROOT + '/' + url).replace(/\/{2,}/g, '/').replace('https:/', 'https://').split('?')[0];
}
function sameHost(u) {
  try { return new URL(u).host === new URL(ROOT).host; } catch { return false; }
}
function parsePriceCents(str) {
  if (!str && str !== 0) return null;
  if (typeof str === 'number') return Math.round(str);
  const s = String(str).replace(/\s/g, '');
  const m = s.match(/(\d{1,6}[.,]\d{1,2}|\d{1,6})/g);
  if (!m) return null;
  const raw = m[m.length - 1].replace('.', ',');
  const [eu, dec = '0'] = raw.split(',');
  const cents = parseInt(eu, 10) * 100 + parseInt(dec.padEnd(2, '0').slice(0, 2), 10);
  return Number.isFinite(cents) ? cents : null;
}

async function fetchHTML(url) {
  const res = await axios.get(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; ImporterBot/1.0; +https://railway.app)',
      'accept-language': 'es-ES,ca-ES;q=0.9'
    },
    timeout: 30000,
    responseType: 'text',
    validateStatus: s => s >= 200 && s < 400
  });
  return res.data;
}

function firstNonEmpty(...arr) {
  for (const v of arr) if (v && String(v).trim()) return String(v).trim();
  return '';
}

/* ───────── Shopify shortcut ───────── */
async function tryShopifyJSON(productUrl) {
  // Shopify exposeix JSON a /products/<handle>.js
  const u = productUrl.replace(/\?.*$/, '');
  if (!/\/products\//.test(u)) return null;
  const jsonUrl = u + '.js';
  try {
    const res = await axios.get(jsonUrl, { validateStatus: s => s >= 200 && s < 400, timeout: 15000 });
    const p = res.data || {};
    const title = p.title || '';
    let img = p.featured_image || (Array.isArray(p.images) && p.images[0]) || '';
    if (img) img = absolute(img);

    let priceCents = null;
    if (typeof p.price !== 'undefined') {
      priceCents = parsePriceCents(p.price);
    } else if (Array.isArray(p.variants) && p.variants.length) {
      const v = p.variants.find(v => v.available) || p.variants[0];
      const val = typeof v?.price !== 'undefined' ? v.price : v?.compare_at_price;
      priceCents = parsePriceCents(val);
    }

    const brand = p.vendor || '';
    const description = (p.body_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    return {
      title,
      image_url: img || '',
      price_cents: priceCents ?? null,
      brand,
      description
    };
  } catch {
    return null;
  }
}

/* ───────── Parsers clàssics ───────── */
function parseListing(html) {
  const $ = cheerio.load(html);
  const links = new Set();

  $('a[href]').each((_, a) => {
    const u = absolute($(a).attr('href'));
    if (!u || !sameHost(u)) return;
    if (u.includes('/products/')) links.add(u);
    else if (u.includes('/collections/') || u === ROOT || u.startsWith(ROOT + '/?')) links.add(u);
  });

  $('link[rel="next"], a[rel="next"]').each((_, e) => {
    const u = absolute($(e).attr('href'));
    if (u && sameHost(u)) links.add(u);
  });

  return Array.from(links);
}

function parseJSONLD($) {
  let priceCents = null;
  let image = null;
  $('script[type="application/ld+json"]').each((_, s) => {
    try {
      const txt = $(s).contents().text();
      if (!txt) return;
      const json = JSON.parse(txt);
      const bucket = Array.isArray(json) ? json : [json];
      for (const obj of bucket) {
        if (obj && (obj['@type'] === 'Product' || obj['@type']?.includes?.('Product'))) {
          if (!image) {
            const img = Array.isArray(obj.image) ? obj.image[0] : obj.image;
            if (img) image = String(img);
          }
          const offers = obj.offers || obj.aggregateOffer || obj.aggregateOffers;
          if (offers) {
            const arr = Array.isArray(offers) ? offers : [offers];
            for (const ofr of arr) {
              if (!priceCents && (ofr.price || ofr.priceSpecification?.price)) {
                priceCents = parsePriceCents(ofr.price || ofr.priceSpecification?.price);
              }
            }
          }
        }
      }
    } catch {}
  });
  return { priceCents, image };
}

function parseProductFallback(html, url) {
  const $ = cheerio.load(html);

  const title = firstNonEmpty(
    $('meta[property="og:title"]').attr('content'),
    $('h1').first().text()
  );

  const { priceCents: ldPrice, image: ldImage } = parseJSONLD($);
  const priceCents =
    ldPrice ??
    parsePriceCents($('meta[property="product:price:amount"]').attr('content')) ??
    parsePriceCents($('[itemprop="price"]').attr('content')) ??
    parsePriceCents($('.price, .product-price, .price__container, .price-item').text());

  const ogImg = $('meta[property="og:image"]').attr('content');
  let img = absolute(ldImage || ogImg);
  if (!img) {
    img =
      absolute($('img[src*="cdn.shopify.com"]').attr('src')) ||
      absolute($('img[data-src*="cdn.shopify.com"]').attr('data-src')) ||
      absolute($('img').first().attr('src'));
  }

  const metaDesc = $('meta[name="description"]').attr('content');
  const descBlock = $('.product__description, .product-description, [itemprop="description"]').text();
  const description = firstNonEmpty(metaDesc, descBlock);

  const breadcrumbBrand = $('a[href*="/collections/brand"], a[href*="/collections/marca"]').first().text();
  const brandGuess = (title.split(' ')[0] || '').replace(/[^A-Za-z0-9\-]/g, '');
  const brand = firstNonEmpty(breadcrumbBrand, brandGuess);

  const catHref = $('a[href*="/collections/"]').first().attr('href') || '';
  let category = decodeURIComponent(catHref.split('/collections/')[1] || '').split('/')[0] || '';
  if (category) {
    category = category.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
    if (/sneaker|zapat|sabat/i.test(category)) category = 'Sabates';
    if (/cloth|ropa|apparel|remera|camis|hood/i.test(category)) category = 'Roba';
  }

  return {
    name: title || '(sense nom)',
    description,
    brand,
    category,
    image_url: img || '',
    base_price_cents: priceCents ?? null,
    source_url: url
  };
}

/* ───────── Crawler ───────── */
async function crawl() {
  await ensureSchema();

  const seen = new Set();
  const queue = [];
  const productUrls = new Set();

  queue.push(ROOT);
  queue.push(`${ROOT}/collections/all`);
  queue.push(`${ROOT}/collections`);

  while (queue.length && seen.size < MAX_PAGES) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);

    try {
      const html = await fetchHTML(url);
      const links = parseListing(html);
      for (const u of links) {
        if (u.includes('/products/')) productUrls.add(u);
        if (!seen.has(u) && !u.includes('/products/')) queue.push(u);
      }
    } catch (e) {
      console.error('Fetch listing error:', url, e.message);
    }
    await sleep(200);
  }

  console.log(`Trobats ${productUrls.size} productes. Processant…`);

  const items = Array.from(productUrls);
  let ok = 0, fail = 0;

  async function worker(slice) {
    for (const url of slice) {
      try {
        // 1) Prova JSON de Shopify
        const sj = await tryShopifyJSON(url);

        let prod;
        if (sj && (sj.price_cents || sj.image_url)) {
          // si tenim JSON fiable, muntem producte amb aquesta info
          const html = await fetchHTML(url); // per categoria/breadcrumb i og:title
          const fallback = parseProductFallback(html, url);
          prod = {
            ...fallback,
            name: sj.title || fallback.name,
            image_url: sj.image_url || fallback.image_url,
            base_price_cents: sj.price_cents ?? fallback.base_price_cents,
            brand: sj.brand || fallback.brand
          };
        } else {
          // 2) Fallback clàssic
          const html = await fetchHTML(url);
          prod = parseProductFallback(html, url);
        }

        await upsertProduct(prod);
        ok++;
      } catch (e) {
        fail++;
        console.error('Product error:', url, e.message);
      }
      await sleep(150);
    }
  }

  const chunk = Math.ceil(items.length / CONCURRENCY);
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push(worker(items.slice(i * chunk, (i + 1) * chunk)));
  }
  await Promise.all(workers);

  console.log(`Imports OK: ${ok} | Errors: ${fail}`);
}

crawl()
  .then(() => pool.end())
  .catch(err => { console.error('Importer crash:', err); pool.end(); process.exit(1); });
