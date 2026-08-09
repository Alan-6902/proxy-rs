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
  LOCAL_ADMIN_REPORT_ALL_HOURS,
  LOCAL_ADMIN_STATS_STATE,
  LOCAL_ADMIN_USAGE_WARN_RATIO,
  accumulateHourlyUsage,
  aggregateLocalAdminStats,
  buildLocalAdminReport,
  resolveLocalAdminAlerts,
  resolveReportWindow,
  selectExhaustedLocalAdminCredentials,
  toHourStart,
  toLocalDateKey,
  type LocalAdminCredentialStats,
  type LocalAdminHourlyBucket,
  type LocalAdminHourlyCredentialDelta
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

  it('解析 kiro-rs 返回的 token 统计', () => {
    const stats = toCredentialStats({
      ...REMOTE_CREDENTIAL,
      inputTokens: 6_604_122,
      outputTokens: 3_077
    })
    expect(stats!.inputTokens).toBe(6_604_122)
    expect(stats!.outputTokens).toBe(3_077)
  })

  it('旧版 kiro-rs 不返回 token 字段时保持 undefined，而不是 0', () => {
    // 必须能区分「不支持该字段」与「支持但确实是 0」，否则页面会把
    // 旧版本显示成「消耗 0」误导人
    const stats = toCredentialStats(REMOTE_CREDENTIAL)
    expect(stats!.inputTokens).toBeUndefined()
    expect(stats!.outputTokens).toBeUndefined()
  })

  it('token 字段为负数或非法值时按缺失处理', () => {
    const stats = toCredentialStats({
      ...REMOTE_CREDENTIAL,
      inputTokens: -5,
      outputTokens: 'abc' as unknown as number
    })
    expect(stats!.inputTokens).toBeUndefined()
    expect(stats!.outputTokens).toBeUndefined()
  })

  it('解析积分统计时保留小数，不像 token 那样取整', () => {
    // 上游给的是 currentUsageWithPrecision 口径的差分累计，取整会把零头抹掉
    const stats = toCredentialStats({ ...REMOTE_CREDENTIAL, usedCredits: 8_456.31 })
    expect(stats!.usedCredits).toBe(8_456.31)
  })

  it('旧版 kiro-rs 不返回积分字段时保持 undefined，而不是 0', () => {
    const stats = toCredentialStats(REMOTE_CREDENTIAL)
    expect(stats!.usedCredits).toBeUndefined()
  })

  it('积分字段为负数或非法值时按缺失处理', () => {
    expect(
      toCredentialStats({ ...REMOTE_CREDENTIAL, usedCredits: -1 })!.usedCredits
    ).toBeUndefined()
    expect(
      toCredentialStats({ ...REMOTE_CREDENTIAL, usedCredits: 'x' as unknown as number })!
        .usedCredits
    ).toBeUndefined()
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

  it('定时轮询顺带采用量：一轮里既打 /credentials 也逐条打 balance', async () => {
    const urls: string[] = []
    const fetchImpl = makeFetch((url) => {
      urls.push(url)
      if (url.endsWith('/balance')) {
        return jsonResponse({
          currentUsage: 120,
          usageLimit: 1000,
          remaining: 880,
          usagePercentage: 12
        })
      }
      return jsonResponse({ total: 1, available: 1, credentials: [REMOTE_CREDENTIAL] })
    })
    const manager = new LocalAdminStatsManager({
      readTarget: async () => ({ baseUrl: BASE_URL, adminApiKey: ADMIN_KEY, timeoutSeconds: 5 }),
      fetchImpl,
      notifySnapshot: () => undefined
    })

    const snapshot = await manager.refreshNow()
    manager.stop()

    expect(urls).toContain('http://127.0.0.1:12888/api/admin/credentials/1/balance')
    // 用量已挂到凭据上，不必再等用户手动点「刷新用量」
    expect(snapshot.credentials[0].usage?.current).toBe(120)
    expect(snapshot.totals.usageCurrent).toBe(120)
  })

  it('用量拉取失败不影响计数入库，状态仍为 healthy', async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith('/balance')) return jsonResponse({ error: 'upstream down' }, 500)
      return jsonResponse({ total: 1, available: 1, credentials: [REMOTE_CREDENTIAL] })
    })
    const manager = new LocalAdminStatsManager({
      readTarget: async () => ({ baseUrl: BASE_URL, adminApiKey: ADMIN_KEY, timeoutSeconds: 5 }),
      fetchImpl,
      notifySnapshot: () => undefined
    })

    const snapshot = await manager.refreshNow()
    manager.stop()

    expect(snapshot.status.state).toBe(LOCAL_ADMIN_STATS_STATE.HEALTHY)
    expect(snapshot.totals.successCount).toBe(142)
    expect(snapshot.credentials[0].usage).toBeUndefined()
    expect(snapshot.status.lastUsageErrorCount).toBe(1)
  })
})

