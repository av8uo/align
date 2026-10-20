# Align — single-container deploy (ECS Express Mode / Fargate; also Railway, Render, Fly)
FROM node:24-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

# SQLite lives here; mount a volume at /app/data for persistence across
# restarts, or leave it ephemeral (the server re-seeds the demo on boot).
ENV NODE_ENV=production \
    PORT=3344 \
    LIFEOS_DB=/app/data/lifeos.db
EXPOSE 3344

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3344)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/server.ts"]
