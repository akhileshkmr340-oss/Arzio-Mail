FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY scripts ./scripts
ENV NODE_ENV=production \
    ARZIO_DATA_DIR=/data \
    PORT=3000 \
    INBOUND_SMTP_PORT=2525 \
    IMAP_PORT=1993 \
    SUBMISSION_PORT=1465
RUN mkdir -p /data /backups && chown node:node /data /backups
USER node
VOLUME ["/data", "/backups"]
# 3000 web + API + CalDAV/CardDAV + MCP, 2525 inbound MX, 1993 IMAP, 1465 SMTP submission.
# Map host ports 25, 993 and 465 onto these (see deploy/docker-compose.yml).
EXPOSE 3000 2525 1993 1465
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/ready" >/dev/null || exit 1
STOPSIGNAL SIGTERM
CMD ["node", "--no-warnings", "src/server.js"]
