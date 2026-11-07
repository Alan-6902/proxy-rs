#!/usr/bin/env node
/**
 * postinstall：确认原生依赖能在 Electron 运行时加载。
 *
 * 原来的 `electron-builder install-app-deps` 会按 Electron ABI 从源码重建原生模块，
 * 在 Python 3.12+（无 distutils）下直接失败，且会先清掉已有的构建产物。
 * better-sqlite3 与 cbor-extract 都带 Node-API 预编译包，Electron 可直接加载，不需要重建。
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

// 本仓库按 Node 22 验证。Node 26 下 electron 的 postinstall（install.js）会直接退出而不解压二进制，
// 之后 require('electron') 抛 "Electron failed to install correctly"。这里把原因说清楚，省得排查。
const SUPPORTED_NODE_MAJOR = 22
const nodeMajor = Number(process.versions.node.split('.')[0])
let electron
try {
  electron = createRequire(import.meta.url)('electron')
} catch (error) {
  console.error('[postinstall] 无法加载 electron：', error instanceof Error ? error.message : error)
  if (nodeMajor !== SUPPORTED_NODE_MAJOR) {
    console.error(
      `[postinstall] 当前 Node ${process.versions.node}；electron 的安装脚本在 Node ${SUPPORTED_NODE_MAJOR} 之外可能静默跳过二进制下载。` +
        `请切到 Node ${SUPPORTED_NODE_MAJOR}（见 .nvmrc）后执行：node node_modules/electron/install.js`
    )
  }
  process.exit(1)
}

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
