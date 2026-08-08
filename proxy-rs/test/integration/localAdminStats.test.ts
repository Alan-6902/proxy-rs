/**
 * 反代统计的解析、聚合与采集调度验证。
 *
 * 重点覆盖三件容易走偏的事：
 * 1. Admin 响应字段的解析（RFC3339 时间、秒级时间戳、缺字段），
 *    上游给的 usagePercentage 是百分数而本地统一用 0-1 小数，混用会让告警阈值失效；
 * 2. 用量只在手动刷新时查，定时轮询必须沿用上一轮缓存，否则页面用量列会闪空；
 * 3. 未配置本机 Admin 属正常状态，不能刷错误也不能发请求。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  LOCAL_ADMIN_ALERT,
  LOCAL_ADMIN_STATS_STATE,
  LOCAL_ADMIN_USAGE_WARN_RATIO,
  aggregateLocalAdminStats,
  resolveLocalAdminAlerts,
  type LocalAdminCredentialStats
} from '../../src/shared/localAdminStats'
import {
  fetchLocalAdminCredentialStats,
  fetchLocalAdminUsage,
  toCredentialStats,
  toCredentialUsage
} from '../../src/main/localAdminStats/statsClient'
import { normalizeSamplesPayload } from '../../src/main/localAdminStats/samplesStore'
import { LocalAdminStatsManager } from '../../src/main/localAdminStats/statsManager'
import type { KskAutomationFetch } from '../../src/main/kskAutomation/localAdminClient'

const BASE_URL = 'http://127.0.0.1:12888/admin'
const ADMIN_KEY = 'admin-test-key'

/** kiro-rs 实测响应的形状，字段名与大小写照抄。 */
const REMOTE_CREDENTIAL = {
  id: 1,
  priority: 0,
  disabled: false,
  failureCount: 0,
  isCurrent: true,
  expiresAt: null,
  authMethod: 'api_key',
  hasProfileArn: false,
  refreshTokenHash: null,
  apiKeyHash: 'd7e6f5b9',
  maskedApiKey: 'ksk_...ibfB',
  email: null,
  successCount: 142,
  lastUsedAt: '2026-08-08T03:23:59.368368185+00:00',
  hasProxy: false,
  refreshFailureCount: 0,
  endpoint: 'ide'
}

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload)
  } as unknown as Response
}

function makeFetch(handler: (url: string) => Response): KskAutomationFetch {
  return vi.fn(async (url) => handler(url)) as unknown as KskAutomationFetch
}

function target(fetchImpl: KskAutomationFetch): {
  baseUrl: string
  adminApiKey: string
  timeoutSeconds: number
  fetchImpl: KskAutomationFetch
} {
  return { baseUrl: BASE_URL, adminApiKey: ADMIN_KEY, timeoutSeconds: 5, fetchImpl }
}

function statsFixture(patch: Partial<LocalAdminCredentialStats> = {}): LocalAdminCredentialStats {
  return {
    id: '1',
    priority: 0,
    disabled: false,
    isCurrent: false,
    successCount: 0,
    failureCount: 0,
    refreshFailureCount: 0,
    alerts: [],
    ...patch
  }
}

