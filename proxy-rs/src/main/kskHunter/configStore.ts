/**
 * 抢号配置与推送队列的加密持久化。
 *
 * 与 kskAutomation/configStore 同一套路：safeStorage 加密整个文件，
 * 所有写操作串到一条 mutation 队列上，避免 3 秒一轮的并发写互相覆盖。
 *
 * 推送队列也存在这里：抢到的 ksk 在推给下游之前必须落盘，
 * 否则应用重启就会丢掉「已花钱买到但没交付」的号。
 */

import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_KSK_HUNTER_CHANNEL_BILLING,
  DEFAULT_KSK_HUNTER_CONFIG,
  KSK_HUNTER_CHANNEL,
  KSK_HUNTER_DELIVERY_STATE,
  KSK_HUNTER_MAX_CNY_PER_UNIT,
  KSK_HUNTER_MODE,
  KSK_HUNTER_POLL_INTERVAL_SECONDS,
  KSK_HUNTER_REQUEST_TIMEOUT_SECONDS,
  KSK_HUNTER_STORE_VERSION,
  hunterLocalDateKey,
  hunterUrlHint,
  maskHunterSecretTail,
  roundCny,
  type KskHunterChannel,
  type KskHunterChannelBilling,
  type KskHunterConfig,
  type KskHunterConfigView,
  type KskHunterDeliveryState,
  type KskHunterDeliveryView,
  type KskHunterLink,
  type KskHunterLinkInput,
  type KskHunterLinkSecrets,
  type KskHunterLinkView,
  type KskHunterMode,
  type KskHunterSecretInput,
  type KskHunterSpendEntry
} from '../../shared/kskHunter'
import { isValidKiroRegion, maskKiroApiKey } from '../../shared/kiroApiKey'

const STORE_FILE = 'ksk-hunter.enc'

/** 推送队列保留上限：只留最近的记录，避免文件无界增长。 */
const MAX_DELIVERY_RECORDS = 200

/**
 * 花费账本保留天数。
 *
 * 统计只看当天，但保留几天历史便于用户回看，也避免刚过零点时因为清空过狠
 * 而看不到昨天花了多少。
 */
const SPEND_RETENTION_DAYS = 14

export interface PersistedKskHunterLink extends KskHunterLink {
  secrets: KskHunterLinkSecrets
}

/** 落盘的推送记录，含 ksk 明文（整个文件已加密）。 */
export interface PersistedKskHunterDelivery {
  id: string
  linkId: string
  linkName: string
  /**
   * 下单时所属渠道。推送成功/失败要记进报表，而链接可能已被删除，
   * 光靠 linkId 回查不到渠道，所以在记录上冗余一份。
   * 本字段晚于 v2 引入，老记录为 undefined。
   */
  channel?: KskHunterChannel
  key: string
  region: string
  state: KskHunterDeliveryState
  attempts: number
  createdAt: number
  updatedAt: number
  nextAttemptAt?: number
  lastError?: string
  /** 下单时的原币金额；商品无价格时为 undefined。 */
  costUnit?: number
  costCny?: number
  unitLabel?: string
}

/** 落盘的花费记录。按渠道与时间记账，统计时按本地日期分组。 */
export interface PersistedKskHunterSpend {
  id: string
  channel: KskHunterChannel
  amountUnit: number
  amountCny: number
  at: number
}

export interface PersistedKskHunterStore {
  version: typeof KSK_HUNTER_STORE_VERSION
  config: KskHunterConfig
  secrets: {
    downstreamApiKey: string
    /** 每渠道余额查询地址（含 token）。未配置的渠道键缺失或为空串。 */
    balanceUrls: Partial<Record<KskHunterChannel, string>>
  }
  links: PersistedKskHunterLink[]
  deliveries: PersistedKskHunterDelivery[]
  spend: PersistedKskHunterSpend[]
}

let mutationQueue: Promise<void> = Promise.resolve()

function storePath(): string {
  return join(app.getPath('userData'), STORE_FILE)
}

function normalizeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function positiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numberValue)) return fallback
  return Math.min(max, Math.max(min, Math.floor(numberValue)))
}

