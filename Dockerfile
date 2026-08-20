FROM node:20-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
COPY public ./public

ENV PORT=3400
EXPOSE 3400

CMD ["node", "src/server.js"]
