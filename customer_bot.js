// customer_bot.js — Telegraf + PostgreSQL + Webhook (Railway-ready)
import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import pkg from 'pg';

const { Pool } = pkg;

/* =========================
   1) BASE DE DADES (PG)
   ========================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false
});

async function initDb() {
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
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id BIGINT,
      username TEXT,
      items_json JSONB NOT NULL,
      total_cents INTEGER NOT NULL,
      total_cost_cents INTEGER DEFAULT 0,
      status TEXT DEFAULT 'PENDING',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS queries (
      id SERIAL PRIMARY KEY,
      user_id BIGINT,
      username TEXT,
      text TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

const db = {
  listProducts: async () => {
    const r = await pool.query('SELECT * FROM products ORDER BY id DESC LIMIT 100');
    return r.rows;
  },
  listProductsLike: async (q) => {
    const r = await pool.query('SELECT * FROM products WHERE name ILIKE $1 ORDER BY id DESC LIMIT 25', [q]);
    return r.rows;
  },
  getProduct: async (id) => {
    const r = await pool.query('SELECT * FROM products WHERE id=$1', [id]);
    return r.rows[0];
  },
  getVariantsOfProduct: async (pid) => {
    const r = await pool.query('SELECT * FROM variants WHERE product_id=$1 ORDER BY id ASC', [pid]);
    return r.rows;
  },
  getVariant: async (id) => {
    const r = await pool.query('SELECT * FROM variants WHERE id=$1', [id]);
    return r.rows[0];
  },
  decStock: async (variant_id, qty) => {
    return pool.query('UPDATE variants SET stock = stock - $1 WHERE id=$2 AND stock >= $1', [qty, variant_id]);
  },
  insertOrder: async (user_id, username, items_json, total_cents, total_cost_cents) => {
    return pool.query(
      'INSERT INTO orders(user_id, username, items_json, total_cents, total_cost_cents) VALUES($1,$2,$3,$4,$5)',
      [user_id, username, items_json, total_cents, total_cost_cents]
    );
  },
  insertQuery: async (user_id, username, text) => {
    return pool.query('INSERT INTO queries(user_id, username, text) VALUES($1,$2,$3)', [user_id, username, text]);
  }
};

const toEuro = (cents) =>
  (cents / 100).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

/* =========================
   2) BOT (Telegraf)
   ========================= */
const BOT_TOKEN = process.env.CUSTOMER_BOT_TOKEN || process.env.CLIENT_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('Falta CUSTOMER_BOT_TOKEN o CLIENT_BOT_TOKEN');

await initDb();
const bot = new Telegraf(BOT_TOKEN);

// (Opcional) avisar admins en confirmar comanda
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || '').split(',').filter(Boolean);

// Sessió simple en memòria
const sessions = new Map(); // userId -> { step, productId, variantId, cart: [] }
const getS = (id) => sessions.get(id) || {};
const setS = (id, s) => sessions.set(id, s);

/* =========================
   3) HANDLERS
   ========================= */
bot.start((ctx) => {
  setS(ctx.from.id, {});
  ctx.reply(
    '👋 Benvingut/da! Escriu què busques (ex: "sabatilles"). També: /catalog',
    Markup.keyboard([['🛍️ Catàleg', '🧺 Veure cistella']]).resize()
  );
});

bot.hears('🛍️ Catàleg', async (ctx) => {
  const rows = await db.listProducts();
  if (!rows.length) return ctx.reply('Encara no hi ha productes.');
  const kb = rows.map((p) => [Markup.button.callback(`🧩 ${p.name}`, `P_${p.id}`)]);
  await ctx.reply('Tria un producte:', Markup.inlineKeyboard(kb));
});

bot.command('catalog', async (ctx) => bot.emit('hears', '🛍️ Catàleg', ctx));

bot.hears('🧺 Veure cistella', async (ctx) => {
  const s = getS(ctx.from.id);
  if (!s.cart || !s.cart.length) return ctx.reply('La cistella és buida.');
  const lines = s.cart.map(
    (it, i) => `#${i + 1} ${it.productName} — ${it.variantLabel} ×${it.qty} = ${toEuro(it.price_cents * it.qty)}`
  );
  const total = s.cart.reduce((acc, it) => acc + it.price_cents * it.qty, 0);
  return ctx.reply(
    ['Cistella:', ...lines, `\nTotal: ${toEuro(total)}`].join('\n'),
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirmar comanda', 'CHECKOUT')],
      [Markup.button.callback('🧹 Buidar cistella', 'CLEAR_CART')]
    ])
  );
});

// Producte → variants
bot.action(/P_(\d+)/, async (ctx) => {
  const productId = Number(ctx.match[1]);
  const p = await db.getProduct(productId);
  if (!p) return ctx.answerCbQuery('Producte no trobat');
  const vs = await db.getVariantsOfProduct(productId);
  if (!vs.length) return ctx.editMessageText(`«${p.name}» encara no té variants.`);
  const kb = vs.map((v) => [
    Markup.button.callback(`${v.option_value} — ${toEuro(v.price_cents)} (${v.stock} en stock)`, `V_${v.id}`)
  ]);
  await ctx.editMessageText(`Opcions per a «${p.name}»:`, Markup.inlineKeyboard(kb));
});

