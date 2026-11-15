#!/bin/sh
# live-rec-hinas 一次性环境安装脚本（在盒子上执行）
# 用法: chmod +x setup.sh && sudo ./setup.sh
set -e

DIR=$(cd "$(dirname "$0")" && pwd)
cd "$DIR"
RUNTIME="$DIR/runtime"
mkdir -p "$RUNTIME"

NODE_VER="v20.18.1"
detect_arch() {
  case "$(uname -m)" in
    aarch64|arm64)  NODE_ARCH="arm64";  FF_TAG="linux-arm64" ;;
    armv7l|armv6l)  NODE_ARCH="armv7l"; FF_TAG="linux-armhf" ;;
    x86_64|amd64)   NODE_ARCH="x64";    FF_TAG="linux-amd64" ;;
    *) echo "不支持的架构: $(uname -m)"; exit 1 ;;
  esac
}
detect_arch

have() { command -v "$1" >/dev/null 2>&1; }

node_ok() {
  "$1" -v 2>/dev/null | sed 's/^v//' | awk '{exit ($1>=18)?0:1}' 2>/dev/null
}

echo "==> [1/3] 检查 Node.js (>=18) ..."
NODE_BIN=""
if have node && node_ok node; then
  NODE_BIN="node"; echo "    使用系统 node $(node -v)"
elif [ -x "$RUNTIME/node/bin/node" ] && node_ok "$RUNTIME/node/bin/node"; then
  NODE_BIN="$RUNTIME/node/bin/node"; export PATH="$RUNTIME/node/bin:$PATH"; echo "    使用本地 node $($RUNTIME/node/bin/node -v)"
else
  echo "    下载 Node.js $NODE_VER linux-$NODE_ARCH ..."
  TGZ="node-$NODE_VER-linux-$NODE_ARCH.tar.gz"
  for MIRROR in \
    "https://registry.npmmirror.com/-/binary/node/$NODE_VER/$TGZ" \
    "https://mirrors.huaweicloud.com/nodejs/$NODE_VER/$TGZ" \
    "https://nodejs.org/dist/$NODE_VER/$TGZ"; do
    echo "    try: $MIRROR"
    (have curl && curl -fL --connect-timeout 10 -o "$RUNTIME/$TGZ" "$MIRROR") || \
    (have wget && wget -q -T 10 -O "$RUNTIME/$TGZ" "$MIRROR") || continue
    break
  done
  if [ ! -s "$RUNTIME/$TGZ" ]; then echo "Node.js 下载失败，请手动下载 $TGZ 放到 runtime/ 后重跑"; exit 1; fi
  tar -xzf "$RUNTIME/$TGZ" -C "$RUNTIME"
  rm -rf "$RUNTIME/node"
  mv "$RUNTIME/node-$NODE_VER-linux-$NODE_ARCH" "$RUNTIME/node"
  rm -f "$RUNTIME/$TGZ"
  export PATH="$RUNTIME/node/bin:$PATH"
  NODE_BIN="$RUNTIME/node/bin/node"
  echo "    Node.js $($NODE_BIN -v) 安装完成"
fi

echo "==> [2/3] 检查 ffmpeg ..."
FF_PATH=""
if have ffmpeg; then
  FF_PATH="ffmpeg"; echo "    使用系统 ffmpeg: $(command -v ffmpeg)"
elif [ -x "$RUNTIME/ffmpeg/ffmpeg" ]; then
  FF_PATH="$RUNTIME/ffmpeg/ffmpeg"; echo "    使用本地 ffmpeg"
else
  mkdir -p "$RUNTIME/ffmpeg"
  echo "    下载静态 ffmpeg ($FF_TAG) ..."
  DL_OK=0
  # 首选单文件二进制（eugeneware/ffmpeg-static，约 30-70MB）
  for MIRROR in \
    "https://ghproxy.net/https://github.com/eugeneware/ffmpeg-static/releases/latest/download/ffmpeg-$FF_TAG" \
    "https://gh-proxy.com/https://github.com/eugeneware/ffmpeg-static/releases/latest/download/ffmpeg-$FF_TAG" \
    "https://github.com/eugeneware/ffmpeg-static/releases/latest/download/ffmpeg-$FF_TAG"; do
    echo "    try: $MIRROR"
    (have curl && curl -fL --connect-timeout 10 -o "$RUNTIME/ffmpeg/ffmpeg" "$MIRROR") || \
    (have wget && wget -q -T 10 -O "$RUNTIME/ffmpeg/ffmpeg" "$MIRROR") || continue
    DL_OK=1; break
  done
  # 备选 johnvansickle 静态构建（tar.xz）
  if [ "$DL_OK" != "1" ]; then
    JV="ffmpeg-release-arm64-static.tar.xz"
    [ "$NODE_ARCH" = "armv7l" ] && JV="ffmpeg-release-armhf-static.tar.xz"
    [ "$NODE_ARCH" = "x64" ] && JV="ffmpeg-release-amd64-static.tar.xz"
    for MIRROR in "https://www.johnvansickle.com/ffmpeg/releases/$JV"; do
      echo "    try: $MIRROR"
      (have curl && curl -fL --connect-timeout 10 -o "$RUNTIME/$JV" "$MIRROR") || \
      (have wget && wget -q -T 10 -O "$RUNTIME/$JV" "$MIRROR") || continue
      tar -xJf "$RUNTIME/$JV" -C "$RUNTIME" && find "$RUNTIME" -name ffmpeg -type f -newer "$RUNTIME/$JV" -exec cp {} "$RUNTIME/ffmpeg/ffmpeg" \; && rm -f "$RUNTIME/$JV" && DL_OK=1 && break
    done
  fi
  if [ "$DL_OK" != "1" ] && have apt-get; then
    echo "    尝试 apt-get install ffmpeg ..."
    apt-get update -qq && apt-get install -y -qq ffmpeg && FF_PATH="ffmpeg" || true
  fi
  if [ -f "$RUNTIME/ffmpeg/ffmpeg" ]; then
    chmod +x "$RUNTIME/ffmpeg/ffmpeg"
    FF_PATH="$RUNTIME/ffmpeg/ffmpeg"
  fi
  if [ -z "$FF_PATH" ]; then
    echo "ffmpeg 安装失败：请手动安装 ffmpeg（apt install ffmpeg 或放静态二进制到 runtime/ffmpeg/ffmpeg）后重跑本脚本"
    exit 1
  fi
  echo "    ffmpeg 就绪: $FF_PATH"
fi

echo "==> [3/3] 写入配置 ..."
"$NODE_BIN" -e '
const fs = require("fs");
const path = require("path");
const cfgPath = path.join(process.cwd(), "config.json");
const ff = process.argv[1];
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch {}
if (!cfg.ffmpegselect && ff !== "ffmpeg") cfg.ffmpegselect = ff;
if (cfg.savefolder === undefined) cfg.savefolder = "";
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
console.log("    config.json ->", cfgPath, "ffmpegselect =", cfg.ffmpegselect || "PATH");
' "$FF_PATH"

chmod +x start.sh 2>/dev/null || true

echo ""
echo "=================================================="
echo " 安装完成！启动服务:   ./start.sh"
echo " 然后浏览器访问:       http://<盒子IP>:$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync("config.json","utf8")).port||7788)}catch{console.log(7788)}')"
echo " 开机自启（可选）:     见 README.md「开机自启」"
echo "=================================================="