function normalizeChannel(value: unknown): KskHunterChannel {
  // 认不出就回落到第一个渠道；这只发生在配置被外部改坏的情况
  return normalizeChannelValue(value) ?? KSK_HUNTER_CHANNEL.KIRO_MARKET
}

function normalizeMode(value: unknown): KskHunterMode {
  return normalizeString(value) === KSK_HUNTER_MODE.AUTO_ORDER
    ? KSK_HUNTER_MODE.AUTO_ORDER
    : KSK_HUNTER_MODE.NOTIFY
}

function normalizeRegions(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const item of value) {
    const region = normalizeString(item).toLowerCase()
    if (isValidKiroRegion(region)) seen.add(region)
  }
  return [...seen]
}

function normalizeDeliveryState(value: unknown): KskHunterDeliveryState {
  const states = Object.values(KSK_HUNTER_DELIVERY_STATE) as string[]
  const text = normalizeString(value)
  return states.includes(text)
    ? (text as KskHunterDeliveryState)
    : KSK_HUNTER_DELIVERY_STATE.PENDING
}

/** 金额类配置：非法值一律回落到 fallback，并夹到 [0, max]。 */
function normalizeAmount(value: unknown, fallback: number, max: number): number {
  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numberValue) || numberValue < 0) return fallback
  return roundCny(Math.min(max, numberValue))
}

/**
 * 归一化单渠道计费配置。
 *
 * cnyPerUnit 非正一律回落到 1：填 0 会让所有花费算成 0，
 * 等于上限判断彻底失效、无限狂买，比记错账危险得多。
 */
function normalizeChannelBilling(value: unknown): KskHunterChannelBilling {
  const source = (value ?? {}) as Partial<KskHunterChannelBilling>
  const rawPerUnit =
    typeof source.cnyPerUnit === 'number' ? source.cnyPerUnit : Number(source.cnyPerUnit)
  const cnyPerUnit =
    Number.isFinite(rawPerUnit) && rawPerUnit > 0
      ? Math.min(KSK_HUNTER_MAX_CNY_PER_UNIT, rawPerUnit)
      : DEFAULT_KSK_HUNTER_CHANNEL_BILLING.cnyPerUnit
  return {
    unitLabel:
      normalizeString(source.unitLabel).slice(0, 8) || DEFAULT_KSK_HUNTER_CHANNEL_BILLING.unitLabel,
    cnyPerUnit,
    dailyLimitUnit: normalizeAmount(source.dailyLimitUnit, 0, Number.MAX_SAFE_INTEGER),
    lowBalanceThresholdUnit: normalizeAmount(
      source.lowBalanceThresholdUnit,
      0,
      Number.MAX_SAFE_INTEGER
    )
  }
}

/** 补齐所有渠道的计费配置，缺失的渠道用默认值填上。 */
function normalizeBilling(value: unknown): Record<KskHunterChannel, KskHunterChannelBilling> {
  const source = (value ?? {}) as Record<string, unknown>
  const result = {} as Record<KskHunterChannel, KskHunterChannelBilling>
  for (const channel of Object.values(KSK_HUNTER_CHANNEL) as KskHunterChannel[]) {
    result[channel] = normalizeChannelBilling(
      source[channel] ?? DEFAULT_KSK_HUNTER_CONFIG.billing[channel]
    )
  }
  return result
}

/** 余额地址：只保留渠道枚举里认识的键，值按普通字符串归一化。 */
function normalizeBalanceUrls(value: unknown): Partial<Record<KskHunterChannel, string>> {
  const source = (value ?? {}) as Record<string, unknown>
  const result: Partial<Record<KskHunterChannel, string>> = {}
  for (const channel of Object.values(KSK_HUNTER_CHANNEL) as KskHunterChannel[]) {
    const url = normalizeString(source[channel])
    if (url) result[channel] = url
  }
  return result
}

