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
  type LocalAdminStatsSample
} from '../../shared/localAdminStats'

const STORE_FILE = 'local-admin-stats-samples.json'

interface PersistedSamples {
  version: 1
  samples: LocalAdminStatsSample[]
}

let mutationQueue: Promise<void> = Promise.resolve()

function storePath(): string {
  return join(app.getPath('userData'), STORE_FILE)
}

/** userData 目录首启时可能还不存在，写盘前补建一次。 */
async function writeSamples(samples: LocalAdminStatsSample[]): Promise<void> {
  const path = storePath()
  await fs.mkdir(dirname(path), { recursive: true })
  const payload: PersistedSamples = { version: 1, samples }
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
    usageLimit: readOptionalNumber(source.usageLimit)
  }
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

export async function loadLocalAdminStatsSamples(): Promise<LocalAdminStatsSample[]> {
  try {
    const raw = await fs.readFile(storePath(), 'utf-8')
    return normalizeSamplesPayload(JSON.parse(raw))
  } catch {
    // 缺文件或内容损坏都按空趋势处理：这是可再生的观测数据，不值得阻塞页面
    return []
  }
}

/** 追加一个采样点并落盘。写操作串行化，避免定时轮询与手动刷新互相覆盖。 */
export async function appendLocalAdminStatsSample(
  sample: LocalAdminStatsSample
): Promise<LocalAdminStatsSample[]> {
  let resolveResult: (value: LocalAdminStatsSample[]) => void
  let rejectResult: (reason?: unknown) => void
  const result = new Promise<LocalAdminStatsSample[]>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  mutationQueue = mutationQueue
    .then(async () => {
      const samples = await loadLocalAdminStatsSamples()
      samples.push(sample)
      const trimmed = samples.slice(-LOCAL_ADMIN_STATS_MAX_SAMPLES)
      await writeSamples(trimmed)
      resolveResult(trimmed)
    })
    .catch((error) => {
      rejectResult(error)
    })
  return result
}

export async function clearLocalAdminStatsSamples(): Promise<void> {
  let resolveResult: () => void
  let rejectResult: (reason?: unknown) => void
  const result = new Promise<void>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  mutationQueue = mutationQueue
    .then(async () => {
      const payload: PersistedSamples = { version: 1, samples: [] }
      await writeSamples(payload.samples)
      resolveResult()
    })
    .catch((error) => {
      rejectResult(error)
    })
  return result
}
