/**
 * 针对真实本机 Admin 的解析验证（可选执行）。
 *
 * 为什么需要它：其余用例都用手抄的 fixture，能证明「按我以为的形状解析是对的」，
 * 但证不了「kiro-rs 真实回的就是这个形状」。字段改名或类型变化（比如 lastUsedAt
 * 从字符串变成秒级时间戳）只有打真实服务才会暴露。
 *
 * 执行条件：设置 KIRO_ADMIN_BASE_URL 与 KIRO_ADMIN_API_KEY，且服务可达；
 * 缺任一条件就整组跳过，避免没起容器时 CI 变红。
 *
 * 只读接口：全程只 GET /credentials，不碰 balance（那个会打上游 AWS 花额度），
 * 也不做任何写操作。
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { fetch as undiciFetch } from 'undici'
import { aggregateLocalAdminStats, resolveLocalAdminAlerts } from '../../src/shared/localAdminStats'
import { fetchLocalAdminCredentialStats } from '../../src/main/localAdminStats/statsClient'
import {
  resolveLocalAdminApiBase,
  type KskAutomationFetch
} from '../../src/main/kskAutomation/localAdminClient'

const BASE_URL = process.env.KIRO_ADMIN_BASE_URL ?? ''
const API_KEY = process.env.KIRO_ADMIN_API_KEY ?? ''

const liveFetch: KskAutomationFetch = async (url, init) =>
  (await undiciFetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal
  })) as unknown as Response

/** 与生产代码同一条归一化路径，避免测试自己拼 URL 拼歪。 */
async function getCredentialsRaw(timeoutMs: number): Promise<unknown> {
  const response = await undiciFetch(`${resolveLocalAdminApiBase(BASE_URL)}/credentials`, {
    method: 'GET',
    headers: { 'x-api-key': API_KEY },
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

let reachable = false

beforeAll(async () => {
  if (!BASE_URL || !API_KEY) return
  try {
    await getCredentialsRaw(3000)
    reachable = true
  } catch {
    reachable = false
  }
})

describe.runIf(BASE_URL && API_KEY)('反代统计 · 真实 Admin 契约', () => {
  it('GET /credentials 的每条记录都能映射出 id 与计数字段', async () => {
    if (!reachable) return

    const stats = await fetchLocalAdminCredentialStats({
      baseUrl: BASE_URL,
      adminApiKey: API_KEY,
      timeoutSeconds: 10,
      fetchImpl: liveFetch
    })

    expect(stats.length).toBeGreaterThan(0)
    for (const credential of stats) {
      // id 解析失败的条目会被过滤掉，所以能出现在结果里就说明 id 存在
      expect(credential.id).toBeTruthy()
      expect(Number.isInteger(credential.successCount)).toBe(true)
      expect(Number.isInteger(credential.failureCount)).toBe(true)
      expect(Number.isInteger(credential.refreshFailureCount)).toBe(true)
      expect(typeof credential.disabled).toBe('boolean')
      // lastUsedAt 若存在必须是合理的毫秒时间戳（解析失败会得到 NaN 或秒级小数）
      if (credential.lastUsedAt !== undefined) {
        expect(credential.lastUsedAt).toBeGreaterThan(Date.parse('2020-01-01'))
        expect(credential.lastUsedAt).toBeLessThan(Date.now() + 86_400_000)
      }
      // 定时轮询不查余额，所以这里必须是空的
      expect(credential.usage).toBeUndefined()
      // 告警判定必须与共享纯函数一致，两处口径不能走偏
      expect(credential.alerts).toEqual(
        resolveLocalAdminAlerts({
          disabled: credential.disabled,
          failureCount: credential.failureCount,
          refreshFailureCount: credential.refreshFailureCount
        })
      )
    }
  })

  it('聚合总览与 Admin 自报的 total / available 对得上', async () => {
    if (!reachable) return

    const raw = (await getCredentialsRaw(10_000)) as { total?: number; available?: number }

    const stats = await fetchLocalAdminCredentialStats({
      baseUrl: BASE_URL,
      adminApiKey: API_KEY,
      timeoutSeconds: 10,
      fetchImpl: liveFetch
    })
    const totals = aggregateLocalAdminStats(stats)

    expect(totals.credentials).toBe(raw.total)
    expect(totals.available).toBe(raw.available)
    expect(totals.disabled).toBe((raw.total ?? 0) - (raw.available ?? 0))
  })
})
