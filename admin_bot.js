// admin_bot.js — watcher de comandes i missatge amb productes
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import pkg from 'pg';
const { Pool } = pkg;

/* ───────── Config ───────── */
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
if (!ADMIN_BOT_TOKEN) throw new Error('Falta ADMIN_BOT_TOKEN');

const ADMIN_IDS = (process.env.ADMIN_IDS || process.env.ADMIN_USER_ID || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false
});

const bot = new Telegraf(ADMIN_BOT_TOKEN);

const toEuro = (cents) =>
  (Number(cents || 0) / 100).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

const isAdmin = (ctx) => ADMIN_IDS.includes(String(ctx.from.id));

/* ───────── Utils ───────── */
function itemsFromRow(order) {
  const src = order?.items_json;
  if (!src) return [];
  if (Array.isArray(src)) return src;                 // jsonb[] ja deserialitzat
  if (typeof src === 'object') return src;            // jsonb (array objecte)
  try { return JSON.parse(src); } catch { return []; } // text -> JSON
}

function formatOrderMessage(o) {
  const items = itemsFromRow(o);
  const lines = items.map(it => {
    const p = Number(it.price_cents) || 0;
    const q = Number(it.qty) || 1;
    return `• ${it.productName} — talla ${it.size} ×${q} = ${toEuro(p * q)}`;
  });
  const itemsBlock = lines.length ? lines.join('\n') : '(buit)';

  const userStr = o.username ? `@${o.username}` : String(o.user_id);
  return [
    `🆕 NOVA COMANDA #${o.id}`,
    `🧑‍💼 Client: ${o.customer_name || '-'}`,
    `🪪 Usuari: ${userStr}`,
    `📍 Adreça:`,
    `${o.address_text || '-'}`,
    ``,
    `📦 Productes:`,
    `${itemsBlock}`,
    ``,
    `💶 Total: ${toEuro(o.total_cents)}`
  ].join('\n');
}

/* ───────── Comandes ───────── */
async function watchNewOrders() {
  try {
    const res = await pool.query(
      `SELECT id, user_id, username, items_json, total_cents, customer_name, address_text, created_at
         FROM orders
        WHERE notified_at IS NULL
        ORDER BY id ASC
        LIMIT 20`
    );

    for (const o of res.rows) {
      const msg = formatOrderMessage(o);

      // envia a tots els admins; sense parse_mode
      for (const adminId of ADMIN_IDS) {
        try { await bot.telegram.sendMessage(adminId, msg, { disable_web_page_preview: true }); }
        catch (e) { console.error('Send fail to', adminId, e.message); }
      }

      // marca com a notificat
      try { await pool.query('UPDATE orders SET notified_at = now() WHERE id = $1', [o.id]); }
      catch (e) { console.error('Mark notified error for', o.id, e.message); }
    }
  } catch (e) {
    console.error('watchNewOrders error:', e.message);
  }
}

/* ───────── Bot UI ───────── */
bot.start((ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('No autoritzat.');
  ctx.reply('🛠️ Admin en marxa. Rebràs notificacions de noves comandes aquí.');
});

bot.command('ping', (ctx) => {
  if (!isAdmin(ctx)) return;
  ctx.reply('pong');
});

bot.command('orders', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const r = await pool.query(`SELECT id, total_cents, customer_name, created_at
                                FROM orders ORDER BY id DESC LIMIT 10`);
  if (!r.rows.length) return ctx.reply('Sense comandes.');
  const txt = r.rows
    .map(o => `#${o.id} — ${toEuro(o.total_cents)} — ${o.customer_name || '-'} — ${new Date(o.created_at).toLocaleString('es-ES')}`)
    .join('\n');
  ctx.reply(txt);
});

/* ───────── Infra (webhook / polling) ───────── */
const USE_WEBHOOK = String(process.env.USE_WEBHOOK).toLowerCase() === 'true';
const PORT = Number(process.env.PORT || 3000);
const APP_URL = process.env.APP_URL;              // ex: https://<subdomini-admin>.up.railway.app
const HOOK_PATH = process.env.HOOK_PATH || '/tghook';

if (USE_WEBHOOK) {
  const express = (await import('express')).default;
  const app = express();
  app.use(bot.webhookCallback(HOOK_PATH));
  if (!APP_URL) throw new Error('Falta APP_URL per al webhook');
  await bot.telegram.setWebhook(`${APP_URL}${HOOK_PATH}`);
  app.get('/', (_, res) => res.send('OK'));
  app.listen(PORT, () => console.log('Admin listening on', PORT));
} else {
  await bot.launch();
  console.log('Admin bot running (long polling)');
}
process.once('SIGINT', () => { try { bot.stop('SIGINT'); } catch {} });
process.once('SIGTERM', () => { try { bot.stop('SIGTERM'); } catch {} });

/* ───────── Loop del watcher ───────── */
setInterval(watchNewOrders, 7000); // cada 7s comprova noves comandes
