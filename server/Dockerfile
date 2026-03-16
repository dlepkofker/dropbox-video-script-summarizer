FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# tsx needed at runtime since we skip the compile step
RUN npm install tsx

COPY index.ts tsconfig.json ./

EXPOSE 3001

CMD ["node", "--import", "tsx/esm", "index.ts"]
