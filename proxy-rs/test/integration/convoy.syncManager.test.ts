// 同步器编排：概览预检、门禁阻断、原子替换、状态迁移、区域探测、账号池注入

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConvoySyncManager } from '../../src/main/convoy/syncManager'
import { probeKeyRegion } from '../../src/main/convoy/regionProbe'
import type { ConvoyFetch } from '../../src/main/convoy/client'
import {
  CONVOY_REGION_PROBE_ORDER,
  CONVOY_STATE,
  DEFAULT_CONVOY_SYNC_CONFIG,
  type ConvoySyncConfig,
  type ConvoySyncStatus
} from '../../src/shared/convoyCredentials'

const BASE_URL = 'http://kiro.example.com/api/user'
const CONVOY_KEY = 'convoy-login-key-9999'
const API_KEY = 'ksk_pulledKey123456'

interface PoolInput {
  credentials: { id: string; apiKey?: string; accessToken?: string; region?: string; expiresAt?: number }[]
  manualKeys: { id: string; apiKey: string; region: string; email?: string }[]
}

/** 按 URL 路径分派响应；每个路径可给一个队列，末项重复使用 */
function routedFetch(routes: Record<string, { status?: number; body?: unknown }[]>): {
  fetchImpl: ConvoyFetch
  calls: string[]
} {
  const queues: Record<string, { status?: number; body?: unknown }[]> = {}
  for (const [key, value] of Object.entries(routes)) queues[key] = [...value]
  const calls: string[] = []

  const fetchImpl: ConvoyFetch = async (url) => {
    calls.push(url)
    const matchedKey = Object.keys(queues).find((key) => url.endsWith(key))
    if (!matchedKey) throw new Error(`unexpected url ${url}`)
    const queue = queues[matchedKey]
    const next = queue.length > 1 ? queue.shift()! : queue[0]
    const status = next.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(next.body ?? {})
    }
  }
  return { fetchImpl, calls }
}

function makeManager(options: {
  fetchImpl: ConvoyFetch
  config?: Partial<ConvoySyncConfig>
  convoyKey?: string
  verifyOk?: boolean
}): {
  manager: ConvoySyncManager
  poolInputs: PoolInput[]
  statuses: ConvoySyncStatus[]
} {
  const poolInputs: PoolInput[] = []
  const statuses: ConvoySyncStatus[] = []
  const config: ConvoySyncConfig = {
    ...DEFAULT_CONVOY_SYNC_CONFIG,
    enabled: true,
    baseUrl: BASE_URL,
    allowInsecureHttp: true,
    allowInitialCharge: true,
    ...options.config
  }

  const manager = new ConvoySyncManager({
    readConfig: async () => config,
    readConvoyKey: async () => options.convoyKey ?? CONVOY_KEY,
    fetchImpl: options.fetchImpl,
    verifyKeyRegion: async ({ region }) =>
      options.verifyOk === false
        ? { ok: false, error: `region ${region} rejected` }
        : { ok: true, email: 'probe@example.com' },
    applyToAccountPool: (input) => poolInputs.push(input),
    notifyStatus: (status) => statuses.push(status),
    log: () => {}
  })
  return { manager, poolInputs, statuses }
}

function summaryBody(activeIds: string[], fare = 2.0): Record<string, unknown> {
  return {
    onBoard: true,
    autoConvoyId: 42,
    autoConvoyTitle: '示例自动车',
    convoy: { fare },
    credentialSummary: activeIds.map((id) => ({ credentialId: id, status: 'active' }))
  }
}