describe('反代统计 · 清理额度耗尽的凭据', () => {
  /** 额度耗尽的 balance 响应，对应界面上 0.00 / 10000.00（0.0% 剩余）那种。 */
  const EXHAUSTED_BALANCE = {
    currentUsage: 10000,
    usageLimit: 10000,
    remaining: 0,
    usagePercentage: 100
  }

  function statsCredential(
    patch: Partial<LocalAdminCredentialStats> = {}
  ): LocalAdminCredentialStats {
    return {
      id: '9',
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

  it('只挑额度耗尽的：没查过用量、还有剩余、只是失败过的都不动', () => {
    const exhausted = statsCredential({
      id: '9',
      usage: { current: 10000, limit: 10000, remaining: 0, percentUsed: 1, fetchedAt: 1 },
      alerts: [LOCAL_ADMIN_ALERT.QUOTA_EXHAUSTED]
    })
    const selected = selectExhaustedLocalAdminCredentials([
      exhausted,
      // 还有剩余
      statsCredential({
        id: '1',
        usage: { current: 500, limit: 1000, remaining: 500, percentUsed: 0.5, fetchedAt: 1 },
        alerts: []
      }),
      // 用量未知：还没采到余额的新号，不能当成耗尽删掉
      statsCredential({ id: '2', alerts: [] }),
      // 只是调用失败过，可能是上游 5xx，不算账号失效
      statsCredential({ id: '3', failureCount: 7, alerts: [LOCAL_ADMIN_ALERT.FAILING] })
    ])

    expect(selected).toEqual([exhausted])
  })

  it('自动清理开启时采完用量就删，并把重新抓到的列表更新到快照', async () => {
    const cleanupExhausted = vi.fn(async (credentials: readonly LocalAdminCredentialStats[]) => ({
      checked: credentials.length,
      exhausted: 1,
      removed: 1,
      removedLocalAccounts: 1,
      removedMaskedKeys: ['ksk_...rcnS'],
      errors: []
    }))
    let deleted = false
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith('/balance')) return jsonResponse(EXHAUSTED_BALANCE)
      // 清理后再抓一次，那时候这条已经不在了
      return jsonResponse({
        total: deleted ? 0 : 1,
        available: deleted ? 0 : 1,
        credentials: deleted ? [] : [REMOTE_CREDENTIAL]
      })
    })
    const manager = new LocalAdminStatsManager({
      readTarget: async () => ({
        baseUrl: BASE_URL,
        adminApiKey: ADMIN_KEY,
        timeoutSeconds: 5,
        autoDeleteExhausted: true
      }),
      fetchImpl,
      cleanupExhausted: async (credentials) => {
        deleted = true
        return cleanupExhausted(credentials)
      },
      notifySnapshot: () => undefined
    })

    const snapshot = await manager.refreshNow()
    manager.stop()

    expect(cleanupExhausted).toHaveBeenCalledTimes(1)
    expect(cleanupExhausted.mock.calls[0][0]).toHaveLength(1)
    expect(snapshot.status.lastCleanupRemovedCount).toBe(1)
    // 删完立刻重抓，页面上那条不该等下一轮才消失
    expect(snapshot.credentials).toEqual([])
  })

  it('开关关闭时不调清理，即使有额度耗尽的凭据', async () => {
    const cleanupExhausted = vi.fn()
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith('/balance')) return jsonResponse(EXHAUSTED_BALANCE)
      return jsonResponse({ total: 1, available: 1, credentials: [REMOTE_CREDENTIAL] })
    })
    const manager = new LocalAdminStatsManager({
      readTarget: async () => ({
        baseUrl: BASE_URL,
        adminApiKey: ADMIN_KEY,
        timeoutSeconds: 5,
        autoDeleteExhausted: false
      }),
      fetchImpl,
      cleanupExhausted,
      notifySnapshot: () => undefined
    })

    const snapshot = await manager.refreshNow()
    manager.stop()

    expect(cleanupExhausted).not.toHaveBeenCalled()
    // 不删，但告警照标：用户要能在页面上看见它已经耗尽
    expect(snapshot.credentials[0].alerts).toContain(LOCAL_ADMIN_ALERT.QUOTA_EXHAUSTED)
  })

  it('没有额度耗尽的凭据时一次清理都不发起', async () => {
    const cleanupExhausted = vi.fn()
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith('/balance')) {
        return jsonResponse({ currentUsage: 100, usageLimit: 1000, remaining: 900 })
      }
      return jsonResponse({ total: 1, available: 1, credentials: [REMOTE_CREDENTIAL] })
    })
    const manager = new LocalAdminStatsManager({
      readTarget: async () => ({
        baseUrl: BASE_URL,
        adminApiKey: ADMIN_KEY,
        timeoutSeconds: 5,
        autoDeleteExhausted: true
      }),
      fetchImpl,
      cleanupExhausted,
      notifySnapshot: () => undefined
    })

    await manager.refreshNow()
    manager.stop()

    expect(cleanupExhausted).not.toHaveBeenCalled()
  })

  it('清理失败不把整轮采集判成失败，只在 lastError 留痕', async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith('/balance')) return jsonResponse(EXHAUSTED_BALANCE)
      return jsonResponse({ total: 1, available: 1, credentials: [REMOTE_CREDENTIAL] })
    })
    const manager = new LocalAdminStatsManager({
      readTarget: async () => ({
        baseUrl: BASE_URL,
        adminApiKey: ADMIN_KEY,
        timeoutSeconds: 5,
        autoDeleteExhausted: true
      }),
      fetchImpl,
      cleanupExhausted: async () => {
        throw new Error('admin refused')
      },
      notifySnapshot: () => undefined
    })

    const snapshot = await manager.refreshNow()
    manager.stop()

    expect(snapshot.status.state).toBe(LOCAL_ADMIN_STATS_STATE.HEALTHY)
    expect(snapshot.status.lastError).toContain('admin refused')
    expect(snapshot.totals.successCount).toBe(142)
  })

  it('手动清理先刷一遍用量再判，且开关关闭也照样能手动清', async () => {
    const balanceCalls: string[] = []
    let deleted = false
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith('/balance')) {
        balanceCalls.push(url)
        return jsonResponse(EXHAUSTED_BALANCE)
      }
      return jsonResponse({
        total: deleted ? 0 : 1,
        available: deleted ? 0 : 1,
        credentials: deleted ? [] : [REMOTE_CREDENTIAL]
      })
    })
    const manager = new LocalAdminStatsManager({
      readTarget: async () => ({
        baseUrl: BASE_URL,
        adminApiKey: ADMIN_KEY,
        timeoutSeconds: 5,
        // 自动清理关着，手动按钮仍要能用
        autoDeleteExhausted: false
      }),
      fetchImpl,
      cleanupExhausted: async () => {
        deleted = true
        return {
          checked: 1,
          exhausted: 1,
          removed: 1,
          removedLocalAccounts: 1,
          removedMaskedKeys: ['ksk_...ibfB'],
          errors: []
        }
      },
      notifySnapshot: () => undefined
    })

    const summary = await manager.cleanupExhaustedNow()
    manager.stop()

    // 页面上的用量可能是几分钟前采的，那之后额度可能已经重置，所以要先刷一遍
    expect(balanceCalls.length).toBeGreaterThan(0)
    expect(summary).toMatchObject({ removed: 1, removedLocalAccounts: 1 })
  })

  it('未接入清理能力时手动清理明确报错，不静默成功', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({ credentials: [] }))
    const manager = new LocalAdminStatsManager({
      readTarget: async () => ({ baseUrl: BASE_URL, adminApiKey: ADMIN_KEY, timeoutSeconds: 5 }),
      fetchImpl,
      notifySnapshot: () => undefined
    })

    await expect(manager.cleanupExhaustedNow()).rejects.toThrow('清理')
    manager.stop()
  })

  it('删掉的凭据这一小时已产生的消耗仍留在报表里', async () => {
    let deleted = false
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith('/balance')) return jsonResponse(EXHAUSTED_BALANCE)
      return jsonResponse({
        total: deleted ? 0 : 1,
        available: deleted ? 0 : 1,
        credentials: deleted ? [] : [REMOTE_CREDENTIAL]
      })
    })
    const manager = new LocalAdminStatsManager({
      readTarget: async () => ({
        baseUrl: BASE_URL,
        adminApiKey: ADMIN_KEY,
        timeoutSeconds: 5,
        autoDeleteExhausted: true
      }),
      fetchImpl,
      cleanupExhausted: async () => {
        deleted = true
        return {
          checked: 1,
          exhausted: 1,
          removed: 1,
          removedLocalAccounts: 1,
          removedMaskedKeys: ['ksk_...ibfB'],
          errors: []
        }
      },
      notifySnapshot: () => undefined
    })

    const snapshot = await manager.refreshNow()
    manager.stop()

    /*
     * 清理前必须先记账：删完再 accumulate 的话这条凭据当轮就不在列表里了，
     * 它这一小时的消耗会永久丢失，换号后那段用量就查无对证。
     */
    const hourBucket = snapshot.buckets.at(-1)
    expect(hourBucket?.credentials.map((item) => item.id)).toContain('1')
  })
})

