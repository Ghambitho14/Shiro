# Shiro — imagen para servidor web (y puente WhatsApp con QR desde la UI)
# Node 20 + Chromium para whatsapp-web.js
FROM node:20-bookworm-slim

# Chromium y librerías para Puppeteer en Docker
RUN apt-get update && apt-get install -y --no-install-recommends \
	chromium \
	ca-certificates \
	fonts-liberation \
	&& rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1
ENV WA_CHROME_PATH=/usr/bin/chromium

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm ci || npm install

COPY src ./src
COPY public ./public

# El servidor debe escuchar en todas las interfaces dentro del contenedor
ENV BIND_HOST=0.0.0.0
ENV PORT=1406

EXPOSE 1406

# Solo servidor web; el puente WhatsApp se inicia desde la UI (QR en la web)
CMD ["node", "--import", "tsx", "src/server.ts"]
