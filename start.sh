#!/bin/sh
# live-rec-hinas 启动脚本
DIR=$(cd "$(dirname "$0")" && pwd)
cd "$DIR"

# 优先使用 setup.sh 安装的本地 Node
if [ -x "$DIR/runtime/node/bin/node" ]; then
  export PATH="$DIR/runtime/node/bin:$PATH"
fi

# PORT 环境变量可临时覆盖端口；默认读 config.json 的 port（7788）
# 例: PORT=8080 ./start.sh
export PORT="${PORT:-}"

exec node server.js