export function normalizeKskHunterConfig(
  input: Partial<KskHunterConfig> | null | undefined
): KskHunterConfig {
  const source = input ?? {}
  return {
    targetGroupId: normalizeString(source.targetGroupId) || undefined,
    requestTimeoutSeconds: positiveInt(
      source.requestTimeoutSeconds,
      KSK_HUNTER_REQUEST_TIMEOUT_SECONDS,
      3,
      120
    ),
    notifyOnAutoOrder: source.notifyOnAutoOrder !== false,
    downstreamEnabled: source.downstreamEnabled === true,
    downstreamBaseUrl:
      normalizeString(source.downstreamBaseUrl) || DEFAULT_KSK_HUNTER_CONFIG.downstreamBaseUrl,
    dailyLimitCny: normalizeAmount(source.dailyLimitCny, 0, Number.MAX_SAFE_INTEGER),
    billing: normalizeBilling(source.billing),
    allowUnknownPriceOrder: source.allowUnknownPriceOrder === true,
    balanceCheckEnabled: source.balanceCheckEnabled === true
  }
}

function normalizeLink(value: unknown, now: number): PersistedKskHunterLink | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Partial<PersistedKskHunterLink>
  const id = normalizeString(source.id)
  if (!id) return null
  const createdAt = positiveInt(source.createdAt, now, 0, Number.MAX_SAFE_INTEGER)
  return {
    id,
    name: normalizeString(source.name) || '未命名链接',
    channel: normalizeChannel(source.channel),
    enabled: source.enabled !== false,
    mode: normalizeMode(source.mode),
    regions: normalizeRegions(source.regions),
    createdAt,
    updatedAt: positiveInt(source.updatedAt, createdAt, 0, Number.MAX_SAFE_INTEGER),
    secrets: {
      listUrl: normalizeString(source.secrets?.listUrl),
      orderUrl: normalizeString(source.secrets?.orderUrl)
    }
  }
}

function normalizeDelivery(value: unknown, now: number): PersistedKskHunterDelivery | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Partial<PersistedKskHunterDelivery>
  const id = normalizeString(source.id)
  const key = normalizeString(source.key)
  if (!id || !key) return null
  const createdAt = positiveInt(source.createdAt, now, 0, Number.MAX_SAFE_INTEGER)
  return {
    id,
    linkId: normalizeString(source.linkId),
    linkName: normalizeString(source.linkName) || '未命名链接',
    channel: normalizeChannelValue(source.channel) ?? undefined,
    key,
    region: normalizeString(source.region),
    state: normalizeDeliveryState(source.state),
    attempts: positiveInt(source.attempts, 0, 0, 1000),
    createdAt,
    updatedAt: positiveInt(source.updatedAt, createdAt, 0, Number.MAX_SAFE_INTEGER),
    nextAttemptAt:
      source.nextAttemptAt === undefined
        ? undefined
        : positiveInt(source.nextAttemptAt, now, 0, Number.MAX_SAFE_INTEGER),
    lastError: normalizeString(source.lastError) || undefined,
    costUnit:
      typeof source.costUnit === 'number' && Number.isFinite(source.costUnit)
        ? source.costUnit
        : undefined,
    costCny:
      typeof source.costCny === 'number' && Number.isFinite(source.costCny)
        ? roundCny(source.costCny)
        : undefined,
    unitLabel: normalizeString(source.unitLabel) || undefined
  }
}

function normalizeChannelValue(value: unknown): KskHunterChannel | null {
  const channels = Object.values(KSK_HUNTER_CHANNEL) as string[]
  const text = normalizeString(value)
  return channels.includes(text) ? (text as KskHunterChannel) : null
}

/** 花费记录：渠道认不出或金额非法就丢弃，避免污染统计。 */
function normalizeSpend(value: unknown, now: number): PersistedKskHunterSpend | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Partial<PersistedKskHunterSpend>
  const id = normalizeString(source.id)
  const channel = normalizeChannelValue(source.channel)
  if (!id || !channel) return null
  const amountUnit = typeof source.amountUnit === 'number' ? source.amountUnit : Number.NaN
  const amountCny = typeof source.amountCny === 'number' ? source.amountCny : Number.NaN
  if (!Number.isFinite(amountUnit) || !Number.isFinite(amountCny)) return null
  if (amountUnit < 0 || amountCny < 0) return null
  return {
    id,
    channel,
    amountUnit,
    amountCny: roundCny(amountCny),
    at: positiveInt(source.at, now, 0, Number.MAX_SAFE_INTEGER)
  }
}

