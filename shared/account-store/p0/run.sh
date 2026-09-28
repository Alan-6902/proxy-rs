#!/usr/bin/env bash
# P0 跨进程实验编排：Rust(rusqlite) 与 Electron(better-sqlite3) 读写同一本地临时库。
# 只用无秘密的测试数据，库文件在 work/ 下，跑完可整个丢弃。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
# 直接用 Electron 真实可执行文件：node_modules/.bin/electron 是 node 包装脚本，
# kill -9 只会杀掉包装进程，打不到真正持有数据库连接的 Electron。
ELECTRON="$ROOT/proxy-rs/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
NODE_SCRIPT="$HERE/node/p0.js"
RUST="$HERE/rust/target/release/p0-sqlite"
WORK="$HERE/work"
DB="$WORK/p0.sqlite3"
export ELECTRON_RUN_AS_NODE=1

# 前台调用可以用函数；后台进程必须直接写命令，保证 $! 是真实进程而不是子 shell
el() { "$ELECTRON" "$NODE_SCRIPT" "$@" 2>/dev/null; }
pass() { printf '  PASS %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; exit 1; }
expect() { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3（期望 $2，实际 $1）"; fi; }
wait_file() { for _ in $(seq 1 200); do [[ -f "$1" ]] && return 0; sleep 0.05; done; fail "等待 $1 超时"; }
jget() { python3 -c "import json,sys;print(json.loads(sys.argv[1])$2)" "$1"; }
check() { el check "$DB"; }
cleanup() {
  local status=$?
  pkill -9 -f "$RUST" 2>/dev/null || true
  pkill -9 -f "$NODE_SCRIPT" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT

(cd "$HERE/rust" && cargo build -q --release)
rm -rf "$WORK" && mkdir -p "$WORK"

echo '== 1. 驱动与 SQLite 版本'
"$RUST" version
el version

echo '== 2. 路径写错时不静默建空库'
if el get "$WORK/missing.sqlite3" k >/dev/null 2>&1; then fail 'electron 建了空库'; fi
if "$RUST" get "$WORK/missing.sqlite3" k >/dev/null 2>&1; then fail 'rust 建了空库'; fi
expect "$([[ -e "$WORK/missing.sqlite3" ]] && echo exists || echo absent)" absent '两端打开不存在的路径均报错，未创建文件'

"$RUST" init "$DB" >/dev/null

echo '== 3. 双向可见（随机挑战值）'
c1="$(uuidgen)"; "$RUST" put "$DB" challenge "$c1"
expect "$(el get "$DB" challenge)" "$c1" 'rust 写 → electron 立即读到'
c2="$(uuidgen)"; el put "$DB" challenge "$c2"
expect "$("$RUST" get "$DB" challenge)" "$c2" 'electron 写 → rust 立即读到'

echo '== 4. 写锁互斥'
rm -f "$WORK/lock"; "$RUST" hold "$DB" 1500 "$WORK/lock" & HP=$!; wait_file "$WORK/lock"
expect "$(jget "$(el incr "$DB" 1 blocked 100)" "['busy']")" 1 'rust 持写锁时 electron 写入得到 SQLITE_BUSY'
r="$(el read-during-lock "$DB")"
pass "rust 持写锁时 electron 仍可读（WAL 读不阻塞，读耗时 $(jget "$r" "['read_ms']") ms）"
wait $HP
rm -f "$WORK/lock"; "$ELECTRON" "$NODE_SCRIPT" hold "$DB" 1500 "$WORK/lock" 2>/dev/null & HP=$!; wait_file "$WORK/lock"
expect "$(jget "$("$RUST" incr "$DB" 1 blocked 100)" "['busy']")" 1 'electron 持写锁时 rust 写入得到 SQLITE_BUSY'
wait $HP
expect "$(jget "$("$RUST" incr "$DB" 1 waited 5000)" "['ok']")" 1 '锁释放后 busy_timeout 内写入成功'

echo '== 5. 并发读改写（2 个 rust + 2 个 electron，各 1500 次事务）'
before="$(jget "$(check)" "['n']")"
out="$WORK/concurrent.out"; : > "$out"
"$RUST" incr "$DB" 1500 r1 >>"$out" & p1=$!
"$RUST" incr "$DB" 1500 r2 >>"$out" & p2=$!
"$ELECTRON" "$NODE_SCRIPT" incr "$DB" 1500 e1 >>"$out" 2>/dev/null & p3=$!
"$ELECTRON" "$NODE_SCRIPT" incr "$DB" 1500 e2 >>"$out" 2>/dev/null & p4=$!
wait $p1 $p2 $p3 $p4
sed 's/^/    /' "$out"
ok_total="$(python3 -c "import json;print(sum(json.loads(l)['ok'] for l in open('$out')))")"
busy_total="$(python3 -c "import json;print(sum(json.loads(l)['busy'] for l in open('$out')))")"
r="$(check)"
n_after="$(jget "$r" "['n']")"
delta=$((n_after - before))
expect "$delta" "$ok_total" "计数器增量 = 成功事务数（无丢失更新；busy=${busy_total}）"
expect "$(jget "$r" "['n']")" "$(jget "$r" "['incr_rows']")" '计数器与日志行一致'

echo '== 6. kill -9'
rm -f "$WORK/ready"; "$RUST" crash-uncommitted "$DB" "$WORK/ready" & KP=$!; wait_file "$WORK/ready"
kill -9 $KP; wait $KP 2>/dev/null || true
r="$(check)"
expect "$(jget "$r" "['log_by_tag'].get('uncommitted',0)")" 0 '未提交事务中途被杀：数据全部回滚'
expect "$(jget "$r" "['integrity']")" ok '  且 integrity_check=ok'
rm -f "$WORK/ready"; "$RUST" crash-committed "$DB" "$WORK/ready" & KP=$!; wait_file "$WORK/ready"
kill -9 $KP; wait $KP 2>/dev/null || true
expect "$(jget "$(check)" "['log_by_tag'].get('committed',0)")" 5000 '提交后立即被杀：5000 行全部保留'
tag_rows() { jget "$1" "['log_by_tag'].get('$2',0)"; }
for round in 1 2 3; do
  # 1：只有 rust 在写；2：只有 electron 在写；3：两端同时写
  # 分开跑的原因：两端都热循环写时，后启动的一方会被饿住（见第 7 节），测不到它被杀的情况
  if [[ $round != 2 ]]; then "$RUST" incr "$DB" 100000000 "kr$round" >/dev/null & a=$!; else a=; fi
  if [[ $round != 1 ]]; then "$ELECTRON" "$NODE_SCRIPT" incr "$DB" 100000000 "ke$round" >/dev/null 2>&1 & b=$!; else b=; fi
  sleep 1.5
  kill -9 $a $b; wait $a $b 2>/dev/null || true
  r="$(check)"
  kr="$(tag_rows "$r" "kr$round")"; ke="$(tag_rows "$r" "ke$round")"
  case $round in
    1) expect "$([[ $kr -gt 0 ]] && echo yes)" yes "第 1 轮：rust 写入中被 kill -9（已提交 $kr 次）" ;;
    2) expect "$([[ $ke -gt 0 ]] && echo yes)" yes "第 2 轮：electron 写入中被 kill -9（已提交 $ke 次）" ;;
    3) pass "第 3 轮：两端同时写入中被 kill -9（rust 已提交 $kr 次，electron $ke 次）" ;;
  esac
  expect "$(jget "$r" "['integrity']")" ok "  integrity_check=ok"
  expect "$(jget "$r" "['n']")" "$(jget "$r" "['incr_rows']")" "  计数器与日志一致"
