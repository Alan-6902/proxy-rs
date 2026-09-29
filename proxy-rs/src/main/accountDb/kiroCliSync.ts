/**
 * 账号库模式下把 kiro-rs 的续期结果同步给 kiro-cli。
 *
 * 为什么需要：kiro-cli 自己也会在 token 临期时刷新，而 refresh token 是一次性的——
 * 它刷一次，账号库里那份就作废，于是变成两个刷新方互相抢（正是这次改造要消除的）。
 *
 * 做法：让 kiro-rs 始终提前续期（后台每分钟检查、临期 10 分钟就刷），CLI 看到的 token
 * 一直很新鲜，它自己的刷新逻辑不会触发；管理器监听账号库的凭据版本变化，把新 token
 * 写进 CLI。这与 Kiro IDE 那边"主动续期避免对方刷新循环启动"的思路一致。
 *
 * 安全前提：只覆盖"管理器上次写进 CLI 的那一份"。每次同步前读 CLI 当前 refresh token，
 * 与记录的哈希比对；不一致说明用户在 CLI 里自己登录过别的账号，此时放弃同步并清掉映射，
 * 绝不覆盖用户的手动登录。哈希用 sha256，不落明文。
 *
 * 反向（adoptKiroCliIntoAccountDb）：CLI 自己刷新过（例如 App 没开时一直在用 CLI），
 * 库里那份 refresh token 已作废。这时不再让 kiro-rs 刷新，而是把 CLI 的新凭据交给
 * kiro-rs 收编：kiro-rs 用它查上游身份（userId），命中库中账号、且比库里新才替换。
 * CLI 里是库中账号的独立登录（用户直接 kiro-cli login）时同样收编，两边从此共用一条 token 链。
 */

import { createHash } from 'node:crypto'
import {
  KIRO_CLI_AUTH_KEY,
  readKiroCliCurrentToken,
  resolveKiroCliDbPath,
  syncRefreshedKiroCliCredentials
} from '../kiroCli/cliCredentials'
import type { AdoptCredentialResult, adoptCredential } from './adminApi'
import type { AccountDbRow } from './db'

/** electron-store 里的映射键 */
export const KIRO_CLI_SYNC_KEY = 'kiroCliSync'

export interface KiroCliSyncState {
  /** 上次切号写进 CLI 的账号（proxy 侧账号 ID） */
  accountId: string
  /** 写进 CLI 的 refresh token 的 sha256，只用于核对"CLI 里那份是不是我们写的" */
  refreshTokenHash: string
  /** 已同步到 CLI 的账号库凭据版本 */
  credentialVersion: number
}

export interface KiroCliSyncStore {
  get(key: string, defaultValue?: unknown): unknown
  set(key: string, value: unknown): void
  delete?(key: string): void
}

