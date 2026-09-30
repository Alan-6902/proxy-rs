import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertIdle, cleanRustCaches, directory, withPackageLock } from './build-mac-with-cleanup.mjs'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP_NAME = 'Proxy RS.app'
const QUIT_TIMEOUT_MS = 30_000
const POLL_MS = 250

// 校验整个包的内容、执行权限和软链；复制时的组写权限差异不影响包一致性。
export function appDigest(app) {
  for (const relative of ['Contents/Info.plist', 'Contents/MacOS/Proxy RS',
    'Contents/Resources/app.asar', 'Contents/Resources/kiro-rs']) {
    if (!fs.lstatSync(path.join(app, relative)).isFile()) throw new Error(`应用缺少普通文件：${relative}`)
  }
  const hash = createHash('sha256')
  function visit(relative) {
    const file = path.join(app, relative)
    const info = fs.lstatSync(file)
    hash.update(JSON.stringify([relative, info.mode & 0o111]))
    if (info.isSymbolicLink()) {
      hash.update(JSON.stringify(['link', fs.readlinkSync(file)]))
    } else if (info.isDirectory()) {
      hash.update('directory')
      for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name))
    } else if (info.isFile()) {
      hash.update(createHash('sha256').update(fs.readFileSync(file)).digest())
    } else throw new Error(`应用包含不支持的文件类型：${file}`)
  }
  visit('')
  return hash.digest('hex')
}

function checked(run, command, args) {
  const result = run(command, args, { encoding: 'utf8', timeout: QUIT_TIMEOUT_MS })
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(`${path.basename(command)} 失败：${result.error?.message || result.stderr?.trim() || result.status}`)
  }
  return result.stdout || ''
}

function withInstallLock(applicationsRoot, action) {
  const apps = directory(path.parse(applicationsRoot).root, applicationsRoot.slice(1))
  if (!apps) throw new Error('Applications 目录不存在')
  // 不同 checkout/worktree 也会安装到同一应用，必须共享目标目录上的锁。
  const lock = path.join(apps, '.proxy-rs-install.lock')
  try { fs.mkdirSync(lock) } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`已有安装任务或遗留安装锁：${lock}；确认安装进程已退出后才移除此空目录。`)
    throw error
  }
  try { return action(apps) } finally { fs.rmdirSync(lock) }
}

export function installCurrentMac({
  projectRoot = PROJECT_ROOT,
  applicationsRoot = '/Applications',
  arch = process.arch,
  run = spawnSync,
  log = console.log,
  clean = cleanRustCaches,
  wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
} = {}) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error(`不支持的架构：${arch}`)
  return withPackageLock(projectRoot, (project, repo) => withInstallLock(applicationsRoot, apps => {
    const source = directory(project, `dist/${arch === 'arm64' ? 'mac-arm64' : 'mac'}/${APP_NAME}`)
    if (!source) throw new Error('缺少当前架构的安装包，请先运行 npm run dist:current')
    const expected = appDigest(source)
    checked(run, '/usr/bin/codesign', ['--verify', '--deep', '--strict', source])
    const destination = path.join(apps, APP_NAME)
    const existing = directory(apps, APP_NAME)
    if (existing && appDigest(existing) === expected) {
      checked(run, '/usr/bin/codesign', ['--verify', '--deep', '--strict', destination])
      log('Applications 中已是同一安装包，校验通过，无需退出或替换。')
    } else {
      const stage = fs.mkdtempSync(path.join(apps, '.proxy-rs-install-'))
      const stagedApp = path.join(stage, APP_NAME)
      const backup = path.join(stage, 'previous.app')
      let installed = false
      let completed = false
      try {
        checked(run, '/usr/bin/ditto', [source, stagedApp])
        if (appDigest(stagedApp) !== expected) throw new Error('暂存副本校验失败，保留旧应用和 target')
        checked(run, '/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedApp])
        if (existing) {
          const processes = checked(run, '/bin/ps', ['-axo', 'comm='])
          if (processes.split('\n').some(line => line.trim().startsWith(`${destination}/`))) {
            checked(run, '/usr/bin/osascript', ['-e', `tell application ${JSON.stringify(destination)} to quit`])
          }
          let idle = false
          const deadline = Date.now() + QUIT_TIMEOUT_MS
          for (let elapsed = 0; elapsed <= QUIT_TIMEOUT_MS; elapsed += POLL_MS) {
            try { assertIdle(destination, run); idle = true; break } catch (error) {
              if (elapsed === QUIT_TIMEOUT_MS || Date.now() >= deadline) throw error
              wait(POLL_MS)
            }
          }
          if (!idle) throw new Error('旧应用尚未退出，保留 target')
          fs.renameSync(destination, backup)
        }
        try {
          fs.renameSync(stagedApp, destination)
          installed = true
          if (appDigest(destination) !== expected) throw new Error('安装后内容校验失败')
          checked(run, '/usr/bin/codesign', ['--verify', '--deep', '--strict', destination])
        } catch (error) {
          if (installed) fs.renameSync(destination, stagedApp)
          installed = false
          if (existing) fs.renameSync(backup, destination)
          throw error
        }
        // open 成功只表示系统接受启动请求，不代表业务健康检查通过。
        checked(run, '/usr/bin/open', ['-a', destination])
        completed = true
        log('已安装到 Applications，完整包校验通过，已请求启动。')
      } finally {
        if (completed || (!installed && !fs.existsSync(backup))) fs.rmSync(stage, { recursive: true })
        else log(`安装未完整结束，保留应用暂存和旧版备份；未清理 target。位置：${stage}`)
      }
    }
    try {
      clean(repo, run, log, Date.now())
    } catch (error) {
      log(`安装已校验，跳过剩余缓存清理：${error.message}`)
    }
    return 0
  }))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = installCurrentMac() } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