function emptyStore(): PersistedKskHunterStore {
  return {
    version: KSK_HUNTER_STORE_VERSION,
    config: normalizeKskHunterConfig(undefined),
    secrets: { downstreamApiKey: '', balanceUrls: {} },
    links: [],
    deliveries: [],
    spend: []
  }
}

/**
 * 纯函数便于迁移测试。
 *
 * v1 → v2：v1 没有 billing / dailyLimitCny / spend，normalizeKskHunterConfig 会
 * 用默认值补齐（人民币 1:1、不限额），账本从空开始。老配置不会丢，
 * 表现是「统计从升级这天起算」，这比拒绝加载旧文件好。
 */
export function normalizeKskHunterStorePayload(
  payload: unknown,
  now = Date.now()
): PersistedKskHunterStore {
  if (!payload || typeof payload !== 'object') return emptyStore()
  const source = payload as Partial<PersistedKskHunterStore>
  const ids = new Set<string>()
  const links = (Array.isArray(source.links) ? source.links : [])
    .map((link) => normalizeLink(link, now))
    .filter((link): link is PersistedKskHunterLink => Boolean(link))
    .filter((link) => {
      if (ids.has(link.id)) return false
      ids.add(link.id)
      return true
    })
  const deliveries = (Array.isArray(source.deliveries) ? source.deliveries : [])
    .map((delivery) => normalizeDelivery(delivery, now))
    .filter((delivery): delivery is PersistedKskHunterDelivery => Boolean(delivery))
    .slice(-MAX_DELIVERY_RECORDS)
  // 只保留近 N 天：账本按天统计，更早的记录留着只会让文件变大
  const spendCutoff = now - SPEND_RETENTION_DAYS * 24 * 60 * 60_000
  const spend = (Array.isArray(source.spend) ? source.spend : [])
    .map((entry) => normalizeSpend(entry, now))
    .filter((entry): entry is PersistedKskHunterSpend => Boolean(entry))
    .filter((entry) => entry.at >= spendCutoff)
  return {
    version: KSK_HUNTER_STORE_VERSION,
    config: normalizeKskHunterConfig(source.config),
    secrets: {
      downstreamApiKey: normalizeString(source.secrets?.downstreamApiKey),
      balanceUrls: normalizeBalanceUrls(source.secrets?.balanceUrls)
    },
    links,
    deliveries,
    spend
  }
}

