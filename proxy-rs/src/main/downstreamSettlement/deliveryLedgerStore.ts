/**
 * 交付账本的持久化。
 *
 * **必须加密**：账本里有完整 KSK 明文。这是它与另外两份观测数据最大的不同——
 * 抢号报表事件流（`ksk-hunter-report.jsonl`）与抢号台账（`ksk-hunter-ledger.json`）
 * 都只有脱敏 key，可以明文落盘；这里存了明文 key，明文落盘等于把已交付的号
 * 裸放在磁盘上。所以走 safeStorage，与 `kskHunter/configStore` 同一套路。
 *
 * 为什么不塞进 `ksk-hunter.enc`：那份 store 的 `deliveries` 是**运行态推送队列**，
 * 只留最近 200 条（`MAX_DELIVERY_RECORDS`）且会被裁掉。对账要的是永久存档，
 * 两者的保留策略互相冲突，混在一起必然有一方被牺牲。
 *
 * 只追加、不裁剪：交付记录是收款依据，裁掉就等于账目缺一块。一条约 400 字节，
 * 一年抢一万个号也就 4MB。
 */

import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  pruneDownstreamSettlements,
  type DownstreamCreditDelta,
  type DownstreamDaySettlement,
  type DownstreamDelivery
} from '../../shared/downstreamSettlement'
import { KSK_HUNTER_CHANNEL, type KskHunterChannel } from '../../shared/kskHunter'
import { isValidKiroApiKey, maskKiroApiKey } from '../../shared/kiroApiKey'

const STORE_FILE = 'ksk-delivery-ledger.enc'

interface PersistedDeliveryLedger {
  version: 1
  deliveries: DownstreamDelivery[]
  settlements: DownstreamDaySettlement[]
  /** 最后一次成功结算的本地日期键，用来跳过已结算的天。 */
  lastSettledDate?: string
}

export interface DeliveryLedgerState {
  deliveries: DownstreamDelivery[]
  settlements: DownstreamDaySettlement[]
  lastSettledDate?: string
}

let mutationQueue: Promise<void> = Promise.resolve()

export function deliveryLedgerStorePath(): string {
  return join(app.getPath('userData'), STORE_FILE)
}

export function isDeliveryLedgerAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readOptionalString(value: unknown): string | undefined {
  return readString(value) || undefined
}

function readOptionalNumber(value: unknown): number | undefined {
  const numberValue = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numberValue) ? numberValue : undefined
}

/** 累计量不允许负数：负的消耗没有意义，读到按 0 处理。 */
function readCount(value: unknown): number {
  const numberValue = readOptionalNumber(value)
  return numberValue !== undefined && numberValue > 0 ? numberValue : 0
}

function readChannel(value: unknown): KskHunterChannel {
  const channels = Object.values(KSK_HUNTER_CHANNEL) as string[]
  const text = readString(value)
  // 认不出就回落到第一个渠道：整条记录的 key、时刻与成本仍然有效，
  // 不值得为一个展示字段丢掉一笔账
  return channels.includes(text) ? (text as KskHunterChannel) : KSK_HUNTER_CHANNEL.KIRO_MARKET
}

/**
 * 纯函数便于测试：id、key、交付时刻缺一不可。
 *
 * key 还要过格式校验——这份文件的全部价值就在于「能拿去跟下游对」，
 * 一个格式都不对的 key 对不了任何账，留着只会让人以为交付过。
 */
