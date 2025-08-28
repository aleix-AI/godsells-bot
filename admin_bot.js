// admin_bot.js — Telegraf + PostgreSQL + Webhook (Railway-ready)
import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import pkg from 'pg';

const { Pool } = pkg;

/* DB (PG) */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products(
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS variants(
      id SERIAL PRIMARY KEY, product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      option_name TEXT DEFAULT 'variant', option_value TEXT NOT NULL,
      price_cents INT NOT NULL, cost_cents INT DEFAULT 0, stock INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS orders(
      id SERIAL PRIMARY KEY, user_id BIGINT, username TEXT,
      items_json JSONB NOT NULL, total_cents INT NOT NULL, total_cost_cents INT DEFAULT 0,
      status TEXT DEFAULT 'PENDING', created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS queries(
      id SERIAL PRIMARY KEY, user_id BIGINT, username TEXT, text TEXT, created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

const db = {
  insertProduct: async (name, description='') =>
    (await pool.query('INSERT INTO products(name, description) VALUES($1,$2) RETURNING id',[name,description])).rows[0],
  listProducts: async () =>
    (await pool.query('SELECT * FROM products ORDER BY id DESC LIMIT 100')).rows,
  insertVariant: async (pid, opt, val, price_cents, stock, cost_cents=0) =>
    (await pool.query('INSERT INTO variants(product_id, option_name, option_value, price_cents, stock, cost_cents) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[pid,opt,val,price_cents,stock,cost_cents])).rows[0],
  listOrders: async () =>
    (await pool.query('SELECT * FROM orders ORDER BY id DESC LIMIT 100')).rows,
  listQueries: async () =>
    (await pool.query('SELECT * FROM queries ORDER BY id DESC LIMIT 200')).rows,
  salesSummary: async () =>
    (await pool.query(`SELECT date_trunc('day', created_at) AS day,
                               SUM(total_cents) AS rev,
                               SUM(total_cost_cents) AS cog,
                               SUM(total_cents-total_cost_cents) AS margin
                        FROM orders GROUP BY 1 ORDER BY 1 DESC LIMIT 30`)).rows
};

/* BOT */
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').toString().split(',').filter(Boolean);
if (!ADMIN_BOT_TOKEN) throw new Error('Falta ADMIN_BOT_TOKEN');

await initDb();
const admin = new Telegraf(ADMIN_BOT_TOKEN);
const isAdmin = (ctx) => ADMIN_IDS.includes(String(ctx.from.id));

/* HANDLERS */
admin.start((ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('No autoritzat.');
  ctx.reply('🛠️ Admin bot', Markup.keyboard([
    ['➕ Afegir producte','🧩 Llistar productes'],
    ['📦 Llistar comandes','📝 Consultes clients'],
    ['📊 Balanç (30 dies)']
  ]).resize());
});

admin.hears('🧩 Llistar productes', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = await db.listProducts();
  if (!rows.length) return ctx.reply('No hi ha productes.');
  ctx.reply(rows.map(p=>`#${p.id} — ${p.name}`).join('\n'));
});

admin.hears('📦 Llistar comandes', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = await db.listOrders();
  if (!rows.length) return ctx.reply('Encara no hi ha comandes.');
  ctx.reply(rows.map(o=>`#${o.id} — ${new Date(o.created_at).toLocaleString('es-ES')} — ${o.username || o.user_id} — ${(o.total_cents/100).toFixed(2)} €`).join('\n'));
});

admin.hears('📝 Consultes clients', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = await db.listQueries();
  if (!rows.length) return ctx.reply('Sense consultes.');
  ctx.reply(rows.slice(0,30).map(q=>`${new Date(q.created_at).toLocaleString('es-ES')} — ${q.username || q.user_id}: ${q.text}`).join('\n'));
});

admin.hears('➕ Afegir producte', (ctx) => {
  if (!isAdmin(ctx)) return;
  ctx.reply('Envia: Nom | Descripció opcional');
  admin.once('text', async (ctx2) => {
    if (!isAdmin(ctx2)) return;
    const [name, ...rest] = ctx2.message.text.split('|').map(s=>s.trim());
    if (!name) return ctx2.reply('Nom requerit.');
    const { id } = await db.insertProduct(name, rest.join(' | ') || '');
    ctx2.reply(`✅ Producte #${id} creat. Ara /addvariant`);
  });
});

admin.command('addvariant', (ctx) => {
  if (!isAdmin(ctx)) return;
  ctx.reply('Format: productId | Variant | Valor | Preu € | Stock | Cost € (opcional)');
});

admin.on('text', async (ctx, next) => {
  if (!isAdmin(ctx)) return;
  const t = ctx.message.text;
  if (!t.includes('|')) return next();
  const parts = t.split('|').map(s=>s.trim());
  if (parts.length >= 5 && /^\d+$/.test(parts[0])) {
    const [pid, opt, val, priceEur, stockStr, costEur] = parts;
    const price_cents = Math.round(parseFloat((priceEur||'0').replace(',','.'))*100);
    const stock = parseInt(stockStr||'0',10);
    const cost_cents = costEur ? Math.round(parseFloat(costEur.replace(',','.'))*100) : 0;
    if (Number.isNaN(price_cents) || Number.isNaN(stock) || Number.isNaN(cost_cents)) return ctx.reply('Preu/stock/cost invàlids.');
    const { id } = await db.insertVariant(Number(pid), opt, val, price_cents, stock, cost_cents);
    return ctx.reply(`✅ Variant #${id} a prod ${pid}: ${opt}=${val} (${(price_cents/100).toFixed(2)} €, cost ${(cost_cents/100).toFixed(2)} €, stock ${stock})`);
  }
  return next();
});

admin.hears('📊 Balanç (30 dies)', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = await db.salesSummary();
  if (!rows.length) return ctx.reply('Sense dades.');
  ctx.reply(rows.map(r=>{
    const d = new Date(r.day).toLocaleDateString('es-ES');
    const rev=(Number(r.rev)/100).toFixed(2), cog=(Number(r.cog)/100).toFixed(2), mar=(Number(r.margin)/100).toFixed(2);
    return `${d} — Ingrés: ${rev} € | Cost: ${cog} € | Marge: ${mar} €`;
  }).join('\n'));
});

/* ARRANQUE (Webhook o Polling) */
const USE_WEBHOOK = String(process.env.USE_WEBHOOK).toLowerCase() === 'true';
const PORT = Number(process.env.PORT || 3000);
const APP_URL = process.env.APP_URL;     // Domini públic d’AQUEST servei admin
const HOOK_PATH = process.env.HOOK_PATH || '/tghook';

if (USE_WEBHOOK) {
  const express = (await import('express')).default;
  const app = express();
  app.use(admin.webhookCallback(HOOK_PATH));
  if (!APP_URL) throw new Error('Falta APP_URL per al webhook');
  await admin.telegram.setWebhook(`${APP_URL}${HOOK_PATH}`);
  app.get('/', (_, res) => res.send('OK'));
  app.listen(PORT, () => console.log('Listening on', PORT));
} else {
  await admin.launch();
  console.log('Admin bot running (long polling)');
}

process.once('SIGINT', () => admin.stop('SIGINT'));
process.once('SIGTERM', () => admin.stop('SIGTERM'));
