import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:net'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  KiroRsProcess,
  checkPortFree,
  type KiroRsState
} from '../../src/main/accountDb/kiroRsProcess'

const FAKE = resolve(import.meta.dirname, '../helpers/fakeKiroRs.mjs')

async function freePort(): Promise<number> {
  return await new Promise((done) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => done(port))
    })
  })
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待超时')
    await new Promise((r) => setTimeout(r, 50))
  }
}

const processes: KiroRsProcess[] = []
afterEach(async () => {
  await Promise.all(processes.splice(0).map((p) => p.stop()))
})

function make(
  port: number,
  options: { dbId?: string; states?: KiroRsState[]; antigravity?: boolean } = {}
): KiroRsProcess {
  const proc = new KiroRsProcess({
    binary: process.execPath,
    configPath: 'config.json',
    // 假服务不读写账号；用已存在文件验证路径身份。
    dbPath: options.antigravity ? FAKE : 'accounts.sqlite3',
    service: options.antigravity ? 'antigravity-rs' : 'kiro-rs',
    host: '127.0.0.1',
    port,
    adminApiKey: 'admin-key',
    expectedDatabaseId: 'db-1',
    startTimeoutMs: 5000,
    stopGraceMs: 1000,
    maxBackoffMs: 200,
    onStateChange: (state) => options.states?.push(state),
    // 用 node 运行假 kiro-rs：把真实参数原样透传给脚本
    spawnImpl: ((_bin: string, args: string[], opts: object) =>
      spawn(process.execPath, [FAKE, ...args], {
        ...opts,
        env: { ...process.env, FAKE_ADMIN_KEY: 'admin-key', FAKE_DB_ID: options.dbId ?? 'db-1' }
      })) as unknown as typeof spawn
  })
  processes.push(proc)
  return proc
}

describe('KiroRsProcess', () => {
  it('两个服务分别健康检查，停止 AG 不影响 Kiro', async () => {
    const kiro = make(await freePort())
    const ag = make(await freePort(), { antigravity: true })
    await Promise.all([kiro.start(), ag.start()])
    expect(kiro.currentState).toBe('running')
    expect(ag.currentState).toBe('running')
    await ag.stop()
    expect(ag.currentState).toBe('stopped')
    expect(kiro.currentState).toBe('running')
    const target = kiro.target()!
    const response = await fetch(`${target.baseUrl}/store/info`, {
      headers: { 'x-api-key': target.adminApiKey }
    })
    expect(response.ok).toBe(true)
  })

  it('AG 端口冲突时 Kiro 仍可运行，错误明确标识 antigravity-rs', async () => {
    const kiro = make(await freePort())
    await kiro.start()
    const ag = make(Number(new URL(kiro.target()!.baseUrl).port), { antigravity: true })
    await expect(ag.start()).rejects.toThrow(/antigravity-rs/)
    expect(kiro.currentState).toBe('running')
  })

  it('启动后健康检查通过，stop 后不再重启', async () => {
    const port = await freePort()
    const states: KiroRsState[] = []
    const proc = make(port, { states })
    await proc.start()
    expect(proc.currentState).toBe('running')
    expect(proc.target()?.baseUrl).toBe(`http://127.0.0.1:${port}/api/admin`)
    await proc.stop()
    expect(proc.currentState).toBe('stopped')
    expect(await checkPortFree('127.0.0.1', port)).toBe(true)
    expect(states).toEqual(['starting', 'running', 'stopped'])
  })

  it('意外退出后按退避自动重启', async () => {
    const port = await freePort()
    const proc = make(port)
    await proc.start()
    const child = (proc as unknown as { child: { pid: number } }).child
    process.kill(child.pid, 'SIGKILL')
    await waitFor(() => proc.currentState === 'restarting')
    await waitFor(() => proc.currentState === 'running')
    expect((proc as unknown as { child: { pid: number } }).child.pid).not.toBe(child.pid)
  })

  it('启动失败后按退避重试，端口释放后恢复', async () => {
    const port = await freePort()
    const blocker: Server = createServer()
    await new Promise<void>((r) => blocker.listen(port, '127.0.0.1', () => r()))
    const proc = make(port)
    await expect(proc.start()).rejects.toThrow(/已被占用/)
    await new Promise<void>((r) => blocker.close(() => r()))
    await waitFor(() => proc.currentState === 'running')
  })

  it('端口已被占用时拒绝启动，不起第二个', async () => {
    const port = await freePort()
    const blocker: Server = createServer()
    await new Promise<void>((r) => blocker.listen(port, '127.0.0.1', () => r()))
    try {
      await expect(make(port).start()).rejects.toThrow(/已被占用/)
    } finally {
      blocker.close()
    }
  })

  it('打开的账号库与 proxy 不是同一个时拒绝', async () => {
    const port = await freePort()
    await expect(make(port, { dbId: 'other-db' }).start()).rejects.toThrow(/不是同一个/)
  })

  it('父进程关闭 stdin（被强杀的效果）时子进程自行退出', async () => {
    const port = await freePort()
    const proc = make(port)
    await proc.start()
    const child = (
      proc as unknown as { child: { stdin: { end(): void }; exitCode: number | null } }
    ).child
    ;(proc as unknown as { stopping: boolean }).stopping = true // 避免触发自动重启
    child.stdin.end()
    await waitFor(() => child.exitCode !== null)
    expect(child.exitCode).toBe(0)
  })
})
