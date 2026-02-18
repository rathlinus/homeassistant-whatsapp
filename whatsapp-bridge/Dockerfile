ARG BUILD_FROM=node:20-slim
FROM $BUILD_FROM

# Install Chromium + helper tools
RUN apt-get update && \
    apt-get install -y \
      chromium \
      bash \
      jq \
      ca-certificates \
      fonts-liberation \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcups2 \
      libdrm2 \
      libgbm1 \
      libnspr4 \
      libnss3 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libxss1 \
      libxtst6 \
      xdg-utils \
      --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Tell Puppeteer / whatsapp-web.js to use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Node app
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD ["/run.sh"]
