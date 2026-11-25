#!/bin/bash
# QBoard 启动脚本
# 双击运行，或在终端里 ./start.sh

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "没找到 node。先装一个：https://nodejs.org （选 LTS 版本）"
  read -r -p "按回车关闭…" _
  exit 1
fi

if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo "已生成 config.json，第一次用需要在网页里填 API Key。"
fi

export PORT="${PORT:-7788}"
export HOST="${HOST:-127.0.0.1}"

# 等服务器起来再开浏览器
( sleep 1.2; open "http://localhost:${PORT}" 2>/dev/null || true ) &

node server.mjs
