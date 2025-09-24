// admin_bot.js — Notifica comandes pagades noves + llistats + peticions + vendes mes
import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import pkg from 'pg';
const { Pool, Client } = pkg;
// --- PAYPAL CONFIG ---
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
// Usa "https://api-m.sandbox.paypal.com" per sandbox, o "https://api-m.paypal.com" per producció
const PAYPAL_API_BASE = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.warn('⚠️ Falta PAYPAL_CLIENT_ID o PAYPAL_CLIENT_SECRET a les env vars; el reemborsament fallarà.');
}

// Obtenir access token
async function paypalAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error('Falten PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET');
  }

  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');

  // URLSearchParams assegura el x-www-form-urlencoded correcte
  const body = new URLSearchParams({ grant_type: 'client_credentials' });

  const r = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Accept': 'application/json'
      // (no posem Content-Type manualment; fetch el posa automàticament per URLSearchParams)
    },
    body
  });

  // Log útil si falla per veure la causa exacta
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`PayPal token ${r.status} — ${txt || 'sense cos'}`);
  }

  const j = await r.json();
  if (!j.access_token) throw new Error('PayPal sense access_token');
  return j.access_token;
}


// Fer refund d’un capture
// amount opcional: { currency_code: 'EUR', value: 'xx.xx' }
// Si no passes amount, PayPal farà refund total.
async function paypalRefundCapture(captureId, amount) {
  const access = await paypalAccessToken();
  const r = await fetch(`${PAYPAL_API_BASE}/v2/payments/captures/${captureId}/refund`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(amount ? { amount } : {})
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j?.details?.[0]?.issue || j?.name || `HTTP ${r.status}`;
    throw new Error(`Refund error: ${msg}`);
  }
  return j; // conté refund id, status, etc.
}

// Extreure captureId i amount de la comanda guardada (sigui order o capture)
function extractCaptureFromOrder(order) {
  let receipt = order.payment_receipt_json;
  try { if (typeof receipt === 'string') receipt = JSON.parse(receipt); } catch {}
  const cap =
    // cas webhook PAYMENT.CAPTURE.COMPLETED: receipt ja és el capture
    (receipt && receipt.id && receipt.amount && receipt.status ? receipt : null) ||
    // cas checkout: dins purchase_units[0].payments.captures[0]
    receipt?.purchase_units?.[0]?.payments?.captures?.[0] ||
    null;

  const captureId = cap?.id || null;
  const amount = cap?.amount || null; // {currency_code, value}
  return { captureId, amount };
}


/* ───────── Config ───────── */
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
if (!ADMIN_BOT_TOKEN) throw new Error('Missing ADMIN_BOT_TOKEN');

const OVERDUE_HOURS = Number(process.env.OVERDUE_HOURS || 6);
const OVERDUE_POLL_MIN = Number(process.env.OVERDUE_POLL_MINUTES || 5);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? ({ rejectUnauthorized: false }) : false
});

const admin = new Telegraf(ADMIN_BOT_TOKEN);
const isAdmin = (ctx) => ADMIN_IDS.includes(String(ctx.from.id));
const toEuro = (c) => (Number(c || 0) / 100).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

/* ───────── DB bootstrap ───────── */
async function ensureSchema() {
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS overdue_alerted_at timestamptz`).catch(()=>{});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS overdue_snooze_until timestamptz`).catch(()=>{});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS notified_at timestamptz`).catch(()=>{});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_requests (
      id SERIAL PRIMARY KEY,
      user_id BIGINT,
      username TEXT,
      desired_name TEXT NOT NULL,
      desired_size TEXT,
      notes TEXT,
      status TEXT DEFAULT 'NEW',
      created_at TIMESTAMPTZ DEFAULT now(),
      notified_at TIMESTAMPTZ
    );
  `);
}
await ensureSchema();

/* ───────── DB helpers ───────── */
const db = {
  listLatestOrders: async (limit = 20) =>
    (await pool.query(`SELECT id, created_at, username, user_id, customer_name, address_text, total_cents, status, payment_status, items_json
                       FROM orders ORDER BY id DESC LIMIT $1`, [limit])).rows,

  getOrder: async (id) =>
    (await pool.query(`SELECT * FROM orders WHERE id=$1`, [id])).rows[0],

  setStatus: (id, status) =>
    pool.query(`UPDATE orders SET status=$2 WHERE id=$1`, [id, status]),

  // vendes mes actual
  currentMonthSales: async () => {
    const q = await pool.query(`
      WITH bounds AS (
        SELECT date_trunc('month', now()) AS start,
               date_trunc('month', now()) + interval '1 month' AS stop
      )
      SELECT
        COUNT(*) FILTER (WHERE payment_status='PAID')::int AS orders_paid,
        COALESCE(SUM(CASE WHEN payment_status='PAID' THEN total_cents END),0)::bigint AS revenue_cents,
        COALESCE(SUM(CASE WHEN payment_status='PAID' THEN total_cost_cents END),0)::bigint AS cost_cents
      FROM orders, bounds
      WHERE created_at >= bounds.start AND created_at < bounds.stop
    `);
    return q.rows[0] || { orders_paid: 0, revenue_cents: 0, cost_cents: 0 };
  }
};

