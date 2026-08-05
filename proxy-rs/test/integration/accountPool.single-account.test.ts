import { describe, expect, it } from 'vitest'
import { AccountPool } from '../../src/main/proxy/accountPool'
import type { ProxyAccount } from '../../src/main/proxy/types'

function makeAccount(overrides: Partial<ProxyAccount> = {}): ProxyAccount {
  return {
    id: 'acc-1',
    email: 'a@example.com',
    accessToken: 'token-1',
    credentialKind: 'oauth',
    refreshToken: 'refresh-1',
    ...overrides
  } as ProxyAccount
}

function poolWith(accounts: ProxyAccount[]): AccountPool {
  const pool = new AccountPool()
  accounts.forEach((a) => pool.addAccount(a))
  return pool
}

describe('单账号池的断路器边界', () => {
  describe('仍然放行：没有备选账号时应把真实上游错误透给用户', () => {
    it('健康的单账号正常返回', () => {
      const pool = poolWith([makeAccount()])
      expect(pool.getNextAccount()?.id).toBe('acc-1')
    })

    it('累计失败进入退避冷却期，单账号仍放行', () => {
      // 冷却是为"切号"服务的，单账号切不了；拦下来只会变成 503
      const pool = poolWith([makeAccount({ errorCount: 5, lastUsed: Date.now() })])
      expect(pool.getNextAccount()?.id).toBe('acc-1')
    })

    it('被显式排除时返回 null（重试已试过该账号）', () => {
      const pool = poolWith([makeAccount()])
      expect(pool.getNextAccount(new Set(['acc-1']))).toBeNull()
    })
  })

  describe('应当拦下：确定性不可用，继续打上游没有意义', () => {
    it('被风控封禁（suspended）时返回 null，需人工解封', () => {
      const pool = poolWith([makeAccount()])
      pool.markSuspended('acc-1', 'TEMPORARILY_SUSPENDED')
      expect(pool.getNextAccount()).toBeNull()
    })

    it('配额耗尽时返回 null', () => {
      const pool = poolWith([makeAccount()])
      // 用满配额触发 quotaExhausted，重置时间在未来
      pool.updateQuota('acc-1', 100, 100, Date.now() + 60 * 60_000)
      expect(pool.getNextAccount()).toBeNull()
    })

    it('配额重置时间已过则重新放行', () => {
      const pool = poolWith([makeAccount()])
      pool.updateQuota('acc-1', 100, 100, Date.now() - 1000)
      expect(pool.getNextAccount()?.id).toBe('acc-1')
    })

    it('解除封禁后重新放行', () => {
      const pool = poolWith([makeAccount()])
      pool.markSuspended('acc-1', 'TEMPORARILY_SUSPENDED')
      expect(pool.getNextAccount()).toBeNull()
      pool.clearSuspended('acc-1')
      expect(pool.getNextAccount()?.id).toBe('acc-1')
    })
  })

  describe('空池', () => {
    it('无账号时返回 null', () => {
      expect(poolWith([]).getNextAccount()).toBeNull()
    })
  })

  describe('多账号仍走完整断路器（回归）', () => {
    it('封禁的账号被跳过，切到健康账号', () => {
      const pool = poolWith([
        makeAccount({ id: 'acc-1' }),
        makeAccount({ id: 'acc-2', email: 'b@example.com' })
      ])
      pool.markSuspended('acc-1', 'TEMPORARILY_SUSPENDED')
      expect(pool.getNextAccount()?.id).toBe('acc-2')
    })

    it('全部配额耗尽时返回 null 而非硬塞一个', () => {
      const pool = poolWith([
        makeAccount({ id: 'acc-1' }),
        makeAccount({ id: 'acc-2', email: 'b@example.com' })
      ])
      const resetAt = Date.now() + 60 * 60_000
      pool.updateQuota('acc-1', 100, 100, resetAt)
      pool.updateQuota('acc-2', 100, 100, resetAt)
      expect(pool.getNextAccount()).toBeNull()
    })
  })
})
