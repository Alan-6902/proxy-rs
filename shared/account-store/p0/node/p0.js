// P0 跨进程实验：Electron 侧（better-sqlite3）。用 ELECTRON_RUN_AS_NODE=1 electron p0.js 运行，
// 保证加载的是 Electron 运行时下的原生模块。子命令与 rust/src/main.rs 对应。
'use strict'
const fs = require('fs')
const Database = require('better-sqlite3')

const DEFAULT_BUSY_MS = 5000

function openExisting(path, busyMs = DEFAULT_BUSY_MS) {
  // fileMustExist：路径写错时报错，不静默建空库
  const db = new Database(path, { fileMustExist: true, timeout: busyMs })
  const mode = db.pragma('journal_mode = WAL', { simple: true })
  if (mode !== 'wal') throw new Error(`journal_mode=${mode}`)
  db.pragma('synchronous = FULL')
  db.pragma('foreign_keys = ON')
  return db
}

function isBusy(error) {
  return error && (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED')
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  return sorted[Math.round((sorted.length - 1) * p)]
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function incr(path, count, tag, busyMs) {
  const db = openExisting(path, busyMs)
  const read = db.prepare('SELECT n FROM counter WHERE id = 1')
  const update = db.prepare('UPDATE counter SET n = ? WHERE id = 1')
  const insert = db.prepare('INSERT INTO log(tag, seq) VALUES (?, ?)')
  const step = db.transaction((seq) => {
    const { n } = read.get()
    update.run(n + 1)
    insert.run(tag, seq)
  })
  let ok = 0
  let busy = 0
  const lat = []
  for (let seq = 0; seq < count; seq++) {
    const started = process.hrtime.bigint()
    try {
      step.immediate(seq)
      ok++
    } catch (error) {
      if (!isBusy(error)) throw error
      busy++
    }
    lat.push(Number(process.hrtime.bigint() - started) / 1e6)
  }
  lat.sort((a, b) => a - b)
  console.log(
    JSON.stringify({
      side: 'electron',
      tag,
      ok,
      busy,
      p50_ms: +percentile(lat, 0.5).toFixed(2),
      p95_ms: +percentile(lat, 0.95).toFixed(2),
      max_ms: +lat[lat.length - 1].toFixed(2)
    })
  )
}

const [cmd = 'version', path = ':memory:', ...rest] = process.argv.slice(2)
switch (cmd) {
  case 'version': {
    const db = new Database(':memory:')
    console.log(
      JSON.stringify({
        side: 'electron',
        driver: `better-sqlite3 ${require('better-sqlite3/package.json').version}`,
        electron: process.versions.electron,
        sqlite_version: db.prepare('SELECT sqlite_version() AS v').get().v
      })
    )
    break
  }
  case 'incr':
    incr(path, Number(rest[0]), rest[1], rest[2] ? Number(rest[2]) : DEFAULT_BUSY_MS)
    break
  case 'put': {
    const db = openExisting(path)
    db.prepare(
      'INSERT INTO kv(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'
    ).run(rest[0], rest[1])
    break
  }
  case 'get': {
    const db = openExisting(path)
    const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(rest[0])
    console.log(row ? row.v : '')
    break
  }
  case 'hold': {
    // 持有写锁 ms 毫秒；marker 文件出现即表示已拿到锁
    const db = openExisting(path)
    db.exec('BEGIN IMMEDIATE')
    db.prepare("INSERT INTO log(tag, seq) VALUES ('hold', 0)").run()
    fs.writeFileSync(rest[1], 'locked')
    sleepSync(Number(rest[0]))
    db.exec('COMMIT')
    break
  }
  case 'check': {
    const db = openExisting(path)
    console.log(
      JSON.stringify({
        integrity: db.pragma('integrity_check', { simple: true }),
        n: db.prepare('SELECT n FROM counter WHERE id = 1').get().n,
        // counter 与 log 在同一事务里写，二者必须相等；hold / crash-* 行不计数
        incr_rows: db
          .prepare(
            "SELECT COUNT(*) AS c FROM log WHERE tag NOT IN ('hold', 'committed', 'uncommitted')"
          )
          .get().c,
        log_by_tag: Object.fromEntries(
          db
            .prepare('SELECT tag, COUNT(*) AS c FROM log GROUP BY tag ORDER BY tag')
            .all()
            .map((r) => [r.tag, r.c])
        )
      })
    )
    break
  }
  case 'read-during-lock': {
    // 另一端持写锁时读：WAL 下读者不应被阻塞
    const db = openExisting(path, 100)
    const started = process.hrtime.bigint()
    const n = db.prepare('SELECT n FROM counter WHERE id = 1').get().n
    console.log(
      JSON.stringify({ n, read_ms: +(Number(process.hrtime.bigint() - started) / 1e6).toFixed(2) })
    )
    break
  }
  default:
    throw new Error(`未知子命令: ${cmd}`)
}
