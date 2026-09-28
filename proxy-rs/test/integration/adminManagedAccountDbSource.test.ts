import { describe, expect, it } from 'vitest'
import {
  adminManagedEntry,
  forgetManagedByCredentialId,
  isAdminManagedAccount,
  reconcileManagedAccounts,
  reloadAdminManagedIds,
  setAdminManagedSource
} from '../../src/main/adminManaged/gate'

describe('账号库作为托管来源', () => {
  it('库中账号一律托管；登记表的回收与注销不再生效', async () => {
    let rows = [{ accountId: 'a', credentialId: '7', authMethod: 'social' as const, pushedAt: 1 }]
    setAdminManagedSource(() => rows)
    await reloadAdminManagedIds()
    expect(isAdminManagedAccount('a')).toBe(true)
    expect(isAdminManagedAccount('b')).toBe(false)
    expect(adminManagedEntry('a')?.credentialId).toBe('7')
    // 反代列表里看不到（未入池）也不回收
    expect((await reconcileManagedAccounts([])).dropped).toEqual([])
    await forgetManagedByCredentialId('7')
    expect(isAdminManagedAccount('a')).toBe(true)
    rows = []
    await reloadAdminManagedIds()
    expect(isAdminManagedAccount('a')).toBe(false)
  })
})
