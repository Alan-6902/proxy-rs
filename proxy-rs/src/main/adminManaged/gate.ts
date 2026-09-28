/**
 * 托管判定的热路径闸门，也是本模块对外的统一入口。
 *
 * 刷新调度是高频路径（主进程 60 秒一轮、每轮遍历全部账号），所以判定必须同步
 * 且 O(1)：登记表在内存里维护成一个 Set，落盘变更后重建。
 *
 * 依赖方向：gate 单向依赖 registryStore。反查「明文 refreshToken → accountId」
 * 需要账号库，而账号库在 main/index.ts，直接 import 会形成循环，所以改成由主进程
 * 启动时注入 resolver。
 */

import {
  ADMIN_MANAGED_REFRESH_SUPPRESSED,
  shouldSuppressKiroRefresh,
  type AdminManagedAccountEntry,
  type AdminManagedReconcileDrop,
  type AdminManagedRemoteCredential
} from '../../shared/adminManaged'
import {
  applyAdminManagedReconcile,
  forgetAdminManagedAccount,
  forgetAdminManagedByCredentialId,
  loadAdminManagedEntries,
  recordAdminManagedAccount
} from './registryStore'

/**
 * 命中此错误码表示「刷新被托管闸门拦下」，调用方据此区分「失败」与「无需刷新」。
 *
 * 定义在 shared，渲染进程也要用它判断该不该把卡片标红。
 */
export { ADMIN_MANAGED_REFRESH_SUPPRESSED }

type RefreshTokenResolver = (refreshToken: string) => Promise<string | undefined>

let managedIds: ReadonlySet<string> = new Set()
let managedById: ReadonlyMap<string, AdminManagedAccountEntry> = new Map()
let resolveAccountIdByRefreshToken: RefreshTokenResolver | undefined

/**
 * 注入「明文 refreshToken → accountId」的反查实现。
 *
 * 只给拿不到 accountId 的调用方用（推送探针、导入前验活）。反查要读账号库，
 * 代价不低，不要放进定时刷新那种高频路径。
 */
export function setAdminManagedRefreshTokenResolver(resolver: RefreshTokenResolver): void {
  resolveAccountIdByRefreshToken = resolver
}

/** 从磁盘重建内存索引。启动时、以及每次登记表变更后调用。 */
export async function reloadAdminManagedIds(): Promise<ReadonlySet<string>> {
  const entries = await loadAdminManagedEntries()
  managedById = new Map(entries.map((entry) => [entry.accountId, entry]))
  managedIds = new Set(managedById.keys())
  return managedIds
}

/** 取该账号的托管登记（含反代凭据 id）。未托管时返回 undefined。 */
export function adminManagedEntry(accountId?: string): AdminManagedAccountEntry | undefined {
  return accountId ? managedById.get(accountId) : undefined
}

/** 内存索引快照，供调试与 UI 计数使用。 */
export function adminManagedIdsSnapshot(): ReadonlySet<string> {
  return managedIds
}

/**
 * 该账号的本地刷新是否应被抑制。同步、O(1)，热路径可放心调用。
 *
 * 白名单语义：只有明确登记过托管的账号才返回 true。registry 尚未加载、条目损坏
 * 或 accountId 缺失时一律 false —— fail-open。反过来（fail-closed）会让未托管
 * 账号集体停刷、token 过期、服务不可用，代价大得多。
 */
export function isAdminManagedAccount(accountId?: string): boolean {
  return shouldSuppressKiroRefresh(managedIds, accountId)
}

/**
 * 只拿到 refreshToken 的调用方用它判断托管关系。
 *
 * resolver 未注入或反查抛错时返回 false（同样 fail-open）。
 */
export async function isAdminManagedRefreshToken(refreshToken: string): Promise<boolean> {
  const trimmed = refreshToken.trim()
  if (!trimmed || !resolveAccountIdByRefreshToken) return false
  try {
    const accountId = await resolveAccountIdByRefreshToken(trimmed)
    return isAdminManagedAccount(accountId)
  } catch {
    return false
  }
}

/** 登记一个账号已托管，并立即刷新内存索引。 */
export async function recordManagedAccount(entry: AdminManagedAccountEntry): Promise<void> {
  await recordAdminManagedAccount(entry)
  await reloadAdminManagedIds()
}

/** 本地账号被删除时注销托管。 */
export async function forgetManagedAccount(accountId: string): Promise<void> {
  await forgetAdminManagedAccount(accountId)
  await reloadAdminManagedIds()
}

/** 反代凭据被删除时注销托管。 */
export async function forgetManagedByCredentialId(credentialId: string): Promise<void> {
  await forgetAdminManagedByCredentialId(credentialId)
  await reloadAdminManagedIds()
}

/**
 * 按反代当前凭据列表核对，丢弃已失效的登记并刷新内存索引。
 *
 * 返回被丢弃的条目，调用方据此提示用户「这些账号已不在反代，已恢复本地刷新」。
 */
export async function reconcileManagedAccounts(
  remote: readonly AdminManagedRemoteCredential[],
  now?: number
): Promise<{ dropped: AdminManagedReconcileDrop[] }> {
  const result = await applyAdminManagedReconcile(remote, now)
  if (result.dropped.length > 0) await reloadAdminManagedIds()
  return result
}
