/**
 * Cursor 账号的本地加密存储。
 *
 * 单文件 + safeStorage 加密，与 KSK 自动任务、抢号配置同一套做法：账号里有 access/refresh
 * token，不落明文。所有写操作排进串行队列，避免批量刷新与手动操作互相覆盖。
 *
 * 去重口径移植自 cockpit-tools：authId（WorkOS user id）优先；双方都没有 authId 时才按
 * email 或 access token 匹配；一方有一方没有视为不同账号。
 */

import { app, safeStorage } from 'electron'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  CURSOR_AUTO_REFRESH_DEFAULT_SETTINGS,
  CURSOR_AUTO_REFRESH_INTERVAL_OPTIONS,
  type CursorAccount,
  type CursorAutoRefreshSettings
} from '../../shared/cursorAccounts'
import { extractAuthIdFromAccessToken } from './cursorApi'

const STORE_FILE = 'cursor-accounts.json'
const STORE_VERSION = 1
/** 小于这个值的时间戳按秒处理（cockpit-tools 导出的 created_at / last_used 是秒）。 */
const SECONDS_TIMESTAMP_UPPER_BOUND = 1e11

/** 落盘格式。settings 与账号放同一个文件：只有一处要加密、一处要排队。 */
interface PersistedCursorAccountStore {
  version: number
  accounts: CursorAccount[]
  settings?: CursorAutoRefreshSettings
}

interface CursorStoreState {
  accounts: CursorAccount[]
  settings: CursorAutoRefreshSettings
}

export interface CursorImportPayload {
  email: string
  authId?: string
  name?: string
  tags?: string[]
  accessToken: string
  refreshToken?: string
  membershipType?: string
  subscriptionStatus?: string
  signUpType?: string
  authRaw?: Record<string, unknown>
  usageRaw?: Record<string, unknown>
  botUsageRaw?: Record<string, unknown>
  creditBalanceCents?: number
  status?: string
  statusReason?: string
  quotaQueryLastError?: string
  quotaQueryLastErrorAt?: number
  createdAt?: number
}

let mutationQueue: Promise<void> = Promise.resolve()

export function cursorAccountsStorePath(): string {
  return join(app.getPath('userData'), STORE_FILE)
}

export function isCursorAccountStoreAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function readTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const tags: string[] = []
  for (const item of value) {
    const tag = readString(item)
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
  }
  return tags
}

function readTimestampMs(value: unknown): number | undefined {
  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numberValue) || numberValue <= 0) return undefined
  return numberValue < SECONDS_TIMESTAMP_UPPER_BOUND
    ? Math.floor(numberValue * 1000)
    : Math.floor(numberValue)
}

/** 金额（美分）：非数字或负数按未知处理。 */
function readCents(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const numberValue = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numberValue) && numberValue >= 0 ? Math.round(numberValue) : undefined
}

