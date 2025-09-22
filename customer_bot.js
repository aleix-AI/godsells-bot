// customer_bot.js — Cistella, talles per categoria, PayPal, perfil, peticions i CERCADOR PAGINAT
import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import pkg from 'pg';
const { Pool } = pkg;

/* ───────── Config PayPal ───────── */
const PAYPAL_MODE = (process.env.PAYPAL_MODE || 'live').toLowerCase(); // 'sandbox' | 'live'
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_SECRET = process.env.PAYPAL_SECRET || '';
const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID || '';
const PAYPAL_API_BASE = PAYPAL_MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

/* ───────── DB ───────── */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? ({ rejectUnauthorized: false }) : false
});

async function ensureSchema() {
  // Products
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS brand TEXT;`).catch(()=>{});
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT;`).catch(()=>{});
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;`).catch(()=>{});
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS base_price_cents INT;`).catch(()=>{});
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb;`).catch(()=>{});
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'import';`).catch(()=>{});

  // Orders
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_cost_cents INT DEFAULT 0;`).catch(()=>{});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name TEXT;`).catch(()=>{});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS address_text TEXT;`).catch(()=>{});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'PENDING';`).catch(()=>{});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();`).catch(()=>{});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;`).catch(()=>{});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_provider TEXT;`).catch(()=>{});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'UNPAID';`).catch(()=>{});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_id TEXT;`).catch(()=>{});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_receipt_json JSONB;`).catch(()=>{});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;`).catch(()=>{});

  // Queries
  await pool.query(`
    CREATE TABLE IF NOT EXISTS queries(
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT,
      username TEXT,
      text TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Customers (perfil + darrera cistella)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers(
      user_id BIGINT PRIMARY KEY,
      username TEXT,
      customer_name TEXT,
      address_text  TEXT,
      updated_at TIMESTAMPTZ DEFAULT now(),
      last_cart_json JSONB DEFAULT '[]'::jsonb
    );
  `);

  // Product requests (peticions quan no es troba el producte)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_requests (
      id SERIAL PRIMARY KEY,
      user_id BIGINT,
      username TEXT,
      desired_name TEXT NOT NULL,
      desired_size TEXT,
      notes TEXT,
      status TEXT DEFAULT 'NEW', -- NEW | APPROVED | REJECTED | DONE
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}
await ensureSchema();

/* ───────── DB helpers ───────── */
const db = {
  // Cerca antiga (compatibilitat)
  listProductsLike: async (q) =>
    (await pool.query('SELECT * FROM products WHERE name ILIKE $1 ORDER BY id DESC LIMIT 25', [q])).rows,

  // <<< Cerca paginada nom/brand/category/tags >>>
  countBySearch: async (q) => {
    const like = `%${q}%`;
    const r = await pool.query(`
      SELECT COUNT(*)::int AS n
      FROM products p
      WHERE p.name ILIKE $1
         OR p.brand ILIKE $1
         OR p.category ILIKE $1
         OR EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.tags,'[]'::jsonb)) t
              WHERE t ILIKE $1
            )
    `, [like]);
    return Number(r.rows[0]?.n || 0);
  },
  pageBySearch: async (q, limit, offset) => {
    const like = `%${q}%`;
    const r = await pool.query(`
      SELECT *
      FROM products p
      WHERE p.name ILIKE $1
         OR p.brand ILIKE $1
         OR p.category ILIKE $1
         OR EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.tags,'[]'::jsonb)) t
              WHERE t ILIKE $1
            )
      ORDER BY id DESC
      LIMIT $2 OFFSET $3
    `, [like, limit, offset]);
    return r.rows;
  },

  getProduct: async (id) =>
    (await pool.query('SELECT * FROM products WHERE id=$1', [id])).rows[0],

  topCategories: async () =>
    (await pool.query(`SELECT category, COUNT(*) n
                       FROM products
                       WHERE COALESCE(category,'') <> ''
                       GROUP BY 1 ORDER BY n DESC LIMIT 12`)).rows,

  topBrands: async () =>
    (await pool.query(`SELECT brand, COUNT(*) n
                       FROM products
                       WHERE COALESCE(brand,'') <> ''
                       GROUP BY 1 ORDER BY n DESC LIMIT 20`)).rows,

  countByCategory: async (c) =>
    Number((await pool.query(`SELECT COUNT(*) FROM products WHERE category ILIKE $1`, [c])).rows[0].count),

  pageByCategory: async (c, limit, offset) =>
    (await pool.query(`SELECT * FROM products WHERE category ILIKE $1 ORDER BY id DESC LIMIT $2 OFFSET $3`,
      [c, limit, offset])).rows,

  countByBrand: async (b) =>
    Number((await pool.query(`SELECT COUNT(*) FROM products WHERE brand ILIKE $1`, [b])).rows[0].count),

  pageByBrand: async (b, limit, offset) =>
    (await pool.query(`SELECT * FROM products WHERE brand ILIKE $1 ORDER BY id DESC LIMIT $2 OFFSET $3`,
      [b, limit, offset])).rows,

  minPriceForProduct: async (pid) =>
    Number((await pool.query(`SELECT MIN(price_cents) AS min FROM variants WHERE product_id=$1`, [pid])).rows[0]?.min || 0),

  insertOrder: async (o) =>
    (await pool.query(
      `INSERT INTO orders(user_id, username, items_json, total_cents, total_cost_cents, customer_name, address_text, status, payment_provider, payment_status, payment_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, created_at`,
      [o.user_id, o.username, JSON.stringify(o.items), o.total_cents, o.total_cost_cents || 0, o.customer_name || '', o.address_text || '', o.status || 'PENDING',
       o.payment_provider || null, o.payment_status || 'UNPAID', o.payment_id || null]
    )).rows[0],

  setOrderPaymentInfo: async (orderId, fields) => {
    const { payment_status, payment_id, payment_receipt_json, paid_at, notified_at } = fields;
    await pool.query(
      `UPDATE orders
         SET payment_status = COALESCE($2, payment_status),
             payment_id = COALESCE($3, payment_id),
             payment_receipt_json = COALESCE($4, payment_receipt_json),
             paid_at = COALESCE($5, paid_at),
             notified_at = COALESCE($6, notified_at)
       WHERE id = $1`,
      [orderId, payment_status || null, payment_id || null, payment_receipt_json ? JSON.stringify(payment_receipt_json) : null, paid_at || null, notified_at || null]
    );
  },

  getOrderById: async (id) =>
    (await pool.query(`SELECT * FROM orders WHERE id=$1`, [id])).rows[0],

  insertQuery: async (user_id, username, text) =>
    pool.query('INSERT INTO queries(user_id, username, text) VALUES($1,$2,$3)', [user_id, username, text]),

  getCustomer: async (user_id) =>
    (await pool.query('SELECT * FROM customers WHERE user_id=$1', [user_id])).rows[0],

  upsertCustomer: async (user_id, username, name, addr) =>
    pool.query(`
      INSERT INTO customers(user_id, username, customer_name, address_text)
      VALUES($1,$2,$3,$4)
      ON CONFLICT (user_id) DO UPDATE
        SET username=EXCLUDED.username,
            customer_name=EXCLUDED.customer_name,
            address_text=EXCLUDED.address_text,
            updated_at=now()
    `, [user_id, username, name, addr]),

  saveCart: async (user_id, username, cart) =>
    pool.query(`
      INSERT INTO customers(user_id, username, last_cart_json)
      VALUES($1,$2,$3::jsonb)
      ON CONFLICT (user_id) DO UPDATE
        SET username=EXCLUDED.username,
            last_cart_json=EXCLUDED.last_cart_json,
            updated_at=now()
    `, [user_id, username, JSON.stringify(cart || [])]),

  loadCart: async (user_id) => {
    const row = (await pool.query(`SELECT last_cart_json FROM customers WHERE user_id=$1`, [user_id])).rows[0];
    return Array.isArray(row?.last_cart_json) ? row.last_cart_json : [];
  }
};

/* ───────── Bot ───────── */
const BOT_TOKEN = process.env.CUSTOMER_BOT_TOKEN || process.env.CLIENT_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('Falta CUSTOMER_BOT_TOKEN o CLIENT_BOT_TOKEN');

const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || process.env.ADMIN_USER_ID || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const bot = new Telegraf(BOT_TOKEN);
const sessions = new Map();           // key: userId -> { step, cart, ... }
const getS = (id) => sessions.get(id) || {};
const setS = (id, s) => sessions.set(id, s);

const toEuro = (c) => (Number(c || 0) / 100).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const PAGE_SIZE = 10;
const enc = (s) => encodeURIComponent(s || '');
const dec = (s) => decodeURIComponent(s || '');
const trim = (t, n = 300) => (t || '').replace(/\s+/g, ' ').trim().slice(0, n);

/* ─── Talles per categoria ─── */
const deaccent = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function sizeKindFor(p) {
  const cat = deaccent(p.category);
  const shoes = ['sneakers', 'zapatillas', 'sandalias', 'chanclas'];
  const apparel = ['chandal', 'camisetas', 'chaquetas', 'banador', 'pantalones', 'camiseta', 'chaqueta', 'pantalon'];
  if (shoes.some(k => cat?.includes(k))) return 'shoe';
  if (apparel.some(k => cat?.includes(k))) return 'apparel';
  return 'none';
}
function sizeSuggestionsFor(p) {
  const kind = sizeKindFor(p);
  if (kind === 'shoe') return ['36','36.5','37','37.5','38','38.5','39','40','40.5','41','42','42.5','43','44','44.5','45','46'];
  if (kind === 'apparel') return ['XS','S','M','L','XL','XXL'];
  return null;
}
async function displayPriceCents(p) {
  if (Number(p.base_price_cents) > 0) return Number(p.base_price_cents);
  const m = await db.minPriceForProduct(p.id);
  return m > 0 ? m : 0;
}

/* ───────── Menú ───────── */
bot.start((ctx) => {
  setS(ctx.from.id, {});
  ctx.reply(
    '👋 Benvingut/da! Escriu per cercar o navega:',
    Markup.keyboard([
      ['📂 Categories', '🏷️ Marques'],
      ['🧺 Veure cistella', '👤 Dades d’enviament']
    ]).resize()
  );
});
bot.command('categories', (ctx) => bot.emit('hears', '📂 Categories', ctx));
bot.command('marques', (ctx) => bot.emit('hears', '🏷️ Marques', ctx));
bot.command('cistella', (ctx) => bot.emit('hears', '🧺 Veure cistella', ctx));
bot.command('dades', (ctx) => bot.emit('hears', '👤 Dades d’enviament', ctx));

/* ───────── Catàleg (categories/marques) ───────── */
bot.hears([/📂\s*Categories/i, /^(\p{Emoji_Presentation}?\s*)?categories$/iu], async (ctx) => {
  const cats = await db.topCategories();
  if (!cats.length) return ctx.reply('Encara no hi ha categories disponibles.');
  const kb = cats.map(c => [Markup.button.callback(`${c.category} (${c.n})`, `CAT|${enc(c.category)}|0`)]);
  await ctx.reply('Tria una categoria:', Markup.inlineKeyboard(kb));
});
bot.hears([/🏷️\s*Marques/i, /^(\p{Emoji_Presentation}?\s*)?marques$/iu], async (ctx) => {
  const brs = await db.topBrands();
  if (!brs.length) return ctx.reply('Encara no hi ha marques disponibles.');
  const rows = brs.map(b => [Markup.button.callback(`${b.brand} (${b.n})`, `BRAND|${enc(b.brand)}|0`)]);
  await ctx.reply('Tria una marca:', Markup.inlineKeyboard(rows));
});
// Teclat: "🧺 Veure cistella"
bot.hears([/🧺\s*Veure cistella/i, /^veure cistella$/i], (ctx) => showCart(ctx));

/* Llistats amb paginació per categoria/marca */
async function renderList(ctx, mode, value, page) {
  const offset = page * PAGE_SIZE;
  let total = 0, rows = [];
  if (mode === 'CAT') { total = await db.countByCategory(value); rows = await db.pageByCategory(value, PAGE_SIZE, offset); }
  if (mode === 'BRAND') { total = await db.countByBrand(value); rows = await db.pageByBrand(value, PAGE_SIZE, offset); }
  if (!rows.length) return ctx.answerCbQuery('Sense productes');

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const items = rows.map(p => [Markup.button.callback(`🧩 ${p.name}`, `P_${p.id}`)]);
  const nav = [];
  if (page > 0) nav.push(Markup.button.callback('◀️ Ant', `${mode}|${enc(value)}|${page - 1}`));
  nav.push(Markup.button.callback(`Pàg. ${page + 1}/${pages}`, 'NOOP'));
  if (page < pages - 1) nav.push(Markup.button.callback('▶️ Seg', `${mode}|${enc(value)}|${page + 1}`));
  items.push(nav);
  const title = mode === 'CAT' ? `Categoria: ${value}` : `Marca: ${value}`;
  try { await ctx.editMessageText(`${title}\nTria un producte:`, Markup.inlineKeyboard(items)); }
  catch { await ctx.reply(`${title}\nTria un producte:`, Markup.inlineKeyboard(items)); }
}
bot.action(/^(CAT|BRAND)\|(.+)\|(\d+)$/, async (ctx) => {
  const mode = ctx.match[1]; const value = decodeURIComponent(ctx.match[2]); const page = Number(ctx.match[3]);
  await ctx.answerCbQuery(); return renderList(ctx, mode, value, page);
});
bot.action('NOOP', (ctx) => ctx.answerCbQuery());

/* ───────── Targeta producte ───────── */
async function showProductCard(ctx, p) {
  const priceC = await displayPriceCents(p);
  const caption = `🧩 ${p.name}\n💶 ${priceC ? toEuro(priceC) : 'Preu a consultar'}\n\n${trim(p.description, 300)}`;

  const kind = sizeKindFor(p);
  let buttons;
  if (kind === 'none') {
    buttons = [
      [Markup.button.callback('➕ Afegir', `ADD_NOPSZ_${p.id}`)],
      [Markup.button.callback('🧺 Veure cistella', 'OPEN_CART')]
    ];
  } else {
    buttons = [
      [Markup.button.callback('➕ Afegir (tria talla)', `ASKSZ_${p.id}`)],
      [Markup.button.callback('🧺 Veure cistella', 'OPEN_CART')]
    ];
  }

  try {
    if (p.image_url) await ctx.replyWithPhoto(p.image_url, { caption, ...Markup.inlineKeyboard(buttons) });
    else await ctx.reply(caption, Markup.inlineKeyboard(buttons));
  } catch {
    await ctx.reply(caption, Markup.inlineKeyboard(buttons));
  }
}
bot.action(/P_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const pid = Number(ctx.match[1]);
  const p = await db.getProduct(pid);
  if (!p) return ctx.answerCbQuery('Producte no trobat');
  return showProductCard(ctx, p);
});
bot.action(/ADD_NOPSZ_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const pid = Number(ctx.match[1]);
  await addToCart(ctx, pid, null, 1);
});
bot.action(/ASKSZ_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const pid = Number(ctx.match[1]);
  const p = await db.getProduct(pid);
  if (!p) return;
  if (sizeKindFor(p) === 'none') return addToCart(ctx, pid, null, 1);

  const s = getS(ctx.from.id);
  setS(ctx.from.id, { ...s, step: 'ASK_SIZE', productId: pid });

  const sizes = sizeSuggestionsFor(p);
  const rows = [];
  for (let i = 0; i < sizes.length; i += 3) rows.push(sizes.slice(i, i + 3).map(v => Markup.button.callback(v, `SIZE|${pid}|${encodeURIComponent(v)}`)));
  rows.push([Markup.button.callback('✍️ Escriure talla manualment', 'NOOP')]);

  const txt = `Indica la talla per a «${p.name}». Tria una opció o escriu-la (ex: 42.5, 43 1/3).`;
  try { await ctx.editMessageText(txt, Markup.inlineKeyboard(rows)); }
  catch { await ctx.reply(txt, Markup.inlineKeyboard(rows)); }
});
bot.action(/^SIZE\|(\d+)\|(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const pid = Number(ctx.match[1]);
  const size = decodeURIComponent(ctx.match[2]);
  await addToCart(ctx, pid, size, 1);
});

/* ───────── Cistella ───────── */
async function persistCart(ctx, cart) {
  try { await db.saveCart(ctx.from.id, ctx.from.username || '', cart || []); }
  catch (e) { console.error('persistCart error:', e.message); }
}
function cartText(cart) {
  const lines = (cart || []).map((it, i) => {
    const labelTalla = it.size ? ` — talla ${it.size}` : '';
    return `#${i + 1} ${it.productName}${labelTalla} ×${it.qty} = ${toEuro((it.price_cents || 0) * (it.qty || 1))}`;
  });
  const total = (cart || []).reduce((a, it) => a + (it.price_cents || 0) * (it.qty || 1), 0);
  return { text: ['Cistella:', ...lines, `Total: ${toEuro(total)}`].join('\n'), total };
}
function cartKeyboard(cart) {
  const rows = [];
  (cart || []).slice(0, 10).forEach((it, i) => {
    rows.push([
      Markup.button.callback(`−`, `DEC_${i}`),
      Markup.button.callback(`×${it.qty}`, 'NOOP'),
      Markup.button.callback(`+`, `INC_${i}`)
    ]);
    if (it.size) {
      rows.push([
        Markup.button.callback('🔁 Talla', `EDIT_SIZE_${i}`),
        Markup.button.callback('🗑 Eliminar', `DEL_${i}`)
      ]);
    } else {
      rows.push([Markup.button.callback('🗑 Eliminar', `DEL_${i}`)]);
    }
  });
  rows.push([Markup.button.callback('✅ Confirmar comanda', 'CHECKOUT')]);
  rows.push([Markup.button.callback('🛍️ Continuar comprant', 'CONT_SHOP'), Markup.button.callback('🧹 Buidar', 'CLEAR_CART')]);
  return Markup.inlineKeyboard(rows);
}
async function renderCart(ctx, edit = false) {
  const s = getS(ctx.from.id);
  if (!s.cart || !s.cart.length) {
    const persisted = await db.loadCart(ctx.from.id);
    if (persisted?.length) setS(ctx.from.id, { ...s, cart: persisted });
  }
  const state = getS(ctx.from.id);
  if (!state.cart || !state.cart.length) {
    if (edit) { try { await ctx.editMessageText('La cistella és buida.'); } catch { await ctx.reply('La cistella és buida.'); } }
    else await ctx.reply('La cistella és buida.');
    return;
  }
  const { text } = cartText(state.cart);
  const kb = cartKeyboard(state.cart);
  if (edit) { try { await ctx.editMessageText(text, kb); } catch { await ctx.reply(text, kb); } }
  else await ctx.reply(text, kb);
}
async function showCart(ctx) { return renderCart(ctx, false); }

