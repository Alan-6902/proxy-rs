import { describe, expect, it, vi } from 'vitest'
import {
  buildKiroCredentialRefreshSingleflightKey,
  KiroCredentialRefreshSingleflight,
  LegacyKiroRsMigrationCredentialRefreshGate,
  mergeAccountDataPreservingRotatedKiroCredentials,
  mergeRotatedKiroCredentials,
  shouldReuseCanonicalKiroCredentials
} from '../../src/main/legacyKiroRsMigrationCredentialRefreshGate'

describe('LegacyKiroRsMigrationCredentialRefreshGate', () => {
  it('closes admission before draining and waits for every active lease exactly once', async () => {
    const gate = new LegacyKiroRsMigrationCredentialRefreshGate()
    expect(gate.acquire()).toBeNull()
    gate.openAdmission()
    const first = gate.acquire()
    const second = gate.acquire()
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(gate.activeCount()).toBe(2)

    const drained = vi.fn()
    const draining = gate.closeAdmissionAndDrain().then(drained)
    expect(gate.isAdmissionClosed()).toBe(true)
    expect(gate.acquire()).toBeNull()
    first!.release()
    first!.release()
    await Promise.resolve()
    expect(drained).not.toHaveBeenCalled()
    second!.release()
    await draining

    expect(gate.activeCount()).toBe(0)
    expect(drained).toHaveBeenCalledOnce()
  })

  it('fails closed instead of waiting forever for a stuck refresh lease', async () => {
    vi.useFakeTimers()
    try {
      const gate = new LegacyKiroRsMigrationCredentialRefreshGate(100)
      gate.openAdmission()
      const lease = gate.acquire()
      expect(lease).not.toBeNull()
      const draining = gate.closeAdmissionAndDrain()
      const rejection = expect(draining).rejects.toThrow('Credential refresh drain timed out')

      await vi.advanceTimersByTimeAsync(100)
      await rejection
      expect(gate.isAdmissionClosed()).toBe(true)
      expect(gate.activeCount()).toBe(1)
      lease?.release()
      expect(gate.activeCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('merges only rotated credential fields and rejects a stale refresh result', () => {
    const original = {
      accounts: {
        account: {
          email: 'preserved@example.test',
          credentials: {
            refreshToken: 'refresh-before',
            clientId: 'preserved-client',
            expiresAt: 1
          }
        }
      },
      groups: { preserved: true }
    }

    const merged = mergeRotatedKiroCredentials(
      original,
      'account',
      'refresh-before',
      undefined,
      {
        accessToken: 'access-after',
        refreshToken: 'refresh-after',
        expiresAt: 2,
        credentialRevision: 'main-revision-1'
      }
    )
    expect(merged).toEqual({
      accounts: {
        account: {
          email: 'preserved@example.test',
          credentials: {
            accessToken: 'access-after',
            refreshToken: 'refresh-after',
            clientId: 'preserved-client',
            expiresAt: 2,
            credentialRevision: 'main-revision-1'
          }
        }
      },
      groups: { preserved: true }
    })
    expect(original.accounts.account.credentials.refreshToken).toBe('refresh-before')
    expect(
      mergeRotatedKiroCredentials(original, 'account', 'stale-refresh-token', undefined, {
        accessToken: 'must-not-write',
        credentialRevision: 'must-not-write'
      })
    ).toBeNull()
    expect(
      mergeRotatedKiroCredentials(merged, 'account', 'refresh-after', undefined, {
        accessToken: 'must-not-double-write',
        credentialRevision: 'main-revision-2'
      })
    ).toBeNull()
  })

  it('preserves main-rotated credentials unless the renderer has the exact revision', () => {
    const current = {
      accounts: {
        account: {
          email: 'old@example.test',
          credentials: {
            accessToken: 'main-access',
            refreshToken: 'main-refresh',
            expiresAt: 200,
            credentialRevision: 'main-revision',
            clientId: 'main-client'
          }
        }
      },
      activeAccountId: null
    }
    const staleRenderer = {
      accounts: {
        account: {
          email: 'updated@example.test',
          credentials: {
            accessToken: 'stale-access',
            refreshToken: 'stale-refresh',
            expiresAt: 100,
            credentialRevision: 'stale-revision',
            clientId: 'updated-client'
          }
        }
      },
      activeAccountId: 'account'
    }

    expect(mergeAccountDataPreservingRotatedKiroCredentials(current, staleRenderer)).toEqual({
      accounts: {
        account: {
          email: 'updated@example.test',
          credentials: {
            accessToken: 'main-access',
            refreshToken: 'main-refresh',
            expiresAt: 200,
            credentialRevision: 'main-revision',
            clientId: 'updated-client'
          }
        }
      },
      activeAccountId: 'account'
    })

    const currentRenderer = {
      ...staleRenderer,
      accounts: {
        account: {
          ...staleRenderer.accounts.account,
          credentials: {
            ...staleRenderer.accounts.account.credentials,
            credentialRevision: 'main-revision'
          }
        }
      }
    }
    expect(mergeAccountDataPreservingRotatedKiroCredentials(current, currentRenderer)).toBe(
      currentRenderer
    )
  })

  it('coalesces overlapping refresh operations and clears both success and failure entries', async () => {
    const singleflight = new KiroCredentialRefreshSingleflight<string>()
    let finish!: (value: string) => void
    const operation = vi.fn(
      () => new Promise<string>((resolve) => {
        finish = resolve
      })
    )
    const first = singleflight.run('account\0refresh', operation)
    const second = singleflight.run('account\0refresh', operation)
    expect(first).toBe(second)
    await Promise.resolve()
    expect(operation).toHaveBeenCalledOnce()
    expect(singleflight.activeCount()).toBe(1)
    finish('rotated')
    await expect(first).resolves.toBe('rotated')
    await Promise.resolve()
    expect(singleflight.activeCount()).toBe(0)

    await expect(
      singleflight.run('account\0refresh', async () => {
        throw new Error('refresh failed')
      })
    ).rejects.toThrow('refresh failed')
    await Promise.resolve()
    expect(singleflight.activeCount()).toBe(0)
  })

  it('keys the upstream refresh by canonical credential rather than account id', () => {
    const canonical = { refreshToken: 'shared-refresh-token' }
    expect(buildKiroCredentialRefreshSingleflightKey(canonical)).toBe(
      buildKiroCredentialRefreshSingleflightKey({ refreshToken: 'shared-refresh-token' })
    )
  })

  it('reuses canonical credentials for every stale sequential caller', () => {
    expect(
      shouldReuseCanonicalKiroCredentials(
        { refreshToken: 'refresh-before' },
        'refresh-before',
        undefined
      )
    ).toBe(false)
    expect(
      shouldReuseCanonicalKiroCredentials(
        { refreshToken: 'refresh-after', credentialRevision: 'main-revision' },
        'refresh-before',
        undefined
      )
    ).toBe(true)
    expect(
      shouldReuseCanonicalKiroCredentials(
        { refreshToken: 'refresh-before', credentialRevision: 'main-revision' },
        'refresh-before',
        undefined
      )
    ).toBe(true)
    expect(
      shouldReuseCanonicalKiroCredentials(
        { refreshToken: 'refresh-before', credentialRevision: 'main-revision' },
        'refresh-before',
        'main-revision'
      )
    ).toBe(false)
  })
})
