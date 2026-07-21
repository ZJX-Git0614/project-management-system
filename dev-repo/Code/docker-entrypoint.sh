#!/bin/sh
set -e

echo ">>> 等待 PostgreSQL 就绪..."
until npx prisma db push --skip-generate 2>&1; do
  echo ">>> 数据库尚未就绪，5秒后重试..."
  sleep 5
done

echo ">>> 执行增量数据修复脚本..."
for migration in prisma/manual-migrations/*.sql; do
  [ -f "$migration" ] || continue
  npx prisma db execute --file "$migration" --schema prisma/schema.prisma 2>&1
done

echo ">>> 写入种子数据..."
npx prisma db seed 2>&1 || echo ">>> 种子数据已存在或写入失败，继续启动..."

echo ">>> 启动 Ceastar项目管理系统服务..."
exec "$@"
