import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUILD_SCRIPTS = new Set(['build:mac', 'build:mac:current'])
const TEST_RETENTION_MS = 24 * 60 * 60 * 1000
const CARGO_CLEAN_TIMEOUT_MS = 30_000
const RUST_MACRO_SERVER = 'rust-analyzer-proc-macro-srv'
const TEST_DIRECTORY = /^(account-store-test|credential-identity-test)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

// 只接受仓库内的真实目录，拒绝任何一级父路径的软链。
export function directory(root, relative) {
  let current = root
  for (const part of relative.split('/')) {
    current = path.join(current, part)
    let info
    try {
      info = fs.lstatSync(current)
    } catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`清理路径不是普通目录：${current}`)
    }
  }
  return current
}

function onlyRetainedMacroLibraries(output, target) {
  let processName
  let files = 0
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) processName = undefined
    if (line.startsWith('c')) processName = line.slice(1)
    if (!line.startsWith('n')) continue
    const file = line.slice(1)
    const name = path.basename(file)
    // cargo clean -p kiro-rs 不删除第三方宏库；本包库和其他占用仍然阻止清理。
    if (processName !== RUST_MACRO_SERVER || path.dirname(file) !== path.join(target, 'debug/deps') ||
      !name.startsWith('lib') || name.startsWith('libkiro_rs') || !name.endsWith('.dylib')) return false
    files += 1
  }
  return files > 0
}

export function assertIdle(dir, run, allowRetainedMacros = false) {
  const result = run('/usr/sbin/lsof', ['-nP', '+D', dir, '-F', 'pcn'], {
    encoding: 'utf8',
    timeout: 30_000
  })
  if (result.error || result.signal || result.stderr?.trim()) {
    throw new Error(`无法确认目录是否被占用，保留：${dir}`)
  }
  const output = result.stdout?.trim() ?? ''
  if (result.status === 1 && !output) return
  if (allowRetainedMacros && (result.status === 0 || result.status === 1) &&
    onlyRetainedMacroLibraries(output, dir)) return
  throw new Error(`目录正在使用或占用检查失败，保留：${dir}`)
}

function latestMtime(dir) {
  let latest = fs.lstatSync(dir).mtimeMs
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const item = path.join(dir, entry.name)
    latest = Math.max(latest, entry.isDirectory() ? latestMtime(item) : fs.lstatSync(item).mtimeMs)
  }
  return latest
}

export function cleanRustCaches(root, run, log, now) {
  const target = directory(root, 'kiro-rs-src/target')
  if (!target) return
  // 同时检查 Cargo 锁、测试进程和正在运行的 target 内程序。
  assertIdle(target, run, true)
  // 按包清理由 Cargo 自己持有构建锁；不能在一次 lsof 检查后直接删 incremental。
  // 显式固定输出目录，避免环境变量或 Cargo 配置把清理指向仓库外。
  for (const [profile, output] of [['dev', 'debug'], ['release', 'release']]) {
    if (!directory(root, `kiro-rs-src/target/${output}`)) continue
    const result = run('cargo', ['clean', '--frozen', '--profile', profile, '--package', 'kiro-rs',
      '--target-dir', target, '--config', `build.build-dir=${JSON.stringify(target)}`], {
      cwd: path.join(root, 'kiro-rs-src'),
      stdio: 'inherit',
      timeout: CARGO_CLEAN_TIMEOUT_MS
    })
    if (result.error || result.signal || result.status !== 0) {
      throw new Error('Cargo 清理未完成或等待构建锁超时；保留其余缓存。')
    }
    log(`已由 Cargo 清理 kiro-rs 的 ${output} 产物，保留第三方依赖缓存。`)
  }
  assertIdle(target, run, true)
  const candidates = []
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (!entry.isDirectory() || !TEST_DIRECTORY.test(entry.name)) continue
    const item = path.join(target, entry.name)
    if (latestMtime(item) < now - TEST_RETENTION_MS) candidates.push(item)
  }
  for (const item of candidates) {
    fs.rmSync(item, { recursive: true })
    log(`已永久清理构建缓存：${item}`)
  }
  log(`测试临时目录清理完成：${candidates.length} 个；保留最近一天的测试数据。`)
}

export function withPackageLock(projectRoot, action) {
  const project = fs.realpathSync(projectRoot)
  const repo = path.dirname(project)
  const build = directory(repo, `${path.basename(project)}/build`)
  if (!build) throw new Error('缺少 build 资源目录')
  const lock = path.join(build, '.mac-package.lock')
  try {
    fs.mkdirSync(lock)
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`已有打包任务、安装任务或中断后遗留锁：${lock}；请确认没有打包进程后再移除此空目录。`)
    }
    throw error
  }
  try {
    return action(project, repo)
  } finally {
    fs.rmdirSync(lock)
  }
}

export function buildMac(script, args, {
  projectRoot = PROJECT_ROOT,
  run = spawnSync,
  log = console.log
} = {}) {
  if (!BUILD_SCRIPTS.has(script)) throw new Error(`不支持的打包命令：${script}`)
  return withPackageLock(projectRoot, (project, repo) => {
    const dist = directory(repo, `${path.basename(project)}/dist`)
    if (dist) {
      assertIdle(dist, run)
      fs.rmSync(dist, { recursive: true })
      log(`已永久清理旧打包输出：${dist}`)
    }
    const result = run('npm', ['run', script, '--', ...args], {
      cwd: project,
      stdio: 'inherit'
    })
    if (result.error) throw result.error
    if (result.status !== 0) return result.status ?? 1
    log('打包完成；安装并校验成功后才清理 Rust 本包产物。')
    return 0
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = buildMac(process.argv[2], process.argv.slice(3))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
