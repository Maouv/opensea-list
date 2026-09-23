FROM node:22-alpine

WORKDIR /app

RUN npm install -g pm2@latest

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY bot.js lib ./
COPY ecosystem.config.js ./

USER node

CMD ["pm2-runtime", "ecosystem.config.js"]
