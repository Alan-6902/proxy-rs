#!/usr/bin/env bash
# 账号库模式切换完成后，清理 ~/kiro-rs/config 下不再使用的旧账号文件。
#
# 默认只核对、列出将被清理的文件，不做任何修改；加 --apply 才会移入废纸篓（不直接删除）。
#
# 清理前的核对（任一不通过即中止）：
#   1. 账号库存在，integrity_check=ok，schema 版本为 1
#   2. credentials.json 里的每个凭据 ID 都已在账号库中（未删除）
#   3. 没有 kiro-rs 容器在运行（否则它仍在读写这些文件）
#
# 只处理账号相关文件：credentials.json 及其全部备份、kiro_stats.json 及备份、
# kiro_balance_cache.json、kiro_credit_cursors.json。config.json 及其备份不动（kiro-rs 仍在用）。
set -euo pipefail

CONFIG_DIR="${KIRO_RS_CONFIG_DIR:-$HOME/kiro-rs/config}"
DB="${KIRO_RS_ACCOUNT_DB:-$HOME/kiro-rs/data/accounts.sqlite3}"
TRASH="$HOME/.Trash"
APPLY=false
[[ "${1:-}" == "--apply" ]] && APPLY=true

fail() { echo "✖ $1" >&2; exit 1; }
ok() { echo "✔ $1"; }

command -v sqlite3 >/dev/null || fail "需要 sqlite3 命令"
command -v python3 >/dev/null || fail "需要 python3"
[[ -f "$DB" ]] || fail "账号库不存在：${DB}（先完成迁移）"

[[ "$(sqlite3 "$DB" 'PRAGMA integrity_check;')" == "ok" ]] || fail "账号库 integrity_check 未通过"
[[ "$(sqlite3 "$DB" 'PRAGMA user_version;')" == "1" ]] || fail "账号库 schema 版本不是 1"
ok "账号库完整：$DB"

if command -v docker >/dev/null && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx kiro-rs; then
  fail "Docker 里的 kiro-rs 容器仍在运行，先执行 cd ~/kiro-rs && docker compose down"
fi
ok "没有运行中的 kiro-rs 容器"

if [[ -f "$CONFIG_DIR/credentials.json" ]]; then
  live_ids="$(sqlite3 "$DB" 'SELECT id FROM accounts WHERE deleted_at_ms IS NULL;')"
  missing="$(python3 - "$CONFIG_DIR/credentials.json" "$live_ids" <<'EOF'
import json, sys
text = open(sys.argv[1]).read().strip()
creds = json.loads(text) if text else []
creds = creds if isinstance(creds, list) else [creds]
live = set(sys.argv[2].split())
print(" ".join(str(c["id"]) for c in creds if "id" in c and str(c["id"]) not in live))
EOF
)"
  [[ -z "$missing" ]] || fail "credentials.json 中的凭据 #$missing 不在账号库里（可能已在账号库中删除，确认后手动处理）"
  ok "credentials.json 的所有凭据都已在账号库中"
fi

shopt -s nullglob
candidates=(
  "$CONFIG_DIR"/credentials.json
  "$CONFIG_DIR"/credentials.json.*
  "$CONFIG_DIR"/kiro_stats.json
  "$CONFIG_DIR"/kiro_stats.json.*
  "$CONFIG_DIR"/kiro_balance_cache.json
  "$CONFIG_DIR"/kiro_credit_cursors.json
)
shopt -u nullglob
# 不带通配符的路径即使文件不存在也会留在数组里，这里只保留实际存在的
targets=()
for f in "${candidates[@]}"; do [[ -e "$f" ]] && targets+=("$f"); done
if [[ ${#targets[@]} -eq 0 ]]; then
  ok "没有需要清理的旧文件"
  exit 0
fi

echo "将移入废纸篓的文件（${#targets[@]} 个）："
for f in "${targets[@]}"; do echo "  $(basename "$f")"; done

if ! $APPLY; then
  echo "只做了核对，未改动任何文件。确认无误后加 --apply 执行。"
  exit 0
fi

stamp="$(date +%Y%m%d-%H%M%S)"
dest="$TRASH/kiro-rs-legacy-config.$stamp"
mkdir -p "$dest"
for f in "${targets[@]}"; do mv "$f" "$dest/"; done
chmod 700 "$dest"
ok "已移入废纸篓：${dest}（其中含历史 token，确认不再需要后清空废纸篓）"