export function normalizeDownstreamDelivery(value: unknown): DownstreamDelivery | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const id = readString(source.id)
  const key = readString(source.key)
  const deliveredAt = readOptionalNumber(source.deliveredAt)
  if (!id || !isValidKiroApiKey(key) || deliveredAt === undefined || deliveredAt <= 0) return null
  const purchasedAt = readOptionalNumber(source.purchasedAt)
  return {
    id,
    accountId: readOptionalString(source.accountId),
    key,
    // 脱敏值可以从明文重算，不信文件里存的那份（可能被外部改坏）
    maskedKey: maskKiroApiKey(key),
    region: readString(source.region),
    channel: readChannel(source.channel),
    linkId: readString(source.linkId),
    linkName: readString(source.linkName) || '未命名链接',
    groupId: readOptionalString(source.groupId),
    purchasedAt: purchasedAt !== undefined && purchasedAt > 0 ? purchasedAt : deliveredAt,
    deliveredAt: Math.floor(deliveredAt),
    attempts: readCount(source.attempts) || 1,
    costUnit: readOptionalNumber(source.costUnit),
    costCny: readOptionalNumber(source.costCny),
    unitLabel: readOptionalString(source.unitLabel),
    settledCredits: readOptionalNumber(source.settledCredits),
    settledAt: readOptionalNumber(source.settledAt)
  }
}

function normalizeCreditDelta(value: unknown): DownstreamCreditDelta | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const accountId = readString(source.accountId)
  if (!accountId) return null
  return {
    accountId,
    creditsDelta: readCount(source.creditsDelta),
    fromAt: readCount(source.fromAt),
    toAt: readCount(source.toAt)
  }
}

/** 结算记录归一化。日期键格式不对的直接丢：它是这条记录的主键。 */
export function normalizeDownstreamSettlement(value: unknown): DownstreamDaySettlement | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const date = readString(source.date)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const perAccount = Array.isArray(source.perAccount)
    ? source.perAccount
        .map(normalizeCreditDelta)
        .filter((item): item is DownstreamCreditDelta => item !== null)
    : []
  return {
    date,
    settledAt: readCount(source.settledAt),
    deliveries: readCount(source.deliveries),
    spendCny: readCount(source.spendCny),
    credits: readCount(source.credits),
    perAccount
  }
}

/**
 * 清洗整份账本：丢坏记录、按 id 去重、按交付时刻排序。
 *
 * 同一 id 重复时保留交付更晚的：id 本该唯一（复用推送记录 id），重复只出现在
 * 文件被外部改坏的情况，取更晚的更接近当前状态。
 */
