FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node src src
COPY --chown=node:node scripts scripts
COPY --chown=node:node migrations migrations
COPY --chown=node:node certs certs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=15s --start-period=40s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz', {signal:AbortSignal.timeout(12000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