/* ───────── Format helpers ───────── */
function formatItems(items_json) {
  let items = [];
  try { items = typeof items_json === 'string' ? JSON.parse(items_json) : (items_json || []); } catch {}
  if (!Array.isArray(items) || !items.length) return '(buit)';
  return items.map(it => {
    const talla = it.size ? ` — talla ${it.size}` : '';
    const qty = Number(it.qty || 1);
    const price = Number(it.price_cents || 0);
    return `• ${it.productName || it.name}${talla} ×${qty} = ${toEuro(price * qty)}`;
  }).join('\n');
}
function orderLine(o) {
  const when = new Date(o.created_at).toLocaleString('es-ES');
  return `#${o.id} — ${when} — ${o.customer_name || o.username || o.user_id} — ${toEuro(o.total_cents)} — ${o.status}/${o.payment_status}`;
}
function orderButtons(o) {
  if (o.status === 'COMPLETED') {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('Comanda realitzada ✅', 'NOOP'),
        Markup.button.callback('Reemborsament 💸', `ORDER_REFUND_${o.id}`)
      ]
    ]);
  }
  if (o.status === 'REFUND_REQUESTED') {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('Comanda realitzada ✅', 'NOOP'),
        Markup.button.callback('Reemborsament sol·licitat ⏳', 'NOOP')
      ]
    ]);
  }
  if (o.status === 'REFUNDED') {
    return Markup.inlineKeyboard([
      [Markup.button.callback('Reemborsament fet ✅', 'NOOP')]
    ]);
  }
  // Estat inicial (PENDING o altres)
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Marcar realitzada', `ORDER_DONE_${o.id}`)]
  ]);
}


function toAdminMsg(o) {
  return [
    `🆕 *COMANDA NOVA* (#${o.id}) — ${o.payment_status}`,
    ``,
    `Client: ${o.customer_name || '-'}`,
    `Usuari: ${o.username ? '@'+o.username : (o.user_id || '-')}`,
    ``,
    `Adreça:`,
    `${o.address_text || '-'}`,
    ``,
    `Productes:`,
    formatItems(o.items_json),
    ``,
    `Total: ${toEuro(o.total_cents)}`
  ].join('\n');
}
/* ───────── PG LISTENER: NOTIFICA NOVES ORDRES IMMEDIATAMENT ─────────
   Aquest bloc fa LISTEN al canal 'new_order'. Quan arriba una notificació,
   busca la comanda i envia el mateix missatge que fas servir al poll.
   També marca notified_at per evitar duplicats. */
(async function startPgListener() {
  try {
    const listenClient = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'require' ? ({ rejectUnauthorized: false }) : false
    });

    listenClient.on('error', (err) => {
      console.error('PG listen client error:', err?.message || err);
    });

    await listenClient.connect();
    await listenClient.query('LISTEN new_order');
    console.log('PG LISTEN new_order actiu');

    listenClient.on('notification', async (msg) => {
      try {
        if (!msg || msg.channel !== 'new_order') return;
        const payload = msg.payload ? JSON.parse(msg.payload) : {};
        const orderId = payload && (payload.orderId || payload.id);
        if (!orderId) {
          console.warn('NOTIFY new_order sense orderId:', msg.payload);
          return;
        }

        // Recupera la comanda tal com fas a db.getOrder
        const o = await db.getOrder(Number(orderId));
        if (!o) {
          console.warn('Nou notify però no trobo la comanda id=', orderId);
          return;
        }

        // Envia el missatge als admins reutilitzant el format existent
        const msgText = toAdminMsg(o);
        for (const chatId of ADMIN_IDS) {
          try {
            await admin.telegram.sendMessage(chatId, msgText, { parse_mode: 'Markdown', reply_markup: orderButtons(o).reply_markup });
          } catch (sendErr) {
            // fallback sense markdown
            try { await admin.telegram.sendMessage(chatId, msgText, { reply_markup: orderButtons(o).reply_markup }); } catch(e){ /* ignore */ }
            console.error('Error enviant notificació a', chatId, sendErr?.message || sendErr);
          }
        }

        // Marca com a notificat per evitar que el poll posterior l'enviï de nou
        try {
          await pool.query(`UPDATE orders SET notified_at = now() WHERE id = $1`, [o.id]);
        } catch (markErr) {
          console.error('Error marcant notified_at per ordre', o.id, markErr?.message || markErr);
        }

      } catch (err) {
        console.error('Error gestionant notification new_order:', err?.message || err);
      }
    });

    // Si el client es tanca, intentem reconnectar (simple retry)
    listenClient.on('end', () => {
      console.warn('Listen client tancat; reintentant en 10s...');
      setTimeout(startPgListener, 10000);
    });

  } catch (err) {
    console.error('No s\'ha pogut iniciar el PG listener new_order:', err?.message || err);
    // No fem throw perquè el poll existent segueixi funcionant com a fallback.
  }
})();


