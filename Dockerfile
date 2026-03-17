FROM node:20-alpine AS base

RUN apk add --no-cache ffmpeg
ENV FFMPEG_PATH=ffmpeg

# ── Build frontend ─────────────────────────────────────────────────────────────
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY index.html tsconfig*.json ./
COPY src ./src
RUN npm run build

# ── Install server deps ────────────────────────────────────────────────────────
WORKDIR /app/server

COPY server/package*.json ./
RUN npm ci

# tsx needed at runtime since we skip the compile step
RUN npm install tsx

COPY server/index.ts server/tsconfig.json ./

EXPOSE 3001

CMD ["node", "--import", "tsx/esm", "index.ts"]
