import 'dotenv/config';


admin.hears('📝 Consultes clients', async (ctx) => {
if (!isAdmin(ctx)) return;
const rows = await db.listQueries();
if (!rows.length) return ctx.reply('Sense consultes.');
const text = rows.map(q => `${new Date(q.created_at).toLocaleString('es-ES')} — ${q.username || q.user_id}: ${q.text}`).slice(0,30).join('\n');
ctx.reply(text);
});


admin.hears('➕ Afegir producte', (ctx) => {
if (!isAdmin(ctx)) return;
ctx.reply('Envia: Nom | Descripció opcional');
admin.once('text', async (ctx2) => {
if (!isAdmin(ctx2)) return;
const [name, ...rest] = ctx2.message.text.split('|').map(s => s.trim());
if (!name) return ctx2.reply('Nom requerit.');
const { id } = await db.insertProduct(name, rest.join(' | ') || '');
ctx2.reply(`✅ Producte #${id} creat. Ara afegeix variants (vegeu instruccions).`);
});
});


admin.command('addvariant', (ctx) => {
if (!isAdmin(ctx)) return;
ctx.reply('Format: productId | Variant | Valor | Preu € | Stock | Cost € (opcional)');
});


admin.on('text', async (ctx, next) => {
if (!isAdmin(ctx)) return;
const m = ctx.message.text;
if (!m.includes('|')) return next();
const parts = m.split('|').map(s => s.trim());
if (parts.length >= 5 && /^\d+$/.test(parts[0])) {
const [pid, optName, optValue, priceEuroStr, stockStr, costEuroStr] = parts;
const price_cents = Math.round(parseFloat((priceEuroStr||'0').replace(',', '.')) * 100);
const stock = parseInt(stockStr || '0', 10);
const cost_cents = costEuroStr ? Math.round(parseFloat(costEuroStr.replace(',','.'))*100) : 0;
if (Number.isNaN(price_cents) || Number.isNaN(stock) || Number.isNaN(cost_cents)) return ctx.reply('Preu/stock/cost invàlids.');
const { id } = await db.insertVariant(Number(pid), optName, optValue, price_cents, stock, cost_cents);
return ctx.reply(`✅ Variant #${id} → prod ${pid}: ${optName}=${optValue} (${(price_cents/100).toFixed(2)} €, cost ${(cost_cents/100).toFixed(2)} €, stock ${stock})`);
}
return next();
});


admin.hears('📊 Balanç (30 dies)', async (ctx) => {
if (!isAdmin(ctx)) return;
const rows = await db.salesSummary();
if (!rows.length) return ctx.reply('Sense dades.');
const text = rows.map(r => {
const d = new Date(r.day).toLocaleDateString('es-ES');
const rev = (Number(r.rev)/100).toFixed(2);
const cog = (Number(r.cog)/100).toFixed(2);
const mar = (Number(r.margin)/100).toFixed(2);
return `${d} — Ingrés: ${rev} € | Cost: ${cog} € | Marge: ${mar} €`;
}).join('\n');
ctx.reply(text);
});


admin.catch((err, ctx) => { console.error('Admin bot error', err); ctx.reply('Error.'); });


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