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
let managedIdsListener: ((ids: readonly string[]) => void) | undefined

/**
 * 注册托管集合的变更通知，由主进程用来把最新集合推给渲染进程。
 *
 * 做成回调而不是在 gate 里直接发 IPC：gate 是纯逻辑层，不该知道窗口的存在。
 */
export function setAdminManagedChangeListener(
  listener: (ids: readonly string[]) => void
): void {
  managedIdsListener = listener
}

/**
 * 注入「明文 refreshToken → accountId」的反查实现。
 *
 * 只给拿不到 accountId 的调用方用（推送探针、导入前验活）。反查要读账号库，
 * 代价不低，不要放进定时刷新那种高频路径。
 */
export function setAdminManagedRefreshTokenResolver(resolver: RefreshTokenResolver): void {
  resolveAccountIdByRefreshToken = resolver
}

/**
 * 账号库模式下的托管来源：库里的每个账号都由 kiro-rs 刷新，proxy 一律不本地刷新
 * （改造方案 §0.2 D3）。设置后登记表文件不再读写。
 */
let managedSource: (() => AdminManagedAccountEntry[]) | undefined

export function setAdminManagedSource(source: () => AdminManagedAccountEntry[]): void {
  managedSource = source
}

/** 从磁盘（或账号库）重建内存索引。启动时、以及每次登记表变更后调用。 */
export async function reloadAdminManagedIds(): Promise<ReadonlySet<string>> {
  const entries = managedSource ? managedSource() : await loadAdminManagedEntries()
  managedById = new Map(entries.map((entry) => [entry.accountId, entry]))
  managedIds = new Set(managedById.keys())
  managedIdsListener?.([...managedIds])
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
export function isAdminManagedSourceActive(): boolean {
  return managedSource !== undefined
}

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
  if (!managedSource) await recordAdminManagedAccount(entry)
  await reloadAdminManagedIds()
}

/** 本地账号被删除时注销托管。 */
export async function forgetManagedAccount(accountId: string): Promise<void> {
  if (!managedSource) await forgetAdminManagedAccount(accountId)
  await reloadAdminManagedIds()
}

/** 反代凭据被删除时注销托管。 */
export async function forgetManagedByCredentialId(credentialId: string): Promise<void> {
  if (!managedSource) await forgetAdminManagedByCredentialId(credentialId)
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
  // 账号库模式：托管关系就是库本身，没有需要回收的登记
  if (managedSource) return { dropped: [] }
  const result = await applyAdminManagedReconcile(remote, now)
  if (result.dropped.length > 0) await reloadAdminManagedIds()
  return result
}
