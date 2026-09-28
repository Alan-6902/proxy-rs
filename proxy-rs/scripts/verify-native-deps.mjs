#!/usr/bin/env node
/**
 * postinstall：确认原生依赖能在 Electron 运行时加载。
 *
 * 原来的 `electron-builder install-app-deps` 会按 Electron ABI 从源码重建原生模块，
 * 在 Python 3.12+（无 distutils）下直接失败，且会先清掉已有的构建产物。
 * better-sqlite3 与 cbor-extract 都带 Node-API 预编译包，Electron 可直接加载，不需要重建。
 */
import { spawnSync } from 'node:child_process'
import electron from 'electron'

const probe = `
  const Database = require('better-sqlite3')
  const db = new Database(':memory:')
  const v = db.prepare('select sqlite_version() v').get().v
  db.close()
  console.log('better-sqlite3 OK，SQLite ' + v + '，Electron ' + process.versions.electron)
`
const result = spawnSync(electron, ['-e', probe], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8'
})
if (result.status !== 0) {
  console.error('[postinstall] better-sqlite3 无法在 Electron 中加载：')
  console.error(result.stderr || result.stdout)
  process.exit(1)
}
process.stdout.write(`[postinstall] ${result.stdout}`)
