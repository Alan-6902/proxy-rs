/**
 * 抢号台账的持久化。
 *
 * 为什么独立于 ksk-hunter.enc：那份加密 store 里 deliveries 只留 200 条、spend 只留
 * 14 天，都会被裁掉，撑不起「这个号一生花了多少钱、产出多少」的长期账。
 *
 * 为什么可以明文落盘：台账里没有 ksk 明文，只有 `sha256(明文)` 与脱敏 key
 * （见 `KskLedgerEntry` 的说明）。哈希不可逆，脱敏 key 只剩首尾，都不构成凭据泄露。
 * 明文 JSON 反而让用户能直接拿去做别的分析。
 *
 * 为什么不复用 ksk-hunter-report.jsonl：那是只追加的事件流，而台账条目要被反复更新
 * （每轮采样都改累计值），追加式文件重放一年的更新代价太大。
 */

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  KSK_LEDGER_MAX_ENTRIES,
  KSK_LEDGER_RETIRE_REASON,
  applyLedgerObservation,
  toLedgerObservations,
  type KskLedgerCursor,
  type KskLedgerEntry,
  type KskLedgerRetireReason
} from '../../shared/kskLedger'
import { KSK_HUNTER_CHANNEL, type KskHunterChannel } from '../../shared/kskHunter'
import type { LocalAdminCredentialStats } from '../../shared/localAdminStats'

const STORE_FILE = 'ksk-hunter-ledger.json'

interface PersistedLedger {
  version: 1
  entries: KskLedgerEntry[]
}

let mutationQueue: Promise<void> = Promise.resolve()

export function kskLedgerStorePath(): string {
  return join(app.getPath('userData'), STORE_FILE)
}

function readOptionalNumber(value: unknown): number | undefined {
  const numberValue = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numberValue) ? numberValue : undefined
}

/** 累计量不允许负数：负的产出没有意义，读到就按 0 处理。 */
function readCount(value: unknown): number {
  const numberValue = readOptionalNumber(value)
  return numberValue !== undefined && numberValue > 0 ? numberValue : 0
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readOptionalString(value: unknown): string | undefined {
  return readString(value) || undefined
}

function readChannel(value: unknown): KskHunterChannel {
  const channels = Object.values(KSK_HUNTER_CHANNEL) as string[]
  const text = readString(value)
  // 认不出就回落到第一个渠道：整条记录里成本与产出仍然有效，不值得为渠道字段丢掉
  return channels.includes(text) ? (text as KskHunterChannel) : KSK_HUNTER_CHANNEL.KIRO_MARKET
}

function readRetireReason(value: unknown): KskLedgerRetireReason | undefined {
  const reasons = Object.values(KSK_LEDGER_RETIRE_REASON) as string[]
  const text = readString(value)
  return reasons.includes(text) ? (text as KskLedgerRetireReason) : undefined
}

function readCursor(value: unknown): KskLedgerCursor | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const at = readOptionalNumber(source.at)
  if (at === undefined || at <= 0) return undefined
  return {
    usedCredits: readOptionalNumber(source.usedCredits),
    inputTokens: readOptionalNumber(source.inputTokens),
    outputTokens: readOptionalNumber(source.outputTokens),
    successCount: readOptionalNumber(source.successCount),
    failureCount: readOptionalNumber(source.failureCount),
    at: Math.floor(at)
  }
}

/** 纯函数便于测试：keyHash 或 purchasedAt 缺失的条目直接丢，它们没法参与任何聚合。 */
export function normalizeKskLedgerEntry(value: unknown): KskLedgerEntry | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const keyHash = readString(source.keyHash)
  const purchasedAt = readOptionalNumber(source.purchasedAt)
  if (!keyHash || purchasedAt === undefined || purchasedAt <= 0) return null
  return {
    keyHash,
    maskedKey: readString(source.maskedKey) || 'ksk_...',
    region: readString(source.region),
    channel: readChannel(source.channel),
    linkId: readString(source.linkId),
    linkName: readString(source.linkName) || '未命名链接',
    purchasedAt: Math.floor(purchasedAt),
    costUnit: readOptionalNumber(source.costUnit),
    costCny: readOptionalNumber(source.costCny),
    unitLabel: readOptionalString(source.unitLabel),
    firstSeenAt: readOptionalNumber(source.firstSeenAt),
    lastSeenAt: readOptionalNumber(source.lastSeenAt),
    retiredAt: readOptionalNumber(source.retiredAt),
    retireReason: readRetireReason(source.retireReason),
    credentialId: readOptionalString(source.credentialId),
    usedCredits: readCount(source.usedCredits),
    inputTokens: readCount(source.inputTokens),
    outputTokens: readCount(source.outputTokens),
    successCount: readCount(source.successCount),
    failureCount: readCount(source.failureCount),
    cursor: readCursor(source.cursor)
  }
}

/**
 * 清洗整份台账：丢掉坏条目、按 keyHash 去重、按采购时间排序、裁到上限。
 *
 * 同一 keyHash 出现两次时保留采购更晚的那条：同一个号被重复买到时（幂等键失效、
 * 或者同一个号在不同站点上架）后一次的记录更接近当前状态。
 */
