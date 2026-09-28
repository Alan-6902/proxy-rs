/**
 * 账号库模式的运行时状态与编排。
 *
 * 模式开关是 userData 下的 `account-db.json`（由迁移器写入 enabled=true）。文件不存在或
 * enabled=false 时 proxy-rs 保持原来的 electron-store 账号存储，行为不变。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AdminManagedAccountEntry } from '../../shared/adminManaged'
import { reloadAdminManagedIds, setAdminManagedSource } from '../adminManaged/gate'
import { AccountDb, type AccountDbRow } from './db'
import { AccountDataBridge, type BridgeDeps, type RawStore } from './bridge'
import type { KiroRsAdminTarget } from './adminApi'
import { KiroRsProcess, type KiroRsState } from './kiroRsProcess'

export const ACCOUNT_DB_CONFIG_FILE = 'account-db.json'
/** kiro-rs 只监听回环：原配置里的 0.0.0.0 在容器里靠端口映射收敛，原生运行时必须显式覆盖 */
export const KIRO_RS_HOST = '127.0.0.1'
const DEFAULT_KIRO_RS_PORT = 12888
const CHANGE_POLL_MS = 1500
const ADMIN_TIMEOUT_MS = 10_000

export interface AccountDbConfig {
  enabled: boolean
  dbPath: string
  kiroRs: {
    /** kiro-rs 配置文件（读取 adminApiKey / port） */
    configPath: string
    /** 可执行文件；不填时用 App 内置或开发目录下的构建产物 */
    binary?: string
    /** 覆盖端口；不填用配置文件里的 port */
    port?: number
    /** false 时不由 proxy 拉起（开发期手动运行 kiro-rs） */
    manage?: boolean
  }
}

export function defaultAccountDbConfig(): AccountDbConfig {
  const root = join(homedir(), 'kiro-rs')
  return {
    enabled: false,
    dbPath: join(root, 'data', 'accounts.sqlite3'),
    kiroRs: { configPath: join(root, 'config', 'config.json'), manage: true }
  }
}

export function loadAccountDbConfig(userDataDir: string): AccountDbConfig | null {
  const file = join(userDataDir, ACCOUNT_DB_CONFIG_FILE)
  if (!existsSync(file)) return null
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AccountDbConfig>
  const defaults = defaultAccountDbConfig()
  return {
    enabled: parsed.enabled === true,
    dbPath: parsed.dbPath || defaults.dbPath,
    kiroRs: { ...defaults.kiroRs, ...(parsed.kiroRs ?? {}) }
  }
}

export function saveAccountDbConfig(userDataDir: string, config: AccountDbConfig): void {
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(join(userDataDir, ACCOUNT_DB_CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600
  })
}

/** 读 kiro-rs 配置里 proxy 需要的两项；adminApiKey 不出现在日志里 */
export function readKiroRsConnection(
  configPath: string,
  portOverride?: number
): {
  adminApiKey: string
  port: number
} {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    adminApiKey?: string
    port?: number
  }
  const adminApiKey = config.adminApiKey?.trim()
  if (!adminApiKey) throw new Error(`kiro-rs 配置缺少 adminApiKey：${configPath}`)
  return { adminApiKey, port: portOverride ?? config.port ?? DEFAULT_KIRO_RS_PORT }
}

export function managedEntryOf(row: AccountDbRow): AdminManagedAccountEntry {
  return {
    accountId: row.accountUuid,
    credentialId: String(row.id),
    authMethod:
      row.authKind === 'api_key' ? 'api_key' : row.authMethod === 'idc' ? 'idc' : 'social',
    remoteCredentialIdentity: row.credentialIdentity,
    pushedAt: row.createdAtMs
  }
}

interface Runtime {
  config: AccountDbConfig
  db: AccountDb
  bridge: AccountDataBridge
  adminApiKey: string
  port: number
  process: KiroRsProcess | null
  kiroRsState: KiroRsState
  kiroRsDetail?: string
  watcher: NodeJS.Timeout | null
  lastSeq: number
  pendingTimer: NodeJS.Timeout | null
}

let runtime: Runtime | null = null

export function isAccountDbMode(): boolean {
  return runtime !== null
}

export function accountDbBridge(): AccountDataBridge | null {
  return runtime?.bridge ?? null
}

/**
 * 打开账号库并接管账号存储。库打不开时抛错——不会退回 electron-store 里的旧账号。
 */
export function activateAccountDb(input: {
  config: AccountDbConfig
  rawStore: RawStore
  proxyUrlFor?: BridgeDeps['proxyUrlFor']
}): AccountDataBridge {
  const connection = readKiroRsConnection(input.config.kiroRs.configPath, input.config.kiroRs.port)
  const db = new AccountDb(input.config.dbPath)
  const bridge = new AccountDataBridge(db, input.rawStore, {
    proxyUrlFor: input.proxyUrlFor,
    onPending: () => schedulePendingSync()
  })
  runtime = {
    config: input.config,
    db,
    bridge,
    adminApiKey: connection.adminApiKey,
    port: connection.port,
    process: null,
    kiroRsState: 'stopped',
    watcher: null,
    lastSeq: db.changeSeq(),
    pendingTimer: null
  }
  setAdminManagedSource(() => (runtime ? runtime.db.listRows().map(managedEntryOf) : []))
  return bridge
}