describe('反代统计 · 小时桶差分', () => {
  const HOUR = 3_600_000
  /** 2026-08-08 10:30 本地时间，落在 10:00 那个桶里。 */
  const AT = new Date(2026, 7, 8, 10, 30).getTime()

  function credential(patch: Partial<LocalAdminCredentialStats> = {}): LocalAdminCredentialStats {
    return statsFixture({ maskedKey: 'ksk_...aaaa', ...patch })
  }

  function usage(current: number): LocalAdminCredentialStats['usage'] {
    return {
      current,
      limit: 10_000,
      remaining: 10_000 - current,
      percentUsed: current / 10_000,
      fetchedAt: 0
    }
  }

  it('首次观测只建基线，不把入库前的历史算成本小时消耗', () => {
    const result = accumulateHourlyUsage({
      buckets: [],
      cursors: [],
      credentials: [credential({ successCount: 100, usage: usage(5000) })],
      at: AT
    })

    expect(result.buckets).toHaveLength(1)
    expect(result.buckets[0].credentials[0].usageDelta).toBe(0)
    expect(result.buckets[0].credentials[0].successDelta).toBe(0)
    // 基线已记下，下一轮才开始算增量
    expect(result.cursors[0].usageCurrent).toBe(5000)
  })

  it('第二次观测按差值累加到同一个小时桶', () => {
    const first = accumulateHourlyUsage({
      buckets: [],
      cursors: [],
      credentials: [credential({ successCount: 100, usage: usage(5000) })],
      at: AT
    })
    const second = accumulateHourlyUsage({
      buckets: first.buckets,
      cursors: first.cursors,
      credentials: [credential({ successCount: 103, usage: usage(5120.5) })],
      at: AT + 60_000
    })

    expect(second.buckets).toHaveLength(1)
    const entry = second.buckets[0].credentials[0]
    expect(entry.usageDelta).toBeCloseTo(120.5, 5)
    expect(entry.successDelta).toBe(3)
    expect(entry.usageCurrent).toBe(5120.5)
  })

  it('跨小时时增量落到各自的桶里，不串到前一小时', () => {
    const first = accumulateHourlyUsage({
      buckets: [],
      cursors: [],
      credentials: [credential({ usage: usage(100) })],
      at: AT
    })
    const second = accumulateHourlyUsage({
      buckets: first.buckets,
      cursors: first.cursors,
      credentials: [credential({ usage: usage(300) })],
      at: AT + HOUR
    })

    expect(second.buckets.map((bucket) => bucket.credentials[0]?.usageDelta ?? 0)).toEqual([0, 200])
  })

  it('额度按月重置导致的回落记 0，不出现负数消耗', () => {
    const first = accumulateHourlyUsage({
      buckets: [],
      cursors: [],
      credentials: [credential({ successCount: 50, usage: usage(9800) })],
      at: AT
    })
    // 重置后累计值回到低位
    const second = accumulateHourlyUsage({
      buckets: first.buckets,
      cursors: first.cursors,
      credentials: [credential({ successCount: 50, usage: usage(12) })],
      at: AT + 60_000
    })

    expect(second.buckets[0].credentials[0].usageDelta).toBe(0)
    // 新基线要跟上，否则下一轮会把 12→之后的增长算成从 9800 起跳
    expect(second.cursors[0].usageCurrent).toBe(12)
  })

  it('Admin 重启使失败计数归零时同样记 0', () => {
    const first = accumulateHourlyUsage({
      buckets: [],
      cursors: [],
      credentials: [credential({ failureCount: 7, refreshFailureCount: 2 })],
      at: AT
    })
    const second = accumulateHourlyUsage({
      buckets: first.buckets,
      cursors: first.cursors,
      credentials: [credential({ failureCount: 0, refreshFailureCount: 0 })],
      at: AT + 60_000
    })

    expect(second.buckets[0].credentials[0].failureDelta).toBe(0)
    expect(second.buckets[0].credentials[0].refreshFailureDelta).toBe(0)
  })

  it('这一轮没查到用量时保留旧基线，避免下一轮把整段累计当成新增', () => {
    const first = accumulateHourlyUsage({
      buckets: [],
      cursors: [],
      credentials: [credential({ usage: usage(4000) })],
      at: AT
    })
    // 中间一轮 balance 挂了，凭据上没有 usage
    const second = accumulateHourlyUsage({
      buckets: first.buckets,
      cursors: first.cursors,
      credentials: [credential({ usage: undefined })],
      at: AT + 60_000
    })
    const third = accumulateHourlyUsage({
      buckets: second.buckets,
      cursors: second.cursors,
      credentials: [credential({ usage: usage(4050) })],
      at: AT + 120_000
    })

    expect(second.cursors[0].usageCurrent).toBe(4000)
    expect(third.buckets[0].credentials[0].usageDelta).toBe(50)
  })

  it('超出保留窗口的旧桶被裁掉', () => {
    const stale = accumulateHourlyUsage({
      buckets: [],
      cursors: [],
      credentials: [credential({ usage: usage(10) })],
      at: AT
    })
    const fresh = accumulateHourlyUsage({
      buckets: stale.buckets,
      cursors: stale.cursors,
      credentials: [credential({ usage: usage(20) })],
      at: AT + 200 * HOUR,
      retentionHours: 168
    })

    expect(fresh.buckets).toHaveLength(1)
    expect(fresh.buckets[0].hour).toBe(toHourStart(AT + 200 * HOUR))
  })
})

