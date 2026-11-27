#!/bin/zsh
# macOS 双击启动档案整页校正工具：起本地静态服务并打开浏览器。
cd "$(dirname "$0")" || exit 1
PORT=4180

if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:${PORT}/index.html"; then
  open "http://localhost:${PORT}/"
  exit 0
fi

python3 -m http.server "$PORT" &
SRV_PID=$!
sleep 1.2
open "http://localhost:${PORT}/"
echo "档案整页校正工具已启动： http://localhost:${PORT}/"
echo "关闭此终端窗口或按 Ctrl+C 即停止本地服务。"
wait "$SRV_PID"
