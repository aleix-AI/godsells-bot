// customer_bot.js — Catàleg per categories/marques + targeta producte (foto/preu) + talla demanada al client
import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import pkg from 'pg';
const { Pool } = pkg;

/* ───────── DB ───────── */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false
});

async function ensureSchema() {
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS brand TEXT;`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT;`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS base_price_cents INT;`);
  await pool.query(`ALTER TABLE orders   ADD COLUMN IF NOT EXISTS total_cost_cents INT DEFAULT 0;`);
}
await ensureSchema();

const db = {
  listProductsLike: async (q) =>
    (await pool.query('SELECT * FROM products WHERE name ILIKE $1 ORDER BY id DESC LIMIT 25',[q])).rows,
  getProduct: async (id) =>
    (await pool.query('SELECT * FROM products WHERE id=$1',[id])).rows[0],
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
  insertOrder: async (user_id, username, items, total_cents, total_cost_cents=0) =>
    pool.query('INSERT INTO orders(user_id, username, items_json, total_cents, total_cost_cents) VALUES($1,$2,$3,$4,$5)',
      [user_id, username, JSON.stringify(items), total_cents, total_cost_cents]),
  insertQuery: async (user_id, username, text) =>
    pool.query('INSERT INTO queries(user_id, username, text) VALUES($1,$2,$3)',[user_id,username,text]),
};

/* ───────── Bot ───────── */
const BOT_TOKEN = process.env.CUSTOMER_BOT_TOKEN || process.env.CLIENT_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('Falta CUSTOMER_BOT_TOKEN o CLIENT_BOT_TOKEN');
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || '').split(',').map(s=>s.trim()).filter(Boolean);

const bot = new Telegraf(BOT_TOKEN);
const sessions = new Map();
const getS = (id) => sessions.get(id) || {};
const setS = (id, s) => sessions.set(id, s);

const toEuro = (c) => (Number(c||0)/100).toLocaleString('es-ES',{style:'currency',currency:'EUR'});
const PAGE = 10;
const enc = (s) => encodeURIComponent(s || '');
const dec = (s) => decodeURIComponent(s || '');
const trim = (t, n=300) => (t||'').replace(/\s+/g,' ').trim().slice(0,n);

/* ───────── UI bàsica ───────── */
bot.start((ctx) => {
  setS(ctx.from.id, {});
  ctx.reply(
    '👋 Benvingut/da! Escriu per cercar (ex: "samba") o navega:',
    Markup.keyboard([['📂 Categories','🏷️ Marques'],['🧺 Veure cistella']]).resize()
  );
});
bot.command('categories', (ctx)=> bot.emit('hears','📂 Categories',ctx));
bot.command('marques',    (ctx)=> bot.emit('hears','🏷️ Marques',ctx));
bot.command('cistella',   (ctx)=> bot.emit('hears','🧺 Veure cistella',ctx));

/* Accepta sense emoji / majúscules */
const isCat   = (s) => /^(\p{Emoji_Presentation}?\s*)?categories$/iu.test(s.trim());
const isBrand = (s) => /^(\p{Emoji_Presentation}?\s*)?marques$/iu.test(s.trim());
const isCart  = (s) => /^(\p{Emoji_Presentation}?\s*)?veure\s+cistella$/iu.test(s.trim());

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

bot.hears([/🧺\s*Veure\s*Cistella/i, isCart], (ctx) => showCart(ctx));

/* ───────── Llistats amb paginació ───────── */
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
  const mode = ctx.match[1]; const value = dec(ctx.match[2]); const page = Number(ctx.match[3]);
  await ctx.answerCbQuery(); return renderList(ctx, mode, value, page);
});
bot.action('NOOP', (ctx)=>ctx.answerCbQuery());

/* ───────── Cerca lliure (si no demanem talla/quantitat) ───────── */
bot.on('text', async (ctx, next) => {
  const s = getS(ctx.from.id);
  if (s.step === 'ASK_SIZE' || s.step === 'ASK_QTY') return next();

  const q = ctx.message.text.trim();
  if (isCat(q) || isBrand(q) || isCart(q)) return;
  await db.insertQuery(ctx.from.id, ctx.from.username||'', q);

  const rows = await db.listProductsLike(`%${q}%`);
  if (!rows.length) return ctx.reply('No he trobat res amb aquesta cerca. Prova una altra paraula o obre el catàleg.');
  const kb = rows.map(p => [Markup.button.callback(`🧩 ${p.name}`, `P_${p.id}`)]);
  await ctx.reply('He trobat això. Tria un producte:', Markup.inlineKeyboard(kb));
});

/* ───────── Targeta producte + demanar talla ───────── */
function priceText(p) {
  return p.base_price_cents ? toEuro(p.base_price_cents) : 'Preu a consultar';
}
function sizeSuggestionsFor(p) {
  if ((p.category||'').toLowerCase().includes('roba')) {
    return ['XS','S','M','L','XL','XXL'];
  }
  // calçat per defecte
  return ['36','36.5','37','37.5','38','38.5','39','40','40.5','41','42','42.5','43','44','44.5','45','46'];
}

async function showProductCard(ctx, p) {
  const caption = `🧩 ${p.name}\n💶 ${priceText(p)}\n\n${trim(p.description, 300)}`;
  const buttons = [
    [Markup.button.callback('➕ Afegir (tria talla)', `ASKSZ_${p.id}`)],
    [Markup.button.callback('🧺 Veure cistella', 'CHECKOUT')]
  ];
  try {
    if (p.image_url) {
      await ctx.replyWithPhoto(p.image_url, { caption, ...Markup.inlineKeyboard(buttons) });
    } else {
      await ctx.reply(caption, Markup.inlineKeyboard(buttons));
    }
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

// Inicia el flux per demanar talla (amb suggeriments + text lliure)
bot.action(/ASKSZ_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const pid = Number(ctx.match[1]);
  const p = await db.getProduct(pid);
  if (!p) return;
  const s = getS(ctx.from.id);
  setS(ctx.from.id, { ...s, step:'ASK_SIZE', productId: pid });

  const sizes = sizeSuggestionsFor(p);
  const rows = [];
  for (let i=0; i<sizes.length; i+=3) rows.push(sizes.slice(i,i+3).map(v => Markup.button.callback(v, `SIZE|${pid}|${enc(v)}`)));
  rows.push([Markup.button.callback('✍️ Escriure talla manualment', 'NOOP')]);

  const txt = `D'acord! Indica la **talla** per a «${p.name}».\n\nTria una opció o escriu-la (ex: 42.5, 43 1/3, 28cm).`;
  try { await ctx.editMessageText(txt, { parse_mode:'Markdown', ...Markup.inlineKeyboard(rows) }); }
  catch { await ctx.reply(txt, { parse_mode:'Markdown', ...Markup.inlineKeyboard(rows) }); }
});

