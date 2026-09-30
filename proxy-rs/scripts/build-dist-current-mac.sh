#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
readonly MACHINE_ARCH="$(/usr/bin/uname -m)"

case "$MACHINE_ARCH" in
  arm64)
    readonly BUILDER_ARCH_FLAG='--arm64'
    ;;
  x86_64)
    readonly BUILDER_ARCH_FLAG='--x64'
    ;;
  *)
    echo "不支持的 macOS 架构：$MACHINE_ARCH" >&2
    exit 1
    ;;
esac

cd "$PROJECT_ROOT"
echo "开始构建当前机器架构的 .app：$MACHINE_ARCH"
exec node "$SCRIPT_DIR/build-mac-with-cleanup.mjs" build:mac:current "$BUILDER_ARCH_FLAG" --dir
