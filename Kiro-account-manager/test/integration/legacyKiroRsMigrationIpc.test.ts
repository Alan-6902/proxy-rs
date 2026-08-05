import { describe, expect, it, vi } from 'vitest'
import { LegacyKiroRsMigrationIpc } from '../../src/main/legacyKiroRsMigrationIpc'
import { LegacyKiroRsMigrationError } from '../../src/shared/legacyKiroRsMigration'
import { LegacyKiroRsMigrationTransactionError } from '../../src/shared/legacyKiroRsMigrationTransaction'

const scanId = 'a'.repeat(32)

function fixture() {
  const scanner = {
    scan: vi.fn(async () => ({
      scanId,
      expiresAt: 123,
      accounts: {
        available: 2,
        new: 1,
        existing: 1,
        duplicate: 0,
        items: [
          { itemId: 'internal-account-id', redactedId: '14f2ab90', state: 'new' as const },
          { itemId: 'another-internal-id', redactedId: '87ca01ff', state: 'existing' as const }
        ]
      },
      settings: {
        apiKey: { state: 'target_empty' as const },
        adminApiKey: { state: 'conflict' as const },
        unsupportedCount: 1
      }
    }))
  }
  const transaction = {
    apply: vi.fn(async () => ({
      status: 'applied' as 'applied' | 'noop',
      scanId,
      migratedAccountIds: ['internal-account-id'],
      inboundApiKey: 'appended' as 'appended' | 'skipped',
      adminApiKey: 'skipped' as 'skipped' | 'written'
    })),
    rollback: vi.fn(async () => ({
      status: 'rolled_back' as 'rolled_back' | 'cleanup_pending',
      scanId,
      migratedAccountIds: ['internal-account-id']
    })),
    recover: vi.fn<
      () => Promise<{
        status:
          | 'none'
          | 'recovered'
          | 'manual_intervention'
          | 'rollback_available'
          | 'cleanup_pending'
        scanId?: string
        migratedAccountIds: string[]
      }>
    >(async () => ({
      status: 'rollback_available',
      scanId,
      migratedAccountIds: ['internal-account-id']
    }))
  }
  const ipc = new LegacyKiroRsMigrationIpc({
    scanner,
    transaction,
    ensureReady: vi.fn(async () => {}),
    proxyIsRunning: () => false
  })
  return { ipc, scanner, transaction }
}

