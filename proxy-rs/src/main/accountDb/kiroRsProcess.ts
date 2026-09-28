/**
 * kiro-rs 子进程托管：proxy-rs 启动时拉起、退出时带走，两者同生共死（改造方案 D1）。
 *
 * - 启动前检查端口：被占用（Docker 容器没停、残留进程）就拒绝启动，不起第二个
 * - 健康检查：/api/admin/store/info 的 databaseId 必须与 proxy 打开的库一致
 * - 防孤儿：`--exit-on-stdin-eof` + stdin 管道。proxy 无论怎么结束（含被强杀），
 *   系统都会关闭管道，kiro-rs 读到 EOF 自行退出
 * - 意外退出按退避重启；主动 stop 不重启
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { fetchStoreInfo, type AdminFetch, type KiroRsAdminTarget } from './adminApi'

export type KiroRsState = 'stopped' | 'starting' | 'running' | 'restarting' | 'failed'

export interface KiroRsProcessOptions {
  binary: string
  configPath: string
  dbPath: string
  host: string
  port: number
  adminApiKey: string
  expectedDatabaseId: string
  /** 健康检查总时长 */
  startTimeoutMs?: number
  /** stop 时 SIGTERM 后等待多久再 SIGKILL */
  stopGraceMs?: number
  /** 退避重启的上限 */
  maxBackoffMs?: number
  onLog?: (line: string, stream: 'stdout' | 'stderr') => void
  onStateChange?: (state: KiroRsState, detail?: string) => void
  spawnImpl?: typeof spawn
  fetchImpl?: AdminFetch
}

const DEFAULT_START_TIMEOUT_MS = 20_000
const DEFAULT_STOP_GRACE_MS = 3_000
const DEFAULT_MAX_BACKOFF_MS = 30_000
const INITIAL_BACKOFF_MS = 1_000
/** 连续运行超过这个时长后，下一次崩溃的退避从头计 */
const STABLE_RUN_MS = 60_000
const HEALTH_POLL_MS = 200
const ADMIN_TIMEOUT_MS = 10_000

export function checkPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, host, () => server.close(() => resolve(true)))
  })
}

export class KiroRsProcess {
  private child: ChildProcess | null = null
  private state: KiroRsState = 'stopped'
  private stopping = false
  private backoffMs = INITIAL_BACKOFF_MS
  private restartTimer: NodeJS.Timeout | null = null
  private startedAt = 0

  constructor(private readonly options: KiroRsProcessOptions) {}

  get currentState(): KiroRsState {
    return this.state
  }

  /** 运行中时返回 Admin 连接信息，否则 null */
  target(): KiroRsAdminTarget | null {
    return this.state === 'running' ? this.adminTarget() : null
  }

  private adminTarget(): KiroRsAdminTarget {
    return {
      baseUrl: `http://${this.options.host}:${this.options.port}/api/admin`,
      adminApiKey: this.options.adminApiKey,
      timeoutMs: ADMIN_TIMEOUT_MS
    }
  }

  private setState(state: KiroRsState, detail?: string): void {
    this.state = state
    this.options.onStateChange?.(state, detail)
  }

  /**
   * 启动并等待就绪。失败时抛错，同时按退避继续重试（端口被 Docker 占着、启动阶段崩溃等
   * 都可能自行恢复）；主动 stop 会取消重试。
   */
  async start(): Promise<void> {
    this.stopping = false
    this.setState('starting')
    try {
      await this.launch()
      this.backoffMs = INITIAL_BACKOFF_MS
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setState('failed', message)
      if (!this.stopping) this.scheduleRestart(message)
      throw error
    }
  }

  private async launch(): Promise<void> {
    const { host, port } = this.options
    if (!(await checkPortFree(host, port))) {
      throw new Error(
        `端口 ${host}:${port} 已被占用（Docker 里的 kiro-rs 容器是否还在运行？），不会再启动第二个 kiro-rs`
      )
    }
    const spawnImpl = this.options.spawnImpl ?? spawn
    const child = spawnImpl(
      this.options.binary,
      [
        '-c',
        this.options.configPath,
        '--account-db',
        this.options.dbPath,
        '--host',
        host,
        '--port',
        String(port),
        '--exit-on-stdin-eof'
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? 'info' }
      }
    )
    this.child = child
    this.startedAt = Date.now()
    this.pipeLogs(child)

    const exited = new Promise<string>((resolve) => {
      child.once('error', (error) => resolve(`启动失败：${error.message}`))
      child.once('exit', (code, signal) => resolve(`已退出（code=${code}, signal=${signal}）`))
    })
    child.once('exit', () => this.handleExit(child))

    const deadline = Date.now() + (this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS)
    let lastError = ''
    while (Date.now() < deadline) {
      const early = await Promise.race([
        exited,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), HEALTH_POLL_MS))
      ])
      if (early !== null) throw new Error(`kiro-rs ${early}`)
      try {
        const info = await fetchStoreInfo(this.adminTarget(), this.options.fetchImpl)
        if (!info.enabled) throw new Error('kiro-rs 未以账号库模式运行')
        if (info.databaseId !== this.options.expectedDatabaseId) {
          child.kill('SIGTERM')
          throw new Error(
            `kiro-rs 打开的账号库（${info.databaseId}）与 proxy 的（${this.options.expectedDatabaseId}）不是同一个`
          )
        }
        this.setState('running')
        return
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        if (lastError.includes('不是同一个') || lastError.includes('未以账号库模式')) throw error
      }
    }
    child.kill('SIGTERM')
    throw new Error(`kiro-rs 启动超时：${lastError}`)
  }

  private pipeLogs(child: ChildProcess): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      let buffer = ''
      child[stream]?.setEncoding('utf8')
      child[stream]?.on('data', (chunk: string) => {
        buffer += chunk
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) this.options.onLog?.(line, stream)
      })
    }
  }

  private handleExit(child: ChildProcess): void {
    if (this.child !== child) return
    this.child = null
    if (this.stopping) {
      this.setState('stopped')
      return
    }
    if (this.state === 'starting') return // 由 launch() 的调用方报告失败
    if (Date.now() - this.startedAt > STABLE_RUN_MS) this.backoffMs = INITIAL_BACKOFF_MS
    this.scheduleRestart('kiro-rs 意外退出')
  }

  private scheduleRestart(reason: string): void {
    const delay = this.backoffMs
    this.backoffMs = Math.min(
      this.backoffMs * 2,
      this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
    )
    this.setState('restarting', `${reason}，${Math.round(delay / 1000)} 秒后重启`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.stopping) return
      this.setState('starting')
      this.launch().catch((error) => {
        if (!this.stopping) {
          this.scheduleRestart(error instanceof Error ? error.message : String(error))
        }
      })
    }, delay)
  }

  /** 主动停止：SIGTERM，超时 SIGKILL。不会触发重启。 */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    if (!child || child.exitCode !== null) {
      this.setState('stopped')
      return
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
      }, this.options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill('SIGTERM')
    })
  }
}
