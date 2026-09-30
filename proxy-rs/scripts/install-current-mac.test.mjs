import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { appDigest, installCurrentMac } from './install-current-mac.mjs'

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-install-test-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const projectRoot = path.join(root, 'proxy-rs')
  const applicationsRoot = path.join(root, 'Applications')
  fs.mkdirSync(path.join(projectRoot, 'build'), { recursive: true })
  fs.mkdirSync(applicationsRoot)
  const source = path.join(projectRoot, 'dist/mac-arm64/Proxy RS.app')
  const destination = path.join(applicationsRoot, 'Proxy RS.app')
  function app(dir, content) {
    for (const file of ['Info.plist', 'MacOS/Proxy RS', 'Resources/app.asar', 'Resources/kiro-rs']) {
      fs.mkdirSync(path.dirname(path.join(dir, 'Contents', file)), { recursive: true })
      fs.writeFileSync(path.join(dir, 'Contents', file), content)
    }
    fs.symlinkSync('app.asar', path.join(dir, 'Contents/Resources/link'))
  }
  app(source, 'new')
  app(destination, 'old')
  const calls = []
  let cleaned = false
  const options = {
    projectRoot, applicationsRoot, arch: 'arm64', log() {}, wait() {},
    run(command, args) {
      calls.push([command, args])
      if (command.endsWith('/ditto')) fs.cpSync(args[0], args[1], { recursive: true, verbatimSymlinks: true })
      if (command.endsWith('/ps')) return { status: 0, stdout: `${destination}/Contents/MacOS/Proxy RS\n` }
      if (command.endsWith('/lsof')) return { status: 1, stdout: '', stderr: '' }
      return { status: 0 }
    },
    clean() {
      assert.equal(appDigest(destination), appDigest(source))
      assert.equal(calls.some(([c]) => c.endsWith('/open')), true)
      cleaned = true
    }
  }
  return { root, projectRoot, applicationsRoot, source, destination, options, calls, cleaned: () => cleaned }
}

test('安装完整校验和启动请求成功后才清理，暂存与锁释放', t => {
  const f = fixture(t)
  assert.equal(installCurrentMac(f.options), 0)
  assert.equal(f.cleaned(), true)
  assert.deepEqual(fs.readdirSync(f.applicationsRoot), ['Proxy RS.app'])
  assert.equal(fs.existsSync(path.join(f.projectRoot, 'build/.mac-package.lock')), false)
})

test('已经手动安装同一包时只校验和清理，不退出、不复制、不启动', t => {
  const f = fixture(t)
  fs.rmSync(f.destination, { recursive: true })
  fs.cpSync(f.source, f.destination, { recursive: true, verbatimSymlinks: true })
  // Finder/复制工具可能收紧组写权限，但执行权限和包内容仍一致。
  fs.chmodSync(path.join(f.source, 'Contents/Resources/kiro-rs'), 0o775)
  fs.chmodSync(path.join(f.destination, 'Contents/Resources/kiro-rs'), 0o755)
  let cleaned = false
  f.options.clean = () => { cleaned = true }
  assert.equal(installCurrentMac(f.options), 0)
  assert.equal(cleaned, true)
  assert.equal(f.calls.every(([c]) => c.endsWith('/codesign')), true)
})

for (const failure of ['ditto', 'osascript', 'busy', 'corrupt', 'source-signature']) {
  test(`${failure} 失败时保留旧应用且不清理 target`, t => {
    const f = fixture(t)
    const original = appDigest(f.destination)
    const run = f.options.run
    f.options.run = (command, args) => {
      if (command.endsWith(`/${failure}`)) return { status: 1, stderr: 'failed' }
      if (failure === 'busy' && command.endsWith('/lsof')) return { status: 0, stdout: 'p123' }
      if (failure === 'source-signature' && command.endsWith('/codesign')) return { status: 1 }
      const result = run(command, args)
      if (failure === 'corrupt' && command.endsWith('/ditto')) {
        fs.writeFileSync(path.join(args[1], 'Contents/Resources/app.asar'), 'broken')
      }
      return result
    }
    assert.throws(() => installCurrentMac(f.options))
    assert.equal(appDigest(f.destination), original)
    assert.equal(f.cleaned(), false)
  })
}

test('安装后的签名校验失败时恢复旧应用', t => {
  const f = fixture(t)
  const original = appDigest(f.destination)
  const run = f.options.run
  f.options.run = (command, args) => command.endsWith('/codesign') && args.at(-1) === f.destination
    ? { status: 1 } : run(command, args)
  assert.throws(() => installCurrentMac(f.options), /codesign/)
  assert.equal(appDigest(f.destination), original)
  assert.equal(f.cleaned(), false)
})

test('启动请求失败保留已安装新包和旧版备份，不清理 target', t => {
  const f = fixture(t)
  const original = appDigest(f.destination)
  const run = f.options.run
  f.options.run = (command, args) => command.endsWith('/open') ? { status: 1 } : run(command, args)
  assert.throws(() => installCurrentMac(f.options), /open/)
  assert.equal(f.cleaned(), false)
  assert.equal(appDigest(f.destination), appDigest(f.source))
  const stage = fs.readdirSync(f.applicationsRoot).find(name => name.startsWith('.proxy-rs-install-'))
  assert.equal(appDigest(path.join(f.applicationsRoot, stage, 'previous.app')), original)
})

test('缓存被占用不撤销已验证的安装', t => {
  const f = fixture(t)
  f.options.clean = () => { throw new Error('busy') }
  assert.equal(installCurrentMac(f.options), 0)
  assert.equal(appDigest(f.destination), appDigest(f.source))
})

test('已有打包锁时不复制、不清理', t => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.projectRoot, 'build/.mac-package.lock'))
  assert.throws(() => installCurrentMac(f.options), /已有打包任务/)
  assert.equal(f.calls.length, 0)
  assert.equal(f.cleaned(), false)
})

test('拒绝软链安装目标，不修改其指向的应用', t => {
  const f = fixture(t)
  fs.renameSync(f.destination, `${f.destination}-external`)
  fs.symlinkSync(`${f.destination}-external`, f.destination)
  assert.throws(() => installCurrentMac(f.options), /不是普通目录/)
  assert.equal(f.cleaned(), false)
})

test('两个 checkout 安装同一应用时共享目标锁，第二个不得进入复制或回滚', t => {
  const f = fixture(t)
  const otherProject = path.join(f.root, 'other-checkout/proxy-rs')
  fs.mkdirSync(path.join(otherProject, 'build'), { recursive: true })
  const run = f.options.run
  let blocked = false
  f.options.run = (command, args) => {
    if (command.endsWith('/ditto')) {
      assert.throws(() => installCurrentMac({ ...f.options, projectRoot: otherProject,
        run() { assert.fail('第二个安装器不应执行命令') } }), /已有安装任务/)
      blocked = true
      assert.equal(fs.existsSync(path.join(otherProject, 'build/.mac-package.lock')), false)
    }
    return run(command, args)
  }
  assert.equal(installCurrentMac(f.options), 0)
  assert.equal(blocked, true)
  assert.equal(f.cleaned(), true)
  assert.deepEqual(fs.readdirSync(f.applicationsRoot), ['Proxy RS.app'])
})