async function addToCart(ctx, productId, size, qty = 1) {
  const p = await db.getProduct(productId);
  if (!p) return ctx.reply('No he pogut trobar el producte.');
  const price_cents = await displayPriceCents(p);
  const item = { productId: p.id, productName: p.name, size, price_cents, qty };
  const s = getS(ctx.from.id);
  const cart = (s.cart || []).concat(item);
  setS(ctx.from.id, { step: null, cart });
  await persistCart(ctx, cart);

  const total = cart.reduce((a, it) => a + (it.price_cents || 0) * (it.qty || 1), 0);
  const labelTalla = size ? ` — talla ${size}` : '';
  await ctx.reply(
    `🛒 Afegit: ${p.name}${labelTalla} ×${qty}\nTotal: ${toEuro(total)}`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🧺 Veure/Confirmar', 'OPEN_CART')],
      [Markup.button.callback('🛍️ Continuar comprant', 'CONT_SHOP')]
    ])
  );
}
bot.action('OPEN_CART', async (ctx) => { await ctx.answerCbQuery(); return renderCart(ctx, true); });
bot.action('CONT_SHOP', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Perfecte! Escriu què busques o navega amb els botons.', Markup.keyboard([
    ['📂 Categories', '🏷️ Marques'],
    ['🧺 Veure cistella', '👤 Dades d’enviament']
  ]).resize());
});
bot.action(/INC_(\d+)/, async (ctx) => { await ctx.answerCbQuery(); const idx = +ctx.match[1]; const s = getS(ctx.from.id); if (!s.cart?.[idx]) return; s.cart[idx].qty = Math.min(99, (s.cart[idx].qty || 1) + 1); setS(ctx.from.id, s); await persistCart(ctx, s.cart); return renderCart(ctx, true); });
bot.action(/DEC_(\d+)/, async (ctx) => { await ctx.answerCbQuery(); const idx = +ctx.match[1]; const s = getS(ctx.from.id); if (!s.cart?.[idx]) return; s.cart[idx].qty = Math.max(0, (s.cart[idx].qty || 1) - 1); if (s.cart[idx].qty === 0) s.cart.splice(idx, 1); setS(ctx.from.id, s); await persistCart(ctx, s.cart); return renderCart(ctx, true); });
bot.action(/DEL_(\d+)/, async (ctx) => { await ctx.answerCbQuery(); const idx = +ctx.match[1]; const s = getS(ctx.from.id); if (!s.cart?.[idx]) return; s.cart.splice(idx, 1); setS(ctx.from.id, s); await persistCart(ctx, s.cart); return renderCart(ctx, true); });
bot.action(/EDIT_SIZE_(\d+)/, async (ctx) => { await ctx.answerCbQuery(); const idx = +ctx.match[1]; const s = getS(ctx.from.id); if (!s.cart?.[idx]) return; setS(ctx.from.id, { ...s, step: 'ASK_SIZE_EDIT', editIndex: idx }); return ctx.reply(`Escriu la nova talla per a «${s.cart[idx].productName}» (actual: ${s.cart[idx].size || '-'})`); });
// Buidar cistella (inline)
bot.action('CLEAR_CART', async (ctx) => {
  await ctx.answerCbQuery();
  const s = getS(ctx.from.id) || {};
  setS(ctx.from.id, { ...s, cart: [] });
  try { await persistCart(ctx, []); } catch {}
  try { await ctx.editMessageText('🧹 Cistella buidada.'); }
  catch { await ctx.reply('🧹 Cistella buidada.'); }
});

