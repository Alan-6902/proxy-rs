/**
 * 账号库桥：主进程里所有 `store.get/set('accountData')`（约 40 处）经这里转到账号库，
 * 不必逐个改调用点。
 *
 * - get：electron-store 里的设置 / 分组 / 标签等原样返回；`accounts` 换成
 *   「账号库投影 + 尚未入库的待导入账号」
 * - set：库里已有的账号只写 UI 字段（凭据、额度、状态以库为准，旧快照写不回去）；
 *   库里已删除的忽略（防复活）；其余视为待导入，留在 electron-store 里等 kiro-rs 接收
 * - set 从不删除库里的账号：快照可能是旧的，缺了某个账号不代表用户删了它。
 *   删除只走 deleteAccounts。
 */

import type { AccountDb, AccountDbRow } from './db'
import { toAccount, toImportRequest, toUiFields, type AccountLike } from './projection'
import {
  importAccount,
  purgeAccount,
  setProxy,
  type AdminFetch,
  type KiroRsAdminTarget
} from './adminApi'

export const ACCOUNT_DATA_KEY = 'accountData'

type AccountData = Record<string, unknown> & { accounts?: Record<string, AccountLike> }

export interface RawStore {
  get(key: string, defaultValue?: unknown): unknown
  set(key: string, value: unknown): void
}

export interface BridgeDeps {
  /** 待导入账号出现时通知（由调用方安排一次 syncPending） */
  onPending?: () => void
  /** 账号绑定的代理 URL（从 accountData 的代理池绑定解析） */
  proxyUrlFor?: (accountId: string, data: AccountData) => string | undefined
  fetchImpl?: AdminFetch
}

export interface PendingSyncResult {
  imported: string[]
  failed: Array<{ id: string; reason: string }>
}

export class AccountDataBridge {
  private cache: { seq: number; accounts: Record<string, AccountLike> } | null = null
  private syncing: Promise<PendingSyncResult> | null = null

  constructor(
    private readonly db: AccountDb,
    private readonly raw: RawStore,
    private readonly deps: BridgeDeps = {}
  ) {}

  private readBase(defaultValue?: unknown): AccountData {
    const value = this.raw.get(ACCOUNT_DATA_KEY, defaultValue)
    return value && typeof value === 'object' ? (value as AccountData) : {}
  }

  private projected(): Record<string, AccountLike> {
    const seq = this.db.anyChangeSeq()
    if (!this.cache || this.cache.seq !== seq) {
      const accounts: Record<string, AccountLike> = {}
      for (const row of this.db.listRows()) accounts[row.accountUuid] = toAccount(row)
      this.cache = { seq, accounts }
    }
    return this.cache.accounts
  }

  private liveRows(): Map<string, AccountDbRow> {
    return new Map(this.db.listRows().map((row) => [row.accountUuid, row]))
  }

  get(defaultValue?: unknown): AccountData | null {
    const base = this.readBase(defaultValue)
    const projected = this.projected()
    const pending = Object.fromEntries(
      Object.entries(base.accounts ?? {}).filter(([id]) => !(id in projected))
    )
    // 调用方可能原地修改返回值后再 set，必须给副本
    return { ...base, accounts: { ...pending, ...structuredClone(projected) } }
  }

  set(value: unknown): void {
    const data = (value && typeof value === 'object' ? value : {}) as AccountData
    const live = this.liveRows()
    const deleted = this.db.deletedUuids()
    const pending: Record<string, AccountLike> = {}
    for (const [id, account] of Object.entries(data.accounts ?? {})) {
      const row = live.get(id)
      if (row) this.db.writeUi(row.id, toUiFields(account))
      else if (!deleted.has(id)) pending[id] = account
    }
    this.raw.set(ACCOUNT_DATA_KEY, { ...data, accounts: pending })
    if (Object.keys(pending).length > 0) this.deps.onPending?.()
  }

  /** 单个账号的库投影（不存在或未入库返回 undefined） */
  projectedAccount(accountId: string): AccountLike | undefined {
    const account = this.projected()[accountId]
    return account ? structuredClone(account) : undefined
  }

  pendingIds(): string[] {
    return Object.keys(this.readBase().accounts ?? {})
  }