function credentialsBody(ids: string[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    autoConvoyId: 42,
    credentials: ids.map((id) => ({
      credentialId: id,
      status: 'active',
      newlyCharged: true,
      charged: 2.0,
      aliveSecs: 600,
      credential: { type: 'api_key', apiKey: `${API_KEY}${id}` }
    })),
    newlyChargedCount: ids.length,
    totalCharged: 2.0 * ids.length,
    balanceAfter: 97.0,
    insufficientCount: 0,
    ...overrides
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('正常同步路径', () => {
  it('一轮拉取把全部有效凭证注入账号池', async () => {
    const { fetchImpl } = routedFetch({
      '/me/auto-ride': [{ body: summaryBody(['1', '2']) }],
      '/me/auto-ride/credentials': [{ body: credentialsBody(['1', '2']) }]
    })
    const { manager, poolInputs } = makeManager({ fetchImpl })

    const result = await manager.runOnce()
    expect(result.success).toBe(true)

    const status = await manager.buildStatus()
    expect(status.state).toBe(CONVOY_STATE.HEALTHY)
    expect(status.snapshot?.activeCount).toBe(2)
    expect(status.snapshot?.versionShort).toHaveLength(8)
    // 权威计费字段以完整接口返回为准
    expect(status.snapshot?.newlyChargedCount).toBe(2)
    expect(status.snapshot?.totalChargedCents).toBe(400)
    expect(status.balanceAfterCents).toBe(9700)
    expect(status.todayChargedCents).toBe(400)

    const lastPool = poolInputs.at(-1)!
    expect(lastPool.credentials.map((c) => c.id)).toEqual(['1', '2'])
    expect(lastPool.credentials[0].apiKey).toBe(`${API_KEY}1`)
  })

  it('第二轮同 ID 不再计入本地新增，因此门禁不会因上限拦下', async () => {
    const { fetchImpl, calls } = routedFetch({
      '/me/auto-ride': [{ body: summaryBody(['1', '2']) }],
      '/me/auto-ride/credentials': [{ body: credentialsBody(['1', '2']) }]
    })
    // 单次上限 2：第一轮刚好放行，第二轮若仍算「新增 2 个」就会被拦
    const { manager } = makeManager({ fetchImpl, config: { maxNewCredentialsPerPull: 2 } })

    expect((await manager.runOnce()).success).toBe(true)
    expect((await manager.runOnce()).success).toBe(true)

    const status = await manager.buildStatus()
    expect(status.state).toBe(CONVOY_STATE.HEALTHY)
    // 两轮都真的调了完整接口（方案 6.2：不能靠 ID 比对跳过完整拉取）
    expect(calls.filter((url) => url.endsWith('/credentials'))).toHaveLength(2)
  })

  it('同 ID 内容变化能在下一轮被发现', async () => {
    const rotated = credentialsBody(['1'])
    ;(rotated.credentials as Record<string, unknown>[])[0].credential = {
      type: 'api_key',
      apiKey: 'ksk_rotatedKey999'
    }
    const { fetchImpl } = routedFetch({
      '/me/auto-ride': [{ body: summaryBody(['1']) }],
      '/me/auto-ride/credentials': [{ body: credentialsBody(['1']) }, { body: rotated }]
    })
    const { manager, poolInputs } = makeManager({ fetchImpl })

    await manager.runOnce()
    const firstVersion = (await manager.buildStatus()).snapshot!.version
    await manager.runOnce()
    const secondStatus = await manager.buildStatus()

    expect(secondStatus.snapshot!.version).not.toBe(firstVersion)
    expect(poolInputs.at(-1)!.credentials[0].apiKey).toBe('ksk_rotatedKey999')
  })

  it('合法空列表清空可分配池', async () => {
    const { fetchImpl } = routedFetch({
      '/me/auto-ride': [{ body: summaryBody(['1']) }, { body: summaryBody([]) }],
      '/me/auto-ride/credentials': [
        { body: credentialsBody(['1']) },
        { body: credentialsBody([]) }
      ]
    })
    const { manager, poolInputs } = makeManager({ fetchImpl })

    await manager.runOnce()
    expect(poolInputs.at(-1)!.credentials).toHaveLength(1)

    await manager.runOnce()
    expect(poolInputs.at(-1)!.credentials).toHaveLength(0)
    expect((await manager.buildStatus()).snapshot?.activeCount).toBe(0)
  })

  it('未发放与低余额进入告警', async () => {
    const { fetchImpl } = routedFetch({
      '/me/auto-ride': [{ body: summaryBody(['1']) }],
      '/me/auto-ride/credentials': [
        { body: credentialsBody(['1'], { insufficientCount: 2, balanceAfter: 1.0 }) }
      ]
    })
    const { manager } = makeManager({ fetchImpl, config: { minBalanceAlertCents: 2000 } })
    await manager.runOnce()

    const alertKinds = (await manager.buildStatus()).alerts.map((a) => a.kind)
    expect(alertKinds).toContain('insufficient')
    expect(alertKinds).toContain('low_balance')
  })
})

describe('计费门禁拦在完整接口之前', () => {
  it('首次启动默认不调用计费接口，只给出预估', async () => {
    const { fetchImpl, calls } = routedFetch({
      '/me/auto-ride': [{ body: summaryBody(['1', '2', '3']) }],
      '/me/auto-ride/credentials': [{ body: credentialsBody(['1', '2', '3']) }]
    })
    const { manager } = makeManager({ fetchImpl, config: { allowInitialCharge: false } })

    const result = await manager.runOnce()
    expect(result.success).toBe(false)
    expect(calls.some((url) => url.endsWith('/credentials'))).toBe(false)

    const status = await manager.buildStatus()
    expect(status.state).toBe(CONVOY_STATE.BLOCKED)
    expect(status.pendingInitialEstimate).toEqual({
      credentialCount: 3,
      estimatedChargeCents: 600
    })
    expect(status.blockedReason).toContain('首次拉取')
  })

  it('新增数量超上限时不调用完整接口', async () => {
    const { fetchImpl, calls } = routedFetch({
      '/me/auto-ride': [{ body: summaryBody(['1', '2', '3', '4']) }],
      '/me/auto-ride/credentials': [{ body: credentialsBody(['1']) }]
    })
    const { manager } = makeManager({ fetchImpl, config: { maxNewCredentialsPerPull: 2 } })

    expect((await manager.runOnce()).success).toBe(false)
    expect(calls.some((url) => url.endsWith('/credentials'))).toBe(false)
    expect((await manager.buildStatus()).state).toBe(CONVOY_STATE.BLOCKED)
  })

  it('单次金额超上限时不调用完整接口', async () => {
    const { fetchImpl, calls } = routedFetch({
      '/me/auto-ride': [{ body: summaryBody(['1', '2'], 50) }],
      '/me/auto-ride/credentials': [{ body: credentialsBody(['1']) }]
    })
    const { manager } = makeManager({ fetchImpl, config: { maxChargePerPullCents: 1000 } })

    expect((await manager.runOnce()).success).toBe(false)
    expect(calls.some((url) => url.endsWith('/credentials'))).toBe(false)
  })

  it('当日累计触上限后进入阻断', async () => {
    const { fetchImpl } = routedFetch({
      '/me/auto-ride': [{ body: summaryBody(['1']) }, { body: summaryBody(['1', '2']) }],
      '/me/auto-ride/credentials': [{ body: credentialsBody(['1'], { totalCharged: 8.0 }) }]
    })
    const { manager } = makeManager({ fetchImpl, config: { dailyChargeLimitCents: 900 } })

    // 第一轮实际计费 8 元
    expect((await manager.runOnce()).success).toBe(true)
    expect((await manager.buildStatus()).todayChargedCents).toBe(800)

    // 第二轮预估再加 2 元 → 超过 9 元每日上限
    expect((await manager.runOnce()).success).toBe(false)
    const status = await manager.buildStatus()
    expect(status.state).toBe(CONVOY_STATE.BLOCKED)
    expect(status.alerts.some((a) => a.kind === 'billing_limit')).toBe(true)
  })

  it('未上车时不调用完整接口', async () => {
    const { fetchImpl, calls } = routedFetch({
      '/me/auto-ride': [{ body: { onBoard: false, credentialSummary: [] } }],
      '/me/auto-ride/credentials': [{ body: credentialsBody(['1']) }]
    })
    const { manager } = makeManager({ fetchImpl })

    expect((await manager.runOnce()).success).toBe(false)
    expect(calls.some((url) => url.endsWith('/credentials'))).toBe(false)

    const status = await manager.buildStatus()
    expect(status.state).toBe(CONVOY_STATE.NOT_ON_BOARD)
    expect(status.alerts.some((a) => a.kind === 'not_on_board')).toBe(true)
  })
})

describe('失败不破坏最后有效快照', () => {
  async function primeThenFail(failure: { status?: number; body?: unknown }): Promise<{
    manager: ConvoySyncManager
    goodVersion: string
  }> {
    const { fetchImpl } = routedFetch({
      '/me/auto-ride': [{ body: summaryBody(['1']) }],
      '/me/auto-ride/credentials': [{ body: credentialsBody(['1']) }, failure]
    })
    const { manager } = makeManager({ fetchImpl })
    await manager.runOnce()
    const goodVersion = (await manager.buildStatus()).snapshot!.version
    await manager.runOnce()
    return { manager, goodVersion }
  }

  it('5xx 后旧快照保持不变，状态降级', async () => {
    const { manager, goodVersion } = await primeThenFail({ status: 503, body: {} })
    const status = await manager.buildStatus()
    expect(status.snapshot!.version).toBe(goodVersion)
    expect(status.state).toBe(CONVOY_STATE.DEGRADED)
    expect(status.consecutiveFailures).toBe(1)
  })

  it('JSON 格式异常后旧快照保持不变', async () => {
    const { manager, goodVersion } = await primeThenFail({ body: { credentials: 'nope' } })
    const status = await manager.buildStatus()
    expect(status.snapshot!.version).toBe(goodVersion)
    expect(status.state).toBe(CONVOY_STATE.DEGRADED)
  })

  it('单条凭证违反契约时整份候选快照被拒', async () => {
    const { manager, goodVersion } = await primeThenFail({
      body: {
        credentials: [
          { credentialId: '1', status: 'active', newlyCharged: false, charged: 0, credential: { type: 'api_key', apiKey: 'ksk_ok1' } },
          { credentialId: '2', status: 'active', newlyCharged: false, charged: 0, credential: { type: 'magic' } }
        ],
        newlyChargedCount: 0,
        totalCharged: 0
      }
    })
    const status = await manager.buildStatus()
    // 合法的那条也不能单独进池
    expect(status.snapshot!.version).toBe(goodVersion)
    expect(status.snapshot!.credentials.map((c) => c.id)).toEqual(['1'])
    expect(status.lastError).toContain('候选快照被拒绝')
  })

  it('401 进入未授权状态并告警', async () => {
    const { manager, goodVersion } = await primeThenFail({
      status: 401,
      body: { error: { message: 'key revoked' } }
    })
    const status = await manager.buildStatus()
    expect(status.state).toBe(CONVOY_STATE.UNAUTHORIZED)
    expect(status.snapshot!.version).toBe(goodVersion)
    expect(status.alerts.some((a) => a.kind === 'unauthorized')).toBe(true)
  })

  it('403 同样进入未授权状态', async () => {
    const { manager } = await primeThenFail({ status: 403, body: {} })
    expect((await manager.buildStatus()).state).toBe(CONVOY_STATE.UNAUTHORIZED)
  })

  it('连续 3 轮失败触发告警', async () => {
    const { fetchImpl } = routedFetch({
      '/me/auto-ride': [{ status: 500, body: {} }]
    })
    const { manager } = makeManager({ fetchImpl })
    await manager.runOnce()
    await manager.runOnce()
    expect((await manager.buildStatus()).alerts.some((a) => a.kind === 'pull_failed')).toBe(false)
    await manager.runOnce()

    const status = await manager.buildStatus()
    expect(status.consecutiveFailures).toBe(3)
    expect(status.alerts.some((a) => a.kind === 'pull_failed')).toBe(true)
  })
})

describe('配置与调度约束', () => {
  it('未启用或未配置登录 Key 时进入 idle 且不发请求', async () => {
    const { fetchImpl, calls } = routedFetch({ '/me/auto-ride': [{ body: summaryBody([]) }] })
    const disabled = makeManager({ fetchImpl, config: { enabled: false } })
    expect((await disabled.manager.runOnce()).success).toBe(false)

    const noKey = makeManager({ fetchImpl, convoyKey: '   ' })
    expect((await noKey.manager.runOnce()).success).toBe(false)
    expect(calls).toHaveLength(0)
    expect((await noKey.manager.buildStatus()).state).toBe(CONVOY_STATE.IDLE)
  })

  it('明文 HTTP 未放行时拒绝，且发出安全告警前不发请求', async () => {
    const { fetchImpl, calls } = routedFetch({ '/me/auto-ride': [{ body: summaryBody([]) }] })
    const { manager } = makeManager({ fetchImpl, config: { allowInsecureHttp: false } })

    expect((await manager.runOnce()).success).toBe(false)
    expect(calls).toHaveLength(0)
    expect((await manager.buildStatus()).lastError).toContain('明文 HTTP')
  })

  it('放行明文 HTTP 后发出高优先级安全告警，且只报一次', async () => {
    const { fetchImpl } = routedFetch({
      '/me/auto-ride': [{ body: summaryBody(['1']) }],
      '/me/auto-ride/credentials': [{ body: credentialsBody(['1']) }]
    })
    const { manager } = makeManager({ fetchImpl })
    await manager.runOnce()
    await manager.runOnce()

    const insecureAlerts = (await manager.buildStatus()).alerts.filter(
      (a) => a.kind === 'insecure_http'
    )
    expect(insecureAlerts).toHaveLength(1)
    expect(insecureAlerts[0].message).toContain('kiro.example.com')
  })

  it('上一轮未结束时 runOnce 直接拒绝，不产生任务重叠', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchImpl: ConvoyFetch = async () => {
      await gate
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ onBoard: false, credentialSummary: [] })
      }
    }
    const { manager } = makeManager({ fetchImpl })

    const first = manager.runOnce()
    const second = await manager.runOnce()
    expect(second.success).toBe(false)
    expect(second.error).toContain('尚未结束')

    release?.()
    await first
  })

  it('登录 Key 状态只回传布尔与尾 4 位', async () => {
    const { fetchImpl } = routedFetch({ '/me/auto-ride': [{ body: summaryBody([]) }] })
    const { manager } = makeManager({ fetchImpl })
    const status = await manager.buildStatus()

    expect(status.hasConvoyKey).toBe(true)
    expect(status.convoyKeyTail).toBe('***9999')
    expect(JSON.stringify(status)).not.toContain(CONVOY_KEY)
  })

  it('clearSnapshot 清空快照并摘掉池内凭证', async () => {
    const { fetchImpl } = routedFetch({
      '/me/auto-ride': [{ body: summaryBody(['1']) }],
      '/me/auto-ride/credentials': [{ body: credentialsBody(['1']) }]
    })
    const { manager, poolInputs } = makeManager({ fetchImpl })
    await manager.runOnce()
    expect(poolInputs.at(-1)!.credentials).toHaveLength(1)

    manager.clearSnapshot()
    expect(poolInputs.at(-1)!.credentials).toHaveLength(0)
    expect((await manager.buildStatus()).snapshot).toBeNull()
  })
})

