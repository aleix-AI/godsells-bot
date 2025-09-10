// admin_bot.js — Notificacions + llistat + canvi d'estat de comandes
import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
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
  if (Array.isArray(src)) return src;
  if (typeof src === 'object') return src;
  try { return JSON.parse(src); } catch { return []; }
}

function formatOrderMessage(o) {
  const items = itemsFromRow(o);
  const line = (it) => {
    const p = Number(it.price_cents) || 0;
    const q = Number(it.qty) || 1;
    const talla = it.size ? ` — talla ${it.size}` : '';
    return `• ${it.productName}${talla} ×${q} = ${toEuro(p * q)}`;
  };
  const lines = items.map(line);
  const itemsBlock = lines.length ? lines.join('\n') : '(buit)';

  const userStr = o.username ? `@${o.username}` : String(o.user_id);
  const created = o.created_at ? new Date(o.created_at).toLocaleString('es-ES') : '';

  return [
    `🆕 NOVA COMANDA #${o.id}`,
    `Estat: ${o.status || 'PENDING'}`,
    `Client: ${o.customer_name || '-'}`,
    `Usuari: ${userStr}`,
    `Adreça:`,
    `${o.address_text || '-'}`,
    ``,
    `Productes:`,
    `${itemsBlock}`,
    ``,
    `Total: ${toEuro(o.total_cents)}`,
    created ? `Data: ${created}` : ''
  ].filter(Boolean).join('\n');
}

function keyboardForOrder(o) {
  if ((o.status || 'PENDING') === 'PENDING') {
    return Markup.inlineKeyboard([
      [Markup.button.callback('✅ Comanda realitzada', `ORDER_DONE_${o.id}`)]
    ]);
  } else {
    return Markup.inlineKeyboard([
      [Markup.button.callback('↩️ Tornar a pendent', `ORDER_PENDING_${o.id}`)]
    ]);
  }
}

/* ───────── Watcher ───────── */
async function watchNewOrders() {
  try {
    const res = await pool.query(
      `SELECT id, user_id, username, items_json, total_cents, customer_name, address_text, status, created_at
         FROM orders
        WHERE notified_at IS NULL
        ORDER BY id ASC
        LIMIT 20`
    );

    for (const o of res.rows) {
      const msg = formatOrderMessage(o);
      const kb = keyboardForOrder(o);
      for (const adminId of ADMIN_IDS) {
        try { await bot.telegram.sendMessage(adminId, msg, { ...kb, disable_web_page_preview: true }); }
        catch (e) { console.error('Send fail to', adminId, e.message); }
      }
      try { await pool.query('UPDATE orders SET notified_at = now() WHERE id = $1', [o.id]); }
      catch (e) { console.error('Mark notified error for', o.id, e.message); }
    }
  } catch (e) {
    console.error('watchNewOrders error:', e.message);
  }
}

/* ───────── Accions ───────── */
async function loadOrder(id) {
  const r = await pool.query(
    `SELECT id, user_id, username, items_json, total_cents, customer_name, address_text, status, created_at
       FROM orders WHERE id=$1`, [id]
  );
  return r.rows[0];
}
bot.action(/^ORDER_DONE_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('No autoritzat');
  const id = Number(ctx.match[1]);
  await pool.query(`UPDATE orders SET status='DONE' WHERE id=$1`, [id]);
  const o = await loadOrder(id);
  const msg = formatOrderMessage(o);
  const kb = keyboardForOrder(o);
  try { await ctx.editMessageText(msg, { ...kb, disable_web_page_preview: true }); }
  catch { await ctx.reply(msg, { ...kb, disable_web_page_preview: true }); }
  await ctx.answerCbQuery('Comanda marcada com a realitzada');
});
bot.action(/^ORDER_PENDING_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('No autoritzat');
  const id = Number(ctx.match[1]);
  await pool.query(`UPDATE orders SET status='PENDING' WHERE id=$1`, [id]);
  const o = await loadOrder(id);
  const msg = formatOrderMessage(o);
  const kb = keyboardForOrder(o);
  try { await ctx.editMessageText(msg, { ...kb, disable_web_page_preview: true }); }
  catch { await ctx.reply(msg, { ...kb, disable_web_page_preview: true }); }
  await ctx.answerCbQuery('Comanda tornada a pendent');
});

/* ───────── UI ───────── */
bot.start((ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('No autoritzat.');
  ctx.reply('🛠️ Administració', Markup.keyboard([
    ['📦 Llistar comandes']
  ]).resize());
});
async function sendLatestOrders(ctx, limit = 15) {
  const r = await pool.query(
    `SELECT id, user_id, username, items_json, total_cents, customer_name, address_text, status, created_at
       FROM orders ORDER BY id DESC LIMIT $1`, [limit]
  );
  if (!r.rows.length) return ctx.reply('Sense comandes.');
  for (const o of r.rows) {
    const msg = formatOrderMessage(o);
    const kb = keyboardForOrder(o);
    await ctx.reply(msg, { ...kb, disable_web_page_preview: true });
  }
}
bot.hears('📦 Llistar comandes', async (ctx) => { if (!isAdmin(ctx)) return; return sendLatestOrders(ctx, 15); });
bot.command('orders', async (ctx) => { if (!isAdmin(ctx)) return; return sendLatestOrders(ctx, 15); });

/* ───────── Infra ───────── */
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
  app.listen(PORT, () => console.log('Admin listening on', PORT));
} else {
  await bot.launch();
  console.log('Admin bot running (long polling)');
}
process.once('SIGINT', () => { try { bot.stop('SIGINT'); } catch {} });
process.once('SIGTERM', () => { try { bot.stop('SIGTERM'); } catch {} });

/* ───────── Watch loop ───────── */
setInterval(watchNewOrders, 7000);