// Talla escollida via botó
bot.action(/^SIZE\|(\d+)\|(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const pid = Number(ctx.match[1]);
  const size = dec(ctx.match[2]);
  await addToCart(ctx, pid, size, 1);
});

// Talla escrita pel client
bot.on('text', async (ctx) => {
  const s = getS(ctx.from.id);
  if (s.step !== 'ASK_SIZE') return; // altres textos gestionats abans
  const size = ctx.message.text.trim().slice(0, 20);
  if (!size) return ctx.reply('Escriu una talla vàlida (ex: 42, 42.5, 43 1/3)');
  await addToCart(ctx, s.productId, size, 1);
});

async function addToCart(ctx, productId, size, qty=1) {
  const p = await db.getProduct(productId);
  if (!p) return ctx.reply('No he pogut trobar el producte. Torna-ho a provar.');

  const item = {
    productId: p.id,
    productName: p.name,
    size,
    price_cents: p.base_price_cents || 0,
    qty
  };

  const s = getS(ctx.from.id);
  const cart = (s.cart || []).concat(item);
  setS(ctx.from.id, { step:null, cart });

  const total = cart.reduce((a,it)=>a+(it.price_cents||0)*(it.qty||1),0);
  await ctx.reply(
    `🛒 Afegit: ${p.name} — talla ${size} ×${qty}\nTotal: ${toEuro(total)}`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🧺 Veure/Confirmar', 'CHECKOUT')],
      [Markup.button.callback('🛍️ Continuar comprant', 'NOOP')]
    ])
  );
}

/* ───────── Cistella / Checkout ───────── */
function cartText(cart) {
  const lines = cart.map((it,i)=>`#${i+1} ${it.productName} — talla ${it.size} ×${it.qty} = ${toEuro((it.price_cents||0)*(it.qty||1))}`);
  const total = cart.reduce((a,it)=>a+(it.price_cents||0)*(it.qty||1),0);
  return { text: ['Cistella:', ...lines, `Total: ${toEuro(total)}`].join('\n'), total };
}

async function showCart(ctx) {
  const s = getS(ctx.from.id);
  if (!s.cart || !s.cart.length) return ctx.reply('La cistella és buida.');
  const { text } = cartText(s.cart);
  await ctx.reply(text,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirmar comanda','CHECKOUT')],
      [Markup.button.callback('🧹 Buidar cistella','CLEAR_CART')]
    ]));
}

bot.action('CHECKOUT', async (ctx) => {
  await ctx.answerCbQuery();
  const s = getS(ctx.from.id);
  if (!s.cart || !s.cart.length) return ctx.reply('La cistella és buida.');

  const { total } = cartText(s.cart);
  await db.insertOrder(ctx.from.id, ctx.from.username||'', s.cart, total, 0);
  setS(ctx.from.id, { cart: [] });

  // Confirmació al client (sense cap menció d'admin)
  try { await ctx.editMessageText(`✅ Comanda registrada! Import: ${toEuro(total)}. Ens posarem en contacte per tancar el pagament i l’enviament.`); }
  catch { await ctx.reply(`✅ Comanda registrada! Import: ${toEuro(total)}. Ens posarem en contacte per tancar el pagament i l’enviament.`); }

  // (Opcional) notificació interna als admins
  if (ADMIN_CHAT_IDS.length) {
    const orderPreview = s.cart.map(it => `• ${it.productName} — talla ${it.size} ×${it.qty} (${toEuro((it.price_cents||0)*(it.qty||1))})`).join('\n');
    const msg = `📦 Nova comanda de @${ctx.from.username || ctx.from.id}\n${orderPreview}\nTotal: ${toEuro(total)}`;
    for (const chatId of ADMIN_CHAT_IDS) {
      try { await bot.telegram.sendMessage(chatId, msg); } catch {}
    }
  }
});

bot.action('CLEAR_CART', async (ctx) => {
  await ctx.answerCbQuery();
  setS(ctx.from.id, { cart: [] });
  try { await ctx.editMessageText('🧹 Cistella buidada.'); }
  catch { await ctx.reply('🧹 Cistella buidada.'); }
});

bot.catch((err, ctx) => { console.error('Customer bot error', err); try { ctx.reply('Hi ha hagut un error.'); } catch {} });

/* ───────── Arrencada ───────── */
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

// Evitar soroll "Bot is not running!" als logs en aturada
process.once('SIGINT',  () => { try { bot.stop('SIGINT');  } catch {} });
process.once('SIGTERM', () => { try { bot.stop('SIGTERM'); } catch {} });
