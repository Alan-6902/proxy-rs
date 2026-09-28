#!/usr/bin/env bash
# P0-4：按 proxy-rs 的打包方式（asar、npmRebuild:false）打一个最小 Electron 应用，
# 在打包产物的主进程里打开 SQLite 读写，验证 better-sqlite3 预编译包可加载。
# 只打本机架构：electronDist 指向 proxy-rs 已安装的 Electron，本机无 Rosetta，x64 包无法在本机运行。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
BUILDER="$ROOT/proxy-rs/node_modules/.bin/electron-builder"
ARCH="$(uname -m)"
OUT="$(mktemp -d)"
trap 'mv "$OUT" ~/.Trash/"p0-pack-probe.$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true' EXIT

cd "$HERE"
[[ -d node_modules/better-sqlite3 ]] || npm install --no-audit --no-fund >/dev/null
"$BUILDER" --mac --dir "--$ARCH" -c.electronDist="$ROOT/proxy-rs/node_modules/electron/dist" >"$OUT/build.log" 2>&1 \
  || { tail -20 "$OUT/build.log"; exit 1; }

APP="$(ls -d dist/mac*/"P0 Pack Probe.app" | head -1)"
UNPACKED="$APP/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3"
echo "解包目录大小: $(du -sh "$APP/Contents/Resources/app.asar.unpacked" | cut -f1)"
echo "解包的预编译: $(ls "$UNPACKED/prebuilds" | tr '\n' ' ')"

P0_PROBE_OUT="$OUT/probe.json" P0_PROBE_DB="$OUT/probe.sqlite3" "$APP/Contents/MacOS/P0 Pack Probe" >/dev/null 2>&1 &
pid=$!
for _ in $(seq 1 80); do [[ -f "$OUT/probe.json" ]] && break; sleep 0.25; done
kill "$pid" 2>/dev/null || true
cat "$OUT/probe.json" 2>/dev/null || { echo '探针无输出'; exit 1; }
echo
python3 -c "import json,sys;d=json.load(open(sys.argv[1]));sys.exit(0 if d.get('ok') and d.get('packaged') and d.get('rows')==1 else 1)" "$OUT/probe.json"
echo 'P0-4 通过：打包产物内 better-sqlite3 加载、建库、读写正常'
