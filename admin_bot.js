// admin_bot.js — Comandes, reemborsaments, avisos pendents + PETICIONS de producte
import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import pkg from 'pg';
const { Pool } = pkg;

/* ───────── Config ───────── */
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
if (!ADMIN_BOT_TOKEN) throw new Error('Missing ADMIN_BOT_TOKEN');

const OVERDUE_HOURS = Number(process.env.OVERDUE_HOURS || 6);
const OVERDUE_POLL_MIN = Number(process.env.OVERDUE_POLL_MINUTES || 5);

const PAYPAL_MODE = (process.env.PAYPAL_MODE || 'live').toLowerCase();
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_SECRET = process.env.PAYPAL_SECRET || '';
const PAYPAL_API_BASE = PAYPAL_MODE === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? ({ rejectUnauthorized: false }) : false
});

const admin = new Telegraf(ADMIN_BOT_TOKEN);
const isAdmin = (ctx) => ADMIN_IDS.includes(String(ctx.from.id));
const toEuro = (c) => (Number(c || 0) / 100).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

/* ───────── DB bootstrap (migracions suaus) ───────── */
async function ensureColumns() {
  // Columns per avisos de comandes pendents
  await pool.query(`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS overdue_alerted_at timestamptz,
      ADD COLUMN IF NOT EXISTS overdue_snooze_until timestamptz
  `).catch(()=>{});

  // Taula de peticions de producte (si no existeix) + columna de notificació
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_requests (
      id SERIAL PRIMARY KEY,
      user_id BIGINT,
      username TEXT,
      desired_name TEXT NOT NULL,
      desired_size TEXT,
      notes TEXT,
      status TEXT DEFAULT 'NEW',  -- NEW | APPROVED | REJECTED | DONE
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    ALTER TABLE product_requests
      ADD COLUMN IF NOT EXISTS notified_at timestamptz
  `).catch(()=>{});
}
await ensureColumns();

/* ───────── PayPal helpers (per a reemborsaments) ───────── */
async function paypalAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) throw new Error('Falten credencials PayPal (admin-bot)');
  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) throw new Error('PayPal OAuth error');
  return (await res.json()).access_token;
}

function extractCaptureId(payment_receipt_json) {
  try {
    const j = typeof payment_receipt_json === 'string' ? JSON.parse(payment_receipt_json) : payment_receipt_json;
    const cap = j?.purchase_units?.[0]?.payments?.captures?.[0]?.id || j?.id;
    return cap || null;
  } catch { return null; }
}

async function refundCapture(captureId, totalCents) {
  const access = await paypalAccessToken();
  const res = await fetch(`${PAYPAL_API_BASE}/v2/payments/captures/${captureId}/refund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${access}` },
    body: JSON.stringify({ amount: { currency_code: 'EUR', value: (Number(totalCents || 0)/100).toFixed(2) } })
  });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`Refund error: ${bodyText}`);
  return JSON.parse(bodyText || '{}');
}

/* ───────── DB helpers ───────── */
const db = {
  listLatestOrders: async (limit = 20) =>
    (await pool.query(`SELECT id, created_at, username, customer_name, address_text, total_cents, status, payment_status
                       FROM orders ORDER BY id DESC LIMIT $1`, [limit])).rows,

  getOrder: async (id) =>
    (await pool.query(`SELECT * FROM orders WHERE id=$1`, [id])).rows[0],

  setStatus: (id, status) =>
    pool.query(`UPDATE orders SET status=$2 WHERE id=$1`, [id, status]),

  markRefunded: (id, refundJson) =>
    pool.query(`UPDATE orders SET payment_status='REFUNDED', status='REFUNDED',
                payment_receipt_json=$2 WHERE id=$1`,
      [id, JSON.stringify(refundJson)]),

  markOverdueAlerted: (id) =>
    pool.query(`UPDATE orders SET overdue_alerted_at=now() WHERE id=$1`, [id]),

  snoozeOverdue: (id, minutes) =>
    pool.query(`UPDATE orders SET overdue_snooze_until = now() + ($2 || ' minutes')::interval WHERE id=$1`,
      [id, String(minutes)]),

  // Product requests
  listRequests: async (status = 'NEW', limit = 20) =>
    (await pool.query(`SELECT * FROM product_requests WHERE status=$1 ORDER BY id DESC LIMIT $2`, [status, limit])).rows,

  setRequestStatus: (id, status) =>
    pool.query(`UPDATE product_requests SET status=$2 WHERE id=$1`, [id, status]),

  getRequest: async (id) =>
    (await pool.query(`SELECT * FROM product_requests WHERE id=$1`, [id])).rows[0],
};

/* ───────── Format helpers ───────── */
function formatItems(items_json) {
  try {
    const items = typeof items_json === 'string' ? JSON.parse(items_json) : (items_json || []);
    if (!Array.isArray(items) || !items.length) return '(buit)';
    return items.map(it =>
      `• ${it.productName || it.name} — talla ${it.size_label || it.size || '-'} ×${it.qty || 1} = ${toEuro((it.price_cents||0)*(it.qty||1))}`
    ).join('\n');
  } catch { return '(buit)'; }
}

function orderLine(o) {
  const when = new Date(o.created_at).toLocaleString('es-ES');
  return `#${o.id} — ${when} — ${o.customer_name || o.username || o.user_id} — ${toEuro(o.total_cents)} — ${o.status}/${o.payment_status}`;
}

function orderButtons(o) {
  const rows = [];
  rows.push([Markup.button.callback('✅ Marcar realitzada', `ORDER_DONE_${o.id}`)]);
  if (o.payment_status === 'PAID') rows.push([Markup.button.callback('↩️ Reemborsar', `ORDER_REFUND_${o.id}`)]);
  return Markup.inlineKeyboard(rows);
}

function overdueButtons(o) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Marcar realitzada', `ORDER_DONE_${o.id}`)],
    [Markup.button.callback('🕒 Snooze 2h', `OVERDUE_SNOOZE_${o.id}_120`)]
  ]);
}

