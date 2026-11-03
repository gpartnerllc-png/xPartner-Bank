FROM node:24-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY circuits ./circuits

RUN mkdir -p /app/.data && chown -R node:node /app
USER node

ENV PORT=8080 HOST=0.0.0.0 DB_PATH=/app/.data/xpartner.db
ENV XPARTNER_ZK_ARTIFACTS=/app/circuits/build/
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/main.ts"]
