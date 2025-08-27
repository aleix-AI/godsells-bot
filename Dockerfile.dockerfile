FROM node:20-slim AS deps
WORKDIR /app
COPY v2-postgres/package*.json ./
RUN npm ci --omit=dev


FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY v2-postgres/. .
EXPOSE 3000
CMD ["node", "customer_bot.js"] # al servei admin, canvia a admin_bot.js