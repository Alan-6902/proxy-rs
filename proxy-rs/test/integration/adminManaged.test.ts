import { describe, expect, it } from 'vitest'
import {
  normalizeAdminManagedEntry,
  normalizeAdminManagedPayload,
  reconcileAdminManagedEntries,
  shouldSuppressKiroRefresh,
  type AdminManagedAccountEntry
} from '../../src/shared/adminManaged'

const entry = (over: Partial<AdminManagedAccountEntry> = {}): AdminManagedAccountEntry => ({
  accountId: 'acct-1',
  credentialId: '7',
  authMethod: 'social',
  remoteRefreshTokenHash: 'hash-a',
  pushedAt: 1_700_000_000_000,
  ...over
})

describe('admin managed registry helpers', () => {
  describe('shouldSuppressKiroRefresh', () => {
    it('托管账号返回 true', () => {
      expect(shouldSuppressKiroRefresh(new Set(['acct-1']), 'acct-1')).toBe(true)
    })

    it('未登记的账号返回 false', () => {
      expect(shouldSuppressKiroRefresh(new Set(['acct-1']), 'acct-2')).toBe(false)
    })

    /*
     * fail-open 的两个方向都要锁死：registry 读不出来（空集）与 accountId 缺失
     * 都不能抑制刷新。否则未托管账号会集体停刷、token 过期、服务不可用。
     */
    it('registry 为空时不抑制任何账号', () => {
      expect(shouldSuppressKiroRefresh(new Set(), 'acct-1')).toBe(false)
    })

    it('accountId 缺失时不抑制', () => {
      expect(shouldSuppressKiroRefresh(new Set(['acct-1']), undefined)).toBe(false)
      expect(shouldSuppressKiroRefresh(new Set(['acct-1']), '')).toBe(false)
    })
  })

  describe('normalizeAdminManagedEntry', () => {
    it('缺 accountId / credentialId / authMethod / pushedAt 的条目一律丢弃', () => {
      expect(normalizeAdminManagedEntry({ accountId: 'a' })).toBeNull()
      expect(normalizeAdminManagedEntry({ accountId: 'a', credentialId: '1' })).toBeNull()
      expect(
        normalizeAdminManagedEntry({
          accountId: 'a',
          credentialId: '1',
          authMethod: 'bogus',
          pushedAt: 1
        })
      ).toBeNull()
      expect(
        normalizeAdminManagedEntry({
          accountId: 'a',
          credentialId: '1',
          authMethod: 'social'
        })
      ).toBeNull()
    })

    it('保留 adoptedByEmail 标记，非 true 时不设', () => {
      expect(normalizeAdminManagedEntry({ ...entry(), adoptedByEmail: true })?.adoptedByEmail).toBe(
        true
      )
      expect(
        normalizeAdminManagedEntry({ ...entry(), adoptedByEmail: 'yes' })?.adoptedByEmail
      ).toBeUndefined()
    })
  })

  describe('normalizeAdminManagedPayload', () => {
    it('逐条清洗，坏条目不影响其余', () => {
      const result = normalizeAdminManagedPayload([
        entry(),
        { accountId: 'acct-2' },
        { accountId: '', credentialId: '8', authMethod: 'social', pushedAt: 1 },
        { accountId: 'acct-3', credentialId: '9', authMethod: 'bogus', pushedAt: 1 },
        null,
        'nope'
      ])
      expect(result.map((item) => item.accountId)).toEqual(['acct-1'])
    })

    it('同一账号重复登记时保留 pushedAt 最新的一条', () => {
      const result = normalizeAdminManagedPayload([
        entry({ credentialId: 'old', pushedAt: 100 }),
        entry({ credentialId: 'new', pushedAt: 200 })
      ])
      expect(result).toHaveLength(1)
      expect(result[0].credentialId).toBe('new')
    })

    it('接受 { entries: [...] } 形状', () => {
      expect(normalizeAdminManagedPayload({ entries: [entry()] })).toHaveLength(1)
    })

    it('非对象 / 非数组输入返回空表', () => {
      expect(normalizeAdminManagedPayload(null)).toEqual([])
      expect(normalizeAdminManagedPayload(42)).toEqual([])
      expect(normalizeAdminManagedPayload({ entries: 'nope' })).toEqual([])
    })
  })

  describe('reconcileAdminManagedEntries', () => {
    const now = 1_800_000_000_000

    it('远端仍在且 hash 相符 → 保留并刷新 lastSeenRemoteAt', () => {
      const { kept, dropped } = reconcileAdminManagedEntries(
        [entry()],
        [{ id: '7', refreshTokenHash: 'hash-a' }],
        now
      )
      expect(dropped).toEqual([])
      expect(kept).toEqual([{ ...entry(), lastSeenRemoteAt: now }])
    })

    it('远端已无此凭据 → 丢弃，账号恢复本地刷新', () => {
      const { kept, dropped } = reconcileAdminManagedEntries([entry()], [], now)
      expect(kept).toEqual([])
      expect(dropped).toEqual([{ accountId: 'acct-1', credentialId: '7', reason: 'missing' }])
    })

    it('id 还在但 hash 不符 → 判为 id 被复用并丢弃', () => {
      const { kept, dropped } = reconcileAdminManagedEntries(
        [entry()],
        [{ id: '7', refreshTokenHash: 'someone-else' }],
        now
      )
      expect(kept).toEqual([])
      expect(dropped).toEqual([{ accountId: 'acct-1', credentialId: '7', reason: 'hash_changed' }])
    })

    it('api_key 凭据按 apiKeyHash 匹配', () => {
      const apiKeyEntry = entry({
        authMethod: 'api_key',
        remoteApiKeyHash: 'key-hash',
        remoteRefreshTokenHash: undefined
      })
      const { kept } = reconcileAdminManagedEntries(
        [apiKeyEntry],
        [{ id: '7', apiKeyHash: 'key-hash' }],
        now
      )
      expect(kept).toHaveLength(1)
    })

    it('条目没记 hash 时判为 hash 不符（宁可恢复本地刷新，也不永久冻结）', () => {
      const { dropped } = reconcileAdminManagedEntries(
        [entry({ remoteRefreshTokenHash: undefined })],
        [{ id: '7', refreshTokenHash: 'hash-a' }],
        now
      )
      expect(dropped[0].reason).toBe('hash_changed')
    })
  })
})