describe('反代统计 · 响应解析', () => {
  it('把 Admin 凭据映射为统计视图，RFC3339 时间转成毫秒时间戳', () => {
    const stats = toCredentialStats(REMOTE_CREDENTIAL)
    expect(stats).not.toBeNull()
    expect(stats!.id).toBe('1')
    expect(stats!.maskedKey).toBe('ksk_...ibfB')
    expect(stats!.successCount).toBe(142)
    expect(stats!.endpoint).toBe('ide')
    expect(stats!.isCurrent).toBe(true)
    expect(stats!.lastUsedAt).toBe(Date.parse('2026-08-08T03:23:59.368Z'))
    // email 为 null 时不该冒出 "null" 字符串
    expect(stats!.email).toBeUndefined()
    expect(stats!.alerts).toEqual([])
  })

  it('缺少 id 的条目返回 null，交由调用方过滤', () => {
    expect(toCredentialStats({ successCount: 3 })).toBeNull()
  })

  it('余额响应归一化成 0-1 小数，而不是沿用上游的百分数', () => {
    const usage = toCredentialUsage(
      {
        id: 1,
        subscriptionTitle: 'KIRO POWER',
        currentUsage: 7877.2,
        usageLimit: 10000,
        remaining: 2122.8,
        usagePercentage: 78.772,
        nextResetAt: 1788220800
      },
      1000
    )
    expect(usage).not.toBeNull()
    expect(usage!.percentUsed).toBeCloseTo(0.78772, 5)
    expect(usage!.remaining).toBe(2122.8)
    expect(usage!.subscriptionTitle).toBe('KIRO POWER')
    // nextResetAt 是秒级时间戳
    expect(usage!.nextResetAt).toBe(1788220800000)
    expect(usage!.fetchedAt).toBe(1000)
  })

  it('余额响应缺用量字段时返回 null，不编造 0', () => {
    expect(toCredentialUsage({ id: 1 }, 1000)).toBeNull()
    expect(toCredentialUsage(null, 1000)).toBeNull()
  })

  it('remaining 缺失时由 limit - current 兜底', () => {
    const usage = toCredentialUsage({ currentUsage: 400, usageLimit: 1000 }, 1000)
    expect(usage!.remaining).toBe(600)
  })
})

describe('反代统计 · 告警与聚合', () => {
  it('禁用、调用失败、刷新失败各自命中一条告警', () => {
    expect(
      resolveLocalAdminAlerts({ disabled: true, failureCount: 2, refreshFailureCount: 1 })
    ).toEqual([
      LOCAL_ADMIN_ALERT.DISABLED,
      LOCAL_ADMIN_ALERT.FAILING,
      LOCAL_ADMIN_ALERT.REFRESH_FAILING
    ])
  })

  it('用量超阈值报额度告急，耗尽报额度耗尽（互斥）', () => {
    const high = resolveLocalAdminAlerts({
      disabled: false,
      failureCount: 0,
      refreshFailureCount: 0,
      usage: { limit: 100, remaining: 5, percentUsed: LOCAL_ADMIN_USAGE_WARN_RATIO + 0.01 }
    })
    expect(high).toEqual([LOCAL_ADMIN_ALERT.QUOTA_HIGH])

    const exhausted = resolveLocalAdminAlerts({
      disabled: false,
      failureCount: 0,
      refreshFailureCount: 0,
      usage: { limit: 100, remaining: 0, percentUsed: 1 }
    })
    expect(exhausted).toEqual([LOCAL_ADMIN_ALERT.QUOTA_EXHAUSTED])
  })

  it('没查过用量时只判计数类，不因缺用量误报', () => {
    expect(
      resolveLocalAdminAlerts({ disabled: false, failureCount: 0, refreshFailureCount: 0 })
    ).toEqual([])
  })

  it('总览由明细聚合，成功率按成功/(成功+失败)算', () => {
    const totals = aggregateLocalAdminStats([
      statsFixture({ id: '1', successCount: 90, failureCount: 10 }),
      statsFixture({
        id: '2',
        disabled: true,
        successCount: 10,
        alerts: [LOCAL_ADMIN_ALERT.DISABLED],
        usage: { current: 400, limit: 1000, remaining: 600, percentUsed: 0.4, fetchedAt: 1 }
      })
    ])
    expect(totals.credentials).toBe(2)
    expect(totals.available).toBe(1)
    expect(totals.disabled).toBe(1)
    expect(totals.successCount).toBe(100)
    expect(totals.successRate).toBeCloseTo(100 / 110, 6)
    expect(totals.alertCount).toBe(1)
    expect(totals.usageSampleCount).toBe(1)
    expect(totals.usageRemaining).toBe(600)
    expect(totals.usagePercentUsed).toBeCloseTo(0.4, 6)
  })

  it('没有任何调用样本时成功率为 undefined，而不是 0', () => {
    const totals = aggregateLocalAdminStats([statsFixture()])
    expect(totals.successRate).toBeUndefined()
    expect(totals.usagePercentUsed).toBeUndefined()
  })
})