describe('反代统计 · 报表窗口', () => {
  const HOUR = 3_600_000
  const AT = new Date(2026, 7, 8, 10, 30).getTime()

  function bucketAt(
    at: number,
    deltas: Partial<LocalAdminHourlyCredentialDelta>[]
  ): LocalAdminHourlyBucket {
    return {
      hour: toHourStart(at),
      credentials: deltas.map((delta, index) => ({
        id: String(index + 1),
        usageDelta: 0,
        inputTokenDelta: 0,
        outputTokenDelta: 0,
        creditDelta: 0,
        successDelta: 0,
        failureDelta: 0,
        refreshFailureDelta: 0,
        lastSeenAt: at,
        ...delta
      }))
    }
  }

  it('按小时过滤只统计该小时，跨小时的量不混进来', () => {
    const report = buildLocalAdminReport({
      buckets: [
        bucketAt(AT, [{ id: '1', usageDelta: 100, successDelta: 2 }]),
        bucketAt(AT + HOUR, [{ id: '1', usageDelta: 900, successDelta: 9 }])
      ],
      range: { date: '2026-08-08', hour: 10 },
      now: AT
    })

    expect(report.usageDelta).toBe(100)
    expect(report.successDelta).toBe(2)
    expect(report.hoursWithData).toBe(1)
  })

  it('选全天时把当天各小时相加', () => {
    const report = buildLocalAdminReport({
      buckets: [
        bucketAt(AT, [{ id: '1', usageDelta: 100 }]),
        bucketAt(AT + HOUR, [{ id: '1', usageDelta: 900 }]),
        // 次日的量不能算进来
        bucketAt(AT + 24 * HOUR, [{ id: '1', usageDelta: 5000 }])
      ],
      range: { date: '2026-08-08', hour: LOCAL_ADMIN_REPORT_ALL_HOURS },
      now: AT
    })

    expect(report.usageDelta).toBe(1000)
    expect(report.hoursWithData).toBe(2)
  })

  it('按消耗量倒序排，并标出已从 Admin 删除的账号', () => {
    const report = buildLocalAdminReport({
      buckets: [
        bucketAt(AT, [
          { id: '1', usageDelta: 50 },
          { id: '2', usageDelta: 800 }
        ])
      ],
      range: { date: '2026-08-08', hour: 10 },
      now: AT,
      presentIds: ['1']
    })

    expect(report.rows.map((row) => row.id)).toEqual(['2', '1'])
    expect(report.rows[0].present).toBe(false)
    expect(report.rows[1].present).toBe(true)
  })

  it('水位取窗口内最后一次观测，而不是第一次', () => {
    const report = buildLocalAdminReport({
      buckets: [
        {
          hour: toHourStart(AT),
          credentials: [
            {
              id: '1',
              usageDelta: 10,
              inputTokenDelta: 0,
              outputTokenDelta: 0,
              creditDelta: 0,
              successDelta: 0,
              failureDelta: 0,
              refreshFailureDelta: 0,
              usageCurrent: 300,
              usageLimit: 10_000,
              lastSeenAt: AT + 60_000
            }
          ]
        }
      ],
      range: { date: '2026-08-08', hour: 10 },
      now: AT
    })

    expect(report.rows[0].usageCurrent).toBe(300)
    expect(report.rows[0].usageLimit).toBe(10_000)
  })

  it('本地日期串不受 UTC 偏移影响，凌晨不会算到前一天', () => {
    const earlyMorning = new Date(2026, 7, 8, 0, 30).getTime()
    expect(toLocalDateKey(earlyMorning)).toBe('2026-08-08')
    const window = resolveReportWindow({ date: '2026-08-08', hour: 0 }, earlyMorning)
    expect(window.from).toBe(new Date(2026, 7, 8, 0).getTime())
    expect(window.to).toBe(window.from + HOUR)
  })

  it('非法日期回落到当天，不抛错也不返回空窗口', () => {
    const window = resolveReportWindow(
      { date: 'not-a-date', hour: LOCAL_ADMIN_REPORT_ALL_HOURS },
      AT
    )
    expect(window.from).toBe(new Date(2026, 7, 8).getTime())
    expect(window.to).toBe(new Date(2026, 7, 9).getTime())
  })

  it('按「我的 token」倒序排，而不是按账号额度', () => {
    // #1 额度掉得多但 token 少（被别处共用），#2 才是我用得多的号
    const report = buildLocalAdminReport({
      buckets: [
        bucketAt(AT, [
          { id: '1', usageDelta: 9000, inputTokenDelta: 100, outputTokenDelta: 10 },
          { id: '2', usageDelta: 200, inputTokenDelta: 50_000, outputTokenDelta: 900 }
        ])
      ],
      range: { date: '2026-08-08', hour: 10 },
      now: AT
    })

    expect(report.rows.map((row) => row.id)).toEqual(['2', '1'])
    expect(report.inputTokenDelta).toBe(50_100)
    expect(report.outputTokenDelta).toBe(910)
  })

  it('老桶没有 token 字段时按 0 计，不产生 NaN', () => {
    const legacyBucket: LocalAdminHourlyBucket = {
      hour: toHourStart(AT),
      credentials: [
        {
          id: '1',
          usageDelta: 500,
          successDelta: 3,
          failureDelta: 0,
          refreshFailureDelta: 0,
          lastSeenAt: AT
          // inputTokenDelta / outputTokenDelta 缺失，模拟升级前落的桶
        } as unknown as LocalAdminHourlyCredentialDelta
      ]
    }
    const report = buildLocalAdminReport({
      buckets: [legacyBucket],
      range: { date: '2026-08-08', hour: 10 },
      now: AT
    })

    expect(report.inputTokenDelta).toBe(0)
    expect(report.outputTokenDelta).toBe(0)
    expect(Number.isNaN(report.inputTokenDelta)).toBe(false)
    // 额度口径不受影响，老数据仍可读
    expect(report.usageDelta).toBe(500)
  })
})

