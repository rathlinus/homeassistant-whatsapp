FROM node:20-slim

# Install Chromium for Puppeteer
RUN apt-get update && \
    apt-get install -y chromium --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Tell Puppeteer / whatsapp-web.js to use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js .

# Persist the WhatsApp session data outside the container
VOLUME ["/app/.wwebjs_auth"]

EXPOSE 3000

CMD ["node", "server.js"]