/* ───────── Peticions: format + botons ───────── */
function reqButtonsInline(r) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Acceptar', `REQ_ACCEPT_${r.id}`), Markup.button.callback('❌ Rebutjar', `REQ_REJECT_${r.id}`)],
    [Markup.button.callback('✔️ Fet', `REQ_DONE_${r.id}`)]
  ]);
}
function formatReqShort(r) {
  return [
    `📥 Nova petició (#${r.id})`,
    `Usuari: ${r.username ? '@'+r.username : r.user_id}`,
    `Nom: ${r.desired_name}`,
    `Talla: ${r.desired_size || '-'}`,
    r.notes ? `Notes: ${r.notes}` : ''
  ].filter(Boolean).join('\n');
}
function formatReq(r) {
  return [
    `#${r.id} — ${new Date(r.created_at).toLocaleString('es-ES')} — ${r.status}`,
    `Usuari: ${r.username ? '@'+r.username : r.user_id}`,
    `Nom: ${r.desired_name}`,
    `Talla: ${r.desired_size || '-'}`,
    `Notes: ${r.notes || '-'}`
  ].join('\n');
}

/* ───────── Bot UI ───────── */
admin.start((ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('No autoritzat.');
  ctx.reply('🛠️ Admin', Markup.keyboard([
    ['📦 Llistar comandes', '📥 Peticions']
  ]).resize());
});

admin.hears('📦 Llistar comandes', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = await db.listLatestOrders(20);
  if (!rows.length) return ctx.reply('Encara no hi ha comandes.');
  for (const o of rows) await ctx.reply(orderLine(o), orderButtons(o));
});

admin.hears('📥 Peticions', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = await db.listRequests('NEW', 30);
  if (!rows.length) return ctx.reply('Sense peticions noves.');
  for (const r of rows) await ctx.reply(formatReq(r), reqButtonsInline(r));
});

/* ───────── Accions de comandes ───────── */
admin.action(/ORDER_DONE_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('No autoritzat');
  const id = Number(ctx.match[1]);
  await db.setStatus(id, 'COMPLETED');
  await ctx.answerCbQuery('Comanda marcada com realitzada');
  const o = await db.getOrder(id);
  try { await ctx.editMessageText(orderLine(o), orderButtons(o)); } catch {}
});

admin.action(/ORDER_REFUND_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('No autoritzat');
  const id = Number(ctx.match[1]);
  await ctx.answerCbQuery();
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('❗️ Confirmar reemborsament', `ORDER_REFUND_CONFIRM_${id}`)],
    [Markup.button.callback('Cancel·lar', 'NOOP')]
  ]);
  await ctx.reply(`Segur que vols reemborsar la comanda #${id}?`, kb);
});

admin.action(/ORDER_REFUND_CONFIRM_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('No autoritzat');
  const id = Number(ctx.match[1]);
  await ctx.answerCbQuery('Processant reemborsament…');

  const o = await db.getOrder(id);
  if (!o) return ctx.reply('No s’ha trobat la comanda.');
  if (o.payment_status !== 'PAID') return ctx.reply('Només es poden reemborsar comandes pagades.');

  const captureId = extractCaptureId(o.payment_receipt_json);
  if (!captureId) return ctx.reply('No s’ha trobat el capture id a PayPal.');

  try {
    const rr = await refundCapture(captureId, o.total_cents);
    await db.markRefunded(id, rr);
    try { await admin.telegram.sendMessage(o.user_id, `↩️ El pagament de la comanda #${id} ha estat reemborsat.`); } catch {}
    await ctx.reply(`Comanda #${id} reemborsada correctament.`);
    const refreshed = await db.getOrder(id);
    try { await ctx.editMessageText(orderLine(refreshed), orderButtons(refreshed)); } catch {}
  } catch (e) {
    console.error('Refund error:', e.message);
    await ctx.reply(`Error fent el reemborsament: ${e.message}`);
  }
});