/* ───────── Formularis (talla manual, edició talla, nom, adreça) ───────── */
bot.on('text', async (ctx, next) => { // talla manual (després d'ASKSZ)
  const s = getS(ctx.from.id);
  if (s.step !== 'ASK_SIZE') return next();
  const size = ctx.message.text.trim().slice(0, 20);
  if (!size) return ctx.reply('Escriu una talla vàlida (ex: 42, 42.5, 43 1/3)');
  await addToCart(ctx, s.productId, size, 1);
});
bot.on('text', async (ctx, next) => { // editar talla a cistella
  const s = getS(ctx.from.id);
  if (s.step !== 'ASK_SIZE_EDIT') return next();
  const val = ctx.message.text.trim().slice(0, 20);
  if (!val) return ctx.reply('Talla no vàlida.');
  if (!s.cart?.[s.editIndex]) { setS(ctx.from.id, { ...s, step: null, editIndex: null }); return ctx.reply('Element no trobat.'); }
  s.cart[s.editIndex].size = val;
  setS(ctx.from.id, { ...s, step: null, editIndex: null });
  await persistCart(ctx, s.cart);
  return renderCart(ctx, false);
});

/* ───────── Perfil (nom/adreça) ───────── */
bot.hears([/👤\s*Dades d.?enviament/i, /^(\p{Emoji_Presentation}?\s*)?dades\s+d[’']?enviament$/iu], (ctx) => showOrEditProfile(ctx));
async function showOrEditProfile(ctx) {
  const cust = await db.getCustomer(ctx.from.id);
  if (cust?.customer_name && cust?.address_text) {
    const msg = `👤 Dades d’enviament\nNom: ${cust.customer_name}\nAdreça:\n${cust.address_text}`;
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback('✏️ Canviar nom', 'EDIT_NAME'), Markup.button.callback('✏️ Canviar adreça', 'EDIT_ADDR')]
    ]);
    return ctx.reply(msg, kb);
  } else {
    const s = getS(ctx.from.id);
    setS(ctx.from.id, { ...s, step: 'ASK_NAME', profileMode: true });
    return ctx.reply('Escriu el teu Nom i Cognoms:');
  }
}
bot.action('EDIT_NAME', async (ctx) => { await ctx.answerCbQuery(); const s = getS(ctx.from.id); setS(ctx.from.id, { ...s, step: 'ASK_NAME', profileMode: true }); ctx.reply('Escriu el teu Nom i Cognoms:'); });
bot.action('EDIT_ADDR', async (ctx) => { await ctx.answerCbQuery(); const s = getS(ctx.from.id); setS(ctx.from.id, { ...s, step: 'ASK_ADDR', profileMode: true }); ctx.reply('Escriu l’adreça completa d’enviament:'); });
bot.on('text', async (ctx, next) => { // NOM
  const s = getS(ctx.from.id);
  if (s.step !== 'ASK_NAME') return next();
  const name = ctx.message.text.trim().slice(0, 120);
  if (!name) return ctx.reply('Escriu un nom vàlid, si us plau.');
  setS(ctx.from.id, { ...s, temp_name: name, step: 'ASK_ADDR' });
  return ctx.reply('Ara escriu l’adreça completa d’enviament (carrer, número, porta, CP, ciutat):');
});
bot.on('text', async (ctx, next) => { // ADREÇA
  const s = getS(ctx.from.id);
  if (s.step !== 'ASK_ADDR') return next();
  const addr = ctx.message.text.trim().slice(0, 400);
  if (!addr) return ctx.reply('Adreça buida. Prova de nou.');
  const name = s.temp_name || (await db.getCustomer(ctx.from.id))?.customer_name || '';
  await db.upsertCustomer(ctx.from.id, ctx.from.username || '', name, addr);
  if (s.profileMode) {
    setS(ctx.from.id, { ...s, step: null, temp_name: null });
    return ctx.reply('✅ Dades guardades.');
  } else {
    setS(ctx.from.id, { ...s, step: null, temp_name: null });
    return finalizeOrder(ctx); // continua cap al pagament
  }
});

