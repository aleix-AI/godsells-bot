import 'dotenv/config';
bot.action('CONT_SHOP', (ctx) => ctx.reply('Escriu què busques o usa /catalog.'));


bot.action('CHECKOUT', async (ctx) => {
const s = getS(ctx.from.id);
if (!s.cart || !s.cart.length) return ctx.answerCbQuery('Cistella buida');
for (const it of s.cart) {
const res = await db.decStock(it.variantId, it.qty);
if (res.rowCount === 0) return ctx.reply(`Sense stock suficient per ${it.productName} — ${it.variantLabel}.`);
}
const total = s.cart.reduce((acc, it) => acc + it.price_cents*it.qty, 0);
const totalCost = s.cart.reduce((acc, it) => acc + (it.cost_cents||0)*it.qty, 0);
await db.insertOrder(ctx.from.id, ctx.from.username || '', s.cart, total, totalCost);
setS(ctx.from.id, { cart: [] });
await ctx.editMessageText(`✅ Comanda registrada! Total: ${toEuro(total)}. Ens posarem en contacte.`);
});


bot.action('CLEAR_CART', (ctx) => { setS(ctx.from.id, { cart: [] }); ctx.editMessageText('🧹 Cistella buidada.'); });


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