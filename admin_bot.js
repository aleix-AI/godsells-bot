// admin_bot.js — Notificacions automàtiques de comandes noves (nom, adreça, productes, total)
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
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_cost_cents INT DEFAULT 0;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS address_text TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'PENDING';`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;`);
}
await ensureSchema();

/* Bot */
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s=>s.trim()).filter(Boolean);
if (!ADMIN_BOT_TOKEN) throw new Error('Falta ADMIN_BOT_TOKEN');
if (!ADMIN_IDS.length) console.warn('⚠️  No hi ha ADMIN_IDS. No s’enviaran notificacions a ningú.');

const admin = new Telegraf(ADMIN_BOT_TOKEN);
const isAdmin = (ctx) => ADMIN_IDS.includes(String(ctx.from.id));
const toEuro = (c) => (Number(c||0)/100).toLocaleString('es-ES',{style:'currency',currency:'EUR'});

/* UI bàsica */
admin.start((ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('No autoritzat.');
  ctx.reply('🛠️ Admin en marxa', Markup.keyboard([
    ['📦 Comandes pendents','📝 Consultes clients'],
    ['🔔 Provar notificació (/forcecheck)']
  ]).resize());
});

admin.hears('📦 Comandes pendents', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = (await pool.query(
    `SELECT id, created_at, username, customer_name, total_cents, status
     FROM orders WHERE status='PENDING' ORDER BY id DESC LIMIT 50`)).rows;
  if (!rows.length) return ctx.reply('Sense comandes pendents.');
  ctx.reply(rows.map(o =>
    `#${o.id} — ${new Date(o.created_at).toLocaleString('es-ES')} — ${o.customer_name || o.username || o.user_id} — ${toEuro(o.total_cents)} — ${o.status}`
  ).join('\n').slice(0,4000));
});

admin.hears('📝 Consultes clients', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = (await pool.query('SELECT * FROM queries ORDER BY id DESC LIMIT 200')).rows;
  if (!rows.length) return ctx.reply('Sense consultes.');
  ctx.reply(rows.slice(0,30).map(q =>
    `${new Date(q.created_at).toLocaleString('es-ES')} — ${q.username || q.user_id}: ${q.text}`
  ).join('\n'));
});

/* ───────── Notificador ───────── */
const WATCH_MS = Number(process.env.WATCH_INTERVAL_MS || 4000);

async function notifyNewOrders() {
  const rows = (await pool.query(
    `SELECT * FROM orders WHERE notified_at IS NULL ORDER BY id ASC LIMIT 20`
  )).rows;

  for (const o of rows) {
    let items = [];
    try { items = JSON.parse(o.items_json || '[]'); } catch {}

    const lines = items.map(it => {
      const qty = it.qty || 1;
      const line = (it.price_cents || 0) * qty;
      return `• ${it.productName} — talla ${it.size} ×${qty} — ${toEuro(line)}`;
    }).join('\n');

    const who = o.customer_name || (o.username ? `@${o.username}` : `${o.user_id}`);
    const msg = [
      `🆕 *NOVA COMANDA* #${o.id}`,
      `👤 Client: *${who}*`,
      `🔗 Usuari: ${o.username ? '@'+o.username : o.user_id}`,
      `📍 Adreça:\n${o.address_text || '(no informada)'}`,
      ``,
      `📦 Productes:`,
      lines || '(buit)',
      ``,
      `💶 Total: *${toEuro(o.total_cents)}*`,
      `🕒 ${new Date(o.created_at).toLocaleString('es-ES')}`
    ].join('\n');

    for (const aid of ADMIN_IDS) {
      try { await admin.telegram.sendMessage(aid, msg, { parse_mode:'Markdown' }); } catch (e) {
        console.error('Send fail to', aid, e.message);
      }
    }
    // marca com notificat
    await pool.query(`UPDATE orders SET notified_at = now() WHERE id=$1`, [o.id]);
  }
}

/* Comandes de prova/forçat */
admin.command('forcecheck', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await notifyNewOrders();
  ctx.reply('🔔 Check forçat fet.');
});

/* Bucle */
setInterval(() => notifyNewOrders().catch(e=>console.error('notify error', e.message)), WATCH_MS);

/* Arrencada */
const USE_WEBHOOK = String(process.env.USE_WEBHOOK).toLowerCase() === 'true';
const PORT = Number(process.env.PORT || 3000);
const APP_URL = process.env.APP_URL;
const HOOK_PATH = process.env.HOOK_PATH || '/tghook';

if (USE_WEBHOOK) {
  const express = (await import('express')).default;
  const app = express();
  app.use(admin.webhookCallback(HOOK_PATH));
  if (!APP_URL) throw new Error('Falta APP_URL per al webhook');
  await admin.telegram.setWebhook(`${APP_URL}${HOOK_PATH}`);
  app.get('/', (_, res) => res.send('OK'));
  app.listen(PORT, () => console.log('Admin listening on', PORT));
} else {
  await admin.launch();
  console.log('Admin bot running (long polling)');
}
process.once('SIGINT',  () => { try { admin.stop('SIGINT');  } catch {} });
process.once('SIGTERM', () => { try { admin.stop('SIGTERM'); } catch {} });
