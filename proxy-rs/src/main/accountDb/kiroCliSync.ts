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
 */

import { createHash } from 'node:crypto'
import {
  readKiroCliCurrentToken,
  resolveKiroCliDbPath,
  syncRefreshedKiroCliCredentials
} from '../kiroCli/cliCredentials'
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
