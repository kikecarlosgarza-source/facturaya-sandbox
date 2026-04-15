FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

# Instalar Chromium para Playwright
RUN npx playwright install chromium

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
