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
import { toAccount } from './projection'
import { ensureFresh, type KiroRsAdminTarget } from './adminApi'
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

/** 明文凭据投影：仅供导出 / 复制这类显式用户操作，不进普通列表（改造方案 §6.5） */
export function accountDbAccountsWithSecrets(ids?: readonly string[]): Record<string, unknown> {
  if (!runtime) return {}
  const wanted = ids && ids.length > 0 ? new Set(ids) : null
  const entries = runtime.db
    .listRows()
    .filter((row) => !wanted || wanted.has(row.accountUuid))
    .map((row) => [row.accountUuid, toAccount(row)] as const)
  return Object.fromEntries(entries)
}

/** 单个账号的库行（未启用账号库或账号未入库时返回 null） */
export function accountDbRow(accountId: string): AccountDbRow | null {
  if (!runtime || !accountId) return null
  return runtime.db.listRows().find((row) => row.accountUuid === accountId) ?? null
}

export interface FreshCredentialResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  /** 账号库凭据版本（作为 credentialRevision 使用） */
  credentialRevision?: string
  error?: string
}

/**
 * 确保账号 token 新鲜，返回库中最新凭据。刷新只在 kiro-rs 发生（改造方案 §0.2 D3）。
 *
 * - 非账号库模式、或账号尚未入库：返回 null，调用方按原有逻辑处理
 * - `expectedCredentialVersion` 是调用方所用 token 的版本：与库中不同说明已被别处轮换，
 *   kiro-rs 直接返回新版本而不再轮换一次（401 重试就靠这个避免连环轮换）
 * - kiro-rs 不可用时返回失败，不退回本地刷新（否则又变成双边抢刷）
 */
export async function ensureFreshAccountDbCredential(input: {
  accountId: string
  expectedCredentialVersion?: number
  force?: boolean
}): Promise<FreshCredentialResult | null> {
  if (!runtime) return null
  const row = runtime.db.listRows().find((item) => item.accountUuid === input.accountId)
  if (!row) return null

  const read = (): FreshCredentialResult => {
    const latest = runtime?.db.listRows().find((item) => item.accountUuid === input.accountId)
    if (!latest) return { success: false, error: '账号已不在账号库中' }
    const token = latest.authKind === 'api_key' ? latest.kiroApiKey : latest.accessToken
    if (!token) return { success: false, error: 'kiro-rs 尚未取得可用凭据' }
    return {
      success: true,
      accessToken: token,
      refreshToken: latest.refreshToken ?? undefined,
      expiresAt: latest.expiresAtMs ?? undefined,
      credentialRevision: String(latest.credentialVersion)
    }
  }

  // API Key 不刷新，直接给当前值
  if (row.authKind === 'api_key') return read()

  const target = accountDbAdminTarget()
  if (!target) {
    return { success: false, error: 'kiro-rs 尚未就绪，无法刷新凭据' }
  }
  try {
    await ensureFresh(
      target,
      row.id,
      input.expectedCredentialVersion ?? row.credentialVersion,
      input.force ?? false
    )
  } catch (error) {
    return {
      success: false,
      error: `kiro-rs 刷新凭据失败：${error instanceof Error ? error.message : String(error)}`
    }
  }
  return read()
}

/** 拉起 kiro-rs 子进程（config.kiroRs.manage=false 时不拉起） */ export async function startManagedKiroRs(input: {
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
