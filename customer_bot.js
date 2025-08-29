// customer_bot.js — Categories/Marques amb o sense emoji + flux compra + cap menció d'admin
import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import pkg from 'pg';
const { Pool } = pkg;

/* DB */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false
});

async function ensureSchema() {
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS brand TEXT;`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT;`);
}
await ensureSchema();

const db = {
  listProductsLike: async (q) =>
    (await pool.query('SELECT * FROM products WHERE name ILIKE $1 ORDER BY id DESC LIMIT 25',[q])).rows,
  getProduct: async (id) =>
    (await pool.query('SELECT * FROM products WHERE id=$1',[id])).rows[0],
  getVariantsOfProduct: async (pid) =>
    (await pool.query('SELECT * FROM variants WHERE product_id=$1 ORDER BY id ASC',[pid])).rows,
  getVariant: async (id) =>
    (await pool.query('SELECT * FROM variants WHERE id=$1',[id])).rows[0],
  decStock: async (variant_id, qty) =>
    pool.query('UPDATE variants SET stock = stock - $1 WHERE id=$2 AND stock >= $1',[qty,variant_id]),
  insertOrder: async (user_id, username, items_json, total_cents, total_cost_cents) =>
    pool.query('INSERT INTO orders(user_id, username, items_json, total_cents, total_cost_cents) VALUES($1,$2,$3,$4,$5)',[user_id,username,items_json,total_cents,total_cost_cents]),
  insertQuery: async (user_id, username, text) =>
    pool.query('INSERT INTO queries(user_id, username, text) VALUES($1,$2,$3)',[user_id,username,text]),
  topCategories: async () =>
    (await pool.query(`SELECT category, COUNT(*) n FROM products WHERE COALESCE(category,'')<>'' GROUP BY 1 ORDER BY n DESC LIMIT 12`)).rows,
  topBrands: async () =>
    (await pool.query(`SELECT brand, COUNT(*) n FROM products WHERE COALESCE(brand,'')<>'' GROUP BY 1 ORDER BY n DESC LIMIT 20`)).rows,
  countByCategory: async (c) =>
    Number((await pool.query(`SELECT COUNT(*) FROM products WHERE category ILIKE $1`,[c])).rows[0].count),
  pageByCategory: async (c, limit, offset) =>
    (await pool.query(`SELECT * FROM products WHERE category ILIKE $1 ORDER BY id DESC LIMIT $2 OFFSET $3`,[c,limit,offset])).rows,
  countByBrand: async (b) =>
    Number((await pool.query(`SELECT COUNT(*) FROM products WHERE brand ILIKE $1`,[b])).rows[0].count),
  pageByBrand: async (b, limit, offset) =>
    (await pool.query(`SELECT * FROM products WHERE brand ILIKE $1 ORDER BY id DESC LIMIT $2 OFFSET $3`,[b,limit,offset])).rows,
};

const BOT_TOKEN = process.env.CUSTOMER_BOT_TOKEN || process.env.CLIENT_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('Falta CUSTOMER_BOT_TOKEN o CLIENT_BOT_TOKEN');

const bot = new Telegraf(BOT_TOKEN);
const sessions = new Map();
const getS = (id) => sessions.get(id) || {};
const setS = (id, s) => sessions.set(id, s);
const toEuro = (c) => (c/100).toLocaleString('es-ES',{style:'currency',currency:'EUR'});
const PAGE = 10;
const enc = (s) => encodeURIComponent(s || '');
const dec = (s) => decodeURIComponent(s || '');

/* ===== Menú ===== */
bot.start((ctx) => {
  setS(ctx.from.id, {});
  ctx.reply(
    '👋 Benvingut/da! Pots cercar escrivint (ex: "samba") o navegar pel catàleg:',
    Markup.keyboard([['📂 Categories','🏷️ Marques'],['🧺 Veure cistella']]).resize()
  );
});
bot.command('categories', (ctx)=> bot.emit('hears','📂 Categories',ctx));
bot.command('marques',    (ctx)=> bot.emit('hears','🏷️ Marques',ctx));
bot.command('cistella',   (ctx)=> bot.emit('hears','🧺 Veure cistella',ctx));

/* Accepta amb i sense emoji (i indiferent a majúscules) */
const mktest = (t) => (s) => new RegExp(`^(${t}|.*${t.replace(/\s+/g,'.*')}).*$`,'i').test(s);
const isCat    = mktest('categories');
const isBrand  = mktest('marques');
const isCart   = mktest('veure\\s+cistella');