/* ───────── Checkout i PayPal ───────── */
bot.action('CHECKOUT', async (ctx) => {
  await ctx.answerCbQuery();
  const s = getS(ctx.from.id);
  if (!s.cart || !s.cart.length) {
    const persisted = await db.loadCart(ctx.from.id);
    if (!persisted?.length) return ctx.reply('La cistella és buida.');
    setS(ctx.from.id, { ...s, cart: persisted });
  }

  const cust = await db.getCustomer(ctx.from.id);
  const { total } = cartText(getS(ctx.from.id).cart || []);
  if (cust?.customer_name && cust?.address_text) {
    const msg = `Farem servir aquestes dades?\n\n${cust.customer_name}\n${cust.address_text}\n\nImport: ${toEuro(total)}`;
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback('✅ Sí, continuar a pagament', 'CONFIRM_PROFILE')],
      [Markup.button.callback('✏️ Canviar dades', 'EDIT_PROFILE')]
    ]);
    return ctx.reply(msg, kb);
  }
  setS(ctx.from.id, { ...getS(ctx.from.id), step: 'ASK_NAME', profileMode: false });
  return ctx.reply('Escriu el teu Nom i Cognoms:');
});
bot.action('EDIT_PROFILE', async (ctx) => { await ctx.answerCbQuery(); const s = getS(ctx.from.id); setS(ctx.from.id, { ...s, step: 'ASK_NAME', profileMode: false }); ctx.reply('Escriu el teu Nom i Cognoms:'); });
bot.action('CONFIRM_PROFILE', async (ctx) => { await ctx.answerCbQuery(); return finalizeOrder(ctx); });

