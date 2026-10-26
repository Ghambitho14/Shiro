# Shiro — imagen para servidor web (y puente WhatsApp con QR desde la UI)
# Node 22 + Chromium (navegador de Shiro y whatsapp-web.js)
FROM node:22-bookworm-slim

# Chromium y librerías para Puppeteer en Docker
RUN apt-get update && apt-get install -y --no-install-recommends \
	chromium \
	ca-certificates \
	fonts-liberation \
	&& rm -rf /var/lib/apt/lists/*

# Dentro de un contenedor Chromium no puede usar su sandbox: el lanzador de Debian
# lee /etc/chromium.d, así que --no-sandbox le llega también al navegador de Shiro.
RUN echo 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox"' > /etc/chromium.d/docker-no-sandbox

# No descargar el Chrome de puppeteer: se usa el Chromium del sistema
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1
ENV WA_CHROME_PATH=/usr/bin/chromium

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci && npm cache clean --force

COPY src ./src
COPY public ./public
COPY bin ./bin

# Se ejecuta como el usuario "node" (uid 1000): los archivos de ./data montados
# desde el servidor siguen siendo del usuario normal, no de root.
RUN mkdir -p /app/data && chown node:node /app/data
USER node

# El servidor debe escuchar en todas las interfaces dentro del contenedor
ENV BIND_HOST=0.0.0.0
ENV PORT=1406

EXPOSE 1406

# Solo servidor web; el puente WhatsApp se inicia desde la UI (QR en la web)
CMD ["node", "--import", "tsx", "src/server.ts"]