describe('反代统计 · token 差分', () => {
  const AT = new Date(2026, 7, 8, 10, 30).getTime()

  function credential(patch: Partial<LocalAdminCredentialStats> = {}): LocalAdminCredentialStats {
    return statsFixture({ maskedKey: 'ksk_...aaaa', ...patch })
  }

  it('两轮观测按差值累加 token，与账号额度各自独立', () => {
    const first = accumulateHourlyUsage({
      buckets: [],
      cursors: [],
      credentials: [credential({ inputTokens: 1_000, outputTokens: 100 })],
      at: AT
    })
    const second = accumulateHourlyUsage({
      buckets: first.buckets,
      cursors: first.cursors,
      credentials: [credential({ inputTokens: 1_450, outputTokens: 180 })],
      at: AT + 60_000
    })

    const entry = second.buckets[0].credentials[0]
    expect(entry.inputTokenDelta).toBe(450)
    expect(entry.outputTokenDelta).toBe(80)
    // 没查用量时额度增量保持 0，不会被 token 带上
    expect(entry.usageDelta).toBe(0)
  })

  it('kiro-rs 重启使 token 计数归零时记 0，不出现负值', () => {
    const first = accumulateHourlyUsage({
      buckets: [],
      cursors: [],
      credentials: [credential({ inputTokens: 900_000, outputTokens: 5_000 })],
      at: AT
    })
    const second = accumulateHourlyUsage({
      buckets: first.buckets,
      cursors: first.cursors,
      credentials: [credential({ inputTokens: 120, outputTokens: 8 })],
      at: AT + 60_000
    })

    const entry = second.buckets[0].credentials[0]
    expect(entry.inputTokenDelta).toBe(0)
    expect(entry.outputTokenDelta).toBe(0)
    // 新基线要跟上，否则下一轮会把 120 之后的增长当成从 900000 起跳
    expect(second.cursors[0].inputTokens).toBe(120)
  })

  it('kiro-rs 不支持 token 时不记增量，也不把基线写成 0', () => {
    const state = accumulateHourlyUsage({
      buckets: [],
      cursors: [],
      credentials: [credential({ inputTokens: undefined, outputTokens: undefined })],
      at: AT
    })

    expect(state.buckets[0].credentials[0].inputTokenDelta).toBe(0)
    expect(state.cursors[0].inputTokens).toBeUndefined()
  })

  it('总览把各凭据的 token 相加，缺字段的按 0 计', () => {
    const totals = aggregateLocalAdminStats([
      statsFixture({ id: '1', inputTokens: 1_000, outputTokens: 50 }),
      statsFixture({ id: '2', inputTokens: 20, outputTokens: 5 }),
      statsFixture({ id: '3' })
    ])

    expect(totals.inputTokens).toBe(1_020)
    expect(totals.outputTokens).toBe(55)
  })
})