describe('反代统计 · 趋势快照清洗', () => {
  it('丢掉缺时间戳的脏数据并按时间排序', () => {
    const samples = normalizeSamplesPayload({
      version: 1,
      samples: [
        { at: 300, successCount: 3 },
        { successCount: 9 },
        { at: 100, successCount: 1, usageCurrent: 42 }
      ]
    })
    expect(samples.map((item) => item.at)).toEqual([100, 300])
    expect(samples[0].usageCurrent).toBe(42)
    // 未提供的计数补 0，避免渲染层到处判 undefined
    expect(samples[1].failureCount).toBe(0)
  })

  it('非法载荷按空趋势处理', () => {
    expect(normalizeSamplesPayload(null)).toEqual([])
    expect(normalizeSamplesPayload({ samples: 'nope' })).toEqual([])
  })
})

describe('反代统计 · 逐条查用量', () => {
  it('串行查询每条凭据，单条失败不影响其余', async () => {
    const seen: string[] = []
    const fetchImpl = makeFetch((url) => {
      seen.push(url)
      if (url.includes('/credentials/2/balance')) return jsonResponse({ error: 'boom' }, 500)
      return jsonResponse({ currentUsage: 100, usageLimit: 1000, remaining: 900 })
    })
    const progress: number[] = []
    const result = await fetchLocalAdminUsage(target(fetchImpl), ['1', '2', '3'], (done) =>
      progress.push(done)
    )

    expect(seen).toHaveLength(3)
    expect(result.usage.size).toBe(2)
    expect(result.usage.get('1')!.remaining).toBe(900)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('#2')
    expect(progress).toEqual([1, 2, 3])
  })

  it('未配置 Admin API Key 时直接报错，不发请求', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}))
    await expect(
      fetchLocalAdminUsage({ ...target(fetchImpl), adminApiKey: '  ' }, ['1'])
    ).rejects.toThrow('未配置本机 Admin API Key')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('反代统计 · 采集调度', () => {
  it('定时轮询只打 /credentials 一次，并沿用上一轮的用量缓存', async () => {
    const urls: string[] = []
    const fetchImpl = makeFetch((url) => {
      urls.push(url)
      return jsonResponse({ total: 1, available: 1, credentials: [REMOTE_CREDENTIAL] })
    })
    const previousUsage = new Map([
      ['1', { current: 400, limit: 1000, remaining: 600, percentUsed: 0.4, fetchedAt: 1 }]
    ])
    const stats = await fetchLocalAdminCredentialStats(target(fetchImpl), previousUsage)

    expect(urls).toEqual(['http://127.0.0.1:12888/api/admin/credentials'])
    expect(stats).toHaveLength(1)
    expect(stats[0].usage?.remaining).toBe(600)
  })

  it('未配置本机 Admin 时标 unconfigured 且不发任何请求', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}))
    const snapshots: string[] = []
    const manager = new LocalAdminStatsManager({
      readTarget: async () => undefined,
      fetchImpl,
      notifySnapshot: (snapshot) => snapshots.push(snapshot.status.state)
    })

    const snapshot = await manager.refreshNow()
    manager.stop()

    expect(snapshot.status.state).toBe(LOCAL_ADMIN_STATS_STATE.UNCONFIGURED)
    expect(snapshot.status.lastError).toBeUndefined()
    expect(snapshot.credentials).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(snapshots).toContain(LOCAL_ADMIN_STATS_STATE.UNCONFIGURED)
  })

  it('地址非 loopback 且非 HTTPS 时按配置问题处理，不当成抓取失败重试', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}))
    const manager = new LocalAdminStatsManager({
      readTarget: async () => ({
        baseUrl: 'http://example.com/admin',
        adminApiKey: ADMIN_KEY,
        timeoutSeconds: 5
      }),
      fetchImpl,
      notifySnapshot: () => undefined
    })

    const snapshot = await manager.refreshNow()
    manager.stop()

    expect(snapshot.status.state).toBe(LOCAL_ADMIN_STATS_STATE.UNCONFIGURED)
    expect(snapshot.status.lastError).toContain('HTTPS')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('抓取成功后状态转 healthy，凭据与总览同时可见', async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse({
        total: 2,
        available: 1,
        credentials: [
          REMOTE_CREDENTIAL,
          { ...REMOTE_CREDENTIAL, id: 2, disabled: true, failureCount: 3, isCurrent: false }
        ]
      })
    )
    const manager = new LocalAdminStatsManager({
      readTarget: async () => ({
        baseUrl: BASE_URL,
        adminApiKey: ADMIN_KEY,
        timeoutSeconds: 5
      }),
      fetchImpl,
      notifySnapshot: () => undefined
    })

    const snapshot = await manager.refreshNow()
    manager.stop()

    expect(snapshot.status.state).toBe(LOCAL_ADMIN_STATS_STATE.HEALTHY)
    expect(snapshot.status.baseUrl).toBe('http://127.0.0.1:12888/api/admin')
    expect(snapshot.totals.credentials).toBe(2)
    expect(snapshot.totals.disabled).toBe(1)
    expect(snapshot.totals.failureCount).toBe(3)
    expect(snapshot.totals.alertCount).toBe(1)
    expect(snapshot.samples.length).toBeGreaterThan(0)
  })

  it('抓取失败时状态转 failed 并保留错误原因', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({ error: 'unauthorized' }, 401))
    const manager = new LocalAdminStatsManager({
      readTarget: async () => ({
        baseUrl: BASE_URL,
        adminApiKey: ADMIN_KEY,
        timeoutSeconds: 5
      }),
      fetchImpl,
      notifySnapshot: () => undefined
    })

    const snapshot = await manager.refreshNow()
    manager.stop()

    expect(snapshot.status.state).toBe(LOCAL_ADMIN_STATS_STATE.FAILED)
    expect(snapshot.status.lastError).toContain('401')
  })

  it('手动刷新用量：查余额并把结果挂到凭据上', async () => {
    const balanceCalls: string[] = []
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith('/balance')) {
        balanceCalls.push(url)
        return jsonResponse({
          currentUsage: 9500,
          usageLimit: 10000,
          remaining: 500,
          subscriptionTitle: 'KIRO POWER'
        })
      }
      return jsonResponse({ total: 1, available: 1, credentials: [REMOTE_CREDENTIAL] })
    })
    const manager = new LocalAdminStatsManager({
      readTarget: async () => ({
        baseUrl: BASE_URL,
        adminApiKey: ADMIN_KEY,
        timeoutSeconds: 5
      }),
      fetchImpl,
      notifySnapshot: () => undefined
    })

    const summary = await manager.refreshUsageNow()
    const snapshot = manager.snapshot()
    manager.stop()

    expect(summary).toEqual({ refreshed: 1, failed: 0, errors: [] })
    expect(balanceCalls).toEqual(['http://127.0.0.1:12888/api/admin/credentials/1/balance'])
    expect(snapshot.credentials[0].usage?.remaining).toBe(500)
    // 95% 已用超过阈值，应该报额度告急
    expect(snapshot.credentials[0].alerts).toContain(LOCAL_ADMIN_ALERT.QUOTA_HIGH)
    expect(snapshot.status.lastUsageErrorCount).toBe(0)
    expect(snapshot.status.lastUsageRefreshAt).toBeGreaterThan(0)
  })

  it('并发调用刷新用量合并为一次执行，不把上游请求数翻倍', async () => {
    let balanceCalls = 0
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith('/balance')) {
        balanceCalls++
        return jsonResponse({ currentUsage: 1, usageLimit: 10, remaining: 9 })
      }
      return jsonResponse({ total: 1, available: 1, credentials: [REMOTE_CREDENTIAL] })
    })
    const manager = new LocalAdminStatsManager({
      readTarget: async () => ({
        baseUrl: BASE_URL,
        adminApiKey: ADMIN_KEY,
        timeoutSeconds: 5
      }),
      fetchImpl,
      notifySnapshot: () => undefined
    })

    const [first, second] = await Promise.all([
      manager.refreshUsageNow(),
      manager.refreshUsageNow()
    ])
    manager.stop()

    expect(first).toBe(second)
    expect(balanceCalls).toBe(1)
  })

  it('未配置 Admin 时刷新用量报错提示去任务管理配置', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}))
    const manager = new LocalAdminStatsManager({
      readTarget: async () => undefined,
      fetchImpl,
      notifySnapshot: () => undefined
    })

    await expect(manager.refreshUsageNow()).rejects.toThrow('本机 Admin')
    manager.stop()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