bot.hears([/📂\s*Categories/i, isCat], async (ctx) => {
  const cats = await db.topCategories();
  if (!cats.length) return ctx.reply('Encara no hi ha categories disponibles.');
  const kb = cats.map(c => [Markup.button.callback(`${c.category} (${c.n})`, `CAT|${enc(c.category)}|0`)]);
  await ctx.reply('Tria una categoria:', Markup.inlineKeyboard(kb));
});

bot.hears([/🏷️\s*Marques/i, isBrand], async (ctx) => {
  const brs = await db.topBrands();
  if (!brs.length) return ctx.reply('Encara no hi ha marques disponibles.');
  const rows = brs.map(b => [Markup.button.callback(`${b.brand} (${b.n})`, `BRAND|${enc(b.brand)}|0`)]);
  await ctx.reply('Tria una marca:', Markup.inlineKeyboard(rows));
});

bot.hears([/🧺\s*Veure\s*Cistella/i, isCart], (ctx) => {
  const s = getS(ctx.from.id);
  if (!s.cart || !s.cart.length) return ctx.reply('La cistella és buida.');
  const lines = s.cart.map((it,i)=>`#${i+1} ${it.productName} — ${it.variantLabel} ×${it.qty} = ${toEuro(it.price_cents*it.qty)}`);
  const total = s.cart.reduce((a,it)=>a+it.price_cents*it.qty,0);
  ctx.reply(['Cistella:',...lines,`Total: ${toEuro(total)}`].join('\n'),
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirmar comanda','CHECKOUT')],
      [Markup.button.callback('🧹 Buidar cistella','CLEAR_CART')]
    ]));
});

/* ===== Paginació llistes ===== */
async function renderList(ctx, mode, value, page) {
  const offset = page*PAGE;
  let total=0, rows=[];
  if (mode==='CAT') { total = await db.countByCategory(value); rows = await db.pageByCategory(value,PAGE,offset); }
  if (mode==='BRAND') { total = await db.countByBrand(value); rows = await db.pageByBrand(value,PAGE,offset); }
  if (!rows.length) return ctx.answerCbQuery('Sense productes');

  const pages = Math.max(1, Math.ceil(total/PAGE));
  const items = rows.map(p => [Markup.button.callback(`🧩 ${p.name}`, `P_${p.id}`)]);
  const nav = [];
  if (page>0) nav.push(Markup.button.callback('◀️ Ant', `${mode}|${enc(value)}|${page-1}`));
  nav.push(Markup.button.callback(`Pàg. ${page+1}/${pages}`, 'NOOP'));
  if (page<pages-1) nav.push(Markup.button.callback('▶️ Seg', `${mode}|${enc(value)}|${page+1}`));
  items.push(nav);
  const title = mode==='CAT' ? `Categoria: ${value}` : `Marca: ${value}`;

  try { await ctx.editMessageText(`${title}\nTria un producte:`, Markup.inlineKeyboard(items)); }
  catch { await ctx.reply(`${title}\nTria un producte:`, Markup.inlineKeyboard(items)); }
}
bot.action(/^(CAT|BRAND)\|(.+)\|(\d+)$/, async (ctx) => {
  const mode = ctx.match[1]; const value = decodeURIComponent(ctx.match[2]); const page = Number(ctx.match[3]);
  await ctx.answerCbQuery(); return renderList(ctx, mode, value, page);
});
bot.action('NOOP', (ctx)=>ctx.answerCbQuery());

/* ===== Cerca lliure (si no estem demanant quantitat) ===== */
bot.on('text', async (ctx, next) => {
  const s = getS(ctx.from.id);
  if (s.step === 'ASK_QTY') return next();

  const q = ctx.message.text.trim();
  if (isCat(q) || isBrand(q) || isCart(q)) return; // ja cobert pels hears
  await db.insertQuery(ctx.from.id, ctx.from.username||'', q);

  const rows = await db.listProductsLike(`%${q}%`);
  if (!rows.length) return ctx.reply('No he trobat res amb aquesta cerca. Prova una altra paraula o obre el catàleg.');
  const kb = rows.map(p => [Markup.button.callback(`🧩 ${p.name}`, `P_${p.id}`)]);
  await ctx.reply('He trobat això. Tria un producte:', Markup.inlineKeyboard(kb));
});

