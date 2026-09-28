/// <reference path="../../src/preload/index.d.ts" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAccountsStore } from '../../src/renderer/src/store/accounts'
import type { Account } from '../../src/renderer/src/types/account'

function account(id: string): Account {
  return {
    id,
    email: `${id}@example.test`,
    idp: 'Github',
    tags: [],
    status: 'active',
    isActive: false,
    createdAt: 1,
    lastUsedAt: 1,
    credentials: {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      authMethod: 'social',
      expiresAt: 1
    },
    subscription: { type: 'Free' },
    usage: { current: 0, limit: 100, percentUsed: 0, lastUpdated: 1 }
  }
}

const api = {
  refreshAccountToken: vi.fn(),
  checkAccountStatus: vi.fn(),
  backgroundBatchRefresh: vi.fn(),
  backgroundBatchCheck: vi.fn(),
  diagnoseAccountLiveness: vi.fn()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { api })
  useAccountsStore.setState({
    accounts: new Map([
      ['managed', account('managed')],
      ['local', account('local')]
    ]),
    adminManagedIds: new Set(['managed']),
    autoRefreshConcurrency: 2,
    autoRefreshSyncInfo: true,
    autoSwitchEnabled: false,
    saveToStorage: vi.fn().mockResolvedValue(undefined)
  })
  api.backgroundBatchRefresh.mockResolvedValue({
    success: true,
    completed: 2,
    successCount: 2,
    failedCount: 0
  })
  api.backgroundBatchCheck.mockResolvedValue({ success: true, successCount: 2, failedCount: 0 })
})
afterEach(() => vi.unstubAllGlobals())

describe('托管账号渲染层只发送标识、展示结果', () => {
  it('手动托管刷新成功时不需要本地凭据，也不回写任何凭据', async () => {
    const original = useAccountsStore.getState().accounts.get('managed')!.credentials
    api.refreshAccountToken.mockResolvedValue({
      success: true,
      adminManaged: true,
      data: { accessToken: 'unexpected' }
    })
    expect(await useAccountsStore.getState().refreshAccountToken('managed')).toBe(true)
    expect(api.refreshAccountToken).toHaveBeenCalledWith({ id: 'managed' })
    expect(useAccountsStore.getState().accounts.get('managed')!.credentials).toEqual(original)
    expect(useAccountsStore.getState().accounts.get('managed')!.status).toBe('active')
  })

  it('未托管账号继续更新本地 token', async () => {
    api.refreshAccountToken.mockResolvedValue({
      success: true,
      data: { accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600 }
    })
    expect(await useAccountsStore.getState().refreshAccountToken('local')).toBe(true)
    expect(api.refreshAccountToken.mock.calls[0][0].credentials.refreshToken).toBe('old-refresh')
    expect(useAccountsStore.getState().accounts.get('local')!.credentials.refreshToken).toBe(
      'new-refresh'
    )
  })

  it('混合批量刷新保留本地账号凭据，托管账号只传标识并明确委托刷新', async () => {
    await useAccountsStore.getState().batchRefreshTokens(['managed', 'local'])
    const [accounts, concurrency, syncInfo, refreshManaged] =
      api.backgroundBatchRefresh.mock.calls[0]
    expect(accounts.find((item: Account) => item.id === 'managed').credentials).toEqual({})
    expect(accounts.find((item: Account) => item.id === 'local').credentials.refreshToken).toBe(
      'old-refresh'
    )
    expect([concurrency, syncInfo, refreshManaged]).toEqual([2, true, true])
  })

  it('自动任务只同步托管状态，不请求强制刷新', async () => {
    await useAccountsStore.getState().triggerBackgroundRefresh()
    const [accounts, , , refreshManaged] = api.backgroundBatchRefresh.mock.calls[0]
    expect(accounts.find((item: Account) => item.id === 'managed')).toMatchObject({
      credentials: {},
      needsTokenRefresh: false
    })
    expect(refreshManaged).toBeUndefined()
    expect(api.refreshAccountToken).not.toHaveBeenCalled()
  })

  it('批量检查托管账号也只传标识', async () => {
    await useAccountsStore.getState().batchCheckStatus(['managed', 'local'])
    const accounts = api.backgroundBatchCheck.mock.calls[0][0]
    expect(accounts.find((item: Account) => item.id === 'managed').credentials).toEqual({})
    expect(accounts.find((item: Account) => item.id === 'local').credentials.accessToken).toBe('old-access')
  })

  it('旧的过期检查入口不能用托管账号本地时间触发强刷', async () => {
    api.refreshAccountToken.mockResolvedValue({ success: true, data: { accessToken: 'new', expiresIn: 3600 } })
    api.checkAccountStatus.mockResolvedValue({ success: true, data: { status: 'active' } })
    await useAccountsStore.getState().checkAndRefreshExpiringTokens()
    await useAccountsStore.getState().refreshExpiredTokensOnly()
    expect(api.refreshAccountToken.mock.calls.every(([item]) => item.id === 'local')).toBe(true)
    expect(api.checkAccountStatus.mock.calls.some(([item]) => item.id === 'managed')).toBe(true)
  })

  it('只刷新 token 的自动轮次不调度托管账号', async () => {
    useAccountsStore.setState({ autoRefreshSyncInfo: false })
    await useAccountsStore.getState().triggerBackgroundRefresh()
    expect(api.backgroundBatchRefresh.mock.calls[0][0].map((item: Account) => item.id)).toEqual([
      'local'
    ])
  })

  it('托管状态和后台响应中的 token 一律忽略', async () => {
    const original = useAccountsStore.getState().accounts.get('managed')!.credentials
    api.checkAccountStatus.mockResolvedValue({
      success: true,
      data: {
        status: 'active',
        newCredentials: { accessToken: 'unexpected', refreshToken: 'unexpected' }
      }
    })
    await useAccountsStore.getState().checkAccountStatus('managed')
    expect(api.checkAccountStatus).toHaveBeenCalledWith({
      id: 'managed',
      email: 'managed@example.test'
    })
    useAccountsStore
      .getState()
      .applyBackgroundRefreshResults([
        {
          id: 'managed',
          success: true,
          data: {
            accessToken: 'unexpected',
            refreshToken: 'unexpected',
            usage: { current: 20, limit: 100 }
          }
        }
      ])
    expect(useAccountsStore.getState().accounts.get('managed')!.credentials).toEqual(original)
    expect(useAccountsStore.getState().accounts.get('managed')!.usage.current).toBe(20)
  })

  it('托管验活只传标识并丢弃回传凭据', async () => {
    const original = useAccountsStore.getState().accounts.get('managed')!.credentials
    api.diagnoseAccountLiveness.mockResolvedValue({
      success: true,
      latencyMs: 1,
      credentials: { accessToken: 'unexpected', refreshToken: 'unexpected' }
    })
    await useAccountsStore.getState().runAccountLiveness('managed', { model: 'test-model' })
    expect(api.diagnoseAccountLiveness.mock.calls[0][0].account).toEqual({ id: 'managed' })
    expect(useAccountsStore.getState().accounts.get('managed')!.credentials).toEqual(original)
  })

  it('反代失败明确显示错误，不回退本地刷新', async () => {
    api.refreshAccountToken.mockResolvedValue({
      success: false,
      error: { message: 'Admin unavailable' }
    })
    expect(await useAccountsStore.getState().refreshAccountToken('managed')).toBe(false)
    expect(api.refreshAccountToken).toHaveBeenCalledTimes(1)
    expect(useAccountsStore.getState().accounts.get('managed')).toMatchObject({
      status: 'error',
      lastError: 'Admin unavailable'
    })
  })
})
