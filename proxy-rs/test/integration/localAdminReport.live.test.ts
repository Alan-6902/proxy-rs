/**
 * 针对真实本机 Admin 的消耗差分验证（可选执行）。
 *
 * 为什么需要它：小时桶的增量全靠「相邻两次观测做差」，fixture 只能证明算法自洽，
 * 证不了真实响应喂进去也对——比如 currentUsage 是否真的单调增、凭据换号时
 * id 会不会串数据、balance 缓存 TTL 内取到的是否为同一份快照。
 *
 * 执行条件：设置 KIRO_ADMIN_BASE_URL 与 KIRO_ADMIN_API_KEY，且服务可达；
 * 缺任一条件就整组跳过，避免没起容器时 CI 变红。
 *
 * 只读接口：GET /credentials 与 GET /credentials/:id/balance。后者是 AWS 的
 * 只读计量接口（UsageLimitsResponse），不消耗账号额度。
 */

import { describe, expect, it } from 'vitest'
import { fetch as undiciFetch } from 'undici'
import {
  accumulateHourlyUsage,
  buildLocalAdminReport,
  toLocalDateKey,
  type LocalAdminCredentialStats
} from '../../src/shared/localAdminStats'
import {
  fetchLocalAdminCredentialStats,
  fetchLocalAdminUsage,
  type LocalAdminStatsTarget
} from '../../src/main/localAdminStats/statsClient'
import type { KskAutomationFetch } from '../../src/main/kskAutomation/localAdminClient'

const BASE_URL = process.env.KIRO_ADMIN_BASE_URL ?? ''
const API_KEY = process.env.KIRO_ADMIN_API_KEY ?? ''

const liveFetch: KskAutomationFetch = async (url, init) =>
  (await undiciFetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal
  })) as unknown as Response

function liveTarget(): LocalAdminStatsTarget {
  return {
    baseUrl: BASE_URL,
    adminApiKey: API_KEY,
    timeoutSeconds: 20,
    fetchImpl: liveFetch
  }
}

/** 采一轮：计数 + 逐条用量，与 statsManager 的 executeRound 同口径。 */
async function sampleOnce(): Promise<LocalAdminCredentialStats[]> {
  const target = liveTarget()
  const base = await fetchLocalAdminCredentialStats(target)
  const { usage } = await fetchLocalAdminUsage(
    target,
    base.map((item) => item.id)
  )
  return usage.size > 0 ? await fetchLocalAdminCredentialStats(target, usage) : base
}

describe.runIf(BASE_URL && API_KEY)('反代统计 · 真实 Admin 消耗差分', () => {
  it('真实响应能拿到用量，且首轮只建基线不产生增量', async () => {
    const credentials = await sampleOnce()
    expect(credentials.length).toBeGreaterThan(0)
    // 自动采集的意义就在这：不点按钮也该有用量
    expect(credentials.some((item) => item.usage !== undefined)).toBe(true)

    const state = accumulateHourlyUsage({
      buckets: [],
      cursors: [],
      credentials,
      at: Date.now()
    })
    expect(state.buckets).toHaveLength(1)
    for (const entry of state.buckets[0].credentials) {
      expect(entry.usageDelta).toBe(0)
      expect(entry.successDelta).toBe(0)
    }
    // 基线必须落到游标上，否则第二轮无从算差
    for (const cursor of state.cursors) {
      expect(cursor.at).toBeGreaterThan(0)
    }
  })

  it('连续两轮观测得到非负增量，报表按账号出数', async () => {
    const first = await sampleOnce()
    let state = accumulateHourlyUsage({
      buckets: [],
      cursors: [],
      credentials: first,
      at: Date.now()
    })

    const second = await sampleOnce()
    state = accumulateHourlyUsage({
      buckets: state.buckets,
      cursors: state.cursors,
      credentials: second,
      at: Date.now()
    })

    const report = buildLocalAdminReport({
      buckets: state.buckets,
      range: { date: toLocalDateKey(Date.now()), hour: new Date().getHours() },
      now: Date.now(),
      presentIds: second.map((item) => item.id)
    })

    // 核心断言：真实数据喂进来也不会出现负增量
    for (const row of report.rows) {
      expect(row.usageDelta).toBeGreaterThanOrEqual(0)
      expect(row.successDelta).toBeGreaterThanOrEqual(0)
      expect(row.failureDelta).toBeGreaterThanOrEqual(0)
      expect(row.inputTokenDelta).toBeGreaterThanOrEqual(0)
      expect(row.outputTokenDelta).toBeGreaterThanOrEqual(0)
      expect(row.creditDelta).toBeGreaterThanOrEqual(0)
    }
    expect(report.usageDelta).toBeGreaterThanOrEqual(0)
    expect(report.rows.length).toBe(second.length)
    // 当前仍在 Admin 里的凭据都应标 present
    for (const row of report.rows) expect(row.present).toBe(true)
  })

  it('真实 Admin 返回 token 统计（需 kiro-rs 支持该字段）', async () => {
    const credentials = await sampleOnce()
    expect(credentials.length).toBeGreaterThan(0)

    // 字段存在性是契约的核心：本仓库靠它区分「kiro-rs 不支持」与「确实是 0」。
    // 若这条失败，说明连的 kiro-rs 版本没有落 token 统计，页面会显示「不支持」。
    const supported = credentials.some((item) => item.inputTokens !== undefined)
    expect(supported).toBe(true)

    for (const credential of credentials) {
      if (credential.inputTokens === undefined) continue
      expect(Number.isInteger(credential.inputTokens)).toBe(true)
      expect(credential.inputTokens).toBeGreaterThanOrEqual(0)
      expect(Number.isInteger(credential.outputTokens ?? 0)).toBe(true)
      // 被调用过的凭据必须有输入 token，否则说明记账没挂上
      if (credential.successCount > 0) {
        expect(credential.inputTokens).toBeGreaterThan(0)
      }
    }
  })

  it('真实 Admin 返回积分统计（需 kiro-rs 支持该字段）', async () => {
    const credentials = await sampleOnce()
    expect(credentials.length).toBeGreaterThan(0)

    // 与 token 同理：字段存在性是契约核心，缺失时页面显示「不支持」
    const supported = credentials.some((item) => item.usedCredits !== undefined)
    expect(supported).toBe(true)

    for (const credential of credentials) {
      if (credential.usedCredits === undefined) continue
      expect(Number.isFinite(credential.usedCredits)).toBe(true)
      expect(credential.usedCredits).toBeGreaterThanOrEqual(0)
    }
  })
})
