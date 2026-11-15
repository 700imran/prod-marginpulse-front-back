FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
ENV NODE_ENV=production AUTH_DIR=/data/auth SPOOL_DIR=/data/spool PORT=8787
VOLUME /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "src/server.js"]