describe('反代统计 · 积分差分', () => {
  const AT = new Date(2026, 7, 8, 10, 30).getTime()

  function credential(patch: Partial<LocalAdminCredentialStats> = {}): LocalAdminCredentialStats {
    return statsFixture({ maskedKey: 'ksk_...aaaa', ...patch })
  }

  it('两轮观测按差值累加积分，保留小数', () => {
    const first = accumulateHourlyUsage({
      buckets: [],
      cursors: [],
      credentials: [credential({ usedCredits: 100.5 })],
      at: AT
    })
    const second = accumulateHourlyUsage({
      buckets: first.buckets,
      cursors: first.cursors,
      credentials: [credential({ usedCredits: 126.94 })],
      at: AT + 60_000
    })

    // 积分是小数口径，取整会把零头抹掉
    expect(second.buckets[0].credentials[0].creditDelta).toBeCloseTo(26.44, 2)
  })

  it('kiro-rs 重启使积分归零时记 0，不出现负值', () => {
    const first = accumulateHourlyUsage({
      buckets: [],
      cursors: [],
      credentials: [credential({ usedCredits: 8_456.31 })],
      at: AT
    })
    const second = accumulateHourlyUsage({
      buckets: first.buckets,
      cursors: first.cursors,
      credentials: [credential({ usedCredits: 12.5 })],
      at: AT + 60_000
    })

    expect(second.buckets[0].credentials[0].creditDelta).toBe(0)
    // 新基线要跟上，否则下一轮会把 12.5 之后的增长当成从 8456.31 起跳
    expect(second.cursors[0].usedCredits).toBe(12.5)
  })

  it('kiro-rs 不支持积分时不记增量，也不把基线写成 0', () => {
    const state = accumulateHourlyUsage({
      buckets: [],
      cursors: [],
      credentials: [credential({ usedCredits: undefined })],
      at: AT
    })

    expect(state.buckets[0].credentials[0].creditDelta).toBe(0)
    expect(state.cursors[0].usedCredits).toBeUndefined()
  })

  it('换号时作废旧基线，不把新号的历史累计算成本轮消耗', () => {
    const first = accumulateHourlyUsage({
      buckets: [],
      cursors: [],
      credentials: [credential({ maskedKey: 'ksk_...old', usedCredits: 5_000 })],
      at: AT
    })
    // 同一个 id 换成另一个号，新号自己已经消耗了 3000 分
    const second = accumulateHourlyUsage({
      buckets: first.buckets,
      cursors: first.cursors,
      credentials: [credential({ maskedKey: 'ksk_...new', usedCredits: 3_000 })],
      at: AT + 60_000
    })

    expect(second.buckets[0].credentials[0].creditDelta).toBe(0)
    expect(second.cursors[0].usedCredits).toBe(3_000)
  })

  it('总览把各凭据的积分相加，缺字段的按 0 计', () => {
    const totals = aggregateLocalAdminStats([
      statsFixture({ id: '1', usedCredits: 26.44 }),
      statsFixture({ id: '2', usedCredits: 3.5 }),
      statsFixture({ id: '3' })
    ])

    expect(totals.usedCredits).toBeCloseTo(29.94, 2)
  })

  it('报表按积分降序排，积分缺失时退回按 token 排', () => {
    const withCredits = buildLocalAdminReport({
      buckets: [
        {
          hour: toHourStart(AT),
          credentials: [
            {
              id: '1',
              usageDelta: 0,
              inputTokenDelta: 900_000,
              outputTokenDelta: 0,
              creditDelta: 5,
              successDelta: 0,
              failureDelta: 0,
              refreshFailureDelta: 0,
              lastSeenAt: AT
            },
            {
              id: '2',
              usageDelta: 0,
              inputTokenDelta: 10,
              outputTokenDelta: 0,
              creditDelta: 80,
              successDelta: 0,
              failureDelta: 0,
              refreshFailureDelta: 0,
              lastSeenAt: AT
            }
          ]
        }
      ],
      range: { date: toLocalDateKey(AT), hour: new Date(AT).getHours() },
      now: AT
    })

    // 积分多的排前面，即使它的 token 少得多
    expect(withCredits.rows.map((row) => row.id)).toEqual(['2', '1'])
    expect(withCredits.creditDelta).toBe(85)
  })
})