export function normalizeDeliveryLedgerPayload(payload: unknown): DeliveryLedgerState {
  const source = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const rawDeliveries = Array.isArray(source.deliveries) ? source.deliveries : []
  const byId = new Map<string, DownstreamDelivery>()
  for (const item of rawDeliveries) {
    const delivery = normalizeDownstreamDelivery(item)
    if (!delivery) continue
    const existing = byId.get(delivery.id)
    if (existing && existing.deliveredAt >= delivery.deliveredAt) continue
    byId.set(delivery.id, delivery)
  }

  const rawSettlements = Array.isArray(source.settlements) ? source.settlements : []
  const settlementByDate = new Map<string, DownstreamDaySettlement>()
  for (const item of rawSettlements) {
    const settlement = normalizeDownstreamSettlement(item)
    if (settlement) settlementByDate.set(settlement.date, settlement)
  }

  return {
    deliveries: [...byId.values()].sort((a, b) => a.deliveredAt - b.deliveredAt),
    settlements: [...settlementByDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    lastSettledDate: readOptionalString(source.lastSettledDate)
  }
}

function emptyState(): DeliveryLedgerState {
  return { deliveries: [], settlements: [] }
}

/**
 * 读整份账本。
 *
 * 解密失败**抛错**而不是返回空——与 `loadKskHunterStore` 同一判断：空账本会被
 * 下一次写入覆盖掉原文件，而这里存的是收款依据，宁可让调用方看到错误。
 * 缺文件（还没交付过）是正常状态，返回空。
 */
export async function loadDeliveryLedger(): Promise<DeliveryLedgerState> {
  if (!isDeliveryLedgerAvailable()) return emptyState()
  try {
    const encrypted = await fs.readFile(deliveryLedgerStorePath())
    return normalizeDeliveryLedgerPayload(JSON.parse(safeStorage.decryptString(encrypted)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
    throw new Error('交付账本无法解密或已损坏，已拒绝用空账本覆盖原文件')
  }
}

async function writeLedger(state: DeliveryLedgerState): Promise<void> {
  if (!isDeliveryLedgerAvailable()) {
    throw new Error('系统加密存储不可用，拒绝明文保存已交付的 KSK')
  }
  const path = deliveryLedgerStorePath()
  await fs.mkdir(dirname(path), { recursive: true })
  const payload: PersistedDeliveryLedger = {
    version: 1,
    deliveries: state.deliveries,
    settlements: state.settlements,
    lastSettledDate: state.lastSettledDate
  }
  await fs.writeFile(path, safeStorage.encryptString(JSON.stringify(payload)), { mode: 0o600 })
}

/** 写操作串行化：抢号交付（可能并发多条）与结算 tick 会同时改这份文件。 */
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
 * 读改写一次账本。
 *
 * 每次从磁盘重读而不是缓存在内存：交付记账与结算是两条独立链路，
 * 各持一份内存副本必然互相覆盖。文件只有几 MB，重读代价可忽略。
 */
export async function mutateDeliveryLedger<T>(
  mutate: (state: DeliveryLedgerState) => { state: DeliveryLedgerState; result: T; dirty?: boolean }
): Promise<T> {
  return enqueue(async () => {
    const current = await loadDeliveryLedger()
    const { state, result, dirty } = mutate(current)
    if (dirty !== false) await writeLedger(state)
    return result
  })
}

/**
 * 记一条交付。
 *
 * 按 id 幂等：推送重试可能让同一条记录触发两次记账（比如落库成功但响应丢了，
 * 下游按 key 幂等回了 ok，抢号器这边看成新的一次成功）。已在账上就什么都不做，
 * 不覆盖——首次那条的 `deliveredAt` 才是真正的交付时刻。
 */
export async function recordDownstreamDelivery(delivery: DownstreamDelivery): Promise<void> {
  return mutateDeliveryLedger((state) => {
    if (state.deliveries.some((item) => item.id === delivery.id)) {
      return { state, result: undefined, dirty: false }
    }
    return {
      state: { ...state, deliveries: [...state.deliveries, delivery] },
      result: undefined
    }
  })
}

/**
 * 给一条交付补上账号 id。
 *
 * 交付发生在验活入库之后，正常下单流程里 accountId 已经有了；这个入口是给
 * 「重复号没建账号档、后来又补上」这类补录用的。不在账上的 id 静默忽略。
 */
export async function attachDownstreamAccountId(input: {
  deliveryId: string
  accountId: string
}): Promise<void> {
  return mutateDeliveryLedger((state) => {
    const index = state.deliveries.findIndex((item) => item.id === input.deliveryId)
    if (index < 0 || state.deliveries[index].accountId === input.accountId) {
      return { state, result: undefined, dirty: false }
    }
    const deliveries = [...state.deliveries]
    deliveries[index] = { ...deliveries[index], accountId: input.accountId }
    return { state: { ...state, deliveries }, result: undefined }
  })
}

/** 落一次日结算：写定稿记录、推进锚点、裁掉过期结算。 */
export async function commitDownstreamSettlement(input: {
  date: string
  settlement: DownstreamDaySettlement
  deliveries: readonly DownstreamDelivery[]
  now: number
}): Promise<void> {
  return mutateDeliveryLedger((state) => {
    const settlements = pruneDownstreamSettlements(
      [...state.settlements.filter((item) => item.date !== input.date), input.settlement],
      input.now
    )
    return {
      state: {
        deliveries: [...input.deliveries],
        settlements,
        // 取较大值：补齐历史缺口时会逐日结算，不能被中间某天覆盖成更早的日期
        lastSettledDate:
          state.lastSettledDate && state.lastSettledDate > input.date
            ? state.lastSettledDate
            : input.date
      },
      result: undefined
    }
  })
}