export function isKskHunterStoreAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export async function loadKskHunterStore(): Promise<PersistedKskHunterStore> {
  if (!isKskHunterStoreAvailable()) return emptyStore()
  try {
    const encrypted = await fs.readFile(storePath())
    return normalizeKskHunterStorePayload(JSON.parse(safeStorage.decryptString(encrypted)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore()
    throw new Error('抢号配置无法解密或已损坏，已拒绝用空配置覆盖原文件')
  }
}

async function saveStore(store: PersistedKskHunterStore): Promise<void> {
  if (!isKskHunterStoreAvailable()) {
    throw new Error('系统加密存储不可用，拒绝明文保存商品链接 token、下游 API Key 或已购 KSK')
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(store))
  await fs.writeFile(storePath(), encrypted, { mode: 0o600 })
}

/** 所有写操作串行化，杜绝 3 秒一轮的并发写互相覆盖。 */
export async function mutateKskHunterStore<T>(
  mutate: (store: PersistedKskHunterStore) => T | Promise<T>
): Promise<T> {
  let resolveResult: (value: T | PromiseLike<T>) => void
  let rejectResult: (reason?: unknown) => void
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  mutationQueue = mutationQueue
    .then(async () => {
      const store = await loadKskHunterStore()
      const value = await mutate(store)
      await saveStore(store)
      resolveResult(value)
    })
    .catch((error) => {
      rejectResult(error)
    })
  return result
}

export async function updateKskHunterConfig(
  config: Partial<KskHunterConfig>,
  secrets: KskHunterSecretInput | undefined
): Promise<PersistedKskHunterStore> {
  return mutateKskHunterStore((store) => {
    store.config = normalizeKskHunterConfig({ ...store.config, ...config })
    if (secrets?.downstreamApiKey !== undefined) {
      store.secrets.downstreamApiKey = normalizeString(secrets.downstreamApiKey)
    }
    // 余额地址按渠道逐个合并：省略的键保留原值，空串表示清除
    if (secrets?.balanceUrls) {
      store.secrets.balanceUrls = { ...(store.secrets.balanceUrls ?? {}) }
      for (const [channel, url] of Object.entries(secrets.balanceUrls)) {
        if (url === undefined) continue
        const trimmed = normalizeString(url)
        if (trimmed) store.secrets.balanceUrls[channel as KskHunterChannel] = trimmed
        else delete store.secrets.balanceUrls[channel as KskHunterChannel]
      }
    }
    return store
  })
}

function applyLinkInput(
  link: PersistedKskHunterLink,
  input: KskHunterLinkInput
): PersistedKskHunterLink {
  link.name = normalizeString(input.name) || link.name
  link.channel = normalizeChannel(input.channel)
  link.enabled = input.enabled ?? link.enabled
  link.mode = normalizeMode(input.mode)
  link.regions = input.regions === undefined ? link.regions : normalizeRegions(input.regions)
  if (input.listUrl !== undefined) link.secrets.listUrl = normalizeString(input.listUrl)
  if (input.orderUrl !== undefined) link.secrets.orderUrl = normalizeString(input.orderUrl)
  link.updatedAt = Date.now()
  return link
}

export async function createKskHunterLink(
  id: string,
  input: KskHunterLinkInput
): Promise<PersistedKskHunterLink> {
  return mutateKskHunterStore((store) => {
    const now = Date.now()
    const link: PersistedKskHunterLink = {
      id,
      name: normalizeString(input.name) || '未命名链接',
      channel: normalizeChannel(input.channel),
      enabled: input.enabled !== false,
      mode: normalizeMode(input.mode),
      regions: normalizeRegions(input.regions),
      createdAt: now,
      updatedAt: now,
      secrets: { listUrl: '', orderUrl: '' }
    }
    store.links.push(applyLinkInput(link, input))
    return link
  })
}

export async function updateKskHunterLink(
  linkId: string,
  input: KskHunterLinkInput
): Promise<PersistedKskHunterLink> {
  return mutateKskHunterStore((store) => {
    const link = store.links.find((item) => item.id === linkId)
    if (!link) throw new Error('链接不存在或已删除')
    return applyLinkInput(link, input)
  })
}

export async function setKskHunterLinkEnabled(
  linkId: string,
  enabled: boolean
): Promise<PersistedKskHunterLink> {
  return mutateKskHunterStore((store) => {
    const link = store.links.find((item) => item.id === linkId)
    if (!link) throw new Error('链接不存在或已删除')
    link.enabled = enabled
    link.updatedAt = Date.now()
    return link
  })
}

export async function deleteKskHunterLink(linkId: string): Promise<void> {
  return mutateKskHunterStore((store) => {
    const index = store.links.findIndex((item) => item.id === linkId)
    if (index < 0) throw new Error('链接不存在或已删除')
    store.links.splice(index, 1)
  })
}

export async function appendKskHunterDelivery(delivery: PersistedKskHunterDelivery): Promise<void> {
  return mutateKskHunterStore((store) => {
    store.deliveries.push(delivery)
    if (store.deliveries.length > MAX_DELIVERY_RECORDS) {
      store.deliveries.splice(0, store.deliveries.length - MAX_DELIVERY_RECORDS)
    }
  })
}

/**
 * 记一笔花费。
 *
 * 必须在下单成功后立刻调用，且与 appendKskHunterDelivery 同样走 mutation 队列，
 * 否则并发下单会互相覆盖账本、把上限判断算漏。
 */
export async function appendKskHunterSpend(entry: PersistedKskHunterSpend): Promise<void> {
  return mutateKskHunterStore((store) => {
    store.spend.push(entry)
    const cutoff = Date.now() - SPEND_RETENTION_DAYS * 24 * 60 * 60_000
    store.spend = store.spend.filter((item) => item.at >= cutoff)
  })
}

export async function patchKskHunterDelivery(
  deliveryId: string,
  patch: Partial<Omit<PersistedKskHunterDelivery, 'id'>>
): Promise<void> {
  return mutateKskHunterStore((store) => {
    const delivery = store.deliveries.find((item) => item.id === deliveryId)
    if (!delivery) return
    Object.assign(delivery, patch, { updatedAt: Date.now() })
  })
}

export async function deleteKskHunterDelivery(deliveryId: string): Promise<void> {
  return mutateKskHunterStore((store) => {
    const index = store.deliveries.findIndex((item) => item.id === deliveryId)
    if (index < 0) throw new Error('记录不存在或已删除')
    store.deliveries.splice(index, 1)
  })
}

export function toKskHunterConfigView(store: PersistedKskHunterStore): KskHunterConfigView {
  return {
    ...store.config,
    pollIntervalSeconds: KSK_HUNTER_POLL_INTERVAL_SECONDS,
    encryptionAvailable: isKskHunterStoreAvailable(),
    hasDownstreamApiKey: Boolean(store.secrets.downstreamApiKey),
    downstreamApiKeyTail: maskHunterSecretTail(store.secrets.downstreamApiKey),
    balanceUrlHints: Object.fromEntries(
      (Object.values(KSK_HUNTER_CHANNEL) as KskHunterChannel[]).map((channel) => [
        channel,
        hunterUrlHint(store.secrets.balanceUrls?.[channel] ?? '')
      ])
    ) as Record<KskHunterChannel, string | undefined>
  }
}

/** 每条链接的运行时状态由 runner 持有，落盘的只有配置。 */
export interface KskHunterLinkRuntime {
  lastInStock: boolean
  lastCheckedAt?: number
  lastError?: string
}

export function toKskHunterLinkView(
  link: PersistedKskHunterLink,
  runtime: KskHunterLinkRuntime = { lastInStock: false }
): KskHunterLinkView {
  return {
    id: link.id,
    name: link.name,
    channel: link.channel,
    enabled: link.enabled,
    mode: link.mode,
    regions: [...link.regions],
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
    hasListUrl: Boolean(link.secrets.listUrl),
    listUrlHint: hunterUrlHint(link.secrets.listUrl),
    hasOrderUrl: Boolean(link.secrets.orderUrl),
    orderUrlHint: hunterUrlHint(link.secrets.orderUrl),
    lastInStock: runtime.lastInStock,
    lastCheckedAt: runtime.lastCheckedAt,
    lastError: runtime.lastError
  }
}

/** ksk 明文只留在主进程，渲染进程拿到的是脱敏形式。 */
export function toKskHunterDeliveryView(
  delivery: PersistedKskHunterDelivery
): KskHunterDeliveryView {
  return {
    id: delivery.id,
    linkId: delivery.linkId,
    linkName: delivery.linkName,
    maskedKey: maskKiroApiKey(delivery.key),
    region: delivery.region,
    state: delivery.state,
    attempts: delivery.attempts,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
    nextAttemptAt: delivery.nextAttemptAt,
    lastError: delivery.lastError,
    costUnit: delivery.costUnit,
    costCny: delivery.costCny,
    unitLabel: delivery.unitLabel
  }
}

/** 账本记录转成统计用的最小形状。 */
/**
 * 账本记录转成统计用的最小形状。
 *
 * 对 spend 缺失做容错：v1 store 文件里没有这个字段，
 * 虽然 normalizeKskHunterStorePayload 会补上，但直接构造的 store 对象可能漏。
 */
export function toKskHunterSpendEntries(store: PersistedKskHunterStore): KskHunterSpendEntry[] {
  return (store.spend ?? []).map((entry) => ({
    channel: entry.channel,
    amountUnit: entry.amountUnit,
    amountCny: entry.amountCny,
    at: entry.at
  }))
}

/** 当前本地日期键，供主进程记账与统计对齐同一个日切口。 */
export function currentHunterDateKey(): string {
  return hunterLocalDateKey()
}