/* ───────── Accions de peticions ───────── */
admin.action(/REQ_ACCEPT_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('No autoritzat');
  const id = Number(ctx.match[1]);
  await db.setRequestStatus(id, 'APPROVED');
  const r = await db.getRequest(id);
  await ctx.answerCbQuery('Acceptada');
  try { await ctx.editMessageText(formatReq(r), reqButtonsInline(r)); } catch {}
  // (Opcional) avisar l'usuari: descomenta si vols
  // try { await admin.telegram.sendMessage(r.user_id, `👌 Hem acceptat la teva petició per «${r.desired_name}».`); } catch {}
});

admin.action(/REQ_REJECT_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('No autoritzat');
  const id = Number(ctx.match[1]);
  await db.setRequestStatus(id, 'REJECTED');
  const r = await db.getRequest(id);
  await ctx.answerCbQuery('Rebutjada');
  try { await ctx.editMessageText(formatReq(r), reqButtonsInline(r)); } catch {}
  // try { await admin.telegram.sendMessage(r.user_id, `Ho sentim, ara mateix no podem aconseguir «${r.desired_name}».`); } catch {}
});

admin.action(/REQ_DONE_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('No autoritzat');
  const id = Number(ctx.match[1]);
  await db.setRequestStatus(id, 'DONE');
  const r = await db.getRequest(id);
  await ctx.answerCbQuery('Marcada com feta');
  try { await ctx.editMessageText(formatReq(r), reqButtonsInline(r)); } catch {}
  // try { await admin.telegram.sendMessage(r.user_id, `✅ La teva petició «${r.desired_name}» s’ha completat.`); } catch {}
});

admin.action('NOOP', (ctx) => ctx.answerCbQuery());

/* ───────── Scheduler: avisos de comandes pendents ───────── */
async function sendOverdueMessage(o) {
  const hours = Math.floor((Date.now() - new Date(o.created_at).getTime()) / 3600000);
  const msg = [
    `⏰ *COMANDA PENDENT* (#${o.id}) — fa ${hours}h`,
    ``,
    `Client: ${o.customer_name || '-'}`,
    `Usuari: ${o.username ? '@'+o.username : (o.user_id || '-')}`,
    `Adreça:\n${o.address_text || '-'}`,
    ``,
    `Productes:`,
    formatItems(o.items_json),
    ``,
    `Total: ${toEuro(o.total_cents)}`
  ].join('\n');

  for (const chatId of ADMIN_IDS) {
    try {
      await admin.telegram.sendMessage(chatId, msg, { parse_mode: 'Markdown', reply_markup: overdueButtons(o).reply_markup });
    } catch {
      await admin.telegram.sendMessage(chatId, msg, { reply_markup: overdueButtons(o).reply_markup }).catch(()=>{});
    }
  }
}

async function checkOverdue() {
  try {
    const q = await pool.query(`
      SELECT *
      FROM orders
      WHERE status='PENDING'
        AND payment_status='PAID'
        AND created_at <= now() - make_interval(hours => $1)
        AND (overdue_snooze_until IS NULL OR overdue_snooze_until <= now())
        AND overdue_alerted_at IS NULL
      ORDER BY id ASC
      LIMIT 20
    `, [OVERDUE_HOURS]);

    for (const o of q.rows) {
      await sendOverdueMessage(o);
      await db.markOverdueAlerted(o.id);
    }
  } catch (e) {
    console.error('overdue checker error:', e);
  }
}
setInterval(checkOverdue, Math.max(1, OVERDUE_POLL_MIN) * 60 * 1000);
checkOverdue();

/* ───────── Notificador de PETICIONS noves ───────── */
async function checkNewRequests() {
  try {
    const q = await pool.query(`
      SELECT * FROM product_requests
      WHERE status='NEW' AND notified_at IS NULL
      ORDER BY id ASC
      LIMIT 20
    `);
    for (const r of q.rows) {
      for (const chatId of ADMIN_IDS) {
        try {
          await admin.telegram.sendMessage(chatId, formatReqShort(r), { reply_markup: reqButtonsInline(r).reply_markup });
        } catch (e) {
          console.error('send req notify fail:', e.message);
        }
      }
      await pool.query(`UPDATE product_requests SET notified_at=now() WHERE id=$1`, [r.id]);
    }
  } catch (e) {
    console.error('checkNewRequests error:', e.message);
  }
}
setInterval(checkNewRequests, 30 * 1000);
checkNewRequests();

/* ───────── Launch ───────── */
admin.catch((err, ctx) => { console.error('Admin bot error', err); try { ctx.reply('Error.'); } catch {} });
admin.launch().then(() => console.log('Admin listening on 8080'));
process.once('SIGINT', () => admin.stop('SIGINT'));
process.once('SIGTERM', () => admin.stop('SIGTERM'));
