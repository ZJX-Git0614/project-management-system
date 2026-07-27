# ============ Build Stage ============
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Prisma needs OpenSSL both while generating its engine and at runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# 安装依赖
COPY package.json package-lock.json* ./
RUN npm ci

# 生成 Prisma Client 并构建
COPY . .
RUN mkdir -p public
RUN npx prisma generate
RUN npm run build

# ============ Production Stage ============
FROM node:20-bookworm-slim AS runner

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates postgresql-client tar \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# 从 builder 复制全部产物
COPY --from=builder /app/next.config.ts ./
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules

# PostgreSQL 通过 docker-compose 的 postgres 服务提供，无需本地数据目录

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# 启动脚本：初始化 DB + seed + 启动
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npx", "next", "start"]
