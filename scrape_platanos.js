// scrape_platanos.js — Importador Shopify per platanosneaker.com
// Marca = slug de /collections/<marca>; Preu + imatges des de /products/<handle>.js
import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import pkg from 'pg';
const { Pool } = pkg;

/* ───────── Config ───────── */
const ROOT = (process.env.TARGET_URL || 'https://platanosneaker.com').replace(/\/+$/, '');
const MAX_PAGES = Number(process.env.MAX_PAGES || 1000);
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
    p.name, p.description || '', p.brand || '', p.category || '',
    p.image_url || '', p.base_price_cents ?? null, p.source_url
  ];
  await pool.query(sql, vals);
}

/* ───────── Utils ───────── */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const slugToTitle = (s='') => s.split('-').map(w => w ? w[0].toUpperCase()+w.slice(1) : '').join(' ').trim();

function abs(u) {
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u.split('?')[0];
  if (u.startsWith('//')) return 'https:' + u.split('?')[0];
  if (u.startsWith('/')) return ROOT + u.split('?')[0];
  return (ROOT + '/' + u).replace(/\/{2,}/g, '/').replace('https:/', 'https://').split('?')[0];
}
function sameHost(u){ try { return new URL(u).host === new URL(ROOT).host; } catch { return false; } }
function stripHtml(x){ return String(x || '').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(); }
function firstNonEmpty(...a){ for (const x of a) if (x && String(x).trim()) return String(x).trim(); return ''; }
function parsePriceCents(v){
  if (v === 0) return 0;
  if (typeof v === 'number') {
    // moltes vegades Shopify ja dóna cèntims (15900 = 159,00 €)
    return v >= 1000 ? Math.round(v) : Math.round(v*100);
  }
  if (!v) return null;
  const s = String(v).replace(/\s/g,'');
  const m = s.match(/(\d{1,6}[.,]\d{1,2}|\d{1,6})/g);
  if (!m) return null;
  const raw = m[m.length-1].replace('.',',');
  const [eu, dec='0'] = raw.split(',');
  const cents = parseInt(eu,10)*100 + parseInt(dec.padEnd(2,'0').slice(0,2),10);
  return Number.isFinite(cents) ? cents : null;
}

/* ───────── HTTP ───────── */
async function get(url, type='text'){
  const res = await axios.get(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (ImporterBot; +https://railway.app)',
      'accept': type === 'json' ? 'application/json' : 'text/html,application/xhtml+xml',
      'accept-language': 'es-ES,ca-ES;q=0.9'
    },
    timeout: 30000,
    validateStatus: s => s >= 200 && s < 400
  });
  return res.data;
}

/* ───────── Trobar enllaços des d’una pàgina i deduir brand current ───────── */
function brandFromUrl(url){
  try {
    const { pathname } = new URL(url);
    const parts = pathname.split('/').filter(Boolean);
    const i = parts.indexOf('collections');
    if (i >= 0 && parts[i+1]) {
      const slug = parts[i+1].split('?')[0];
      if (!['all', 'rebajas', 'sale', 'ofertas'].includes(slug)) return slugToTitle(slug);
    }
  } catch {}
  return null;
}

