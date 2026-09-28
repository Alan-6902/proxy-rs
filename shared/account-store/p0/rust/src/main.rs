//! P0 跨进程实验：Rust 侧。与 node/p0.js 的子命令一一对应，由 run.sh 编排。
//!
//! 所有子命令打开的都是已存在的库（除 init），不会因路径写错静默建空库。

use rusqlite::{Connection, ErrorCode, OpenFlags, TransactionBehavior, params};
use std::env;
use std::time::{Duration, Instant};

const DEFAULT_BUSY_MS: u64 = 5000;

fn open_existing(path: &str, busy_ms: u64) -> Connection {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .unwrap_or_else(|e| panic!("打开数据库失败（不自动创建）: {e}"));
    conn.busy_timeout(Duration::from_millis(busy_ms)).unwrap();
    let mode: String = conn
        .query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
    conn.pragma_update(None, "synchronous", "FULL").unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    conn
}

fn is_busy(e: &rusqlite::Error) -> bool {
    matches!(e.sqlite_error_code(), Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked))
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[idx]
}

fn incr(path: &str, count: u64, tag: &str, busy_ms: u64) {
    let mut conn = open_existing(path, busy_ms);
    let (mut ok, mut busy) = (0u64, 0u64);
    let mut lat = Vec::with_capacity(count as usize);
    for seq in 0..count {
        let started = Instant::now();
        let result = (|| -> rusqlite::Result<()> {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let n: i64 = tx.query_row("SELECT n FROM counter WHERE id = 1", [], |r| r.get(0))?;
            tx.execute("UPDATE counter SET n = ?1 WHERE id = 1", params![n + 1])?;
            tx.execute("INSERT INTO log(tag, seq) VALUES (?1, ?2)", params![tag, seq as i64])?;
            tx.commit()
        })();
        match result {
            Ok(()) => ok += 1,
            Err(e) if is_busy(&e) => busy += 1,
            Err(e) => panic!("非 busy 错误: {e}"),
        }
        lat.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    lat.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!(
        "{{\"side\":\"rust\",\"tag\":\"{tag}\",\"ok\":{ok},\"busy\":{busy},\"p50_ms\":{:.2},\"p95_ms\":{:.2},\"max_ms\":{:.2}}}",
        percentile(&lat, 0.5),
        percentile(&lat, 0.95),
        lat.last().copied().unwrap_or(0.0)
    );
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let cmd = args.get(1).map(String::as_str).unwrap_or("version");
    let db = args.get(2).map(String::as_str).unwrap_or(":memory:");
    match cmd {
        "version" => {
            let c = Connection::open_in_memory().unwrap();
            let v: String = c.query_row("SELECT sqlite_version()", [], |r| r.get(0)).unwrap();
            println!("{{\"side\":\"rust\",\"driver\":\"rusqlite 0.40.2 bundled\",\"sqlite_version\":\"{v}\"}}");
        }
        "init" => {
            let c = Connection::open(db).unwrap();
            c.execute_batch(
                "PRAGMA journal_mode=WAL;
                 CREATE TABLE counter(id INTEGER PRIMARY KEY, n INTEGER NOT NULL);
                 INSERT INTO counter VALUES (1, 0);
                 CREATE TABLE log(id INTEGER PRIMARY KEY AUTOINCREMENT, tag TEXT NOT NULL, seq INTEGER NOT NULL);
                 CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);",
            )
            .unwrap();
            println!("init ok");
        }
        "incr" => {
            let count: u64 = args[3].parse().unwrap();
            let busy_ms: u64 = args.get(5).map(|s| s.parse().unwrap()).unwrap_or(DEFAULT_BUSY_MS);
            incr(db, count, &args[4], busy_ms);
        }
        "put" => {
            let c = open_existing(db, DEFAULT_BUSY_MS);
            c.execute(
                "INSERT INTO kv(k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                params![args[3], args[4]],
            )
            .unwrap();
        }
        "get" => {
            let c = open_existing(db, DEFAULT_BUSY_MS);
            let v: Option<String> = c
                .query_row("SELECT v FROM kv WHERE k = ?1", params![args[3]], |r| r.get(0))
                .ok();
            println!("{}", v.unwrap_or_default());
        }
        "hold" => {
            // 持有写锁 ms 毫秒；marker 文件出现即表示已拿到锁
            let ms: u64 = args[3].parse().unwrap();
            let mut c = open_existing(db, DEFAULT_BUSY_MS);
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate).unwrap();
            tx.execute("INSERT INTO log(tag, seq) VALUES ('hold', 0)", []).unwrap();
            std::fs::write(&args[4], "locked").unwrap();
            std::thread::sleep(Duration::from_millis(ms));
            tx.commit().unwrap();
        }
        "crash-uncommitted" => {
            // 写入未提交数据后挂起，等待被 kill -9
            let mut c = open_existing(db, DEFAULT_BUSY_MS);
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate).unwrap();
            for i in 0..5000 {
                tx.execute("INSERT INTO log(tag, seq) VALUES ('uncommitted', ?1)", params![i]).unwrap();
            }
            std::fs::write(&args[3], "ready").unwrap();
            std::thread::sleep(Duration::from_secs(3600));
        }
        "crash-committed" => {
            // 提交后立即挂起，等待被 kill -9，验证已提交数据不丢
            let mut c = open_existing(db, DEFAULT_BUSY_MS);
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate).unwrap();
            for i in 0..5000 {
                tx.execute("INSERT INTO log(tag, seq) VALUES ('committed', ?1)", params![i]).unwrap();
            }
            tx.commit().unwrap();
            std::fs::write(&args[3], "ready").unwrap();
            std::thread::sleep(Duration::from_secs(3600));
        }
        "bench-fsync" => {
            // macOS 的 fsync 不刷盘缓存；fullfsync=ON 才用 F_FULLFSYNC，断电也不丢已提交事务
            for full in ["OFF", "ON"] {
                let mut c = open_existing(db, DEFAULT_BUSY_MS);
                c.pragma_update(None, "fullfsync", full).unwrap();
                c.pragma_update(None, "checkpoint_fullfsync", full).unwrap();
                let mut lat = Vec::new();
                for seq in 0..200 {
                    let started = Instant::now();
                    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate).unwrap();
                    tx.execute("UPDATE counter SET n = n + 1 WHERE id = 1", []).unwrap();
                    tx.execute("INSERT INTO log(tag, seq) VALUES ('bench', ?1)", params![seq]).unwrap();
                    tx.commit().unwrap();
                    lat.push(started.elapsed().as_secs_f64() * 1000.0);
                }
                lat.sort_by(|a, b| a.partial_cmp(b).unwrap());
                println!(
                    "{{\"fullfsync\":\"{full}\",\"p50_ms\":{:.2},\"p95_ms\":{:.2},\"max_ms\":{:.2}}}",
                    percentile(&lat, 0.5),
                    percentile(&lat, 0.95),
                    lat.last().copied().unwrap_or(0.0)
                );
            }
        }
        other => panic!("未知子命令: {other}"),
    }
}
