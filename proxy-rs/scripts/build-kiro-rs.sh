#!/usr/bin/env bash
# 构建 Kiro、Antigravity、Qoder 三个独立反代，供 electron-builder 打进 App。
# 各进程分别由 proxy-rs 托管，只需本机架构。
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
readonly KIRO_RS_DIR="$(cd -- "$PROJECT_ROOT/../kiro-rs-src" && pwd)"
readonly OUT_DIR="$PROJECT_ROOT/build/kiro-rs"

# rust-embed 编译期需要 admin-ui/dist
(cd "$KIRO_RS_DIR/admin-ui" && pnpm install --frozen-lockfile && pnpm build)
(cd "$KIRO_RS_DIR" && cargo build --release --no-default-features --bins)

/bin/mkdir -p "$OUT_DIR"
for binary in kiro-rs antigravity-rs qoder-rs; do
  /bin/cp "$KIRO_RS_DIR/target/release/$binary" "$OUT_DIR/$binary"
  /bin/chmod 755 "$OUT_DIR/$binary"
  echo "$binary 已构建：$OUT_DIR/$binary"
done