function parseListing(html, currentBrand) {
  const $ = cheerio.load(html);
  const out = new Set();
  const relNext = [];

  $('a[href]').each((_, a) => {
    const u = abs($(a).attr('href'));
    if (!u || !sameHost(u)) return;
    if (/\/products\//.test(u)) out.add(u);
    if (/\/collections\//.test(u) || u === ROOT) out.add(u);
  });
  $('link[rel="next"], a[rel="next"]').each((_, a) => {
    const u = abs($(a).attr('href')); if (u && sameHost(u)) relNext.push(u);
  });

  return { links: Array.from(out), nexts: relNext, inferredBrand: currentBrand || null };
}

/* ───────── Shopify product.js ───────── */
async function fetchShopifyJSON(productUrl){
  const clean = productUrl.replace(/\?.*$/,'');
  const jsonUrl = clean + '.js';
  const p = await get(jsonUrl, 'json'); // { title, vendor, body_html, images[], variants[]... }

  const title = p.title || '';
  const description = stripHtml(p.body_html || '');
  const images = Array.isArray(p.images) ? p.images : [];
  const image_url = images.length ? abs(images[0]) : ''; // 1a imatge del producte
  let price_cents = null;
  if (Array.isArray(p.variants) && p.variants.length){
    const prices = p.variants
      .map(v => parsePriceCents(v.price ?? v.compare_at_price))
      .filter(x => Number.isFinite(x));
    if (prices.length) price_cents = Math.min(...prices);
  }

  // Heurística de categoria per si la vols usar
  const pt = (p.product_type || '').toLowerCase();
  const tags = (Array.isArray(p.tags) ? p.tags.join(',') : String(p.tags || '')).toLowerCase();
  let category = '';
  if (/sneaker|zapat|shoe|sabat|calzado/i.test(pt+','+tags)) category = 'Sabates';
  else if (/ropa|hood|sudadera|camis|pantal|apparel|textil/i.test(pt+','+tags)) category = 'Roba';

  return { name: title || '(sense nom)', description, image_url, base_price_cents: price_cents, category };
}

/* ───────── Fallback HTML ───────── */
function parseFallback(html){
  const $ = cheerio.load(html);
  const name = firstNonEmpty(
    $('meta[property="og:title"]').attr('content'),
    $('h1').first().text(),
    $('title').text()
  );
  let price =
    parsePriceCents($('[itemprop="price"]').attr('content')) ??
    parsePriceCents($('.price, .price__container, .price-item, .product__price').text());
  // Evita el logo: prioritzem imatges dins el contenidor de producte
  let img = $('.product__media img[src]').first().attr('src') ||
            $('img[src*="/products/"]').first().attr('src') ||
            $('meta[property="og:image"]').attr('content') ||
            $('meta[name="twitter:image"]').attr('content');
  const image_url = abs(img) || '';
  const description = stripHtml($('.product__description, [itemprop="description"]').html() || $('meta[name="description"]').attr('content') || '');

  return { name: name || '(sense nom)', description, image_url, base_price_cents: price ?? null, category: '' };
}

/* ───────── Crawler ───────── */
async function crawl(){
  await ensureSchema();

  // productURL -> brand deduïda per la col·lecció on s'ha trobat
  const brandOfProduct = new Map();

  // cues amb el context de brand
  const seen = new Set();
  const queue = [{ url: `${ROOT}/collections`, brand: null }];

  const products = new Set();

  while (queue.length && seen.size < MAX_PAGES){
    const { url, brand } = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);

    const pageBrand = brand || brandFromUrl(url);

    try {
      const html = await get(url);
      const { links, nexts } = parseListing(html, pageBrand);

      for (const u of links){
        if (/\/products\//.test(u)) {
          products.add(u);
          if (pageBrand && !brandOfProduct.has(u)) brandOfProduct.set(u, pageBrand);
        } else if (/\/collections\//.test(u) || u === ROOT) {
          queue.push({ url: u, brand: brandFromUrl(u) || pageBrand || null });
        }
      }
      for (const n of nexts) queue.push({ url: n, brand: pageBrand || null });
    } catch(e){ console.error('Listing error:', url, e.message); }

    await sleep(120);
  }

  console.log(`Trobats ${products.size} productes. Processant…`);

  const list = Array.from(products);
  let ok=0, fail=0;

  async function worker(slice){
    for (const url of slice){
      try {
        let prod;
        try {
          const j = await fetchShopifyJSON(url);        // JSON (fiable per preu+imatges)
          prod = j;
        } catch {
          const html = await get(url);                  // Fallback HTML si cal
          prod = parseFallback(html);
        }
        const brand = brandOfProduct.get(url) || '';    // << marca des de /collections/<slug>
        await upsertProduct({
          ...prod,
          brand,
          source_url: url
        });
        ok++;
      } catch(e){
        fail++;
        console.error('Product error:', url, e.message);
      }
      await sleep(90);
    }
  }

  const chunk = Math.ceil(list.length / CONCURRENCY);
  const tasks = [];
  for (let i=0;i<CONCURRENCY;i++) tasks.push(worker(list.slice(i*chunk,(i+1)*chunk)));
  await Promise.all(tasks);

  console.log(`Imports OK: ${ok} | Errors: ${fail}`);
}

crawl()
  .then(()=>pool.end())
  .catch(err=>{ console.error('Importer crash:', err); pool.end(); process.exit(1); });
