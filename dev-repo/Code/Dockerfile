# ============ Build Stage ============
FROM node:20-alpine AS builder

WORKDIR /app

# 安装依赖
COPY package.json package-lock.json* ./
RUN npm ci

# 生成 Prisma Client 并构建
COPY . .
RUN npx prisma generate
RUN npm run build

# ============ Production Stage ============
FROM node:20-alpine AS runner

WORKDIR /app

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
