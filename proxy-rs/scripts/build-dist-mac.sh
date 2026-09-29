#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
readonly DIST_DIR="$PROJECT_ROOT/dist"
readonly TRASH_ROOT="$HOME/.Trash"
# 只打本机架构：包里内置的 kiro-rs 由本机 cargo 构建，另一架构的包跑不起来
case "$(/usr/bin/uname -m)" in
  arm64) readonly BUILDER_ARCH_FLAG='--arm64' ;;
  x86_64) readonly BUILDER_ARCH_FLAG='--x64' ;;
  *) echo "不支持的 macOS 架构：$(/usr/bin/uname -m)" >&2; exit 1 ;;
esac

if [[ -e "$DIST_DIR" || -L "$DIST_DIR" ]]; then
  /bin/mkdir -p "$TRASH_ROOT"

  archive_path="$TRASH_ROOT/proxy-rs-dist.$(/bin/date +%Y%m%d-%H%M%S)"
  suffix=1
  while [[ -e "$archive_path" ]]; do
    archive_path="$TRASH_ROOT/proxy-rs-dist.$(/bin/date +%Y%m%d-%H%M%S).$suffix"
    ((suffix += 1))
  done

  /bin/mv "$DIST_DIR" "$archive_path"
  echo "旧 dist 已移入废纸篓：$archive_path"
else
  echo "未发现旧 dist，直接开始打包。"
fi

cd "$PROJECT_ROOT"
echo "开始构建 macOS dist：$PROJECT_ROOT"
exec npm run build:mac -- "$BUILDER_ARCH_FLAG"