  private removePending(ids: readonly string[]): void {
    if (ids.length === 0) return
    const base = this.readBase()
    const accounts = { ...(base.accounts ?? {}) }
    for (const id of ids) delete accounts[id]
    this.raw.set(ACCOUNT_DATA_KEY, { ...base, accounts })
  }

  /** 把待导入账号交给 kiro-rs。同一时间只跑一轮，重复调用复用进行中的那一轮。 */
  syncPending(target: KiroRsAdminTarget): Promise<PendingSyncResult> {
    if (!this.syncing) {
      this.syncing = this.runSyncPending(target).finally(() => {
        this.syncing = null
      })
    }
    return this.syncing
  }

  private async runSyncPending(target: KiroRsAdminTarget): Promise<PendingSyncResult> {
    const result: PendingSyncResult = { imported: [], failed: [] }
    const base = this.readBase()
    for (const [id, account] of Object.entries(base.accounts ?? {})) {
      const request = toImportRequest({ ...account, id }, this.deps.proxyUrlFor?.(id, base))
      if (!request.ok) {
        result.failed.push({ id, reason: request.reason })
        continue
      }
      try {
        await importAccount(target, request.body, this.deps.fetchImpl)
        // 命中已有账号（created=false）同样移出待导入：库里那一行接管
        this.removePending([id])
        result.imported.push(id)
      } catch (error) {
        result.failed.push({ id, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    return result
  }

  /** 删除账号：库里的经 kiro-rs 删除，待导入的直接丢弃。返回失败条目。 */
  async deleteAccounts(
    ids: readonly string[],
    target: KiroRsAdminTarget | null
  ): Promise<Array<{ id: string; reason: string }>> {
    const failed: Array<{ id: string; reason: string }> = []
    const live = this.liveRows()
    const pendingIds = new Set(this.pendingIds())
    for (const id of ids) {
      const row = live.get(id)
      if (row) {
        if (!target) {
          failed.push({ id, reason: 'kiro-rs 未运行，无法删除账号库中的账号' })
          continue
        }
        try {
          await purgeAccount(target, row.id, this.deps.fetchImpl)
        } catch (error) {
          failed.push({ id, reason: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    this.removePending(ids.filter((id) => pendingIds.has(id)))
    return failed
  }

  /**
   * 账号绑定的代理同步给 kiro-rs（它负责刷新，必须走同一出口）。
   * 只在 proxy 侧有绑定且与库中不同时下发；没有绑定时不清除库里的代理
   * （迁移自 credentials.json 的账号可能本来就配了代理）。
   */
  async syncProxyBindings(target: KiroRsAdminTarget): Promise<number> {
    if (!this.deps.proxyUrlFor) return 0
    const base = this.readBase()
    let updated = 0
    for (const row of this.db.listRows()) {
      const desired = this.deps.proxyUrlFor(row.accountUuid, base)
      if (desired && desired !== row.proxyUrl) {
        await setProxy(target, row.id, desired, this.deps.fetchImpl)
        updated++
      }
    }
    return updated
  }
}

/**
 * 包一层 electron-store：只拦截 accountData 的 get/set，其余方法与属性原样透传。
 */
export function wrapStoreWithBridge<T extends object>(store: T, bridge: AccountDataBridge): T {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'get') {
        return (key: string, defaultValue?: unknown) =>
          key === ACCOUNT_DATA_KEY
            ? bridge.get(defaultValue)
            : (target as unknown as RawStore).get(key, defaultValue)
      }
      if (prop === 'set') {
        return (key: string | Record<string, unknown>, value?: unknown) => {
          if (typeof key === 'object' && key !== null) {
            const { [ACCOUNT_DATA_KEY]: accountData, ...rest } = key
            if (accountData !== undefined) bridge.set(accountData)
            if (Object.keys(rest).length > 0)
              (target as unknown as { set(v: object): void }).set(rest)
            return
          }
          if (key === ACCOUNT_DATA_KEY) bridge.set(value)
          else (target as unknown as RawStore).set(key, value)
        }
      }
      // this 用原对象：electron-store 的 getter 依赖私有字段，经 Proxy 访问会抛 TypeError
      const member = Reflect.get(target, prop, target)
      return typeof member === 'function' ? member.bind(target) : member
    }
  })
}