/* PayPal helpers */
async function paypalAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) throw new Error('Falten credencials PayPal');
  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) throw new Error('PayPal OAuth error');
  const json = await res.json();
  return json.access_token;
}
async function paypalCreateOrder(ourOrderId, totalCents, description, returnBaseUrl) {
  const access = await paypalAccessToken();
  const return_url = `${returnBaseUrl}/paypal/return?order_id=${ourOrderId}`;
  const cancel_url = `${returnBaseUrl}/paypal/cancel?order_id=${ourOrderId}`;
  const body = {
    intent: 'CAPTURE',
    purchase_units: [{
      amount: { currency_code: 'EUR', value: (totalCents / 100).toFixed(2) },
      description: description?.slice(0, 120) || `Order #${ourOrderId}`
    }],
    application_context: { return_url, cancel_url, user_action: 'PAY_NOW', brand_name: 'La teva botiga' }
  };
  const res = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${access}` },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text().catch(()=> '');
    throw new Error(`PayPal create error: ${t}`);
  }
  return res.json();
}
async function paypalCaptureOrder(paypalOrderId) {
  const access = await paypalAccessToken();
  const res = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${paypalOrderId}/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${access}` }
  });
  if (!res.ok) {
    const t = await res.text().catch(()=> '');
    throw new Error(`PayPal capture error: ${t}`);
  }
  return res.json();
}

