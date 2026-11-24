FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY scripts ./scripts
ENV ARZIO_DATA_DIR=/data
VOLUME /data
EXPOSE 3000 25
CMD ["node", "--no-warnings", "src/server.js"]
