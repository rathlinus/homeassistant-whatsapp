ARG BUILD_FROM=ghcr.io/home-assistant/aarch64-base:latest
FROM $BUILD_FROM

# HA base images are Alpine Linux – use apk, not apt-get.
# Install Node.js (not pre-installed) + Chromium + minimal runtime deps.
RUN apk add --no-cache \
      nodejs \
      npm \
      chromium \
      bash \
      jq \
      ca-certificates \
      nss \
      freetype \
      harfbuzz \
      ttf-freefont

# Locate the real Chromium binary and create a stable symlink at /usr/local/bin/chromium-wr
# This survives any Alpine package naming inconsistency.
RUN CHROMIUM_BIN=$(which chromium-browser 2>/dev/null || which chromium 2>/dev/null) && \
    echo "Found Chromium at: ${CHROMIUM_BIN}" && \
    ln -sf "${CHROMIUM_BIN}" /usr/local/bin/chromium-wr

# Bake the path into the image – Puppeteer reads this at startup
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/chromium-wr
ENV CHROME_BIN=/usr/local/bin/chromium-wr

WORKDIR /app
COPY package.json ./
COPY puppeteer.config.cjs ./
RUN npm install --omit=dev

COPY server.js ./
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD ["/run.sh"]
