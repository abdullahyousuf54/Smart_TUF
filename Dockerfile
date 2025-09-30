FROM node:18

# Install system dependencies required by Chromium and Puppeteer
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    libxshmfence1 \
    libu2f-udev \
    chromium \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install only server dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy server source
COPY server.js ./

EXPOSE 3001

# Environment for Puppeteer
ENV NODE_ENV=production \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

CMD ["node", "server.js"]