/* Notifica admin (només després de pagament) */
async function notifyAdminsOfOrder(order) {
  if (!ADMIN_CHAT_IDS.length) return;
  let items = [];
  try { items = Array.isArray(order.items_json) ? order.items_json : JSON.parse(order.items_json || '[]'); } catch {}
  const lines = items.map(it => {
    const label = it.size ? ` — talla ${it.size}` : '';
    return `• ${it.productName}${label} ×${it.qty} = ${toEuro((Number(it.price_cents)||0)*(Number(it.qty)||1))}`;
  }).join('\n') || '(cap)';

  const msg =
    `COMANDA #${order.id}\n` +
    `Estat: ${order.status || 'PENDING'} — Pagament: ${order.payment_status || 'UNPAID'}\n` +
    `Client: ${order.customer_name}\n` +
    `Usuari: ${order.username ? '@'+order.username : order.user_id}\n` +
    `Adreça:\n${order.address_text}\n\n` +
    `Productes:\n${lines}\n\n` +
    `Total: ${toEuro(order.total_cents)}`;

  for (const chatId of ADMIN_CHAT_IDS) {
    try { await bot.telegram.sendMessage(chatId, msg, { disable_web_page_preview: true }); }
    catch (e) { console.error('Admin notify fail:', e.message); }
  }
}

/* Crea comanda i obliga a PayPal */
async function finalizeOrder(ctx) {
  const userId = ctx.from.id;
  const username = ctx.from.username || '';

  let persisted = [];
  try { persisted = await db.loadCart(userId); } catch (e) { console.error('loadCart error:', e.message); }
  const s = getS(userId);
  let cart = Array.isArray(persisted) && persisted.length ? persisted : (s.cart || []);
  if (!cart.length) return ctx.reply('La cistella és buida.');

  const cust = await db.getCustomer(userId);
  if (!cust?.customer_name || !cust?.address_text) {
    setS(userId, { ...s, step: 'ASK_NAME', profileMode: false });
    return ctx.reply('Escriu el teu Nom i Cognoms:');
  }

  const total = cart.reduce((acc, it) => (acc + (Number(it.price_cents) || 0) * (Number(it.qty) || 1)), 0);

  const row = await db.insertOrder({
    user_id: userId,
    username,
    items: cart,
    total_cents: total,
    total_cost_cents: 0,
    customer_name: cust.customer_name,
    address_text: cust.address_text,
    status: 'PENDING',
    payment_provider: 'paypal',
    payment_status: 'UNPAID'
  });
  // després d'inserir la comanda:
try {
  // payload mínim: id de la comanda (pots afegir més camps si vols)
  const payload = JSON.stringify({ orderId: inserted.id });
  // Si tens exportat pool en db.js:
  await db.pool.query("SELECT pg_notify($1, $2)", ['new_order', payload]);
  // si no tens pool exportat, importa un client de pg aquí i fes SELECT pg_notify(...)
} catch (err) {
  console.error('Error fent NOTIFY new_order:', err);
}
  const orderId = row?.id;

  setS(userId, { ...s, cart: [] });
  try { await db.saveCart(userId, username, []); } catch (e) { console.error('saveCart after order error:', e.message); }

  if (!process.env.APP_URL) return ctx.reply('Error de configuració: falta APP_URL');
  try {
    const info = await paypalCreateOrder(orderId, total, `Order #${orderId}`, process.env.APP_URL);
    const approve = (info.links || []).find(l => l.rel === 'approve')?.href;
    await db.setOrderPaymentInfo(orderId, { payment_status: 'CREATED', payment_id: info.id });
    if (!approve) throw new Error('No s’ha rebut enllaç d’aprovació');
    await ctx.reply(
      `Comanda #${orderId} creada.\nAra paga ${toEuro(total)} a PayPal per confirmar la comanda.`,
      Markup.inlineKeyboard([[Markup.button.url('🌐 Obrir PayPal', approve)]])
    );
  } catch (e) {
    console.error('PayPal create fail:', e.message);
    await ctx.reply('No s’ha pogut iniciar el pagament amb PayPal ara mateix. Torna a /cistella i prova de nou en uns minuts.');
  }
}

