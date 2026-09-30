import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { buildMac as packageMac, cleanRustCaches } from './build-mac-with-cleanup.mjs'

// 构建和安装后的清理分开调用，复用原有缓存边界测试。
function buildMac(script, args, options) {
  const status = packageMac(script, args, options)
  if (status === 0) {
    try { cleanRustCaches(path.dirname(options.projectRoot), options.run, options.log, Date.now()) } catch { /* 单独断言保留行为 */ }
  }
  return status
}

const DAY_MS = 24 * 60 * 60 * 1000
const UUID = '12345678-1234-1234-1234-123456789abc'

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-package-cleanup-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = (relative, content = 'keep') => {
    const item = path.join(root, relative)
    fs.mkdirSync(path.dirname(item), { recursive: true })
    fs.writeFileSync(item, content)
    return item
  }
  file('proxy-rs/build/resource.txt')
  file('proxy-rs/dist/old.app/file')
  file('kiro-rs-src/target/debug/incremental/session/cache')
  file('kiro-rs-src/target/debug/deps/test-binary')
  file('kiro-rs-src/target/release/kiro-rs')
  file('kiro-rs-src/src/main.rs')
  file('runtime/accounts.sqlite3')
  const exists = relative => fs.existsSync(path.join(root, relative))
  const calls = []
  const options = {
    projectRoot: path.join(root, 'proxy-rs'),
    log: () => {},
    run(command, args) {
      calls.push([command, args])
      if (command === 'npm') {
        file('proxy-rs/dist/new.app/file')
        return { status: 0 }
      }
      if (command === 'cargo') {
        const output = args[args.indexOf('--profile') + 1] === 'dev' ? 'debug/incremental' : 'release/kiro-rs'
        fs.rmSync(path.join(root, 'kiro-rs-src/target', output), { recursive: true })
        return { status: 0 }
      }
      return { status: 1, stdout: '', stderr: '' }
    }
  }
  return { root, file, exists, calls, options }
}

test('显式清理仅删除白名单缓存，保留新包、源码、依赖和近期测试数据', t => {
  const f = fixture(t)
  const old = `kiro-rs-src/target/account-store-test-${UUID}`
  const recent = `kiro-rs-src/target/credential-identity-test-${UUID}`
  const oldFile = f.file(`${old}/test.sqlite`)
  const oldTime = new Date(Date.now() - 2 * DAY_MS)
  fs.utimesSync(oldFile, oldTime, oldTime)
  fs.utimesSync(path.dirname(oldFile), oldTime, oldTime)
  f.file(`${recent}/test.sqlite`)
  f.file('kiro-rs-src/target/account-store-test-important/notes')
  assert.equal(buildMac('build:mac:current', ['--arm64', '--dir'], f.options), 0)
  for (const p of ['proxy-rs/dist/old.app', 'kiro-rs-src/target/debug/incremental', 'kiro-rs-src/target/release/kiro-rs', old]) {
    assert.equal(f.exists(p), false, p)
  }
  for (const p of ['proxy-rs/dist/new.app/file', 'kiro-rs-src/src/main.rs',
    'kiro-rs-src/target/debug/deps/test-binary',
    'runtime/accounts.sqlite3', recent, 'kiro-rs-src/target/account-store-test-important/notes']) {
    assert.equal(f.exists(p), true, p)
  }
  assert.deepEqual(f.calls.find(([c]) => c === 'npm')[1], ['run', 'build:mac:current', '--', '--arm64', '--dir'])
  assert.equal(f.exists('proxy-rs/build/.mac-package.lock'), false)
})

test('旧目录中的文件最近修改时仍保留测试数据', t => {
  const f = fixture(t)
  const p = `kiro-rs-src/target/account-store-test-${UUID}`
  const file = f.file(`${p}/test.sqlite`)
  const old = new Date(Date.now() - 2 * DAY_MS)
  fs.utimesSync(path.dirname(file), old, old)
  buildMac('build:mac', [], f.options)
  assert.equal(f.exists(p), true)
})

test('构建失败保留 Rust 缓存并返回原退出码', t => {
  const f = fixture(t)
  f.options.run = command => command === 'npm' ? { status: 17 } : { status: 1 }
  assert.equal(buildMac('build:mac', [], f.options), 17)
  assert.equal(f.exists('kiro-rs-src/target/debug/incremental'), true)
  assert.equal(f.exists('proxy-rs/build/.mac-package.lock'), false)
})

test('dist 正在使用或无法检查时，保留旧包且不启动打包', t => {
  for (const result of [{ status: 0, stdout: 'p123' }, { status: 1, stderr: 'permission denied' },
    { status: null, error: new Error('timeout') }, { status: 2 }]) {
    const f = fixture(t)
    f.options.run = command => {
      assert.notEqual(command, 'npm')
      return result
    }
    assert.throws(() => buildMac('build:mac', [], f.options), /保留/)
    assert.equal(f.exists('proxy-rs/dist/old.app/file'), true)
    assert.equal(f.exists('proxy-rs/build/.mac-package.lock'), false)
  }
})