export function hashRefreshToken(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function readKiroCliSyncState(store: KiroCliSyncStore): KiroCliSyncState | null {
  const raw = store.get(KIRO_CLI_SYNC_KEY, null)
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<KiroCliSyncState>
  if (typeof value.accountId !== 'string' || typeof value.refreshTokenHash !== 'string') return null
  return {
    accountId: value.accountId,
    refreshTokenHash: value.refreshTokenHash,
    credentialVersion: typeof value.credentialVersion === 'number' ? value.credentialVersion : -1
  }
}

export function writeKiroCliSyncState(store: KiroCliSyncStore, state: KiroCliSyncState): void {
  store.set(KIRO_CLI_SYNC_KEY, state)
}

export function clearKiroCliSyncState(store: KiroCliSyncStore): void {
  if (store.delete) store.delete(KIRO_CLI_SYNC_KEY)
  else store.set(KIRO_CLI_SYNC_KEY, null)
}

export type KiroCliSyncOutcome =
  /** 不需要同步（没有映射、账号不匹配、版本未变） */
  | { status: 'skipped'; reason: string }
  /** 已把新凭据写进 CLI */
  | { status: 'synced'; accountId: string; credentialVersion: number }
  /** CLI 里的凭据不是管理器写的那份，已放弃同步并清掉映射 */
  | { status: 'detached'; reason: string }
  /** 该账号需要重新登录（kiro-rs 刷新失败，多半是 CLI 自己刷过一次） */
  | { status: 'needs-reauth'; accountId: string }

export interface SyncKiroCliInput {
  store: KiroCliSyncStore
  /** 账号库里该账号的当前行 */
  row: AccountDbRow | null
  dbPath?: string
  /** 注入用：默认读真实 CLI 数据库 */
  readCurrent?: typeof readKiroCliCurrentToken
  write?: typeof syncRefreshedKiroCliCredentials
}

/**
 * 按账号库当前状态把凭据同步给 CLI。幂等：版本没变时什么都不做。
 */
export async function syncKiroCliFromAccountDb(
  input: SyncKiroCliInput
): Promise<KiroCliSyncOutcome> {
  const state = readKiroCliSyncState(input.store)
  if (!state) return { status: 'skipped', reason: 'CLI 未由管理器切号' }

  const row = input.row
  if (!row || row.accountUuid !== state.accountId) {
    clearKiroCliSyncState(input.store)
    return { status: 'detached', reason: 'CLI 当前账号已不在账号库中' }
  }
  // kiro-rs 刷新失败（invalid_grant）会标成 reauth_required：多半是 CLI 自己刷过一次，
  // 把库里那份 refresh token 作废了。此时同步没有意义，交给上层提示用户重新登录。
  if (row.status === 'reauth_required') {
    return { status: 'needs-reauth', accountId: state.accountId }
  }
  if (row.credentialVersion === state.credentialVersion) {
    return { status: 'skipped', reason: '凭据版本未变' }
  }
  if (!row.accessToken || !row.refreshToken) {
    return { status: 'skipped', reason: '账号库中暂无可用凭据' }
  }

  const dbPath = input.dbPath ?? resolveKiroCliDbPath()
  const readCurrent = input.readCurrent ?? readKiroCliCurrentToken
  const current = await readCurrent(dbPath)
  if (!current) {
    clearKiroCliSyncState(input.store)
    return { status: 'detached', reason: 'CLI 当前没有凭据（可能已退出登录）' }
  }
  if (hashRefreshToken(current.refreshToken) !== state.refreshTokenHash) {
    clearKiroCliSyncState(input.store)
    return { status: 'detached', reason: 'CLI 里的凭据不是管理器写入的那份，已停止自动同步' }
  }

  const write = input.write ?? syncRefreshedKiroCliCredentials
  await write(
    current.refreshToken,
    {
      accessToken: row.accessToken,
      refreshToken: row.refreshToken,
      expiresIn: row.expiresAtMs
        ? Math.max(0, Math.ceil((row.expiresAtMs - Date.now()) / 1000))
        : undefined
    },
    dbPath
  )
  writeKiroCliSyncState(input.store, {
    accountId: state.accountId,
    refreshTokenHash: hashRefreshToken(row.refreshToken),
    credentialVersion: row.credentialVersion
  })
  return {
    status: 'synced',
    accountId: state.accountId,
    credentialVersion: row.credentialVersion
  }
}

/** 确认"CLI 里的账号不在账号库"后，多久再问一次 kiro-rs（期间用户可能把它导入库） */
export const KIRO_CLI_NOT_IN_DB_RECHECK_MS = 10 * 60 * 1000

export type KiroCliAdoptOutcome =
  /** 无需处理（CLI 未登录、已一致、CLI 没自己刷新过等） */
  | { status: 'skipped'; reason: string }
  /** CLI 自己刷新得到的凭据已由 kiro-rs 收编 */
  | { status: 'adopted'; accountId: string; credentialVersion: number }
  /** CLI 与库中账号对上了，已建立同步映射（之后 kiro-rs 续期会同步给 CLI） */
  | { status: 'linked'; accountId: string }
  /** CLI 当前账号不在账号库中 */
  | { status: 'not-in-db' }
  | { status: 'failed'; error: string }

export interface AdoptKiroCliInput {
  store: KiroCliSyncStore
  /** 账号库当前的全部行 */
  rows: readonly AccountDbRow[]
  /** kiro-rs 的收编接口（已绑定连接信息） */
  adopt: (body: Parameters<typeof adoptCredential>[1]) => Promise<AdoptCredentialResult>
  /** 已确认不在库中的 CLI refresh token 哈希 → 确认时间 */
  notInDb: Map<string, number>
  dbPath?: string
  readCurrent?: typeof readKiroCliCurrentToken
  now?: () => number
}

/**
 * CLI 自己刷新过时，把它的新凭据收编进账号库，kiro-rs 不再重复刷新。幂等。
 */
export async function adoptKiroCliIntoAccountDb(
  input: AdoptKiroCliInput
): Promise<KiroCliAdoptOutcome> {
  const now = input.now ?? Date.now
  const readCurrent = input.readCurrent ?? readKiroCliCurrentToken
  const current = await readCurrent(input.dbPath ?? resolveKiroCliDbPath())
  if (!current) return { status: 'skipped', reason: 'CLI 未登录' }
  const hash = hashRefreshToken(current.refreshToken)
  const state = readKiroCliSyncState(input.store)

  // CLI 与库里某账号用的是同一份：已一致，补上映射即可
  const same = input.rows.find(
    (row) => row.refreshToken && hashRefreshToken(row.refreshToken) === hash
  )
  if (same) {
    if (state?.accountId === same.accountUuid && state.refreshTokenHash === hash) {
      return { status: 'skipped', reason: '已一致' }
    }
    writeKiroCliSyncState(input.store, {
      accountId: same.accountUuid,
      refreshTokenHash: hash,
      credentialVersion: same.credentialVersion
    })
    return { status: 'linked', accountId: same.accountUuid }
  }
  // CLI 仍是上次写进去的那份：库里更新，交给正向同步
  if (state?.refreshTokenHash === hash) return { status: 'skipped', reason: 'CLI 未自行刷新' }

  const checkedAt = input.notInDb.get(hash)
  if (checkedAt !== undefined && now() - checkedAt < KIRO_CLI_NOT_IN_DB_RECHECK_MS) {
    return { status: 'skipped', reason: '不在账号库中' }
  }
  if (!current.accessToken) return { status: 'skipped', reason: 'CLI 凭据缺少 access token' }
  const isIdc = current.key === KIRO_CLI_AUTH_KEY.OIDC_TOKEN
  if (isIdc && (!current.clientId || !current.clientSecret)) {
    return { status: 'skipped', reason: 'CLI 缺少 IdC 客户端注册，无法收编' }
  }

  let result: AdoptCredentialResult
  try {
    result = await input.adopt({
      accountUuid: state?.accountId,
      authMethod: isIdc ? 'idc' : 'social',
      accessToken: current.accessToken,
      refreshToken: current.refreshToken,
      expiresAtMs: current.expiresAtMs,
      clientId: isIdc ? current.clientId : undefined,
      clientSecret: isIdc ? current.clientSecret : undefined,
      profileArn: current.profileArn,
      region: current.region
    })
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }

  if (result.outcome === 'not_found') {
    input.notInDb.set(hash, now())
    if (state) clearKiroCliSyncState(input.store)
    return { status: 'not-in-db' }
  }
  const row = input.rows.find((item) => item.id === result.credentialId)
  if (!row)
    return { status: 'failed', error: `kiro-rs 返回的账号 #${result.credentialId} 不在库中` }
  if (result.outcome === 'stale') {
    // CLI 里这份比库里旧：记下映射，正向同步会把库里的新凭据写给 CLI
    writeKiroCliSyncState(input.store, {
      accountId: row.accountUuid,
      refreshTokenHash: hash,
      credentialVersion: -1
    })
    return { status: 'linked', accountId: row.accountUuid }
  }
  const credentialVersion = result.credentialVersion ?? row.credentialVersion
  writeKiroCliSyncState(input.store, {
    accountId: row.accountUuid,
    refreshTokenHash: hash,
    credentialVersion
  })
  return result.outcome === 'adopted'
    ? { status: 'adopted', accountId: row.accountUuid, credentialVersion }
    : { status: 'linked', accountId: row.accountUuid }
}
