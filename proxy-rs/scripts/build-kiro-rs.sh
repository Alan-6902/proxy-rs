#!/usr/bin/env bash
# 构建 kiro-rs 并放到 build/kiro-rs/kiro-rs，供 electron-builder 的 extraResources 打进 App。
# kiro-rs 由 proxy-rs 作为子进程拉起（改造方案 D1），只需本机架构。
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
readonly KIRO_RS_DIR="$(cd -- "$PROJECT_ROOT/../kiro-rs-src" && pwd)"
readonly OUT_DIR="$PROJECT_ROOT/build/kiro-rs"

# rust-embed 编译期需要 admin-ui/dist
(cd "$KIRO_RS_DIR/admin-ui" && pnpm install --frozen-lockfile && pnpm build)
(cd "$KIRO_RS_DIR" && cargo build --release --no-default-features)

/bin/mkdir -p "$OUT_DIR"
/bin/cp "$KIRO_RS_DIR/target/release/kiro-rs" "$OUT_DIR/kiro-rs"
/bin/chmod 755 "$OUT_DIR/kiro-rs"
echo "kiro-rs 已构建：$OUT_DIR/kiro-rs"