function pick(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function normalizeAccount(value: unknown, now: number): CursorAccount | null {
  const record = readObject(value)
  if (!record) return null
  const id = readString(record.id)
  const accessToken = readString(record.accessToken)
  if (!id || !accessToken) return null
  return {
    id,
    email: readString(record.email) ?? '',
    authId: readString(record.authId),
    name: readString(record.name),
    tags: readTags(record.tags),
    accessToken,
    refreshToken: readString(record.refreshToken),
    membershipType: readString(record.membershipType),
    subscriptionStatus: readString(record.subscriptionStatus),
    signUpType: readString(record.signUpType),
    authRaw: readObject(record.authRaw),
    usageRaw: readObject(record.usageRaw),
    botUsageRaw: readObject(record.botUsageRaw),
    creditBalanceCents: readCents(record.creditBalanceCents),
    status: readString(record.status),
    statusReason: readString(record.statusReason),
    quotaQueryLastError: readString(record.quotaQueryLastError),
    quotaQueryLastErrorAt: readTimestampMs(record.quotaQueryLastErrorAt),
    usageUpdatedAt: readTimestampMs(record.usageUpdatedAt),
    createdAt: readTimestampMs(record.createdAt) ?? now,
    lastUsed: readTimestampMs(record.lastUsed) ?? now
  }
}

export function normalizeCursorAccountStorePayload(
  payload: unknown,
  now = Date.now()
): CursorAccount[] {
  const record = readObject(payload)
  const source = record && Array.isArray(record.accounts) ? (record.accounts as unknown[]) : []
  const accounts: CursorAccount[] = []
  const seen = new Set<string>()
  for (const item of source) {
    const account = normalizeAccount(item, now)
    if (!account || seen.has(account.id)) continue
    seen.add(account.id)
    accounts.push(account)
  }
  return accounts
}

/** 间隔只接受预设档位，非法值回落到默认；老文件没有 settings 时整体用默认。 */
export function normalizeCursorAutoRefreshSettings(value: unknown): CursorAutoRefreshSettings {
  const record = readObject(value)
  if (!record) return { ...CURSOR_AUTO_REFRESH_DEFAULT_SETTINGS }
  const interval = Number(record.intervalMinutes)
  return {
    enabled:
      typeof record.enabled === 'boolean'
        ? record.enabled
        : CURSOR_AUTO_REFRESH_DEFAULT_SETTINGS.enabled,
    intervalMinutes: CURSOR_AUTO_REFRESH_INTERVAL_OPTIONS.includes(interval)
      ? interval
      : CURSOR_AUTO_REFRESH_DEFAULT_SETTINGS.intervalMinutes
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function emptyState(): CursorStoreState {
  return { accounts: [], settings: { ...CURSOR_AUTO_REFRESH_DEFAULT_SETTINGS } }
}

async function loadStore(): Promise<CursorStoreState> {
  if (!isCursorAccountStoreAvailable()) return emptyState()
  try {
    const encrypted = await fs.readFile(cursorAccountsStorePath())
    const payload: unknown = JSON.parse(safeStorage.decryptString(encrypted))
    return {
      accounts: normalizeCursorAccountStorePayload(payload),
      settings: normalizeCursorAutoRefreshSettings(readObject(payload)?.settings)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
    throw new Error('Cursor 账号库无法解密或已损坏，已拒绝用空数据覆盖原文件')
  }
}

export async function loadCursorAccounts(): Promise<CursorAccount[]> {
  return (await loadStore()).accounts
}

export async function loadCursorAutoRefreshSettings(): Promise<CursorAutoRefreshSettings> {
  return (await loadStore()).settings
}

async function saveStore(state: CursorStoreState): Promise<void> {
  if (!isCursorAccountStoreAvailable()) {
    throw new Error('系统加密存储不可用，拒绝明文保存 Cursor 账号 token')
  }
  const payload: PersistedCursorAccountStore = {
    version: STORE_VERSION,
    accounts: state.accounts,
    settings: state.settings
  }
  const path = cursorAccountsStorePath()
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, safeStorage.encryptString(JSON.stringify(payload)), { mode: 0o600 })
}

/** 读-改-写排队执行；mutate 原地修改状态，返回值透传给调用方。 */
function mutateStore<T>(mutate: (state: CursorStoreState) => T | Promise<T>): Promise<T> {
  let resolveResult: (value: T | PromiseLike<T>) => void
  let rejectResult: (reason?: unknown) => void
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  mutationQueue = mutationQueue
    .then(async () => {
      const state = await loadStore()
      const value = await mutate(state)
      await saveStore(state)
      resolveResult(value)
    })
    .catch((error) => {
      rejectResult(error)
    })
  return result
}

export function mutateCursorAccounts<T>(
  mutate: (accounts: CursorAccount[]) => T | Promise<T>
): Promise<T> {
  return mutateStore((state) => mutate(state.accounts))
}

export function updateCursorAutoRefreshSettings(
  patch: Partial<CursorAutoRefreshSettings>
): Promise<CursorAutoRefreshSettings> {
  return mutateStore((state) => {
    state.settings = normalizeCursorAutoRefreshSettings({ ...state.settings, ...patch })
    return state.settings
  })
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface CursorIdentity {
  authId?: string
  email?: string
  accessToken?: string
}

function normalizeEmailIdentity(value: string | undefined): string | undefined {
  const lowered = readString(value)?.toLowerCase()
  return lowered && lowered.includes('@') ? lowered : undefined
}

function readAuthIdFromRaw(raw: Record<string, unknown> | undefined): string | undefined {
  if (!raw) return undefined
  return readString(pick(raw, 'authId', 'auth_id', 'workosId', 'workos_id'))
}

export function resolveCursorAccountAuthId(account: {
  authId?: string
  authRaw?: Record<string, unknown>
  accessToken: string
}): string | undefined {
  return (
    readString(account.authId) ??
    readAuthIdFromRaw(account.authRaw) ??
    extractAuthIdFromAccessToken(account.accessToken)
  )
}

function identityOf(account: CursorAccount): CursorIdentity {
  return {
    authId: resolveCursorAccountAuthId(account),
    email: normalizeEmailIdentity(account.email),
    accessToken: readString(account.accessToken)
  }
}

/**
 * 同一账号的判定：authId 相同，或邮箱相同。
 *
 * 邮箱是 Cursor 账号的唯一键，而同一个号在不同入口拿到的 WorkOS id 可能不同（本机
 * state.vscdb 里的 cursorAuth/authId 与登录握手 JWT 的 sub 实测就不一样），只认 authId
 * 会把同一个号存成两条。两边都没有 authId 且邮箱不可比时，才退到比较 access token。
 */
function identitiesMatch(left: CursorIdentity, right: CursorIdentity): boolean {
  if (left.authId && right.authId && left.authId === right.authId) return true
  if (left.email && right.email) return left.email === right.email
  // 邮箱不可比：authId 不同或只有一边有，都不敢合并
  if (left.authId || right.authId) return false
  return Boolean(left.accessToken && right.accessToken && left.accessToken === right.accessToken)
}

/** 按身份找已有账号：用于 upsert 去重，也用于识别本机 Cursor 当前登录的是哪个号。 */
export function findCursorAccountByIdentity(
  accounts: CursorAccount[],
  identity: CursorIdentity
): CursorAccount | undefined {
  const normalized: CursorIdentity = {
    authId: readString(identity.authId),
    email: normalizeEmailIdentity(identity.email),
    accessToken: readString(identity.accessToken)
  }
  return accounts.find((account) => identitiesMatch(identityOf(account), normalized))
}

function generateAccountId(identity: CursorIdentity): string {
  const seed = (
    identity.authId ??
    identity.email ??
    identity.accessToken ??
    'cursor_user'
  ).toLowerCase()
  return `cursor_${createHash('md5').update(seed).digest('hex')}`
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function resolvePayloadAuthId(payload: CursorImportPayload): string | undefined {
  return (
    readString(payload.authId) ??
    readAuthIdFromRaw(payload.authRaw) ??
    extractAuthIdFromAccessToken(payload.accessToken)
  )
}

/** 在内存数组上做 upsert，供批量导入复用同一次落盘。 */
function upsertInto(
  accounts: CursorAccount[],
  payload: CursorImportPayload,
  now: number
): CursorAccount {
  const authId = resolvePayloadAuthId(payload)
  const identity: CursorIdentity = {
    authId,
    email: normalizeEmailIdentity(payload.email),
    accessToken: readString(payload.accessToken)
  }
  const existing = findCursorAccountByIdentity(accounts, identity)
  const incomingEmail = readString(payload.email) ?? ''

  const next: CursorAccount = {
    id: existing?.id ?? generateAccountId(identity),
    // 新邮箱优先；没有新邮箱时保留旧的，但旧值不像邮箱（占位串）就清掉
    email: incomingEmail || (existing?.email.includes('@') ? existing.email : ''),
    authId: authId ?? existing?.authId,
    name: readString(payload.name) ?? existing?.name,
    tags: readTags([...(existing?.tags ?? []), ...(payload.tags ?? [])]),
    accessToken: payload.accessToken,
    refreshToken: readString(payload.refreshToken) ?? existing?.refreshToken,
    membershipType: readString(payload.membershipType) ?? existing?.membershipType,
    subscriptionStatus: readString(payload.subscriptionStatus) ?? existing?.subscriptionStatus,
    signUpType: readString(payload.signUpType) ?? existing?.signUpType,
    authRaw: payload.authRaw ?? existing?.authRaw,
    usageRaw: payload.usageRaw ?? existing?.usageRaw,
    botUsageRaw: payload.botUsageRaw ?? existing?.botUsageRaw,
    creditBalanceCents: payload.creditBalanceCents ?? existing?.creditBalanceCents,
    status: readString(payload.status),
    statusReason: readString(payload.statusReason),
    quotaQueryLastError: readString(payload.quotaQueryLastError),
    quotaQueryLastErrorAt: payload.quotaQueryLastError ? payload.quotaQueryLastErrorAt : undefined,
    usageUpdatedAt: payload.usageRaw ? now : existing?.usageUpdatedAt,
    createdAt: existing?.createdAt ?? payload.createdAt ?? now,
    lastUsed: now
  }
  if (authId) {
    next.authRaw = { ...(next.authRaw ?? {}), authId }
  }

  if (existing) {
    accounts[accounts.indexOf(existing)] = next
  } else {
    accounts.push(next)
  }
  return next
}

export function upsertCursorAccount(payload: CursorImportPayload): Promise<CursorAccount> {
  return mutateCursorAccounts((accounts) => upsertInto(accounts, payload, Date.now()))
}

export function upsertCursorAccounts(payloads: CursorImportPayload[]): Promise<CursorAccount[]> {
  return mutateCursorAccounts((accounts) => {
    const now = Date.now()
    return payloads.map((payload) => upsertInto(accounts, payload, now))
  })
}

/**
 * 新增入口给「本次添加要打的标签」：并进 payload，落库时 upsertInto 会与已有标签去重合并。
 * tags 为空时原样返回，不制造无谓的拷贝。
 */
export function withTags(payload: CursorImportPayload, tags: string[]): CursorImportPayload {
  if (tags.length === 0) return payload
  return { ...payload, tags: [...(payload.tags ?? []), ...tags] }
}

/** 刷新后的整条账号写回；账号已被删掉时不复活它。 */
export function replaceCursorAccount(account: CursorAccount): Promise<CursorAccount> {
  return mutateCursorAccounts((accounts) => {
    const index = accounts.findIndex((item) => item.id === account.id)
    if (index < 0) throw new Error(`Cursor 账号不存在: ${account.id}`)
    accounts[index] = account
    return account
  })
}

export function removeCursorAccounts(ids: string[]): Promise<void> {
  const removing = new Set(ids)
  return mutateCursorAccounts((accounts) => {
    for (let index = accounts.length - 1; index >= 0; index -= 1) {
      if (removing.has(accounts[index].id)) accounts.splice(index, 1)
    }
  })
}

export function updateCursorAccountTags(id: string, tags: string[]): Promise<CursorAccount> {
  return mutateCursorAccounts((accounts) => {
    const account = accounts.find((item) => item.id === id)
    if (!account) throw new Error(`Cursor 账号不存在: ${id}`)
    account.tags = readTags(tags)
    return account
  })
}

// ---------------------------------------------------------------------------
// Import / Export
// ---------------------------------------------------------------------------

/** 单条导入记录 → payload。同时认本应用（camelCase）与 cockpit-tools（snake_case）的字段名。 */
export function cursorImportPayloadFromRecord(
  record: Record<string, unknown>
): CursorImportPayload {
  const accessToken = readString(
    pick(record, 'accessToken', 'access_token', 'token', 'cursor_access_token')
  )
  if (!accessToken) throw new Error('缺少 access_token 字段')
  const authRaw =
    readObject(pick(record, 'authRaw', 'cursor_auth_raw', 'cursorAuthRaw')) ?? undefined
  const email = readString(pick(record, 'email', 'cachedEmail', 'cursor_email')) ?? ''
  return {
    email,
    authId: readString(pick(record, 'authId', 'auth_id', 'workosId', 'workos_id')),
    name: readString(pick(record, 'name', 'displayName')),
    tags: readTags(record.tags),
    accessToken,
    refreshToken: readString(pick(record, 'refreshToken', 'refresh_token', 'cursor_refresh_token')),
    membershipType: readString(
      pick(record, 'membershipType', 'membership_type', 'stripeMembershipType', 'plan')
    ),
    subscriptionStatus: readString(
      pick(record, 'subscriptionStatus', 'subscription_status', 'stripeSubscriptionStatus')
    ),
    signUpType: readString(pick(record, 'signUpType', 'sign_up_type', 'cachedSignUpType')),
    authRaw,
    usageRaw: readObject(pick(record, 'usageRaw', 'cursor_usage_raw', 'cursorUsageRaw')),
    botUsageRaw: readObject(record.botUsageRaw),
    creditBalanceCents: readCents(record.creditBalanceCents),
    status: readString(record.status),
    statusReason: readString(pick(record, 'statusReason', 'status_reason')),
    createdAt: readTimestampMs(pick(record, 'createdAt', 'created_at'))
  }
}

/**
 * 解析导入 JSON。接受：本应用导出的数组、cockpit-tools 导出的数组（snake_case）、
 * 单个账号对象、`{ accounts: [...] }` / `{ items: [...] }` 包装，以及最简的
 * `[{ "access_token": "...", "email": "..." }]`。
 */
export function parseCursorImportJson(text: string): CursorImportPayload[] {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('无法解析 JSON 内容')
  }

  let items: unknown[]
  if (Array.isArray(value)) {
    items = value
  } else {
    const record = readObject(value)
    if (!record) throw new Error('Cursor 导入 JSON 必须是对象或数组')
    const wrapped = pick(record, 'accounts', 'items')
    items = Array.isArray(wrapped) ? wrapped : [record]
  }
  if (items.length === 0) throw new Error('导入数组为空')

  return items.map((item, index) => {
    const record = readObject(item)
    if (!record) throw new Error(`第 ${index + 1} 条 Cursor 账号不是对象`)
    try {
      return cursorImportPayloadFromRecord(record)
    } catch (error) {
      throw new Error(
        `第 ${index + 1} 条 Cursor 账号解析失败: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  })
}

export function exportCursorAccountsJson(accounts: CursorAccount[]): string {
  return JSON.stringify(accounts, null, 2)
}