/** kiro-rs Admin 连接信息；由 proxy 托管时仅在子进程就绪后可用 */
export function accountDbAdminTarget(): KiroRsAdminTarget | null {
  if (!runtime) return null
  if (runtime.process) return runtime.process.target()
  return {
    baseUrl: `http://${KIRO_RS_HOST}:${runtime.port}/api/admin`,
    adminApiKey: runtime.adminApiKey,
    timeoutMs: ADMIN_TIMEOUT_MS
  }
}

function schedulePendingSync(): void {
  if (!runtime || runtime.pendingTimer) return
  runtime.pendingTimer = setTimeout(() => {
    if (!runtime) return
    runtime.pendingTimer = null
    void syncAccountDbPending()
  }, 1000)
}

/** 把待导入账号交给 kiro-rs、同步代理绑定。kiro-rs 未就绪时跳过，就绪后会再调一次。 */
export async function syncAccountDbPending(): Promise<void> {
  const target = accountDbAdminTarget()
  if (!runtime || !target) return
  const result = await runtime.bridge.syncPending(target)
  if (result.imported.length > 0) {
    console.log(`[AccountDb] 已导入 ${result.imported.length} 个新账号到 kiro-rs`)
  }
  for (const failure of result.failed) {
    console.warn(`[AccountDb] 账号 ${failure.id} 暂未导入 kiro-rs：${failure.reason}`)
  }
  try {
    const updated = await runtime.bridge.syncProxyBindings(target)
    if (updated > 0) console.log(`[AccountDb] 已同步 ${updated} 个账号的代理绑定到 kiro-rs`)
  } catch (error) {
    console.warn('[AccountDb] 同步代理绑定失败：', error instanceof Error ? error.message : error)
  }
}

/** 拉起 kiro-rs 子进程（config.kiroRs.manage=false 时不拉起） */
export async function startManagedKiroRs(input: {
  binary: string
  onLog?: (line: string, stream: 'stdout' | 'stderr') => void
  onStateChange?: (state: KiroRsState, detail?: string) => void
}): Promise<void> {
  if (!runtime || runtime.config.kiroRs.manage === false) return
  const current = runtime
  if (!existsSync(input.binary)) {
    current.kiroRsState = 'failed'
    current.kiroRsDetail = `找不到 kiro-rs 可执行文件：${input.binary}`
    input.onStateChange?.('failed', current.kiroRsDetail)
    throw new Error(current.kiroRsDetail)
  }
  current.process = new KiroRsProcess({
    binary: input.binary,
    configPath: current.config.kiroRs.configPath,
    dbPath: current.config.dbPath,
    host: KIRO_RS_HOST,
    port: current.port,
    adminApiKey: current.adminApiKey,
    expectedDatabaseId: current.db.databaseId(),
    onLog: input.onLog,
    onStateChange: (state, detail) => {
      current.kiroRsState = state
      current.kiroRsDetail = detail
      input.onStateChange?.(state, detail)
      if (state === 'running') void syncAccountDbPending()
    }
  })
  await current.process.start()
}

export async function stopManagedKiroRs(): Promise<void> {
  await runtime?.process?.stop()
}

/** 轮询跨端变化；有变化时刷新托管索引并通知调用方（推给渲染进程） */
export function startAccountDbWatcher(onChange: () => void): void {
  if (!runtime || runtime.watcher) return
  const current = runtime
  current.watcher = setInterval(() => {
    try {
      const seq = current.db.changeSeq()
      if (seq === current.lastSeq) return
      current.lastSeq = seq
      void reloadAdminManagedIds()
      onChange()
    } catch (error) {
      console.warn('[AccountDb] 读取变更失败：', error instanceof Error ? error.message : error)
    }
  }, CHANGE_POLL_MS)
}

export function stopAccountDbWatcher(): void {
  if (runtime?.watcher) {
    clearInterval(runtime.watcher)
    runtime.watcher = null
  }
}

/**
 * 备份内容：账号库模式下库里的账号不进 electron-store 备份（它们的权威在库里，
 * 旧快照恢复回来会被当成待导入账号、带着已轮换作废的 token 重新导入）。
 */
export function accountDbBackupPayload(data: unknown): unknown {
  if (!runtime || !data || typeof data !== 'object') return data
  const pending = new Set(runtime.bridge.pendingIds())
  const record = data as { accounts?: Record<string, unknown> }
  return {
    ...record,
    accounts: Object.fromEntries(
      Object.entries(record.accounts ?? {}).filter(([id]) => pending.has(id))
    )
  }
}

export interface AccountDbStatus {
  enabled: boolean
  dbPath?: string
  databaseId?: string
  kiroRsState?: KiroRsState
  kiroRsDetail?: string
  pending?: number
}

export function accountDbStatus(): AccountDbStatus {
  if (!runtime) return { enabled: false }
  return {
    enabled: true,
    dbPath: runtime.config.dbPath,
    databaseId: runtime.db.databaseId(),
    kiroRsState: runtime.process ? runtime.kiroRsState : 'running',
    kiroRsDetail: runtime.kiroRsDetail,
    pending: runtime.bridge.pendingIds().length
  }
}

/** 数据目录权限：库、WAL 与备份都含凭据 */
export function ensureAccountDbDir(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
}
