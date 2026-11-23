FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src/ src/
COPY public/ public/
COPY config/ config/
COPY extensions/ extensions/
RUN mkdir -p /data /workspace /plan-secrets && chown node:node /data /workspace /plan-secrets && chmod 700 /plan-secrets
USER node
ENV CLOCKWORK_BIND=0.0.0.0 CLOCKWORK_PORT=8787 CLOCKWORK_DB=/data/clockwork.sqlite
EXPOSE 8787
CMD ["node", "src/server.mjs"]
