// importer.js — platanosneaker: productes, preus i imatges
import 'dotenv/config';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import pkg from 'pg';
const { Pool } = pkg;

/* ───────── Config ───────── */
const ROOT = (process.env.TARGET_URL || 'https://platanosneaker.com').replace(/\/+$/, '');
const MAX_PAGES = Number(process.env.MAX_PAGES || 500);     // límit de pàgines a rastrejar
const CONCURRENCY = 4;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false
});

/* ───────── DB prepare ───────── */
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
  const vals = [p.name, p.description || '', p.brand || '', p.category || '', p.image_url || '', p.base_price_cents ?? null, p.source_url];
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
  if (!str) return null;
  const s = String(str).replace(/\s/g, '');
  // busca 123,45 o 123.45 o 123
  const m = s.match(/(\d{1,6}[.,]\d{1,2}|\d{1,6})/g);
  if (!m) return null;
  const raw = m[m.length - 1].replace('.', ','); // usa coma com a separador decimal
  const parts = raw.split(',');
  let cents = 0;
  if (parts.length === 1) cents = parseInt(parts[0], 10) * 100;
  else cents = parseInt(parts[0], 10) * 100 + parseInt(parts[1].padEnd(2, '0').slice(0,2), 10);
  return Number.isFinite(cents) ? cents : null;
}

async function fetchHTML(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; ImporterBot/1.0; +https://railway.app)',
      'accept-language': 'es-ES,ca-ES;q=0.9'
    },
    timeout: 30000
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

/* ───────── Parsers ───────── */
function parseListing(html, baseUrl) {
  const $ = cheerio.load(html);
  const links = new Set();

  // totes les ancores del mateix host
  $('a[href]').each((_, a) => {
    const u = absolute($(a).attr('href'));
    if (!u || !sameHost(u)) return;
    // només dins del domini
    if (u.includes('/products/')) links.add(u);
    else if (u.includes('/collections/') || u === ROOT || u.startsWith(ROOT + '/?')) links.add(u);
  });

  // Paginació típica (page=2,3…)
  $('link[rel="next"], a[rel="next"]').each((_, e) => {
    const u = absolute($(e).attr('href'));
    if (u && sameHost(u)) links.add(u);
  });

  return Array.from(links);
}

function firstNonEmpty(...arr) {
  for (const v of arr) if (v && String(v).trim()) return String(v).trim();
  return '';
}

function parseProduct(html, url) {
  const $ = cheerio.load(html);

  const title = firstNonEmpty(
    $('meta[property="og:title"]').attr('content'),
    $('h1').first().text()
  );

  const priceCents = (
    parsePriceCents($('meta[property="product:price:amount"]').attr('content')) ??
    parsePriceCents($('[itemprop="price"]').attr('content')) ??
    parsePriceCents($('.price, .product-price, .price__container, .price-item').text())
  );

  const ogImg = $('meta[property="og:image"]').attr('content');
  let img = absolute(ogImg);
  if (!img) {
    // prova altres selectors comuns
    img = absolute($('img[src*="cdn.shopify.com"]').attr('src')) ||
          absolute($('img[data-src*="cdn.shopify.com"]').attr('data-src')) ||
          absolute($('img').first().attr('src'));
  }

  const metaDesc = $('meta[name="description"]').attr('content');
  const descBlock = $('.product__description, .product-description, [itemprop="description"]').text();
  const description = firstNonEmpty(metaDesc, descBlock);

  // Marca (primer mot del títol o breadcrumb)
  const breadcrumbBrand = $('a[href*="/collections/brand"], a[href*="/collections/marca"]').first().text();
  const brandGuess = (title.split(' ')[0] || '').replace(/[^A-Za-z0-9\-]/g, '');
  const brand = firstNonEmpty(breadcrumbBrand, brandGuess);

  // Categoria (primer /collections/... del breadcrumb)
  const catHref = $('a[href*="/collections/"]').first().attr('href') || '';
  let category = decodeURIComponent(catHref.split('/collections/')[1] || '').split('/')[0] || '';
  if (category) {
    category = category.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
    // petites normalitzacions
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

  // llavors de partida
  queue.push(ROOT);
  queue.push(`${ROOT}/collections/all`);
  queue.push(`${ROOT}/collections`);

  while (queue.length && seen.size < MAX_PAGES) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);

    try {
      const html = await fetchHTML(url);
      const links = parseListing(html, url);

      for (const u of links) {
        if (u.includes('/products/')) productUrls.add(u);
        // continua rastreig només per listings i home
        if (!seen.has(u) && !u.includes('/products/')) queue.push(u);
      }
    } catch (e) {
      console.error('Fetch listing error:', url, e.message);
    }

    await sleep(200); // una mica de pausa
  }

  console.log(`Trobats ${productUrls.size} productes. Processant…`);

  // Processa productes amb concurrency petita
  const items = Array.from(productUrls);
  let ok = 0, fail = 0;

  async function worker(slice) {
    for (const url of slice) {
      try {
        const html = await fetchHTML(url);
        const prod = parseProduct(html, url);
        await upsertProduct(prod);
        ok++;
      } catch (e) {
        fail++;
        console.error('Product error:', url, e.message);
      }
      await sleep(150);
    }
  }

  const chunkSize = Math.ceil(items.length / CONCURRENCY);
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push(worker(items.slice(i * chunkSize, (i + 1) * chunkSize)));
  }
  await Promise.all(workers);

  console.log(`Imports OK: ${ok} | Errors: ${fail}`);
}

crawl()
  .then(() => pool.end())
  .catch(err => { console.error('Importer crash:', err); pool.end(); process.exit(1); });
