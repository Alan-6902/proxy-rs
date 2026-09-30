#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
# 只打本机架构：包里内置的 kiro-rs 由本机 cargo 构建，另一架构的包跑不起来
case "$(/usr/bin/uname -m)" in
  arm64) readonly BUILDER_ARCH_FLAG='--arm64' ;;
  x86_64) readonly BUILDER_ARCH_FLAG='--x64' ;;
  *) echo "不支持的 macOS 架构：$(/usr/bin/uname -m)" >&2; exit 1 ;;
esac

cd "$PROJECT_ROOT"
echo "开始构建 macOS dist：$PROJECT_ROOT"
exec node "$SCRIPT_DIR/build-mac-with-cleanup.mjs" build:mac "$BUILDER_ARCH_FLAG"
