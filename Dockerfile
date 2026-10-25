FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
RUN npm run build:web
ENV NODE_OPTIONS=--max-old-space-size=768 \
    PORT=8000
EXPOSE 8000
CMD ["npx", "tsx", "server.ts"]
