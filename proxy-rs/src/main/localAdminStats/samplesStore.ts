/**
 * 反代统计趋势的本地快照。
 *
 * 为什么要本地存：kiro-rs 只持久化 success_count 与 last_used_at，失败计数是内存态、
 * 容器重启即归零，历史时间序列上游根本不存。要画趋势只能本地按采样自己攒。
 *
 * 存的是聚合量（总成功 / 总失败 / 凭据数 / 总用量），不含凭据明文也不含哈希，
 * 所以明文 JSON 落盘即可，不占用 safeStorage 那条串行队列。
 */

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  LOCAL_ADMIN_STATS_MAX_SAMPLES,
  LOCAL_ADMIN_USAGE_BUCKET_RETENTION_HOURS,
  type LocalAdminCumulativeCursor,
  type LocalAdminHourlyBucket,
  type LocalAdminHourlyCredentialDelta,
  type LocalAdminStatsSample
} from '../../shared/localAdminStats'

const STORE_FILE = 'local-admin-stats-samples.json'

/**
 * v2 起在同一份文件里附带按小时的消耗桶与累计游标。
 *
 * 桶和 samples 分开存而不是从 samples 现算：samples 只有聚合量（不分凭据），
 * 而报表要按账号出数；差分还依赖「上一次观测值」这个只有采集时才知道的状态。
 */
interface PersistedSamples {
  version: 1 | 2
  samples: LocalAdminStatsSample[]
  buckets?: LocalAdminHourlyBucket[]
  cursors?: LocalAdminCumulativeCursor[]
}

export interface LocalAdminStatsPersistedState {
  samples: LocalAdminStatsSample[]
  buckets: LocalAdminHourlyBucket[]
  cursors: LocalAdminCumulativeCursor[]
}

let mutationQueue: Promise<void> = Promise.resolve()

function storePath(): string {
  return join(app.getPath('userData'), STORE_FILE)
}

/** userData 目录首启时可能还不存在，写盘前补建一次。 */
async function writeState(state: LocalAdminStatsPersistedState): Promise<void> {
  const path = storePath()
  await fs.mkdir(dirname(path), { recursive: true })
  const payload: PersistedSamples = {
    version: 2,
    samples: state.samples,
    buckets: state.buckets,
    cursors: state.cursors
  }
  await fs.writeFile(path, JSON.stringify(payload), { mode: 0o600 })
}

function readCount(value: unknown): number {
  const numberValue = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.floor(numberValue) : 0
}

function readOptionalNumber(value: unknown): number | undefined {
  const numberValue = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numberValue) ? numberValue : undefined
}

function normalizeSample(value: unknown): LocalAdminStatsSample | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const at = readOptionalNumber(source.at)
  if (at === undefined || at <= 0) return null
  return {
    at: Math.floor(at),
    successCount: readCount(source.successCount),
    failureCount: readCount(source.failureCount),
    refreshFailureCount: readCount(source.refreshFailureCount),
    credentials: readCount(source.credentials),
    available: readCount(source.available),
    usageCurrent: readOptionalNumber(source.usageCurrent),
    usageLimit: readOptionalNumber(source.usageLimit),
    inputTokens: readOptionalNumber(source.inputTokens),
    outputTokens: readOptionalNumber(source.outputTokens)
  }
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** 从未知载荷里取一个数组字段，非数组按空处理。清洗前一律当 unknown[] 看。 */
function readRawArray(payload: unknown, key: keyof PersistedSamples): unknown[] {
  if (!payload || typeof payload !== 'object') return []
  const value = (payload as Record<string, unknown>)[key]
  return Array.isArray(value) ? (value as unknown[]) : []
}

/** 增量允许小数（额度带两位小数），但不允许负数。 */
function readDelta(value: unknown): number {
  const numberValue = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : 0
}

function normalizeDelta(value: unknown): LocalAdminHourlyCredentialDelta | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const id = readOptionalString(source.id)
  if (!id) return null
  return {
    id,
    maskedKey: readOptionalString(source.maskedKey),
    usageDelta: readDelta(source.usageDelta),
    // 升级前落的桶没有这两个键，按 0 读入
    inputTokenDelta: readDelta(source.inputTokenDelta),
    outputTokenDelta: readDelta(source.outputTokenDelta),
    successDelta: readDelta(source.successDelta),
    failureDelta: readDelta(source.failureDelta),
    refreshFailureDelta: readDelta(source.refreshFailureDelta),
    usageCurrent: readOptionalNumber(source.usageCurrent),
    usageLimit: readOptionalNumber(source.usageLimit),
    lastSeenAt: readCount(source.lastSeenAt)
  }
}

