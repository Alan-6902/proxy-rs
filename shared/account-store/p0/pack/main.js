// 打包后探针：在真正的 Electron 主进程里打开库、读写、报告版本与模块路径，然后退出
const { app } = require('electron')
const fs = require('fs')
const out = process.env.P0_PROBE_OUT
app.whenReady().then(() => {
  const result = {}
  try {
    const Database = require('better-sqlite3')
    const db = new Database(process.env.P0_PROBE_DB)
    db.pragma('journal_mode = WAL')
    db.exec('CREATE TABLE IF NOT EXISTS t(v TEXT)')
    db.prepare('INSERT INTO t VALUES (?)').run('from-packaged-app')
    Object.assign(result, {
      ok: true,
      sqlite_version: db.prepare('SELECT sqlite_version() v').get().v,
      rows: db.prepare('SELECT COUNT(*) c FROM t').get().c,
      module: require.resolve('better-sqlite3'),
      packaged: app.isPackaged,
      arch: process.arch
    })
    db.close()
  } catch (e) {
    Object.assign(result, { ok: false, error: String(e && e.stack || e) })
  }
  fs.writeFileSync(out, JSON.stringify(result))
  app.quit()
})
