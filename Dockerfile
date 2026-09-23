# Prism, hosted: accounts on, one data folder per user under /data.
#   docker build -t prism .
#   docker run -p 3000:3000 -e PRISM_SECRET=<long random string> -v prism-data:/data prism
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PRISM_HOSTED=1 PRISM_DATA_DIR=/data PORT=3000
COPY package.json package-lock.json ./
# electron is a desktop-only dependency; the server doesn't need it
RUN npm ci --omit=dev --ignore-scripts && npm uninstall electron electron-builder --no-save 2>/dev/null || true
COPY server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
VOLUME ["/data"]
EXPOSE 3000
USER node
CMD ["node", "server.js"]
