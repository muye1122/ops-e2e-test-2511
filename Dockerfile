# Multi-stage demo image. Base image is MIT/BSD licensed runtime; no GPL deps.
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY mock-server ./mock-server
EXPOSE 3001 3002 3003 3004 4173
CMD ["node", "mock-server/ops.js"]