test('target 被占用时不清理缓存，但打包仍成功', t => {
  const f = fixture(t)
  f.options.run = (command, args) => command === 'npm' ? { status: 0 } :
    args.includes(path.join(f.root, 'kiro-rs-src/target')) ? { status: 0, stdout: 'p123' } : { status: 1 }
  assert.equal(buildMac('build:mac', [], f.options), 0)
  assert.equal(f.exists('kiro-rs-src/target/debug/incremental'), true)
})

test('语言服务仅加载保留的第三方宏库时仍清理本包产物', t => {
  for (const status of [0, 1]) {
    const f = fixture(t)
    const run = f.options.run
    const target = path.join(f.root, 'kiro-rs-src/target')
    f.options.run = (command, args) => command !== 'npm' && command !== 'cargo' && args.includes(target)
      ? { status, stdout: `p123\ncrust-analyzer-proc-macro-srv\nftxt\nn${target}/debug/deps/libserde_derive-abc.dylib\n` }
      : run(command, args)
    assert.equal(buildMac('build:mac', [], f.options), 0)
    assert.equal(f.exists('kiro-rs-src/target/debug/incremental'), false)
    assert.equal(f.calls.some(([command]) => command === 'cargo'), true)
  }
})

test('宏库例外不能放行本包库、其他进程或同时存在的构建锁', t => {
  const records = [
    ['rust-analyzer-proc-macro-srv', 'debug/deps/libkiro_rs-abc.dylib'],
    ['kiro-rs', 'debug/deps/libserde_derive-abc.dylib'],
    ['rust-analyzer-proc-macro-srv', 'debug/.cargo-lock']
  ]
  for (const [processName, relative] of records) {
    const f = fixture(t)
    const run = f.options.run
    const target = path.join(f.root, 'kiro-rs-src/target')
    f.options.run = (command, args) => command !== 'npm' && command !== 'cargo' && args.includes(target)
      ? { status: 0, stdout: `p123\ncrust-analyzer-proc-macro-srv\nn${target}/debug/deps/libserde_derive-abc.dylib\np456\nc${processName}\nn${target}/${relative}\n` }
      : run(command, args)
    assert.equal(buildMac('build:mac', [], f.options), 0)
    assert.equal(f.exists('kiro-rs-src/target/debug/incremental'), true)
    assert.equal(f.calls.some(([command]) => command === 'cargo'), false)
  }
})

test('拒绝软链 dist，保留软链指向的数据', t => {
  const f = fixture(t)
  const dist = path.join(f.root, 'proxy-rs/dist')
  fs.renameSync(dist, `${dist}-external`)
  fs.symlinkSync(`${dist}-external`, dist)
  assert.throws(() => buildMac('build:mac', [], f.options), /不是普通目录/)
  assert.equal(f.exists('proxy-rs/dist-external/old.app/file'), true)
  assert.equal(f.calls.length, 0)
})

test('拒绝软链 target 的父目录；dist 内部软链不会删除外部文件', t => {
  const f = fixture(t)
  const rust = path.join(f.root, 'kiro-rs-src')
  fs.renameSync(rust, `${rust}-external`)
  fs.symlinkSync(`${rust}-external`, rust)
  fs.symlinkSync(path.join(f.root, 'runtime'), path.join(f.root, 'proxy-rs/dist/external'))
  assert.equal(buildMac('build:mac', [], f.options), 0)
  assert.equal(f.exists('kiro-rs-src-external/target/debug/incremental'), true)
  assert.equal(f.exists('runtime/accounts.sqlite3'), true)
})

test('已有打包锁时不清理、不启动第二次构建', t => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.root, 'proxy-rs/build/.mac-package.lock'))
  assert.throws(() => buildMac('build:mac', [], f.options), /已有打包任务/)
  assert.equal(f.exists('proxy-rs/dist/old.app/file'), true)
  assert.equal(f.exists('proxy-rs/build/.mac-package.lock'), true)
  assert.equal(f.calls.length, 0)
})

test('真实 lsof 能阻止删除本进程打开的旧包', { skip: process.platform !== 'darwin' }, t => {
  const f = fixture(t)
  const fd = fs.openSync(path.join(f.root, 'proxy-rs/dist/old.app/file'), 'r')
  t.after(() => fs.closeSync(fd))
  f.options.run = (command, args, options) => {
    assert.notEqual(command, 'npm')
    return spawnSync(command, args, options)
  }
  assert.throws(() => buildMac('build:mac', [], f.options), /保留/)
  assert.equal(f.exists('proxy-rs/dist/old.app/file'), true)
})