done
leftover="$( (pgrep -f "$RUST|$NODE_SCRIPT" || true) | wc -l | tr -d ' ')"
expect "$leftover" 0 '被杀进程没有残留'
expect "$(jget "$("$RUST" incr "$DB" 10 after-crash)" "['ok']")" 10 '崩溃后可继续正常写入'

echo '== 7. 写者饥饿（记录数据，不作通过条件）'
"$RUST" incr "$DB" 100000000 hot-rust >/dev/null & a=$!
sleep 0.3
echo "    rust 热循环写时，electron 200 次写入: $(el incr "$DB" 200 starved-e 5000)"
kill -9 $a; wait $a 2>/dev/null || true
"$ELECTRON" "$NODE_SCRIPT" incr "$DB" 100000000 hot-electron >/dev/null 2>&1 & b=$!
sleep 0.5
echo "    electron 热循环写时，rust 200 次写入: $("$RUST" incr "$DB" 200 starved-r 5000)"
kill -9 $b; wait $b 2>/dev/null || true
expect "$(jget "$(check)" "['integrity']")" ok '饥饿实验后 integrity_check=ok'

echo '== 8. 单次写事务耗时：fullfsync 关 / 开（WAL + synchronous=FULL，记录数据）'
"$RUST" bench-fsync "$DB" | sed 's/^/    /'

echo '== 结果'
check
echo 'P0-3 全部通过'