/* ───────── Flux "Demanar producte" quan no hi ha resultats ───────── */
bot.action(/^REQ\|(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const name = decodeURIComponent(ctx.match[1] || '').slice(0, 120);
  if (!name) return ctx.reply('Nom invàlid.');
  const s = getS(ctx.from.id);
  setS(ctx.from.id, { ...s, step: 'REQ_SIZE', req: { name } });
  await ctx.reply(`Quina talla/mida vols per «${name}»?\nEx.: 42.5 o M (si tant és, escriu "Qualsevol").`);
});
bot.on('text', async (ctx, next) => {
  const s = getS(ctx.from.id);
  if (s.step !== 'REQ_SIZE') return next();
  const size = (ctx.message.text || '').trim().slice(0, 40) || 'Qualsevol';
  setS(ctx.from.id, { ...s, step: 'REQ_NOTES', req: { ...(s.req||{}), size } });
  return ctx.reply('Vols afegir notes (color, pressupost, urgència…)? Si no, escriu "No".');
});
bot.on('text', async (ctx, next) => {
  const s = getS(ctx.from.id);
  if (s.step !== 'REQ_NOTES') return next();
  const notesRaw = (ctx.message.text || '').trim();
  const notes = /^no$/i.test(notesRaw) ? '' : notesRaw.slice(0, 300);
  const req = s.req || {};
  try {
    await pool.query(
      `INSERT INTO product_requests (user_id, username, desired_name, desired_size, notes)
       VALUES ($1,$2,$3,$4,$5)`,
      [ctx.from.id, ctx.from.username || '', req.name || '-', req.size || '', notes]
    );
  } catch (e) {
    console.error('insert product_request error:', e.message);
  }

  // Avisa admins (directe a ADMIN_CHAT_IDS)
  const text =
    `📥 *Nova petició de producte*\n` +
    `Usuari: ${ctx.from.username ? '@'+ctx.from.username : ctx.from.id}\n` +
    `Nom: ${req.name}\n` +
    `Talla: ${req.size || '-'}\n` +
    (notes ? `Notes: ${notes}\n` : '');
  for (const chatId of ADMIN_CHAT_IDS) {
    try { await bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' }); } catch {}
  }

  setS(ctx.from.id, { ...s, step: null, req: null });
  return ctx.reply('Gràcies! Ho buscarem i et direm alguna cosa tan aviat com puguem. 🙌');
});

/* ───────── Infra (webhook + rutes PayPal) ───────── */
const USE_WEBHOOK = String(process.env.USE_WEBHOOK).toLowerCase() === 'true';
const PORT = Number(process.env.PORT || 3000);
const APP_URL = process.env.APP_URL;
const HOOK_PATH = process.env.HOOK_PATH || '/tghook';

if (USE_WEBHOOK) {
  const express = (await import('express')).default;
  const app = express();

  app.get('/paypal/return', async (req, res) => {
    try {
      const token = String(req.query.token || '');        // PayPal order id
      const orderId = Number(req.query.order_id || '0');  // nostra order id
      if (!token || !orderId) throw new Error('Paràmetres invàlids');

      const capture = await paypalCaptureOrder(token);
      const paid = (capture?.status === 'COMPLETED') || (capture?.purchase_units?.[0]?.payments?.captures?.[0]?.status === 'COMPLETED');

      await db.setOrderPaymentInfo(orderId, {
        payment_status: paid ? 'PAID' : 'UNPAID',
        payment_id: token,
        payment_receipt_json: capture,
        paid_at: paid ? new Date().toISOString() : null,
        notified_at: paid ? new Date().toISOString() : null // evitem dobles avisos
      });

      const o = await db.getOrderById(orderId);

      // client
      try {
        await bot.telegram.sendMessage(o.user_id, paid
          ? `✅ Pagament rebut a PayPal. La teva comanda #${orderId} ha quedat confirmada.`
          : `❗️ Pagament no completat. La teva comanda #${orderId} segueix pendent. Torna a /cistella per reintentar.`);
      } catch {}

      // admin NOMÉS si pagada
      if (paid) await notifyAdminsOfOrder(o);

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html><body style="font-family: sans-serif; text-align:center; padding:40px">
          <h2>${paid ? 'Pagament completat ✅' : 'Pagament no completat'}</h2>
          <p>Comanda #${orderId}</p>
          <p>Pots tornar a Telegram.</p>
        </body></html>
      `);
    } catch (e) {
      console.error('paypal/return error:', e.message);
      res.status(500).send('Error processant el retorn de PayPal.');
    }
  });

  app.get('/paypal/cancel', async (req, res) => {
    const orderId = Number(req.query.order_id || '0');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`
      <html><body style="font-family: sans-serif; text-align:center; padding:40px">
        <h2>Pagament cancel·lat</h2>
        <p>Comanda #${orderId || '-'}. Pots tornar a Telegram i reintentar des de la cistella.</p>
      </body></html>
    `);
  });

  // Webhook PayPal (POST)
  const expressJsonForPaypal = (await import('express')).default.json({
    verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); }
  });

  app.post('/paypal/webhook', expressJsonForPaypal, async (req, res) => {
    try {
      // 1) Verificar signatura amb l’API de PayPal
      const hdr = {
        'transmission_id': req.header('paypal-transmission-id'),
        'transmission_time': req.header('paypal-transmission-time'),
        'transmission_sig': req.header('paypal-transmission-sig'),
        'cert_url': req.header('paypal-cert-url'),
        'auth_algo': req.header('paypal-auth-algo')
      };
      const event = req.body;

      if (!PAYPAL_WEBHOOK_ID) throw new Error('Falta PAYPAL_WEBHOOK_ID');
      const access = await paypalAccessToken();
      const vr = await fetch(`${PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${access}` },
        body: JSON.stringify({
          auth_algo: hdr.auth_algo,
          cert_url: hdr.cert_url,
          transmission_id: hdr.transmission_id,
          transmission_sig: hdr.transmission_sig,
          transmission_time: hdr.transmission_time,
          webhook_id: PAYPAL_WEBHOOK_ID,
          webhook_event: event
        })
      }).then(r => r.json());

      if (vr?.verification_status !== 'SUCCESS') {
        console.warn('PayPal webhook: verificació fallida', vr);
        return res.status(400).send('invalid');
      }

      // 2) Gestionar esdeveniments
      const type = event.event_type;

      async function findOurOrderByPayPalOrderId(ppOrderId) {
        return (await pool.query(`SELECT * FROM orders WHERE payment_id=$1 ORDER BY id DESC LIMIT 1`, [ppOrderId])).rows[0];
      }

      if (type === 'CHECKOUT.ORDER.APPROVED') {
        const ppOrderId = event.resource?.id;
        if (ppOrderId) {
          const our = await findOurOrderByPayPalOrderId(ppOrderId);
          if (our && our.payment_status !== 'PAID') {
            const cap = await paypalCaptureOrder(ppOrderId);
            const paid = (cap?.status === 'COMPLETED') ||
                         (cap?.purchase_units?.[0]?.payments?.captures?.[0]?.status === 'COMPLETED');
            await db.setOrderPaymentInfo(our.id, {
              payment_status: paid ? 'PAID' : 'UNPAID',
              payment_id: ppOrderId,
              payment_receipt_json: cap,
              paid_at: paid ? new Date().toISOString() : null
            });
            const updated = await db.getOrderById(our.id);
            if (paid && !updated.notified_at) {
              await notifyAdminsOfOrder(updated);
              await db.setOrderPaymentInfo(updated.id, { notified_at: new Date().toISOString() });
            }
          }
        }
      }

      if (type === 'PAYMENT.CAPTURE.COMPLETED') {
        const capture = event.resource;
        const ppOrderId =
          capture?.supplementary_data?.related_ids?.order_id
          || (capture?.links || []).find(l => l.rel === 'up')?.href?.split('/')?.pop();

        if (ppOrderId) {
          const our = await findOurOrderByPayPalOrderId(ppOrderId);
          if (our && our.payment_status !== 'PAID') {
            await db.setOrderPaymentInfo(our.id, {
              payment_status: 'PAID',
              payment_id: ppOrderId,
              payment_receipt_json: capture,
              paid_at: new Date().toISOString()
            });
            const updated = await db.getOrderById(our.id);
            if (!updated.notified_at) {
              await notifyAdminsOfOrder(updated);
              await db.setOrderPaymentInfo(updated.id, { notified_at: new Date().toISOString() });
            }
          }
        }
      }

      res.send('OK');
    } catch (e) {
      console.error('paypal/webhook error:', e.message);
      res.status(200).send('OK'); // Respondre 200 per evitar reintents continus
    }
  });

  app.use(bot.webhookCallback(HOOK_PATH));
  if (!APP_URL) throw new Error('Falta APP_URL per al webhook');
  await bot.telegram.setWebhook(`${APP_URL}${HOOK_PATH}`);

  app.get('/', (_, res) => res.send('OK'));
  app.listen(PORT, () => console.log('Listening on', PORT));
} else {
  await bot.launch();
  console.log('Bot running (long polling)');
}

/* ───────── CERCADOR PAGINAT (AL FINAL) ───────── */
async function renderSearch(ctx, q, page) {
  const total = await db.countBySearch(q);
  if (!total) {
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback('📨 Demanar aquest producte', `REQ|${encodeURIComponent(q)}`)]
    ]);
    return ctx.reply(`No he trobat res per «${q}».\nVols que el busquem per tu?`, kb);
  }
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rows = await db.pageBySearch(q, PAGE_SIZE, page * PAGE_SIZE);
  const items = rows.map(p => [Markup.button.callback(`🧩 ${p.name}`, `P_${p.id}`)]);
  const nav = [];
  if (page > 0) nav.push(Markup.button.callback('◀️ Ant', `SEARCH|${encodeURIComponent(q)}|${page - 1}`));
  nav.push(Markup.button.callback(`Pàg. ${page + 1}/${pages}`, 'NOOP'));
  if (page < pages - 1) nav.push(Markup.button.callback('▶️ Seg', `SEARCH|${encodeURIComponent(q)}|${page + 1}`));
  items.push(nav);
  const title = `Resultats per «${q}» (${total})`;
  return ctx.reply(title, Markup.inlineKeyboard(items));
}
bot.action(/^SEARCH\|(.+)\|(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const q = decodeURIComponent(ctx.match[1]);
  const page = Number(ctx.match[2]);
  try {
    const total = await db.countBySearch(q);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const rows = await db.pageBySearch(q, PAGE_SIZE, page * PAGE_SIZE);
    const items = rows.map(p => [Markup.button.callback(`🧩 ${p.name}`, `P_${p.id}`)]);
    const nav = [];
    if (page > 0) nav.push(Markup.button.callback('◀️ Ant', `SEARCH|${encodeURIComponent(q)}|${page - 1}`));
    nav.push(Markup.button.callback(`Pàg. ${page + 1}/${pages}`, 'NOOP'));
    if (page < pages - 1) nav.push(Markup.button.callback('▶️ Seg', `SEARCH|${encodeURIComponent(q)}|${page + 1}`));
    items.push(nav);
    await ctx.editMessageText(`Resultats per «${q}» (${total})`, Markup.inlineKeyboard(items));
  } catch {
    await renderSearch(ctx, q, page);
  }
});

/* Cerca lliure: activa el paginador */
bot.on('text', async (ctx) => {
  const s = getS(ctx.from.id);
  if (['ASK_SIZE','ASK_SIZE_EDIT','ASK_NAME','ASK_ADDR','REQ_SIZE','REQ_NOTES'].includes(s.step)) return;

  const q = (ctx.message.text || '').trim();
  if (!q) return;

  const lower = q.toLowerCase();
  if (['categories', '📂 categories', 'marques', '🏷️ marques', 'veure cistella', '🧺 veure cistella'].includes(lower)) return;

  await db.insertQuery(ctx.from.id, ctx.from.username || '', q);
  return renderSearch(ctx, q, 0);
});

process.once('SIGINT', () => { try { bot.stop('SIGINT'); } catch {} });
process.once('SIGTERM', () => { try { bot.stop('SIGTERM'); } catch {} });

