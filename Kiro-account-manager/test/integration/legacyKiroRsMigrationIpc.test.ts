import { describe, expect, it, vi } from 'vitest'
import { LegacyKiroRsMigrationCredentialRefreshGate } from '../../src/main/legacyKiroRsMigrationCredentialRefreshGate'
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
    finalize: vi.fn(async () => ({
      status: 'finalized' as 'finalized' | 'cleanup_pending',
      scanId,
      migratedAccountIds: ['internal-account-id']
    })),
    acknowledgeRollback: vi.fn(async () => ({
      status: 'acknowledged' as 'acknowledged' | 'cleanup_pending',
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
          | 'rollback_sync_required'
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
  const quiesceCredentialRefreshes = vi.fn(async () => {})
  const resumeCredentialRefreshes = vi.fn(() => true)
  const ipc = new LegacyKiroRsMigrationIpc({
    scanner,
    transaction,
    ensureReady: vi.fn(async () => {}),
    proxyIsRunning: () => false,
    quiesceCredentialRefreshes,
    resumeCredentialRefreshes
  })
  return {
    ipc,
    scanner,
    transaction,
    quiesceCredentialRefreshes,
    resumeCredentialRefreshes
  }
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
    const { ipc, transaction, quiesceCredentialRefreshes } = fixture()
    const applied = await ipc.apply(scanId, {
      accounts: true,
      inboundApiKey: false,
      adminApiKey: false
    })
    expect(applied).toEqual({
      ok: true,
      value: { status: 'applied', migratedCount: 1 }
    })
    expect(quiesceCredentialRefreshes.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.apply.mock.invocationCallOrder[0]
    )

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
    const finalized = await ipc.finalize()
    const acknowledged = await ipc.acknowledgeRollback()
    const recovered = await ipc.recover()
    expect(rolledBack).toEqual({
      ok: true,
      value: { status: 'rolled_back', migratedCount: 1 }
    })
    expect(finalized).toEqual({
      ok: true,
      value: { status: 'finalized', migratedCount: 1 }
    })
    expect(acknowledged).toEqual({
      ok: true,
      value: { status: 'acknowledged', migratedCount: 1 }
    })
    expect(recovered).toEqual({
      ok: true,
      value: {
        status: 'rollback_available',
        migratedCount: 1,
        proxyRunning: false,
        rollbackAvailable: true,
        rollbackSyncRequired: false
      }
    })
    expect(JSON.stringify([applied, noop, rolledBack, finalized, acknowledged, recovered])).not.toContain(
      'internal-account-id'
    )
  })

  it('waits for refresh draining before the transaction reads the target snapshot', async () => {
    const { ipc, transaction, quiesceCredentialRefreshes } = fixture()
    let releaseRefresh!: () => void
    const refreshFinished = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    let persistedRefreshToken = 'old-refresh-token'
    quiesceCredentialRefreshes.mockImplementationOnce(async () => {
      await refreshFinished
      persistedRefreshToken = 'new-refresh-token'
    })
    transaction.apply.mockImplementationOnce(async () => {
      expect(persistedRefreshToken).toBe('new-refresh-token')
      return {
        status: 'applied',
        scanId,
        migratedAccountIds: ['internal-account-id'],
        inboundApiKey: 'skipped',
        adminApiKey: 'skipped'
      }
    })

    const applying = ipc.apply(scanId, {
      accounts: true,
      inboundApiKey: false,
      adminApiKey: false
    })
    await vi.waitFor(() => expect(quiesceCredentialRefreshes).toHaveBeenCalledOnce())
    expect(transaction.apply).not.toHaveBeenCalled()
    releaseRefresh()

    await expect(applying).resolves.toEqual({
      ok: true,
      value: { status: 'applied', migratedCount: 1 }
    })
  })

  it('does not reopen refresh admission while apply is draining or awaiting its checkpoint', async () => {
    const { scanner, transaction } = fixture()
    const gate = new LegacyKiroRsMigrationCredentialRefreshGate()
    gate.openAdmission()
    const existingRefresh = gate.acquire()
    expect(existingRefresh).not.toBeNull()

    let markTransactionStarted!: () => void
    const transactionStarted = new Promise<void>((resolve) => {
      markTransactionStarted = resolve
    })
    let finishTransaction!: () => void
    const transactionFinished = new Promise<void>((resolve) => {
      finishTransaction = resolve
    })
    transaction.apply.mockImplementationOnce(async () => {
      markTransactionStarted()
      await transactionFinished
      return {
        status: 'applied',
        scanId,
        migratedAccountIds: ['internal-account-id'],
        inboundApiKey: 'skipped',
        adminApiKey: 'skipped'
      }
    })

    const ipc = new LegacyKiroRsMigrationIpc({
      scanner,
      transaction,
      ensureReady: async () => {},
      proxyIsRunning: () => false,
      quiesceCredentialRefreshes: () => gate.closeAdmissionAndDrain(),
      resumeCredentialRefreshes: () => {
        gate.openAdmission()
        return true
      }
    })

    const applying = ipc.apply(scanId, {
      accounts: true,
      inboundApiKey: false,
      adminApiKey: false
    })
    await vi.waitFor(() => expect(gate.isAdmissionClosed()).toBe(true))

    await expect(ipc.resumeCredentialRefreshes()).resolves.toEqual({
      ok: true,
      value: { resumed: false }
    })
    expect(gate.acquire()).toBeNull()

    existingRefresh?.release()
    await transactionStarted
    await expect(ipc.resumeCredentialRefreshes()).resolves.toEqual({
      ok: true,
      value: { resumed: false }
    })
    expect(gate.acquire()).toBeNull()

    finishTransaction()
    await expect(applying).resolves.toEqual({
      ok: true,
      value: { status: 'applied', migratedCount: 1 }
    })
    await expect(ipc.resumeCredentialRefreshes()).resolves.toEqual({
      ok: true,
      value: { resumed: false }
    })
    expect(gate.acquire()).toBeNull()
  })

  it('allows a guarded resume after a safe no-op apply', async () => {
    const { scanner, transaction } = fixture()
    const gate = new LegacyKiroRsMigrationCredentialRefreshGate()
    gate.openAdmission()
    transaction.apply.mockResolvedValueOnce({
      status: 'noop',
      scanId,
      migratedAccountIds: [],
      inboundApiKey: 'skipped',
      adminApiKey: 'skipped'
    })
    const ipc = new LegacyKiroRsMigrationIpc({
      scanner,
      transaction,
      ensureReady: async () => {},
      proxyIsRunning: () => false,
      quiesceCredentialRefreshes: () => gate.closeAdmissionAndDrain(),
      resumeCredentialRefreshes: () => {
        gate.openAdmission()
        return true
      }
    })

    await expect(
      ipc.apply(scanId, { accounts: false, inboundApiKey: false, adminApiKey: false })
    ).resolves.toEqual({ ok: true, value: { status: 'noop', migratedCount: 0 } })
    await expect(ipc.resumeCredentialRefreshes()).resolves.toEqual({
      ok: true,
      value: { resumed: true }
    })
    const lease = gate.acquire()
    expect(lease).not.toBeNull()
    lease?.release()
  })

  it('applies a terminal clear after an overlapping safe apply finishes', async () => {
    const { ipc, transaction, resumeCredentialRefreshes } = fixture()
    await ipc.apply(scanId, {
      accounts: true,
      inboundApiKey: false,
      adminApiKey: false
    })

    let finishNoopApply!: () => void
    transaction.apply.mockImplementationOnce(
      () => new Promise((resolve) => {
        finishNoopApply = () => resolve({
          status: 'noop',
          scanId,
          migratedAccountIds: [],
          inboundApiKey: 'skipped',
          adminApiKey: 'skipped'
        })
      })
    )
    const overlappingApply = ipc.apply(scanId, {
      accounts: false,
      inboundApiKey: false,
      adminApiKey: false
    })
    await vi.waitFor(() => expect(transaction.apply).toHaveBeenCalledTimes(2))

    await expect(ipc.finalize()).resolves.toEqual({
      ok: true,
      value: { status: 'finalized', migratedCount: 1 }
    })
    await expect(ipc.resumeCredentialRefreshes()).resolves.toEqual({
      ok: true,
      value: { resumed: false }
    })

    finishNoopApply()
    await expect(overlappingApply).resolves.toEqual({
      ok: true,
      value: { status: 'noop', migratedCount: 0 }
    })
    await expect(ipc.resumeCredentialRefreshes()).resolves.toEqual({
      ok: true,
      value: { resumed: true }
    })
    expect(resumeCredentialRefreshes).toHaveBeenCalledOnce()
  })

  it('reopens credential refresh admission only through the guarded resume boundary', async () => {
    const { ipc, resumeCredentialRefreshes } = fixture()
    await expect(ipc.resumeCredentialRefreshes()).resolves.toEqual({
      ok: true,
      value: { resumed: true }
    })
    expect(resumeCredentialRefreshes).toHaveBeenCalledOnce()

    resumeCredentialRefreshes.mockReturnValueOnce(false)
    await expect(ipc.resumeCredentialRefreshes()).resolves.toEqual({
      ok: true,
      value: { resumed: false }
    })
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
        rollbackAvailable: false,
        rollbackSyncRequired: false
      }
    })

    transaction.recover.mockResolvedValueOnce({
      status: 'rollback_sync_required',
      scanId,
      migratedAccountIds: ['internal-account-id']
    })
    await expect(ipc.recover()).resolves.toEqual({
      ok: true,
      value: {
        status: 'rollback_sync_required',
        migratedCount: 1,
        proxyRunning: false,
        rollbackAvailable: false,
        rollbackSyncRequired: true
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
        rollbackAvailable: false,
        rollbackSyncRequired: false
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
      proxyIsRunning: () => true,
      quiesceCredentialRefreshes: async () => {},
      resumeCredentialRefreshes: () => false
    })
    await expect(
      ipc.apply(scanId, { accounts: true, inboundApiKey: false, adminApiKey: false })
    ).resolves.toEqual({ ok: false, errorCode: 'PROXY_RUNNING' })
    await expect(ipc.rollback()).resolves.toEqual({ ok: false, errorCode: 'PROXY_RUNNING' })
    await expect(ipc.finalize()).resolves.toEqual({ ok: false, errorCode: 'PROXY_RUNNING' })
    await expect(ipc.acknowledgeRollback()).resolves.toEqual({ ok: false, errorCode: 'PROXY_RUNNING' })
    expect(transaction.apply).not.toHaveBeenCalled()
    expect(transaction.rollback).not.toHaveBeenCalled()
    expect(transaction.finalize).not.toHaveBeenCalled()
    expect(transaction.acknowledgeRollback).not.toHaveBeenCalled()
  })
})
