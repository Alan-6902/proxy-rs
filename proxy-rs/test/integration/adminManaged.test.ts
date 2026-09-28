import { describe, expect, it } from 'vitest'
import {
  matchRemoteCredentialToLocalAccount,
  normalizeAdminManagedEntry,
  normalizeAdminManagedPayload,
  reconcileAdminManagedEntries,
  shouldSuppressKiroRefresh,
  type AdminManagedAccountEntry,
  type AdoptionLocalAccount,
  type AdoptionRemoteCredential
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

    it('旧 API Key 登记的 hash 不符 → 判为 id 被复用并丢弃', () => {
      const { kept, dropped } = reconcileAdminManagedEntries(
        [entry({ authMethod: 'api_key', remoteApiKeyHash: 'original-key' })],
        [{ id: '7', apiKeyHash: 'someone-else' }],
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

    it('旧 OAuth 登记没记 hash 时保持托管，不能据此恢复刷新', () => {
      const { dropped } = reconcileAdminManagedEntries(
        [entry({ remoteRefreshTokenHash: undefined })],
        [{ id: '7', refreshTokenHash: 'hash-a' }],
        now
      )
      expect(dropped).toEqual([])
    })
  })

  describe('matchRemoteCredentialToLocalAccount', () => {
    const now = 1_900_000_000_000
    const local = (over: Partial<AdoptionLocalAccount> = {}): AdoptionLocalAccount => ({
      id: 'acct-1',
      email: 'a@example.test',
      refreshTokenHash: 'rt-1',
      ...over
    })
    const remote = (over: Partial<AdoptionRemoteCredential> = {}): AdoptionRemoteCredential => ({
      id: '7',
      email: 'a@example.test',
      authMethod: 'social',
      refreshTokenHash: 'rt-1',
      ...over
    })

    it('强匹配命中：本地 token 哈希与反代一致', () => {
      const { claimed } = matchRemoteCredentialToLocalAccount({
        accounts: [local()],
        remote: [remote()],
        now
      })
      expect(claimed).toHaveLength(1)
      expect(claimed[0]).toMatchObject({
        accountId: 'acct-1',
        credentialId: '7',
        authMethod: 'social',
        adoptedByEmail: undefined
      })
    })

    /*
     * 已被反代轮换过的号必然强匹配失败（本地那份 token 早已作废），这时只能靠
     * email 兜底——漏认就意味着这个号继续被双边抢刷、直到烧掉。
     */
    it('强匹配失败但 email 唯一时按 email 兜底认领并打标记', () => {
      const { claimed } = matchRemoteCredentialToLocalAccount({
        accounts: [local({ refreshTokenHash: 'stale' })],
        remote: [remote()],
        now
      })
      expect(claimed).toHaveLength(1)
      expect(claimed[0].adoptedByEmail).toBe(true)
    })

    it('email 在本地重复时不认领，记入 ambiguousEmail', () => {
      const { claimed, ambiguousEmail } = matchRemoteCredentialToLocalAccount({
        accounts: [
          local({ id: 'acct-1', refreshTokenHash: 'stale-1' }),
          local({ id: 'acct-2', refreshTokenHash: 'stale-2' })
        ],
        remote: [remote()],
        now
      })
      expect(claimed).toEqual([])
      expect(ambiguousEmail).toEqual(['a@example.test'])
    })

    it('无 email 且强匹配失败时跳过，不误认', () => {
      const { claimed } = matchRemoteCredentialToLocalAccount({
        accounts: [local({ refreshTokenHash: 'stale' })],
        remote: [remote({ email: undefined })],
        now
      })
      expect(claimed).toEqual([])
    })

    it('api_key 凭据按 apiKeyHash 强匹配并记下 api_key 类型', () => {
      const { claimed } = matchRemoteCredentialToLocalAccount({
        accounts: [local({ refreshTokenHash: undefined, kiroApiKeyHash: 'ksk-1' })],
        remote: [remote({ refreshTokenHash: null, apiKeyHash: 'ksk-1', authMethod: 'api_key' })],
        now
      })
      expect(claimed).toHaveLength(1)
      expect(claimed[0].authMethod).toBe('api_key')
      expect(claimed[0].remoteApiKeyHash).toBe('ksk-1')
    })

    it('每条远端凭据各认领一个本地账号，一一对应', () => {
      const { claimed } = matchRemoteCredentialToLocalAccount({
        accounts: [
          local({ id: 'acct-1', email: 'a@example.test', refreshTokenHash: 'stale-1' }),
          local({ id: 'acct-2', email: 'b@example.test', refreshTokenHash: 'stale-2' })
        ],
        remote: [remote({ email: 'a@example.test' }), remote({ id: '8', email: 'b@example.test' })],
        now
      })
      expect(claimed.map((item) => item.accountId)).toEqual(['acct-1', 'acct-2'])
      expect(new Set(claimed.map((item) => item.credentialId)).size).toBe(2)
    })
  })
})
