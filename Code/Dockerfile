# PostgreSQL 16 client tools are copied from the matching official image so
# backup compatibility does not depend on Debian's default client version.
FROM postgres:16-alpine AS postgres-client

# The npm native MPP converter requires AVX2 on Linux. A Java MPXJ fallback
# keeps MPP imports compatible with older x86 Windows hosts running Docker.
FROM maven:3.9-eclipse-temurin-21 AS mpp-converter-builder

WORKDIR /build
COPY deployment/mpp-converter/pom.xml ./pom.xml
RUN mvn -q -DskipTests dependency:go-offline
COPY deployment/mpp-converter/src ./src
RUN mvn -q -DskipTests package

FROM eclipse-temurin:21-jre-jammy AS java-runtime

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

COPY --from=postgres-client /usr/local/bin/pg_dump /opt/postgresql16/bin/pg_dump
COPY --from=postgres-client /usr/local/bin/pg_restore /opt/postgresql16/bin/pg_restore
COPY --from=postgres-client /lib/ld-musl-x86_64.so.1 /opt/postgresql16/lib/ld-musl-x86_64.so.1
COPY --from=postgres-client /usr/local/lib/libpq.so.5* /opt/postgresql16/lib/
COPY --from=postgres-client /usr/lib/libzstd.so.1* /opt/postgresql16/lib/
COPY --from=postgres-client /usr/lib/liblz4.so.1* /opt/postgresql16/lib/
COPY --from=postgres-client /usr/lib/libcrypto.so.3 /opt/postgresql16/lib/
COPY --from=postgres-client /usr/lib/libz.so.1* /opt/postgresql16/lib/
COPY --from=postgres-client /usr/lib/libssl.so.3 /opt/postgresql16/lib/
COPY --from=postgres-client /usr/lib/libgssapi_krb5.so.2* /opt/postgresql16/lib/
COPY --from=postgres-client /usr/lib/libldap.so.2* /opt/postgresql16/lib/
COPY --from=postgres-client /usr/lib/libkrb5.so.3* /opt/postgresql16/lib/
COPY --from=postgres-client /usr/lib/libk5crypto.so.3* /opt/postgresql16/lib/
COPY --from=postgres-client /usr/lib/libcom_err.so.2* /opt/postgresql16/lib/
COPY --from=postgres-client /usr/lib/libkrb5support.so.0* /opt/postgresql16/lib/
COPY --from=postgres-client /usr/lib/liblber.so.2* /opt/postgresql16/lib/
COPY --from=postgres-client /usr/lib/libsasl2.so.3* /opt/postgresql16/lib/
COPY --from=postgres-client /usr/lib/libkeyutils.so.1* /opt/postgresql16/lib/
COPY --from=java-runtime /opt/java/openjdk /opt/java/openjdk
COPY --from=mpp-converter-builder /build/target/mpp-converter.jar /opt/ceastar/mpp-converter.jar

RUN printf '%s\n' '#!/bin/sh' \
    'exec /opt/postgresql16/lib/ld-musl-x86_64.so.1 --library-path /opt/postgresql16/lib /opt/postgresql16/bin/pg_dump "$@"' \
    > /usr/local/bin/pg_dump \
  && printf '%s\n' '#!/bin/sh' \
    'exec /opt/postgresql16/lib/ld-musl-x86_64.so.1 --library-path /opt/postgresql16/lib /opt/postgresql16/bin/pg_restore "$@"' \
    > /usr/local/bin/pg_restore \
  && chmod +x /usr/local/bin/pg_dump /usr/local/bin/pg_restore

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV MPP_CONVERTER_JAR=/opt/ceastar/mpp-converter.jar
ENV PATH="/opt/java/openjdk/bin:${PATH}"

# 从 builder 复制全部产物
COPY --from=builder /app/next.config.ts ./
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/docs ./docs

# PostgreSQL 通过 docker-compose 的 postgres 服务提供，无需本地数据目录

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# 启动脚本：初始化 DB + seed + 启动
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "run", "start"]
