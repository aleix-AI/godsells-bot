// admin_bot.js — Telegraf + PostgreSQL + Webhook (autotag robust + feedback)
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
  listProducts: async () =>
    (await pool.query('SELECT * FROM products ORDER BY id DESC LIMIT 200')).rows,
  listOrders: async () =>
    (await pool.query('SELECT * FROM orders ORDER BY id DESC LIMIT 100')).rows,
  listQueries: async () =>
    (await pool.query('SELECT * FROM queries ORDER BY id DESC LIMIT 200')).rows,
  salesSummary: async () =>
    (await pool.query(`SELECT date_trunc('day', created_at) AS day,
                              SUM(total_cents) AS rev,
                              SUM(total_cost_cents) AS cog,
                              SUM(total_cents-total_cost_cents) AS margin
                       FROM orders GROUP BY 1 ORDER BY 1 DESC LIMIT 30`)).rows,
  autotag: async () => {
    // BRAND
    await pool.query(`UPDATE products SET brand='Nike'
      WHERE (brand IS NULL OR brand='') AND name ~* '(\\bNike\\b|Dunk|Cortez|Pegasus|P-?6000|Air\\s?Force|TN\\b)'`);
    await pool.query(`UPDATE products SET brand='Adidas'
      WHERE (brand IS NULL OR brand='') AND name ~* '(\\bAdidas\\b|Samba|Gazelle|Campus|Forum|Stan\\s?Smith|Superstar|Yeezy)'`);
    await pool.query(`UPDATE products SET brand='Jordan'
      WHERE (brand IS NULL OR brand='') AND name ~* '(\\bJordan\\b|AJ\\s?\\d)'`);
    await pool.query(`UPDATE products SET brand='New Balance'
      WHERE (brand IS NULL OR brand='') AND name ~* '(New\\s?Balance|\\bNB\\b|\\bNB\\s?\\d{3}\\b|550|530|2002R|990|991|992)'`);
    await pool.query(`UPDATE products SET brand='ASICS'
      WHERE (brand IS NULL OR brand='') AND name ~* '(ASICS|Gel[-\\s]?)'`);
    await pool.query(`UPDATE products SET brand='Puma'
      WHERE (brand IS NULL OR brand='') AND name ~* '(\\bPuma\\b|Suede|RS-?X)'`);
    await pool.query(`UPDATE products SET brand='Reebok'
      WHERE (brand IS NULL OR brand='') AND name ~* '(Reebok|Club\\s?C|Classic)'`);
    // CATEGORY
    await pool.query(`UPDATE products SET category='Roba'
      WHERE (category IS NULL OR category='') AND name ~* '(hoodie|sudadera|chaqueta|cazadora|pantal(|ó|o)n|short|camiseta|t-?shirt|tee|jacket|chandal|tracksuit|top|calcetines|socks)'`);
    await pool.query(`UPDATE products SET category='Sabates'
      WHERE (category IS NULL OR category='')`); // la resta per defecte

    const brands = (await pool.query(`SELECT COALESCE(brand,'(sense)') b, COUNT(*) n FROM products GROUP BY 1 ORDER BY n DESC`)).rows;
    const cats   = (await pool.query(`SELECT COALESCE(category,'(sense)') c, COUNT(*) n FROM products GROUP BY 1 ORDER BY n DESC`)).rows;
    return { brands, cats };
  }
};

/* BOT */
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').toString().split(',').filter(Boolean);
if (!ADMIN_BOT_TOKEN) throw new Error('Falta ADMIN_BOT_TOKEN');

const admin = new Telegraf(ADMIN_BOT_TOKEN);
const isAdmin = (ctx) => ADMIN_IDS.includes(String(ctx.from.id));

admin.start((ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('No autoritzat.');
  ctx.reply('🛠️ Admin', Markup.keyboard([
    ['➕ Afegir producte','🧩 Llistar productes'],
    ['📦 Llistar comandes','📝 Consultes clients'],
    ['📊 Balanç (30 dies)','🏷️ /autotag']
  ]).resize());
});

admin.hears('🧩 Llistar productes', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = await db.listProducts();
  if (!rows.length) return ctx.reply('No hi ha productes.');
  ctx.reply(rows.map(p=>`#${p.id} — ${p.name} ${p.brand?`(${p.brand})`:''} ${p.category?`[${p.category}]`:''}`).join('\n').slice(0,4000));
});

admin.hears('📦 Llistar comandes', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = await db.listOrders();
  if (!rows.length) return ctx.reply('Encara no hi ha comandes.');
  ctx.reply(rows.map(o=>`#${o.id} — ${new Date(o.created_at).toLocaleString('es-ES')} — ${o.username || o.user_id} — ${(o.total_cents/100).toFixed(2)} €`).join('\n').slice(0,4000));
});

admin.hears('📝 Consultes clients', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = await db.listQueries();
  if (!rows.length) return ctx.reply('Sense consultes.');
  ctx.reply(rows.slice(0,30).map(q=>`${new Date(q.created_at).toLocaleString('es-ES')} — ${q.username || q.user_id}: ${q.text}`).join('\n'));
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

// Autotag: /autotag o /tags
async function handleAutotag(ctx){
  if (!isAdmin(ctx)) return;
  try {
    await ctx.reply('🏷️ Classificant marques i categories…');
    const { brands, cats } = await db.autotag();
    await ctx.reply([
      '✅ Fet!',
      '— Marques:',
      ...brands.slice(0,12).map(b=>`• ${b.b}: ${b.n}`),
      '— Categories:',
      ...cats.map(c=>`• ${c.c}: ${c.n}`)
    ].join('\n'));
  } catch (e) {
    console.error('autotag error', e);
    await ctx.reply('❌ Error en /autotag. Revisa logs del servei admin.');
  }
}
admin.command('autotag', handleAutotag);
admin.hears(/^\/tags\b/i, handleAutotag);

admin.catch((err, ctx) => { console.error('Admin bot error', err); try { ctx.reply('Error.'); } catch {} });

/* ARRANQUE (Webhook o Polling) */
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
  app.listen(PORT, () => console.log('Listening on', PORT));
} else {
  await admin.launch();
  console.log('Admin bot running (long polling)');
}

process.once('SIGINT', () => admin.stop('SIGINT'));
process.once('SIGTERM', () => admin.stop('SIGTERM'));
