/**
 * 「已交给本机反代托管」的账号登记表。
 *
 * 为什么不放进账号库（accountData）：那份数据由渲染进程整快照写回
 * （`kiroCredentialRefresh.ts` 的 `mergeAccountDataPreservingRotatedKiroCredentials`
 * 就是为这个风险打的补丁）。主进程写进去的字段会被渲染进程下一次保存覆盖，
 * 标记一丢就静默恢复本地刷新、重新烧号。独立 store 由主进程单写者持有，不存在
 * 覆盖问题，回收逻辑也集中在一处。
 *
 * 为什么可以明文落盘：条目里只有本地账号 id、反代凭据 id，以及**反代自己返回的
 * 哈希**（本身即哈希，不是凭据），不构成泄露。与 `kskHunter/ledgerStore.ts` 同一取舍。
 */

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  normalizeAdminManagedPayload,
  reconcileAdminManagedEntries,
  type AdminManagedAccountEntry,
  type AdminManagedReconcileDrop,
  type AdminManagedRemoteCredential
} from '../../shared/adminManaged'

const STORE_FILE = 'ksk-admin-managed.json'

interface PersistedRegistry {
  version: 1
  entries: AdminManagedAccountEntry[]
}

let mutationQueue: Promise<void> = Promise.resolve()

export function adminManagedStorePath(): string {
  return join(app.getPath('userData'), STORE_FILE)
}

/**
 * 读登记表。
 *
 * 缺文件或内容损坏都按空表处理：读不出来时宁可退回「全部照常刷新」（fail-open），
 * 也不能反过来把账号集体停刷——后者会让未托管账号的 token 过期、服务全线不可用。
 */
export async function loadAdminManagedEntries(): Promise<AdminManagedAccountEntry[]> {
  try {
    return normalizeAdminManagedPayload(
      JSON.parse(await fs.readFile(adminManagedStorePath(), 'utf-8'))
    )
  } catch {
    return []
  }
}

async function writeRegistry(entries: AdminManagedAccountEntry[]): Promise<void> {
  const path = adminManagedStorePath()
  await fs.mkdir(dirname(path), { recursive: true })
  const payload: PersistedRegistry = { version: 1, entries }
  await fs.writeFile(path, JSON.stringify(payload), { mode: 0o600 })
}

/** 写操作串行化：推送登记、回收器核对、删除回收可能并发改这份文件。 */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  let resolveResult: (value: T) => void
  let rejectResult: (reason?: unknown) => void
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  mutationQueue = mutationQueue
    .then(async () => {
      resolveResult(await task())
    })
    .catch((error) => {
      rejectResult(error)
    })
  return result
}

/** 读改写一次登记表；每次都从磁盘重读，避免多链路各持一份内存副本互相覆盖。 */
export async function mutateAdminManagedEntries<T>(
  mutate: (entries: AdminManagedAccountEntry[]) => {
    entries: AdminManagedAccountEntry[]
    result: T
    dirty?: boolean
  }
): Promise<T> {
  return enqueue(async () => {
    const current = await loadAdminManagedEntries()
    const { entries, result, dirty } = mutate(current)
    if (dirty !== false) await writeRegistry(entries)
    return result
  })
}

/**
 * 登记一个账号已托管。
 *
 * 同一 accountId 重复登记时整体覆盖：重新推送会拿到新的 credentialId 与哈希，
 * 旧的那份已经不代表现状了。
 */
export async function recordAdminManagedAccount(entry: AdminManagedAccountEntry): Promise<void> {
  return mutateAdminManagedEntries((entries) => {
    const next = entries.filter((item) => item.accountId !== entry.accountId)
    next.push(entry)
    return { entries: next, result: undefined }
  })
}

/** 按本地账号 id 注销托管（本地账号被删除时用）。不在表上时静默忽略。 */
export async function forgetAdminManagedAccount(accountId: string): Promise<void> {
  return mutateAdminManagedEntries((entries) => {
    const next = entries.filter((item) => item.accountId !== accountId)
    if (next.length === entries.length) return { entries, result: undefined, dirty: false }
    return { entries: next, result: undefined }
  })
}

/** 按反代凭据 id 注销托管（反代那边凭据被删时用）。 */
export async function forgetAdminManagedByCredentialId(credentialId: string): Promise<void> {
  return mutateAdminManagedEntries((entries) => {
    const next = entries.filter((item) => item.credentialId !== credentialId)
    if (next.length === entries.length) return { entries, result: undefined, dirty: false }
    return { entries: next, result: undefined }
  })
}

/**
 * 按反代当前凭据列表核对登记表，丢弃已失效的条目。
 *
 * 返回被丢弃的条目，由调用方决定怎么提示用户（这些账号已恢复本地刷新）。
 */
export async function applyAdminManagedReconcile(
  remote: readonly AdminManagedRemoteCredential[],
  now: number = Date.now()
): Promise<{ dropped: AdminManagedReconcileDrop[] }> {
  return mutateAdminManagedEntries((entries) => {
    if (entries.length === 0) return { entries, result: { dropped: [] }, dirty: false }
    const { kept, dropped } = reconcileAdminManagedEntries(entries, remote, now)
    // kept 里的 lastSeenRemoteAt 会被刷新，所以即便没有丢弃也要落盘
    return { entries: kept, result: { dropped } }
  })
}
