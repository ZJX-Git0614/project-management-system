#!/bin/sh
set -e

DB_PATH="/app/data/dev.db"

# 首次启动时初始化数据库
if [ ! -f "$DB_PATH" ]; then
  echo ">>> 首次启动：初始化数据库..."
  cd /app
  npx prisma db push --skip-generate 2>&1
  echo ">>> 写入种子数据..."
  npx prisma db seed 2>&1
  echo ">>> 数据库初始化完成"
else
  echo ">>> 数据库已存在，跳过初始化"
fi

echo ">>> 启动 Ceastar项目管理系统服务..."
exec "$@"