describe('反代统计 · id 复用（换号）', () => {
  const AT = new Date(2026, 7, 9, 12, 0).getTime()

  function cred(
    maskedKey: string | undefined,
    inputTokens: number,
    successCount: number
  ): LocalAdminCredentialStats {
    return statsFixture({ id: '1', maskedKey, inputTokens, outputTokens: 0, successCount })
  }

  /*
   * 线上实测的事故：Admin 的凭据 id 会被复用（删掉 #1 再建一条还是 #1），实测同一个
   * id=1 先后对应过 5 个不同的号。新号计数从 0 起，而游标存着旧号的大数值，差分只防
   * 回落、不防「换号后重新爬升」，于是新号 0→N 的整段被当成增量，每换一次号叠加一次。
   * 结果把 386 万的真实消耗记成了 2016 万（多算 5 倍）。
   */
  /*
   * 关键是新号的累计要「超过」旧基线才会暴露 bug：低于旧基线时 diff 的回落保护
   * 已经记 0，看不出问题。线上正是这种情形——旧号被删时计数不高，新号很快爬过它。
   */
  it('换号后新号累计超过旧基线时，不把差额当成增量', () => {
    // 旧号建立基线：首轮无基线，按首次观测记 0
    let state = accumulateHourlyUsage({
      buckets: [],
      cursors: [],
      credentials: [cred('ksk_...ItFd', 100_000, 10)],
      at: AT
    })
    expect(state.buckets[0].credentials[0].inputTokenDelta).toBe(0)

    // 换号：新号复用 id=1，自身已累计 500_000，超过旧基线 100_000
    state = accumulateHourlyUsage({
      buckets: state.buckets,
      cursors: state.cursors,
      credentials: [cred('ksk_...tb0E', 500_000, 50)],
      at: AT + 60_000
    })
    // 修复前这里会记 400_000（新号历史被当成本轮增量），修复后按首次观测记 0
    expect(state.buckets[0].credentials[0].inputTokenDelta).toBe(0)
    expect(state.buckets[0].credentials[0].successDelta).toBe(0)

    // 下一轮起按新号自己的基线正常累加
    state = accumulateHourlyUsage({
      buckets: state.buckets,
      cursors: state.cursors,
      credentials: [cred('ksk_...tb0E', 504_125, 51)],
      at: AT + 120_000
    })
    expect(state.buckets[0].credentials[0].inputTokenDelta).toBe(4_125)
    expect(state.buckets[0].credentials[0].successDelta).toBe(1)
    expect(state.cursors.find((c) => c.id === '1')?.maskedKey).toBe('ksk_...tb0E')
  })

  it('maskedKey 未变时照常累加，不误判为换号', () => {
    let state = accumulateHourlyUsage({
      buckets: [],
      cursors: [],
      credentials: [cred('ksk_...tb0E', 1_000, 1)],
      at: AT
    })
    state = accumulateHourlyUsage({
      buckets: state.buckets,
      cursors: state.cursors,
      credentials: [cred('ksk_...tb0E', 5_125, 2)],
      at: AT + 60_000
    })

    expect(state.buckets[0].credentials[0].inputTokenDelta).toBe(4_125)
  })

  it('老数据缺 maskedKey 时按同一条凭据处理，不因缺字段丢增量', () => {
    let state = accumulateHourlyUsage({
      buckets: [],
      cursors: [],
      credentials: [cred(undefined, 1_000, 1)],
      at: AT
    })
    state = accumulateHourlyUsage({
      buckets: state.buckets,
      cursors: state.cursors,
      credentials: [cred(undefined, 3_000, 2)],
      at: AT + 60_000
    })

    expect(state.buckets[0].credentials[0].inputTokenDelta).toBe(2_000)
  })
})