/* ───────── Bot UI ───────── */
admin.start((ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('No autoritzat.');
  ctx.reply('🛠️ Admin', Markup.keyboard([
    ['📦 Llistar comandes', '📥 Peticions'],
    ['📊 Vendes (mes)']
  ]).resize());
});

admin.hears('📦 Llistar comandes', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = await db.listLatestOrders(20);
  if (!rows.length) return ctx.reply('Encara no hi ha comandes.');
  for (const o of rows) await ctx.reply(orderLine(o), orderButtons(o));
});

admin.hears('📊 Vendes (mes)', async (ctx) => {
  if (!isAdmin(ctx)) return;
  try {
    const { orders_paid, revenue_cents, cost_cents } = await db.currentMonthSales();
    const profit_cents = Number(revenue_cents) - Number(cost_cents);
    const avg_cents = orders_paid ? Math.round(Number(revenue_cents)/orders_paid) : 0;
    const monthLabel = new Date().toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
    const msg = [
      `📊 *Vendes del mes* (${monthLabel})`,
      `Comandes pagades: ${orders_paid}`,
      `Ingressos: ${toEuro(revenue_cents)}`,
      `Cost estimat: ${toEuro(cost_cents)}`,
      `Benefici: ${toEuro(profit_cents)}`,
      `Tiquet mitjà: ${toEuro(avg_cents)}`
    ].join('\n');
    try { await ctx.reply(msg, { parse_mode: 'Markdown' }); }
    catch { await ctx.reply(msg); }
  } catch (e) {
    console.error('currentMonthSales error:', e.message);
    await ctx.reply('No s’ha pogut calcular les vendes. Prova en uns segons.');
  }
});

// Quan premen "Marcar realitzada"
admin.action(/ORDER_DONE_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('No autoritzat');
  const id = Number(ctx.match[1]);
  try {
    await db.setStatus(id, 'COMPLETED');
    await ctx.answerCbQuery('Comanda marcada com realitzada');
    const o = await db.getOrder(id);
    await ctx.editMessageReplyMarkup(orderButtons(o).reply_markup);
  } catch (err) {
    console.error('ORDER_DONE error', err);
    await ctx.answerCbQuery('Error marcant', { show_alert: true });
  }
});
admin.action(/ORDER_REFUND_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('No autoritzat');
  const id = Number(ctx.match[1]);
  try {
    const o = await db.getOrder(id);
    if (!o) throw new Error('Comanda inexistent');

    // Extreure captureId i amount de l’ordre
    const { captureId, amount } = extractCaptureFromOrder(o);
    if (!captureId) throw new Error('No s\'ha trobat cap captureId a payment_receipt_json');

    // Opcional: si vols refund parcial, canvia amount.value
    // Exemple parcial: const refund = await paypalRefundCapture(captureId, { currency_code: amount.currency_code || 'EUR', value: '1.00' });
    const refund = await paypalRefundCapture(captureId, amount); // refund total per defecte

    // Actualitza estat a la BD
    if (db.setStatus) await db.setStatus(id, 'REFUND_REQUESTED'); // o 'REFUNDED' si vols tancar directe
    // Si tens columnes per guardar el refund id/json, pots afegir una funció al teu db per persistir: refund_id = refund.id, refund_json = refund
    // await db.setRefundInfo?.(id, { refund_id: refund.id, refund_receipt_json: refund });

    await ctx.answerCbQuery('Reemborsament sol·licitat 💸');
    const updated = await db.getOrder(id);
    // Mostra “Reemborsament sol·licitat ⏳” o “Reemborsament fet ✅” segons l’estat que vulguis deixar
    await ctx.editMessageReplyMarkup(orderButtons(updated).reply_markup);
  } catch (err) {
    console.error('ORDER_REFUND error', err);
    await ctx.answerCbQuery(`Error reemborsant: ${err.message}`, { show_alert: true });
  }
});

// Quan premen "Reemborsament 💸"
admin.action(/ORDER_REFUND_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('No autoritzat');
  const id = Number(ctx.match[1]);
  await db.setStatus(id, 'REFUND_REQUESTED');
  await ctx.answerCbQuery('Reemborsament sol·licitat');
  const o = await db.getOrder(id);
  // refresquem text i botons segons el nou estat
  try { await ctx.editMessageText(orderLine(o), orderButtons(o)); } catch {}
});


