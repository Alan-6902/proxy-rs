import { describe, expect, it, vi } from 'vitest'
import {
  refreshManagedAccountFromAdmin,
  syncManagedAccountFromAdmin
} from '../../src/main/adminManaged/accountSync'

function target(fetchImpl: typeof fetch) {
  return {
    baseUrl: 'http://127.0.0.1:8990',
    adminApiKey: 'test-only',
    timeoutSeconds: 3,
    fetchImpl
  }
}

describe('托管账号操作只委托反代', () => {
  it('手动刷新只调用 Admin 刷新接口，不返回或消费 OAuth 凭据', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, accessToken: 'must-not-be-used' }))
      )
    const result = await refreshManagedAccountFromAdmin(target(fetchImpl), '7')
    expect(result).toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:8990/api/admin/credentials/7/refresh',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': 'test-only' })
      })
    )
  })

  it('反代刷新失败直接报错，不回退到本地刷新', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 503 }))
    await expect(refreshManagedAccountFromAdmin(target(fetchImpl), '7')).rejects.toThrow('503')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('查询额度只请求余额，不主动强制刷新，也不返回凭据', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          currentUsage: 12,
          usageLimit: 100,
          subscriptionTitle: 'KIRO PRO',
          accessToken: 'must-not-be-used',
          refreshToken: 'must-not-be-used'
        })
      )
    )
    const result = await syncManagedAccountFromAdmin(target(fetchImpl), '7', 1000)
    expect(result).toMatchObject({
      status: 'active',
      usage: { current: 12, limit: 100, lastUpdated: expect.any(Number) }
    })
    expect(result).not.toHaveProperty('accessToken')
    expect(result).not.toHaveProperty('refreshToken')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:8990/api/admin/credentials/7/balance')
  })

  it('余额失败保留错误，不伪装成账号状态同步成功', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 503 }))
    expect(await syncManagedAccountFromAdmin(target(fetchImpl), '7')).toMatchObject({
      status: 'error',
      errorMessage: expect.stringContaining('503')
    })
  })

  it('人工查询和验活显式绕过反代缓存', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ currentUsage: 1, usageLimit: 100 })))
    await syncManagedAccountFromAdmin(target(fetchImpl), '7', 1000, true)
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'http://127.0.0.1:8990/api/admin/credentials/7/balance?fresh=true'
    )
  })
})
