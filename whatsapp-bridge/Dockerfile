ARG BUILD_FROM=ghcr.io/home-assistant/aarch64-base:latest
FROM $BUILD_FROM

# HA base images are Alpine Linux – use apk, not apt-get.
# Install Node.js (not pre-installed) + Chromium + minimal Chromium runtime deps.
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

# Alpine Chromium binary is at /usr/bin/chromium-browser
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Node app
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD ["/run.sh"]
