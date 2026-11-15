#!/bin/sh
# live-rec-hinas 一键安装脚本（在盒子上执行）
#
# 一条命令安装（把 kain1999 换成实际 GitHub 用户名）：
#   curl -fsSL https://raw.githubusercontent.com/kain1999/live-rec-hinas/main/install.sh | sudo sh -s -- --dir /opt/live-rec-hinas
# 国内盒子加镜像参数：
#   curl -fsSL https://ghproxy.net/https://raw.githubusercontent.com/kain1999/live-rec-hinas/main/install.sh | sudo sh -s -- --dir /opt/live-rec-hinas --mirror ghproxy
#
# 可选参数:
#   --dir PATH    安装目录（默认 /opt/live-rec-hinas）
#   --mirror MODE 源加速: ghproxy | direct（默认自动尝试）
#   --service     安装后同时注册 systemd 开机自启
set -e

DIR="/opt/live-rec-hinas"
MIRROR="auto"
SERVICE=0
OWNER="kain1999"
REPO="live-rec-hinas"
BRANCH="main"

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)     DIR="$2"; shift 2 ;;
    --mirror)  MIRROR="$2"; shift 2 ;;
    --service) SERVICE=1; shift ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

have() { command -v "$1" >/dev/null 2>&1; }

if [ "$(id -u)" != "0" ]; then
  echo "提示: 未以 root 运行，写入 $DIR 可能失败；建议 sudo"
fi

# ---------- 下载函数（多源回退） ----------
fetch() { # fetch <url> <outfile>
  local url="$1" out="$2" ok=1
  if have curl; then
    curl -fL --connect-timeout 10 --retry 2 -o "$out" "$url" || ok=0
  elif have wget; then
    wget -q -T 10 -O "$out" "$url" || ok=0
  else
    echo "需要 curl 或 wget（hinas 默认自带）"; exit 1
  fi
  return $ok
}

# install.sh 自身要能拿到，否则 pipe 方式下无所谓；源码包多源尝试
ARCHIVE_URLS=""
case "$MIRROR" in
  ghproxy)
    ARCHIVE_URLS="https://ghproxy.net/https://github.com/$OWNER/$REPO/archive/refs/heads/$BRANCH.tar.gz https://gh-proxy.com/https://github.com/$OWNER/$REPO/archive/refs/heads/$BRANCH.tar.gz"
    ;;
  direct)
    ARCHIVE_URLS="https://codeload.github.com/$OWNER/$REPO/tar.gz/refs/heads/$BRANCH"
    ;;
  *)
    ARCHIVE_URLS="https://codeload.github.com/$OWNER/$REPO/tar.gz/refs/heads/$BRANCH https://ghproxy.net/https://github.com/$OWNER/$REPO/archive/refs/heads/$BRANCH.tar.gz https://gh-proxy.com/https://github.com/$OWNER/$REPO/archive/refs/heads/$BRANCH.tar.gz"
    ;;
esac

echo "==> [1/4] 下载 live-rec-hinas 源码包 ..."
TMP=$(mktemp -d)
DOWNLOADED=0
for URL in $ARCHIVE_URLS; do
  echo "    try: $URL"
  if fetch "$URL" "$TMP/src.tar.gz" && [ -s "$TMP/src.tar.gz" ]; then DOWNLOADED=1; break; fi
done
[ "$DOWNLOADED" = "1" ] || { echo "下载失败：请检查网络，或手动下载仓库 tar.gz 传到盒子解压后执行 setup.sh"; exit 1; }

echo "==> [2/4] 解压到 $DIR ..."
tar -xzf "$TMP/src.tar.gz" -C "$TMP"
SRC_DIR=$(find "$TMP" -maxdepth 1 -type d -name "$REPO-*" | head -n 1)
[ -n "$SRC_DIR" ] || { echo "解压异常"; exit 1; }
mkdir -p "$DIR"
cp -a "$SRC_DIR/." "$DIR/"
rm -rf "$TMP"
chmod +x "$DIR/setup.sh" "$DIR/start.sh" 2>/dev/null || true
cd "$DIR"

echo "==> [3/4] 安装运行环境（Node.js + ffmpeg，首次较慢）..."
sh "$DIR/setup.sh"

echo "==> [4/4] 完成"
if [ "$SERVICE" = "1" ] && have systemctl; then
  sed -i "s#/opt/live-rec-hinas#$DIR#g" "$DIR/live-rec.service"
  cp "$DIR/live-rec.service" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now live-rec
  echo "    systemd 服务已注册并启动"
  echo "    状态: systemctl status live-rec"
else
  echo "    启动:   cd $DIR && ./start.sh"
fi
PORT=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync("config.json","utf8")).port||7788)}catch{console.log(7788)}' 2>/dev/null || echo 7788)
FFS=$(node -e 'try{const c=JSON.parse(require("fs").readFileSync("config.json","utf8"));console.log(c.ffmpegselect||"PATH 中的 ffmpeg")}catch{console.log("PATH")}' 2>/dev/null || echo PATH)
MKV=$(node -e 'try{const c=JSON.parse(require("fs").readFileSync("config.json","utf8"));console.log(c.mkvmergenable?("已启用 ("+c.mkvmergepath+")"):"未装，mkv 分段用 ffmpeg 合并")}catch{console.log("未知")}' 2>/dev/null || echo 未知)
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo ""
echo "=================================================="
echo " 安装完成！"
echo " 盒子上访问:   http://127.0.0.1:$PORT"
echo " 局域网访问:   http://${IP:-<盒子IP>}:$PORT"
echo " ffmpeg:       $FFS"
echo " mkvmerge:     $MKV"
echo "=================================================="