describe('手填 Key 与区域探测', () => {
  it('未指定区域时按候选顺序探测，命中即停', async () => {
    const attempted: string[] = []
    const probe = await probeKeyRegion('ksk_manualKey01', undefined, async ({ region }) => {
      attempted.push(region)
      // 第一个候选失败，第二个成功
      return region === CONVOY_REGION_PROBE_ORDER[1]
        ? { ok: true, email: 'hit@example.com' }
        : { ok: false, error: 'HTTP 403' }
    })

    expect(probe.ok).toBe(true)
    expect(probe.region).toBe(CONVOY_REGION_PROBE_ORDER[1])
    expect(attempted).toEqual([...CONVOY_REGION_PROBE_ORDER])
    expect(probe.email).toBe('hit@example.com')
  })

  it('第一个候选就成功时不再试后续区域', async () => {
    const attempted: string[] = []
    const probe = await probeKeyRegion('ksk_manualKey01', undefined, async ({ region }) => {
      attempted.push(region)
      return { ok: true }
    })
    expect(probe.region).toBe(CONVOY_REGION_PROBE_ORDER[0])
    expect(attempted).toEqual([CONVOY_REGION_PROBE_ORDER[0]])
  })

  it('显式指定区域时只试该区域，不悄悄换区', async () => {
    const attempted: string[] = []
    const probe = await probeKeyRegion('ksk_manualKey01', 'eu-central-1', async ({ region }) => {
      attempted.push(region)
      return { ok: false, error: 'HTTP 403' }
    })
    expect(attempted).toEqual(['eu-central-1'])
    expect(probe.ok).toBe(false)
  })

  it('全部候选失败时汇总错误并列出试过的区域', async () => {
    const probe = await probeKeyRegion('ksk_manualKey01', undefined, async () => ({
      ok: false,
      error: 'HTTP 403 forbidden'
    }))
    expect(probe.ok).toBe(false)
    expect(probe.probedRegions).toEqual([...CONVOY_REGION_PROBE_ORDER])
    expect(probe.error).toContain('HTTP 403 forbidden')
  })

  it('验活抛错也算该区域失败，继续试下一个', async () => {
    const probe = await probeKeyRegion('ksk_manualKey01', undefined, async ({ region }) => {
      if (region === CONVOY_REGION_PROBE_ORDER[0]) throw new Error('network down')
      return { ok: true }
    })
    expect(probe.ok).toBe(true)
    expect(probe.region).toBe(CONVOY_REGION_PROBE_ORDER[1])
  })

  it('key 格式非法时不发任何验活请求', async () => {
    let called = 0
    const probe = await probeKeyRegion('not-a-kiro-key', undefined, async () => {
      called++
      return { ok: true }
    })
    expect(probe.ok).toBe(false)
    expect(called).toBe(0)
    expect(probe.error).toContain('格式非法')
  })

  it('区域格式非法时不发验活请求', async () => {
    let called = 0
    const probe = await probeKeyRegion('ksk_manualKey01', 'US_EAST_1', async () => {
      called++
      return { ok: true }
    })
    expect(probe.ok).toBe(false)
    expect(called).toBe(0)
  })

  it('探测成功的手填 Key 注入账号池，失败的不注入', async () => {
    const { fetchImpl } = routedFetch({ '/me/auto-ride': [{ body: summaryBody([]) }] })
    const { manager, poolInputs } = makeManager({ fetchImpl })

    const results = await manager.setManualKeys([
      { id: 'a', key: 'ksk_goodKey0001' },
      { id: 'b', key: 'bad-key' }
    ])

    expect(results[0].ok).toBe(true)
    expect(results[0].resolvedRegion).toBe(CONVOY_REGION_PROBE_ORDER[0])
    expect(results[1].ok).toBe(false)

    const pooled = poolInputs.at(-1)!.manualKeys
    expect(pooled).toHaveLength(1)
    expect(pooled[0]).toMatchObject({ id: 'a', apiKey: 'ksk_goodKey0001' })
  })

  it('手填 Key 的结果只以脱敏形式对外暴露', async () => {
    const { fetchImpl } = routedFetch({ '/me/auto-ride': [{ body: summaryBody([]) }] })
    const { manager } = makeManager({ fetchImpl })
    await manager.setManualKeys([{ id: 'a', key: 'ksk_secretManualKey' }])

    const status = await manager.buildStatus()
    expect(JSON.stringify(status.manualKeys)).not.toContain('ksk_secretManualKey')
    expect(status.manualKeys[0].maskedKey).toBe('ksk_...lKey')
  })

  it('手填 Key 与自动车拉取相互独立：同步未启用也能注入', async () => {
    const { fetchImpl, calls } = routedFetch({ '/me/auto-ride': [{ body: summaryBody([]) }] })
    const { manager, poolInputs } = makeManager({ fetchImpl, config: { enabled: false } })

    await manager.setManualKeys([{ id: 'a', key: 'ksk_standalone01', region: 'us-east-1' }])
    expect(poolInputs.at(-1)!.manualKeys).toHaveLength(1)
    // 只走验活探测，不碰自动车接口
    expect(calls).toHaveLength(0)
  })

  it('clearManualKeys 从池里摘掉全部手填 Key', async () => {
    const { fetchImpl } = routedFetch({ '/me/auto-ride': [{ body: summaryBody([]) }] })
    const { manager, poolInputs } = makeManager({ fetchImpl })
    await manager.setManualKeys([{ id: 'a', key: 'ksk_goodKey0001' }])
    expect(poolInputs.at(-1)!.manualKeys).toHaveLength(1)

    manager.clearManualKeys()
    expect(poolInputs.at(-1)!.manualKeys).toHaveLength(0)
  })

  it('重复调用 setManualKeys 以最后一次为准', async () => {
    const { fetchImpl } = routedFetch({ '/me/auto-ride': [{ body: summaryBody([]) }] })
    const { manager, poolInputs } = makeManager({ fetchImpl })
    await manager.setManualKeys([{ id: 'a', key: 'ksk_firstKey001' }])
    await manager.setManualKeys([{ id: 'b', key: 'ksk_secondKey02' }])

    const pooled = poolInputs.at(-1)!.manualKeys
    expect(pooled).toHaveLength(1)
    expect(pooled[0].id).toBe('b')
  })
})