test('真实 lsof 检查空闲目录后可以完成清理', { skip: process.platform !== 'darwin' }, t => {
  const f = fixture(t)
  const mockBuild = f.options.run
  f.options.run = (command, args, options) => command === 'npm' || command === 'cargo'
    ? mockBuild(command, args)
    : spawnSync(command, args, options)
  assert.equal(buildMac('build:mac', [], f.options), 0)
  assert.equal(f.exists('kiro-rs-src/target/debug/incremental'), false)
  assert.equal(f.exists('proxy-rs/dist/new.app/file'), true)
})

test('lsof 检查后 Cargo 才开始构建，清理等待构建锁超时后保留缓存',
  { skip: process.platform !== 'darwin' }, async t => {
    const f = fixture(t)
    f.file('kiro-rs-src/Cargo.toml', '[package]\nname="kiro-rs"\nversion="0.0.0"\nedition="2021"\n[workspace]\n')
    f.file('kiro-rs-src/Cargo.lock', 'version = 4\n[[package]]\nname = "kiro-rs"\nversion = "0.0.0"\n')
    const lock = f.file('kiro-rs-src/target/debug/.cargo-lock', '')
    const holder = spawn('python3', ['-c',
      'import fcntl,sys,time\nf=open(sys.argv[1],"r+")\nfcntl.flock(f,fcntl.LOCK_EX)\nprint("locked",flush=True)\ntime.sleep(30)', lock])
    const exited = once(holder, 'exit')
    t.after(async () => { holder.kill(); await exited })
    await once(holder.stdout, 'data')
    let cleanResult
    f.options.run = (command, args, options) => {
      // 模拟占用检查刚返回空闲，构建已抢先持有 Cargo 的真实锁。
      if (command === 'cargo') {
        cleanResult = spawnSync(command, args, { ...options, stdio: 'pipe', encoding: 'utf8', timeout: 750 })
        return cleanResult
      }
      return command === 'npm' ? { status: 0 } : { status: 1 }
    }
    assert.equal(buildMac('build:mac', [], f.options), 0)
    assert.equal(cleanResult.error?.code, 'ETIMEDOUT')
    assert.match(cleanResult.stderr, /Blocking.*lock/)
    assert.equal(f.exists('kiro-rs-src/target/debug/incremental/session/cache'), true)
  })


test('纯打包成功也不调用 Cargo 清理，保留 Debug 和 Release', t => {
  const f = fixture(t)
  assert.equal(packageMac('build:mac', [], f.options), 0)
  assert.equal(f.calls.some(([command]) => command === 'cargo'), false)
  assert.equal(f.exists('kiro-rs-src/target/debug/incremental'), true)
  assert.equal(f.exists('kiro-rs-src/target/release/kiro-rs'), true)
})

test('真实 Cargo 清除本包两个 profile，保留依赖库、源码与锁文件', t => {
  const f = fixture(t)
  f.file('kiro-rs-src/Cargo.toml', '[package]\nname="kiro-rs"\nversion="0.0.0"\nedition="2021"\n[workspace]\n[dependencies]\nretained-dep={path="retained-dep"}\n')
  f.file('kiro-rs-src/src/main.rs', 'fn main() { println!("{}", retained_dep::value()); }\n')
  f.file('kiro-rs-src/retained-dep/Cargo.toml', '[package]\nname="retained-dep"\nversion="0.0.0"\nedition="2021"\n')
  f.file('kiro-rs-src/retained-dep/src/lib.rs', 'pub fn value() -> u8 { 1 }\n')
  const cwd = path.join(f.root, 'kiro-rs-src')
  const target = path.join(cwd, 'target')
  const config = ['--target-dir', target, '--config', `build.build-dir=${JSON.stringify(target)}`]
  for (const args of [['build', '--offline', ...config], ['build', '--offline', '--release', ...config]]) {
    const result = spawnSync('cargo', args, { cwd, encoding: 'utf8', timeout: 30_000 })
    assert.equal(result.status, 0, result.stderr)
  }
  const lock = fs.readFileSync(path.join(cwd, 'Cargo.lock'), 'utf8')
  cleanRustCaches(f.root, (command, args, options) => command === 'cargo'
    ? spawnSync(command, args, { ...options, stdio: 'pipe', encoding: 'utf8' })
    : { status: 1, stdout: '', stderr: '' }, () => {}, Date.now())
  for (const output of ['debug', 'release']) {
    assert.equal(f.exists(`kiro-rs-src/target/${output}/kiro-rs`), false)
    assert.equal(fs.readdirSync(path.join(target, output, 'deps')).some(name => /^libretained_dep-.*\.rlib$/.test(name)), true)
  }
  assert.equal(fs.readFileSync(path.join(cwd, 'Cargo.lock'), 'utf8'), lock)
  assert.equal(f.exists('kiro-rs-src/src/main.rs'), true)
})