admin.action('NOOP', (ctx) => ctx.answerCbQuery());

/* ───────── Notificador: COMANDES NOVES PAGADES ─────────
   Envia missatge per cada ordre amb payment_status='PAID' i notified_at IS NULL */
async function checkNewPaidOrders() {
  try {
    const q = await pool.query(`
      SELECT *
      FROM orders
      WHERE payment_status='PAID'
        AND notified_at IS NULL
      ORDER BY id ASC
      LIMIT 20
    `);
    for (const o of q.rows) {
      const msg = toAdminMsg(o);
      // Enviar a tots els ADMIN_IDS (han de ser IDs d'usuari o grup, NO un bot)
      for (const chatId of ADMIN_IDS) {
        try {
          await admin.telegram.sendMessage(chatId, msg, { parse_mode: 'Markdown', reply_markup: orderButtons(o).reply_markup });
        } catch (e) {
          // Fallback sense markdown
          await admin.telegram.sendMessage(chatId, msg, { reply_markup: orderButtons(o).reply_markup }).catch(()=>{});
        }
      }
      await pool.query(`UPDATE orders SET notified_at = now() WHERE id=$1`, [o.id]);
    }
  } catch (e) {
    console.error('checkNewPaidOrders error:', e.message);
  }
}
setInterval(checkNewPaidOrders, 10 * 1000);
checkNewPaidOrders();

/* ───────── (Opcional) Avisos de pendents vells ───────── */
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
      await admin.telegram.sendMessage(chatId, msg, { parse_mode: 'Markdown', reply_markup: orderButtons(o).reply_markup });
    } catch {
      await admin.telegram.sendMessage(chatId, msg, { reply_markup: orderButtons(o).reply_markup }).catch(()=>{});
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
      await pool.query(`UPDATE orders SET overdue_alerted_at=now() WHERE id=$1`, [o.id]);
    }
  } catch (e) {
    console.error('overdue checker error:', e.message);
  }
}
setInterval(checkOverdue, Math.max(1, OVERDUE_POLL_MIN) * 60 * 1000);
checkOverdue();

/* ───────── Peticions (si ja les fas servir) ───────── */
function reqButtonsInline(r) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Acceptar', `REQ_ACCEPT_${r.id}`), Markup.button.callback('❌ Rebutjar', `REQ_REJECT_${r.id}`)],
    [Markup.button.callback('✔️ Fet', `REQ_DONE_${r.id}`)]
  ]);
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
admin.hears('📥 Peticions', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const q = await pool.query(`SELECT * FROM product_requests WHERE status='NEW' ORDER BY id DESC LIMIT 30`);
  const rows = q.rows;
  if (!rows.length) return ctx.reply('Sense peticions noves.');
  for (const r of rows) await ctx.reply(formatReq(r), reqButtonsInline(r));
});
admin.action(/REQ_ACCEPT_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('No autoritzat');
  const id = Number(ctx.match[1]);
  await pool.query(`UPDATE product_requests SET status='APPROVED' WHERE id=$1`, [id]);
  const r = (await pool.query(`SELECT * FROM product_requests WHERE id=$1`, [id])).rows[0];
  await ctx.answerCbQuery('Acceptada');
  try { await ctx.editMessageText(formatReq(r), reqButtonsInline(r)); } catch {}
});
admin.action(/REQ_REJECT_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('No autoritzat');
  const id = Number(ctx.match[1]);
  await pool.query(`UPDATE product_requests SET status='REJECTED' WHERE id=$1`, [id]);
  const r = (await pool.query(`SELECT * FROM product_requests WHERE id=$1`, [id])).rows[0];
  await ctx.answerCbQuery('Rebutjada');
  try { await ctx.editMessageText(formatReq(r), reqButtonsInline(r)); } catch {}
});
admin.action(/REQ_DONE_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('No autoritzat');
  const id = Number(ctx.match[1]);
  await pool.query(`UPDATE product_requests SET status='DONE' WHERE id=$1`, [id]);
  const r = (await pool.query(`SELECT * FROM product_requests WHERE id=$1`, [id])).rows[0];
  await ctx.answerCbQuery('Marcada com feta');
  try { await ctx.editMessageText(formatReq(r), reqButtonsInline(r)); } catch {}
});

/* ───────── Llençar ───────── */
admin.catch((err, ctx) => { console.error('Admin bot error', err); try { ctx.reply('Error.'); } catch {} });
admin.launch().then(() => console.log('Admin bot running'));
process.once('SIGINT', () => admin.stop('SIGINT'));
process.once('SIGTERM', () => admin.stop('SIGTERM'));