/* ===== Producte → Variants → Quantitat ===== */
bot.action(/P_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const productId = Number(ctx.match[1]);
  const p = await db.getProduct(productId);
  if (!p) return ctx.answerCbQuery('Producte no trobat');

  const vs = await db.getVariantsOfProduct(productId);
  if (!vs.length) return ctx.reply(`«${p.name}» no té variants disponibles ara mateix.`);
  const kb = vs.map(v => [Markup.button.callback(`${v.option_value} — ${toEuro(v.price_cents)} (${v.stock} stock)`, `V_${v.id}`)]);
  try { await ctx.editMessageText(`Opcions per a «${p.name}»:`, Markup.inlineKeyboard(kb)); }
  catch { await ctx.reply(`Opcions per a «${p.name}»:`, Markup.inlineKeyboard(kb)); }
});

bot.action(/V_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const variantId = Number(ctx.match[1]);
  const v = await db.getVariant(variantId);
  if (!v) return ctx.answerCbQuery('Variant no disponible');
  const p = await db.getProduct(v.product_id);
  const s = getS(ctx.from.id);
  setS(ctx.from.id, { ...s, step:'ASK_QTY', productId: p.id, variantId: v.id });
  await ctx.reply(`Quantes unitats vols de «${p.name} — ${v.option_value}»? Escriu un número (stock: ${v.stock}).`);
});

/* ===== Demanar quantitat ===== */
bot.on('text', async (ctx) => {
  const s = getS(ctx.from.id);
  if (s.step !== 'ASK_QTY') return;
  const qty = Number(ctx.message.text.replace(/[^0-9]/g,''));
  if (!qty || qty < 1) return ctx.reply('Posa un número vàlid (1, 2, 3, …)');

  const v = await db.getVariant(s.variantId);
  const p = await db.getProduct(s.productId);
  if (!v || !p) return ctx.reply('Ha expirat la selecció. Torna-ho a provar.');
  if (qty > v.stock) return ctx.reply(`Només queden ${v.stock} unitats en stock.`);

  const item = { productId: p.id, productName: p.name, variantId: v.id, variantLabel: v.option_value, price_cents: v.price_cents, cost_cents: v.cost_cents||0, qty };
  const cart = (s.cart || []).concat(item);
  setS(ctx.from.id, { step:null, cart });
  const total = cart.reduce((a,it)=>a+it.price_cents*it.qty,0);

  await ctx.reply(
    `Afegit a la cistella: ${p.name} — ${v.option_value} ×${qty}.\nTotal actual: ${toEuro(total)}`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🧺 Veure/Confirmar', 'CHECKOUT')],
      [Markup.button.callback('🛍️ Continuar comprant', 'NOOP')]
    ])
  );
});

/* ===== Checkout / Cistella ===== */
bot.action('CHECKOUT', async (ctx) => {
  await ctx.answerCbQuery();
  const s = getS(ctx.from.id);
  if (!s.cart || !s.cart.length) return ctx.reply('Cistella buida.');

  for (const it of s.cart) {
    const res = await db.decStock(it.variantId, it.qty);
    if (res.rowCount === 0) return ctx.reply(`Sense stock suficient per ${it.productName} — ${it.variantLabel}.`);
  }

  const total = s.cart.reduce((a,it)=>a+it.price_cents*it.qty,0);
  const totalCost = s.cart.reduce((a,it)=>a+(it.cost_cents||0)*it.qty,0);
  await db.insertOrder(ctx.from.id, ctx.from.username||'', s.cart, total, totalCost);
  setS(ctx.from.id, { cart: [] });

  try { await ctx.editMessageText(`✅ Comanda registrada! Total: ${toEuro(total)}. Ens posarem en contacte.`); }
  catch { await ctx.reply(`✅ Comanda registrada! Total: ${toEuro(total)}. Ens posarem en contacte.`); }
});

bot.action('CLEAR_CART', async (ctx) => {
  await ctx.answerCbQuery();
  setS(ctx.from.id, { cart: [] });
  try { await ctx.editMessageText('🧹 Cistella buidada.'); }
  catch { await ctx.reply('🧹 Cistella buidada.'); }
});

bot.catch((err, ctx) => { console.error('Customer bot error', err); try { ctx.reply('Sembla que hi ha hagut un error.'); } catch {} });

/* ARRANQUE */
const USE_WEBHOOK = String(process.env.USE_WEBHOOK).toLowerCase() === 'true';
const PORT = Number(process.env.PORT || 3000);
const APP_URL = process.env.APP_URL;
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