export function normalizeKskLedgerPayload(payload: unknown): KskLedgerEntry[] {
  const source =
    payload && typeof payload === 'object'
      ? (payload as Partial<PersistedLedger>).entries
      : undefined
  if (!Array.isArray(source)) return []
  const byHash = new Map<string, KskLedgerEntry>()
  for (const item of source) {
    const entry = normalizeKskLedgerEntry(item)
    if (!entry) continue
    const existing = byHash.get(entry.keyHash)
    if (existing && existing.purchasedAt >= entry.purchasedAt) continue
    byHash.set(entry.keyHash, entry)
  }
  return [...byHash.values()]
    .sort((a, b) => a.purchasedAt - b.purchasedAt)
    .slice(-KSK_LEDGER_MAX_ENTRIES)
}

export async function loadKskLedger(): Promise<KskLedgerEntry[]> {
  try {
    return normalizeKskLedgerPayload(JSON.parse(await fs.readFile(kskLedgerStorePath(), 'utf-8')))
  } catch {
    // 缺文件或内容损坏都按空台账处理：这是观测数据，不该阻塞抢号与统计
    return []
  }
}

async function writeLedger(entries: KskLedgerEntry[]): Promise<void> {
  const path = kskLedgerStorePath()
  await fs.mkdir(dirname(path), { recursive: true })
  const payload: PersistedLedger = { version: 1, entries }
  await fs.writeFile(path, JSON.stringify(payload), { mode: 0o600 })
}

/** 写操作串行化：抢号下单（3 秒一轮）与统计采样（60 秒一轮）会并发改这份文件。 */
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

/**
 * 读改写一次台账。
 *
 * 每次都从磁盘重读而不是缓存在内存里：抢号记账与统计采样是两条独立链路，
 * 各自持一份内存副本必然互相覆盖。文件只有几百 KB，重读的代价可以忽略。
 */
export async function mutateKskLedger<T>(
  mutate: (entries: KskLedgerEntry[]) => { entries: KskLedgerEntry[]; result: T; dirty?: boolean }
): Promise<T> {
  return enqueue(async () => {
    const current = await loadKskLedger()
    const { entries, result, dirty } = mutate(current)
    if (dirty !== false) await writeLedger(entries.slice(-KSK_LEDGER_MAX_ENTRIES))
    return result
  })
}

/**
 * 记一笔采购。
 *
 * 同一 keyHash 已在账上时覆盖采购信息、保留已攒的产出：同一个号被重复买到
 * （站点重复上架）时，产出是这个号的，不该因为重新记账被清零。
 */
export async function recordKskLedgerPurchase(entry: KskLedgerEntry): Promise<void> {
  return mutateKskLedger((entries) => {
    const index = entries.findIndex((item) => item.keyHash === entry.keyHash)
    if (index < 0) return { entries: [...entries, entry], result: undefined }
    const previous = entries[index]
    const next = [...entries]
    next[index] = {
      ...entry,
      usedCredits: previous.usedCredits,
      inputTokens: previous.inputTokens,
      outputTokens: previous.outputTokens,
      successCount: previous.successCount,
      failureCount: previous.failureCount,
      firstSeenAt: previous.firstSeenAt,
      lastSeenAt: previous.lastSeenAt,
      cursor: previous.cursor
    }
    return { entries: next, result: undefined }
  })
}

/** 标记一个号下线（验活判死、额度耗尽被清理）。不在账上的哈希静默忽略。 */
export async function markKskLedgerRetired(input: {
  keyHash: string
  at: number
  reason: KskLedgerRetireReason
}): Promise<void> {
  return mutateKskLedger((entries) => {
    const index = entries.findIndex((item) => item.keyHash === input.keyHash)
    if (index < 0) return { entries, result: undefined, dirty: false }
    const next = [...entries]
    next[index] = { ...next[index], retiredAt: input.at, retireReason: input.reason }
    return { entries: next, result: undefined }
  })
}

/**
 * 把一轮反代观测并入台账。供 LocalAdminStatsManager 每轮采样后调用。
 *
 * `canRetire` 传 true：调用方只在采集成功后才调这里，凭据列表是可信的完整快照，
 * 缺席就代表号真的不在池里了。
 */
export async function updateKskLedgerFromCredentials(input: {
  credentials: readonly LocalAdminCredentialStats[]
  at: number
}): Promise<void> {
  const observations = toLedgerObservations(input.credentials)
  return mutateKskLedger((entries) => {
    // 台账为空时（还没抢到过号）直接跳过，省掉一次无意义的写盘
    if (entries.length === 0) return { entries, result: undefined, dirty: false }
    const applied = applyLedgerObservation({
      entries,
      observations,
      at: input.at,
      canRetire: true
    })
    return { entries: applied.entries, result: undefined, dirty: applied.changed }
  })
}

/** 清空台账。历史无法恢复，由调用方做二次确认。 */
export async function clearKskLedger(): Promise<void> {
  return enqueue(() => writeLedger([]))
}