describe('LegacyKiroRsMigrationIpc strict public boundary', () => {
  it('returns a redacted scan preview only', async () => {
    const { ipc } = fixture()
    const result = await ipc.scan()
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        accounts: expect.objectContaining({ redactedIds: ['14f2ab90', '87ca01ff'] })
      })
    })
    expect(JSON.stringify(result)).not.toContain('internal-account-id')
    expect(JSON.stringify(result)).not.toContain('kiroApiKey')
  })

  it('rejects malformed and extra apply payloads before touching the transaction', async () => {
    const { ipc, transaction } = fixture()
    for (const payload of [
      [scanId, { accounts: true, inboundApiKey: true }],
      [
        scanId,
        { accounts: true, inboundApiKey: true, adminApiKey: false, path: '/tmp/config.json' }
      ],
      ['A'.repeat(32), { accounts: true, inboundApiKey: true, adminApiKey: false }]
    ]) {
      await expect(ipc.apply(payload[0], payload[1])).resolves.toEqual({
        ok: false,
        errorCode: 'INVALID_REQUEST'
      })
    }
    expect(transaction.apply).not.toHaveBeenCalled()
  })

  it('sanitizes apply rollback and recover internals', async () => {
    const { ipc, transaction } = fixture()
    const applied = await ipc.apply(scanId, {
      accounts: true,
      inboundApiKey: false,
      adminApiKey: false
    })
    expect(applied).toEqual({
      ok: true,
      value: { status: 'applied', migratedCount: 1 }
    })

    transaction.apply.mockResolvedValueOnce({
      status: 'noop',
      scanId,
      migratedAccountIds: [],
      inboundApiKey: 'skipped',
      adminApiKey: 'skipped'
    })
    const noop = await ipc.apply(scanId, {
      accounts: false,
      inboundApiKey: false,
      adminApiKey: false
    })
    expect(noop).toEqual({ ok: true, value: { status: 'noop', migratedCount: 0 } })

    const rolledBack = await ipc.rollback()
    const recovered = await ipc.recover()
    expect(rolledBack).toEqual({
      ok: true,
      value: { status: 'rolled_back', migratedCount: 1 }
    })
    expect(recovered).toEqual({
      ok: true,
      value: {
        status: 'rollback_available',
        migratedCount: 1,
        proxyRunning: false,
        rollbackAvailable: true
      }
    })
    expect(JSON.stringify([applied, noop, rolledBack, recovered])).not.toContain(
      'internal-account-id'
    )
  })

  it('preserves blocking recovery statuses and error codes', async () => {
    const { ipc, transaction } = fixture()

    transaction.recover.mockResolvedValueOnce({
      status: 'manual_intervention',
      scanId,
      migratedAccountIds: ['internal-account-id']
    })
    await expect(ipc.recover()).resolves.toEqual({
      ok: true,
      value: {
        status: 'manual_intervention',
        migratedCount: 1,
        proxyRunning: false,
        rollbackAvailable: false
      }
    })

    transaction.recover.mockResolvedValueOnce({
      status: 'cleanup_pending',
      scanId,
      migratedAccountIds: ['internal-account-id']
    })
    await expect(ipc.recover()).resolves.toEqual({
      ok: true,
      value: {
        status: 'cleanup_pending',
        migratedCount: 1,
        proxyRunning: false,
        rollbackAvailable: false
      }
    })

    transaction.apply.mockRejectedValueOnce(
      new LegacyKiroRsMigrationTransactionError('MANUAL_INTERVENTION')
    )
    await expect(
      ipc.apply(scanId, {
        accounts: true,
        inboundApiKey: false,
        adminApiKey: false
      })
    ).resolves.toEqual({ ok: false, errorCode: 'MANUAL_INTERVENTION' })

    transaction.rollback.mockResolvedValueOnce({
      status: 'cleanup_pending',
      scanId,
      migratedAccountIds: ['internal-account-id']
    })
    await expect(ipc.rollback()).resolves.toEqual({
      ok: true,
      value: { status: 'cleanup_pending', migratedCount: 1 }
    })

    transaction.rollback.mockRejectedValueOnce(
      new LegacyKiroRsMigrationTransactionError('RECOVERY_REQUIRED')
    )
    await expect(ipc.rollback()).resolves.toEqual({
      ok: false,
      errorCode: 'RECOVERY_REQUIRED'
    })
  })

  it('preserves known error codes and maps unknown failures without error text', async () => {
    const { ipc, scanner, transaction } = fixture()
    scanner.scan.mockRejectedValueOnce(new LegacyKiroRsMigrationError('SOURCE_JSON_INVALID'))
    await expect(ipc.scan()).resolves.toEqual({ ok: false, errorCode: 'SOURCE_JSON_INVALID' })
    transaction.rollback.mockRejectedValueOnce(
      new LegacyKiroRsMigrationTransactionError('WRITE_FAILED')
    )
    await expect(ipc.rollback()).resolves.toEqual({ ok: false, errorCode: 'WRITE_FAILED' })
    transaction.recover.mockRejectedValueOnce(new Error('secret failure detail'))
    const result = await ipc.recover()
    expect(result).toEqual({ ok: false, errorCode: 'DEPENDENCY_FAILED' })
    expect(JSON.stringify(result)).not.toContain('secret failure detail')
  })

  it('blocks mutations while the proxy is running without invoking the transaction', async () => {
    const { scanner, transaction } = fixture()
    const ipc = new LegacyKiroRsMigrationIpc({
      scanner,
      transaction,
      ensureReady: async () => {},
      proxyIsRunning: () => true
    })
    await expect(
      ipc.apply(scanId, { accounts: true, inboundApiKey: false, adminApiKey: false })
    ).resolves.toEqual({ ok: false, errorCode: 'PROXY_RUNNING' })
    await expect(ipc.rollback()).resolves.toEqual({ ok: false, errorCode: 'PROXY_RUNNING' })
    expect(transaction.apply).not.toHaveBeenCalled()
    expect(transaction.rollback).not.toHaveBeenCalled()
  })
})
