/**
 * 托管账号余额查询的解析与逐条请求验证。
 *
 * 上游给的 usagePercentage 是百分数，本地统一用 0-1 小数；缺字段时不能编造 0。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  fetchLocalAdminUsage,
  toCredentialUsage
} from '../../src/main/adminManaged/adminBalanceClient'
import type { KskAutomationFetch } from '../../src/main/kskAutomation/localAdminClient'

const BASE_URL = 'http://127.0.0.1:12888/admin'
const ADMIN_KEY = 'admin-test-key'

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

describe('托管账号余额 · 响应解析', () => {
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

describe('托管账号余额 · 逐条查用量', () => {
  it('串行查询每条凭据，单条失败不影响其余', async () => {
    const seen: string[] = []
    const fetchImpl = makeFetch((url) => {
      seen.push(url)
      if (url.includes('/credentials/2/balance')) return jsonResponse({ error: 'boom' }, 500)
      return jsonResponse({ currentUsage: 100, usageLimit: 1000, remaining: 900 })
    })
    const result = await fetchLocalAdminUsage(target(fetchImpl), ['1', '2', '3'])

    expect(seen).toHaveLength(3)
    expect(result.usage.size).toBe(2)
    expect(result.usage.get('1')!.remaining).toBe(900)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('#2')
  })

  it('fresh=true 时带上 ?fresh=true 让反代跳过缓存', async () => {
    const seen: string[] = []
    const fetchImpl = makeFetch((url) => {
      seen.push(url)
      return jsonResponse({ currentUsage: 1, usageLimit: 10 })
    })
    await fetchLocalAdminUsage(target(fetchImpl), ['7'], true)
    expect(seen).toEqual(['http://127.0.0.1:12888/api/admin/credentials/7/balance?fresh=true'])
  })

  it('未配置 Admin API Key 时直接报错，不发请求', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}))
    await expect(
      fetchLocalAdminUsage({ ...target(fetchImpl), adminApiKey: '  ' }, ['1'])
    ).rejects.toThrow('未配置本机 Admin API Key')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