// Variant → demanar quantitat
bot.action(/V_(\d+)/, async (ctx) => {
  const variantId = Number(ctx.match[1]);
  const v = await db.getVariant(variantId);
  if (!v) return ctx.answerCbQuery('Variant no disponible');
  const p = await db.getProduct(v.product_id);
  const s = getS(ctx.from.id);
  setS(ctx.from.id, { ...s, step: 'ASK_QTY', productId: p.id, variantId: v.id });
  await ctx.reply(`Quantes unitats vols de «${p.name} — ${v.option_value}»? Escriu un número (stock: ${v.stock}).`);
});

// Continuar comprant
bot.action('CONT_SHOP', (ctx) => ctx.reply('Escriu què busques o usa /catalog.'));

// Handler únic de text (gestiona quantitat o cerca)
bot.on('text', async (ctx) => {
  const s = getS(ctx.from.id);
  const msg = ctx.message.text.trim();

  // Si estem demanant quantitat
  if (s.step === 'ASK_QTY') {
    const qty = Number(msg.replace(/[^0-9]/g, ''));
    if (!qty || qty < 1) return ctx.reply('Posa un número vàlid (1, 2, 3, …)');

    const v = await db.getVariant(s.variantId);
    const p = await db.getProduct(s.productId);
    if (!v || !p) return ctx.reply('Ha expirat la selecció. Torna-ho a provar.');
    if (qty > v.stock) return ctx.reply(`Només queden ${v.stock} unitats en stock.`);

    const item = {
      productId: p.id,
      productName: p.name,
      variantId: v.id,
      variantLabel: v.option_value,
      price_cents: v.price_cents,
      cost_cents: v.cost_cents || 0,
      qty
    };

    const cart = (s.cart || []).concat(item);
    setS(ctx.from.id, { step: null, cart });

    const total = cart.reduce((acc, it) => acc + it.price_cents * it.qty, 0);
    return ctx.reply(
      `Afegit a la cistella: ${p.name} — ${v.option_value} ×${qty}.\nTotal actual: ${toEuro(total)}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('🧺 Veure/Confirmar', 'CHECKOUT')],
        [Markup.button.callback('🛍️ Continuar comprant', 'CONT_SHOP')]
      ])
    );
  }

  // Si NO estem demanant quantitat → cerca
  if (['🛍️ Catàleg', '🧺 Veure cistella'].includes(msg)) return; // ja cobert pels hears
  await db.insertQuery(ctx.from.id, ctx.from.username || '', msg);
  const rows = await db.listProductsLike(`%${msg}%`);
  if (!rows.length) return ctx.reply('No he trobat res amb aquesta cerca. Prova un altre nom o usa /catalog.');
  const kb = rows.map((p) => [Markup.button.callback(`🧩 ${p.name}`, `P_${p.id}`)]);
  return ctx.reply('He trobat això. Tria un producte:', Markup.inlineKeyboard(kb));
});

// Checkout
bot.action('CHECKOUT', async (ctx) => {
  const s = getS(ctx.from.id);
  if (!s.cart || !s.cart.length) return ctx.answerCbQuery('Cistella buida');

  // descomptar stock línia a línia
  for (const it of s.cart) {
    const res = await db.decStock(it.variantId, it.qty);
    if (res.rowCount === 0) {
      return ctx.reply(`Sense stock suficient per ${it.productName} — ${it.variantLabel}. Actualitza la cistella.`);
    }
  }

  const total = s.cart.reduce((acc, it) => acc + it.price_cents * it.qty, 0);
  const totalCost = s.cart.reduce((acc, it) => acc + (it.cost_cents || 0) * it.qty, 0);

  await db.insertOrder(ctx.from.id, ctx.from.username || '', s.cart, total, totalCost);
  setS(ctx.from.id, { cart: [] });

  await ctx.editMessageText(`✅ Comanda registrada! Total: ${toEuro(total)}. Ens posarem en contacte.`);

  // Notificació opcional a admins
  if (ADMIN_CHAT_IDS.length) {
    const msg = `📦 Nova comanda de @${ctx.from.username || 'usuari'} (${ctx.from.id}) — Total ${toEuro(total)}`;
    for (const chatId of ADMIN_CHAT_IDS) {
      try { await bot.telegram.sendMessage(chatId, msg); } catch (e) { /* ignore */ }
    }
  }
});

bot.action('CLEAR_CART', (ctx) => {
  setS(ctx.from.id, { cart: [] });
  ctx.editMessageText('🧹 Cistella buidada.');
});

// Errors
bot.catch((err, ctx) => {
  console.error('Bot error', err);
  try { ctx.reply('Sembla que hi ha hagut un error. Torna-ho a provar.'); } catch (e) {}
});

/* =========================
   4) ARRENCADA (Webhook o Polling)
   ========================= */
const USE_WEBHOOK = String(process.env.USE_WEBHOOK).toLowerCase() === 'true';
const PORT = Number(process.env.PORT || 3000);
const APP_URL = process.env.APP_URL;           // ex: https://<subdomini-client>.up.railway.app
const HOOK_PATH = process.env.HOOK_PATH || '/tghook';

if (USE_WEBHOOK) {
  const express = (await import('express')).default;
  const app = express();
  app.use(bot.webhookCallback(HOOK_PATH));
  if (!APP_URL) throw new Error('Falta APP_URL per al webhook');
  await bot.telegram.setWebhook(`${APP_URL}${HOOK_PATH}`);
  app.get('/', (_, res) => res.send('OK'));
  app.listen(PORT, () => console.log('Listening on', PORT));
} else {
  await bot.launch();
  console.log('Bot running (long polling)');
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