/** 清洗小时桶：丢掉非法小时与空 id，按小时排序并裁到保留窗口。 */
export function normalizeBucketsPayload(
  payload: unknown,
  now = Date.now()
): LocalAdminHourlyBucket[] {
  const source = readRawArray(payload, 'buckets')
  const earliest =
    new Date(now).setMinutes(0, 0, 0) - (LOCAL_ADMIN_USAGE_BUCKET_RETENTION_HOURS - 1) * 3_600_000
  return source
    .map((item): LocalAdminHourlyBucket | null => {
      if (!item || typeof item !== 'object') return null
      const record = item as Record<string, unknown>
      const hour = readOptionalNumber(record.hour)
      if (hour === undefined || hour <= 0) return null
      const credentials = Array.isArray(record.credentials)
        ? (record.credentials as unknown[])
            .map(normalizeDelta)
            .filter((entry): entry is LocalAdminHourlyCredentialDelta => entry !== null)
        : []
      return { hour: Math.floor(hour), credentials }
    })
    .filter((item): item is LocalAdminHourlyBucket => item !== null && item.hour >= earliest)
    .sort((a, b) => a.hour - b.hour)
}

/** 清洗累计游标。用量基线允许缺失（还没查过余额）。 */
export function normalizeCursorsPayload(payload: unknown): LocalAdminCumulativeCursor[] {
  return readRawArray(payload, 'cursors')
    .map((item): LocalAdminCumulativeCursor | null => {
      if (!item || typeof item !== 'object') return null
      const record = item as Record<string, unknown>
      const id = readOptionalString(record.id)
      if (!id) return null
      return {
        id,
        successCount: readCount(record.successCount),
        failureCount: readCount(record.failureCount),
        refreshFailureCount: readCount(record.refreshFailureCount),
        usageCurrent: readOptionalNumber(record.usageCurrent),
        inputTokens: readOptionalNumber(record.inputTokens),
        outputTokens: readOptionalNumber(record.outputTokens),
        at: readCount(record.at)
      }
    })
    .filter((item): item is LocalAdminCumulativeCursor => item !== null)
}

/** 纯函数便于测试：清洗、按时间排序、裁到上限。 */
export function normalizeSamplesPayload(payload: unknown): LocalAdminStatsSample[] {
  const source =
    payload && typeof payload === 'object'
      ? (payload as Partial<PersistedSamples>).samples
      : undefined
  if (!Array.isArray(source)) return []
  return source
    .map(normalizeSample)
    .filter((item): item is LocalAdminStatsSample => item !== null)
    .sort((a, b) => a.at - b.at)
    .slice(-LOCAL_ADMIN_STATS_MAX_SAMPLES)
}

/**
 * 读取全量持久化状态。
 *
 * v1 文件没有 buckets/cursors 字段，读出来是空数组：老用户升级后趋势保留，
 * 消耗报表从升级那一刻开始重新攒，不做假数据回填。
 */
export async function loadLocalAdminStatsState(): Promise<LocalAdminStatsPersistedState> {
  try {
    const raw = await fs.readFile(storePath(), 'utf-8')
    const parsed = JSON.parse(raw)
    return {
      samples: normalizeSamplesPayload(parsed),
      buckets: normalizeBucketsPayload(parsed),
      cursors: normalizeCursorsPayload(parsed)
    }
  } catch {
    // 缺文件或内容损坏都按空状态处理：这是可再生的观测数据，不值得阻塞页面
    return { samples: [], buckets: [], cursors: [] }
  }
}

export async function loadLocalAdminStatsSamples(): Promise<LocalAdminStatsSample[]> {
  return (await loadLocalAdminStatsState()).samples
}

/** 把一次写操作排到串行队列上，避免定时轮询与手动刷新互相覆盖。 */
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
 * 追加一个采样点，同时并入小时桶并更新游标。
 *
 * 三者一次落盘：桶的增量依赖游标，两者分开写会在崩溃时留下
 * 「游标已前进但增量没记」的空洞，导致那段消耗永久丢失。
 */
export async function appendLocalAdminStatsSample(input: {
  sample: LocalAdminStatsSample
  buckets: LocalAdminHourlyBucket[]
  cursors: LocalAdminCumulativeCursor[]
}): Promise<LocalAdminStatsPersistedState> {
  return enqueue(async () => {
    const state = await loadLocalAdminStatsState()
    const samples = [...state.samples, input.sample].slice(-LOCAL_ADMIN_STATS_MAX_SAMPLES)
    const next: LocalAdminStatsPersistedState = {
      samples,
      buckets: input.buckets,
      cursors: input.cursors
    }
    await writeState(next)
    return next
  })
}

/** 清空趋势曲线，保留消耗报表：两者是不同粒度的数据，用户清趋势不代表要丢报表。 */
export async function clearLocalAdminStatsSamples(): Promise<void> {
  return enqueue(async () => {
    const state = await loadLocalAdminStatsState()
    await writeState({ samples: [], buckets: state.buckets, cursors: state.cursors })
  })
}

/** 清空消耗报表的小时桶。游标一并清掉，下一轮重新建基线。 */
export async function clearLocalAdminUsageBuckets(): Promise<void> {
  return enqueue(async () => {
    const state = await loadLocalAdminStatsState()
    await writeState({ samples: state.samples, buckets: [], cursors: [] })
  })
}
