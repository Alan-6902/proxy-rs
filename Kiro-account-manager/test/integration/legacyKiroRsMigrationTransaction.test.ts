import { describe, expect, it } from 'vitest'
import type { ProxyConfig } from '../../src/main/proxy/types'
import type { PreparedMigrationPlan } from '../../src/main/legacyKiroRsMigration'
import {
  LegacyKiroRsMigrationTransaction,
  type LegacyKiroRsMigrationJournal,
  type LegacyKiroRsMigrationSnapshot
} from '../../src/main/legacyKiroRsMigrationTransaction'
import { LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES } from '../../src/shared/legacyKiroRsMigrationTransaction'

const inboundSecret = 'fixture-inbound-secret'
const adminSecret = 'fixture-admin-secret'
const upstreamSecret = 'fixture-upstream-secret'

function clone<T>(value: T): T {
  return structuredClone(value)
}

function snapshot(
  overrides: Partial<LegacyKiroRsMigrationSnapshot> = {}
): LegacyKiroRsMigrationSnapshot {
  return {
    accountData: {
      accounts: {},
      groups: { preserved: { label: 'keep' } },
      accountProxyBindings: { preserved: 'proxy-1' },
      activeAccountId: null,
      autoRefreshEnabled: true
    },
    proxyConfig: {
      enabled: false,
      host: '127.0.0.1',
      port: 7890,
      enableMultiAccount: false,
      selectedAccountIds: [],
      logRequests: false,
      maxConcurrent: 1
    } as ProxyConfig,
    ...overrides
  }
}

function plan(overrides: Partial<PreparedMigrationPlan> = {}): PreparedMigrationPlan {
  return {
    scanId: 'scan-1',
    expiresAt: 9_999,
    sourceFingerprint: 'source',
    targetFingerprint: 'target',
    credentials: [
      { itemId: 'new', keyHash: 'new-hash', kiroApiKey: upstreamSecret, state: 'new' },
      {
        itemId: 'existing',
        keyHash: 'old-hash',
        kiroApiKey: 'fixture-existing-secret',
        state: 'existing'
      },
      { itemId: 'duplicate', keyHash: 'new-hash', kiroApiKey: upstreamSecret, state: 'duplicate' }
    ],
    apiKey: inboundSecret,
    adminApiKey: adminSecret,
    ...overrides
  }
}

function makeTransaction(
  options: {
    initial?: LegacyKiroRsMigrationSnapshot
    preparedPlan?: PreparedMigrationPlan
    journal?: LegacyKiroRsMigrationJournal
    running?: boolean
    fail?: (operation: string, count: number, phase: 'before' | 'after') => boolean
    readSnapshots?: LegacyKiroRsMigrationSnapshot[]
    coordinator?: { runExclusive<T>(operation: () => Promise<T>): Promise<T> }
    dependencyFailure?: string
    sentinel?: string
    clock?: () => number
    randomUUID?: () => string
  } = {}
) {
  let current = clone(options.initial ?? snapshot())
  let persistedJournal = options.journal && clone(options.journal)
  let readIndex = 0
  let consumes = 0
  let tail: Promise<void> = Promise.resolve()
  const calls: string[] = []
  const count = new Map<string, number>()
  const invoke = (operation: string) => {
    const next = (count.get(operation) ?? 0) + 1
    count.set(operation, next)
    calls.push(operation)
    if (options.fail?.(operation, next, 'before'))
      throw new Error(`${operation} failed before persistence`)
    return next
  }
  const afterWrite = (operation: string, count: number) => {
    if (options.fail?.(operation, count, 'after'))
      throw new Error(`${operation} failed after persistence`)
  }
  const failDependency = (operation: string) => {
    if (options.dependencyFailure === operation)
      throw new Error(options.sentinel ?? `${operation} dependency failure`)
  }
  const coordinator = options.coordinator ?? {
    runExclusive<T>(operation: () => Promise<T>): Promise<T> {
      const guarded = async () => {
        failDependency('coordinator')
        return operation()
      }
      const result = tail.then(guarded, guarded)
      tail = result.then(
        () => undefined,
        () => undefined
      )
      return result
    }
  }
  const transaction = new LegacyKiroRsMigrationTransaction({
    scanner: {
      consumePreparedPlanForApply: async (scanId) => {
        failDependency('scanner.consume')
        consumes += 1
        return scanId === (options.preparedPlan ?? plan()).scanId
          ? clone(options.preparedPlan ?? plan())
          : undefined
      }
    },
    snapshotStore: {
      read: async () => {
        failDependency('snapshot.read')
        const scheduled = options.readSnapshots?.[readIndex++]
        if (scheduled) current = clone(scheduled)
        return clone(current)
      },
      writeAccountData: async (accountData) => {
        failDependency('snapshot.writeAccountData')
        const write = invoke('account')
        current = { ...current, accountData: clone(accountData) }
        afterWrite('account', write)
      },
      writeProxyConfig: async (proxyConfig) => {
        failDependency('snapshot.writeProxyConfig')
        const write = invoke('proxy')
        current = { ...current, proxyConfig: clone(proxyConfig) }
        afterWrite('proxy', write)
      },
      syncLastSavedData: async () => {
        failDependency('snapshot.syncLastSavedData')
        const write = invoke('sync')
        afterWrite('sync', write)
      }
    },
    journal: {
      read: async () => {
        failDependency('journal.read')
        return clone(persistedJournal)
      },
      write: async (value) => {
        failDependency('journal.write')
        const operation = `journal:${value.state}`
        const write = invoke(operation)
        persistedJournal = clone(value)
        afterWrite(operation, write)
      },
      remove: async () => {
        failDependency('journal.remove')
        const write = invoke('journal:remove')
        persistedJournal = undefined
        afterWrite('journal:remove', write)
      }
    },
    coordinator,
    proxyIsRunning: () => options.running ?? false,
    clock: options.clock ?? (() => 100),
    randomUUID:
      options.randomUUID ??
      (() => {
        let index = 0
        return () => `uuid-${++index}`
      })()
  })
  return {
    transaction,
    calls,
    current: () => clone(current),
    journal: () => clone(persistedJournal),
    consumes: () => consumes,
    coordinator
  }
}

describe('LegacyKiroRsMigrationTransaction', () => {
  it('imports only new scanner credentials, preserves unknown account data, and activates the first new account', async () => {
    const fake = makeTransaction()
    const result = await fake.transaction.apply('scan-1', {
      accounts: true,
      inboundApiKey: true,
      adminApiKey: true
    })

    expect(result).toEqual({
      status: 'applied',
      scanId: 'scan-1',
      migratedAccountIds: ['uuid-1'],
      inboundApiKey: 'appended',
      adminApiKey: 'written'
    })
    const saved = fake.current()
    expect(saved.accountData.groups).toEqual({ preserved: { label: 'keep' } })
    expect(saved.accountData.accountProxyBindings).toEqual({ preserved: 'proxy-1' })
    expect(saved.accountData.activeAccountId).toBe('uuid-1')
    expect(saved.accountData.accounts['uuid-1']).toMatchObject({
      idp: 'Internal',
      status: 'active',
      isActive: true,
      tags: [],
      subscription: { type: 'Free' },
      usage: { current: 0, limit: 0 },
      credentials: {
        credentialKind: 'kiro_api_key',
        kiroApiKey: upstreamSecret,
        region: 'us-east-1'
      }
    })
    expect(saved.proxyConfig.apiKeys).toMatchObject([
      { id: 'uuid-2', name: 'Imported from kiro-rs', key: inboundSecret, enabled: true }
    ])
    expect(fake.calls).toEqual([
      'journal:prepared',
      'account',
      'sync',
      'journal:half',
      'proxy',
      'journal:applied',
      'journal:completed'
    ])
  })

  it('does not steal a valid active account and leaves all accounts untouched when accounts are not selected', async () => {
    const existing = {
      id: 'existing-account',
      email: 'existing@example.com',
      idp: 'Internal',
      credentials: {},
      subscription: { type: 'Free' },
      usage: { current: 0, limit: 0, percentUsed: 0, lastUpdated: 0 },
      tags: [],
      status: 'active',
      isActive: true,
      createdAt: 0,
      lastUsedAt: 0
    }
    const active = makeTransaction({
      initial: snapshot({
        accountData: {
          accounts: { 'existing-account': existing },
          activeAccountId: 'existing-account'
        }
      })
    })
    await active.transaction.apply('scan-1', {
      accounts: true,
      inboundApiKey: false,
      adminApiKey: false
    })
    expect(active.current().accountData.accounts['uuid-1'].isActive).toBe(false)
    expect(active.current().accountData.activeAccountId).toBe('existing-account')

    const skipped = makeTransaction()
    await skipped.transaction.apply('scan-1', {
      accounts: false,
      inboundApiKey: false,
      adminApiKey: false
    })
    expect(skipped.current().accountData.accounts).toEqual({})
  })

  it('skips identical inbound keys, appends distinct keys, and blocks all admin key collisions including disabled keys', async () => {
    const same = makeTransaction({
      initial: snapshot({ proxyConfig: { ...snapshot().proxyConfig, apiKey: inboundSecret } })
    })
    await expect(
      same.transaction.apply('scan-1', { accounts: false, inboundApiKey: true, adminApiKey: false })
    ).resolves.toMatchObject({ inboundApiKey: 'skipped' })

    const appended = makeTransaction({
      initial: snapshot({
        proxyConfig: {
          ...snapshot().proxyConfig,
          apiKeys: [
            {
              id: 'old',
              name: 'old',
              key: 'other',
              format: 'simple',
              enabled: false,
              createdAt: 0,
              usage: {
                totalRequests: 0,
                totalCredits: 0,
                totalInputTokens: 0,
                totalOutputTokens: 0,
                daily: {}
              }
            }
          ]
        }
      })
    })
    await appended.transaction.apply('scan-1', {
      accounts: false,
      inboundApiKey: true,
      adminApiKey: false
    })
    expect(appended.current().proxyConfig.apiKeys).toHaveLength(2)

    const disabledCollision = makeTransaction({
      initial: snapshot({
        proxyConfig: {
          ...snapshot().proxyConfig,
          apiKeys: [
            {
              id: 'disabled',
              name: 'disabled',
              key: adminSecret,
              format: 'simple',
              enabled: false,
              createdAt: 0,
              usage: {
                totalRequests: 0,
                totalCredits: 0,
                totalInputTokens: 0,
                totalOutputTokens: 0,
                daily: {}
              }
            }
          ]
        }
      })
    })
    await expect(
      disabledCollision.transaction.apply('scan-1', {
        accounts: false,
        inboundApiKey: false,
        adminApiKey: true
      })
    ).rejects.toMatchObject({
      code: LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.ADMIN_KEY_CONFLICT
    })
    expect(disabledCollision.calls).toEqual([])

    const sourceCollision = makeTransaction({ preparedPlan: plan({ adminApiKey: inboundSecret }) })
    await expect(
      sourceCollision.transaction.apply('scan-1', {
        accounts: false,
        inboundApiKey: true,
        adminApiKey: true
      })
    ).rejects.toMatchObject({
      code: LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.ADMIN_KEY_CONFLICT
    })
    expect(sourceCollision.calls).toEqual([])
  })

  it('gates apply and rollback while the proxy is running', async () => {
    const running = makeTransaction({ running: true })
    await expect(
      running.transaction.apply('scan-1', {
        accounts: true,
        inboundApiKey: true,
        adminApiKey: true
      })
    ).rejects.toMatchObject({
      code: LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.PROXY_RUNNING
    })
    await expect(running.transaction.rollback()).rejects.toMatchObject({
      code: LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.PROXY_RUNNING
    })
  })

  it.each([
    'journal:prepared',
    'account',
    'sync',
    'journal:half',
    'proxy',
    'journal:applied',
    'journal:completed'
  ])(
    'compensates matching snapshots after a %s write fault without leaking secrets',
    async (operation) => {
      const fake = makeTransaction({ fail: (name, count) => name === operation && count === 1 })
      try {
        await fake.transaction.apply('scan-1', {
          accounts: true,
          inboundApiKey: true,
          adminApiKey: true
        })
        throw new Error('expected write failure')
      } catch (error) {
        expect(error).toMatchObject({
          code: LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.WRITE_FAILED
        })
        expect(JSON.stringify(error)).not.toContain(upstreamSecret)
        expect(JSON.stringify(error)).not.toContain(inboundSecret)
        expect(JSON.stringify(error)).not.toContain(adminSecret)
      }
    }
  )

  it('recovers exact pre, half, and post journal positions, while unknown changes require manual intervention', async () => {
    const seed = makeTransaction()
    await seed.transaction.apply('scan-1', {
      accounts: true,
      inboundApiKey: true,
      adminApiKey: true
    })
    const completed = seed.journal()!
    const pre = makeTransaction({
      initial: completed.before,
      journal: { ...completed, state: 'prepared' }
    })
    await expect(pre.transaction.recover()).resolves.toMatchObject({ status: 'recovered' })
    expect(pre.current()).toEqual(completed.after)

    const half = makeTransaction({
      initial: {
        accountData: completed.after.accountData,
        proxyConfig: completed.before.proxyConfig
      },
      journal: { ...completed, state: 'half' }
    })
    await expect(half.transaction.recover()).resolves.toMatchObject({ status: 'recovered' })
    expect(half.current()).toEqual(completed.after)

    const post = makeTransaction({
      initial: completed.after,
      journal: { ...completed, state: 'applied' }
    })
    await expect(post.transaction.recover()).resolves.toMatchObject({ status: 'recovered' })
    expect(post.calls).toEqual(['journal:completed'])

    const unknown = makeTransaction({
      initial: snapshot({ proxyConfig: { ...snapshot().proxyConfig, host: 'changed' } }),
      journal: { ...completed, state: 'half' }
    })
    await expect(unknown.transaction.recover()).resolves.toMatchObject({
      status: 'manual_intervention'
    })
    expect(unknown.calls).toEqual([])
  })

  it('rolls back an untouched completed transaction and rejects an externally changed post snapshot', async () => {
    const fake = makeTransaction()
    await fake.transaction.apply('scan-1', {
      accounts: true,
      inboundApiKey: true,
      adminApiKey: true
    })
    await expect(fake.transaction.rollback()).resolves.toMatchObject({
      status: 'rolled_back',
      scanId: 'scan-1'
    })
    expect(fake.current()).toEqual(snapshot())
    expect(fake.journal()).toBeUndefined()

    const changed = makeTransaction()
    await changed.transaction.apply('scan-1', {
      accounts: true,
      inboundApiKey: true,
      adminApiKey: true
    })
    const journal = changed.journal()!
    const altered = clone(journal.after)
    altered.proxyConfig.host = 'external-change'
    const guarded = makeTransaction({ initial: altered, journal })
    await expect(guarded.transaction.rollback()).rejects.toMatchObject({
      code: LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.SNAPSHOT_CHANGED
    })
    expect(guarded.calls).toEqual([])
  })
})

describe('LegacyKiroRsMigrationTransaction coordination and journal safety', () => {
  it('does not replace an owned journal and leaves completed journal intact for empty selections', async () => {
    const fake = makeTransaction()
    await fake.transaction.apply('scan-1', {
      accounts: true,
      inboundApiKey: true,
      adminApiKey: true
    })
    const completed = fake.journal()
    const beforeCalls = [...fake.calls]

    await expect(
      fake.transaction.apply('scan-1', { accounts: true, inboundApiKey: true, adminApiKey: true })
    ).rejects.toMatchObject({
      code: LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.MIGRATION_ALREADY_COMPLETED
    })
    await expect(
      fake.transaction.apply('scan-2', { accounts: true, inboundApiKey: true, adminApiKey: true })
    ).rejects.toMatchObject({
      code: LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.MIGRATION_ALREADY_COMPLETED
    })
    await expect(
      fake.transaction.apply('scan-2', {
        accounts: false,
        inboundApiKey: false,
        adminApiKey: false
      })
    ).resolves.toMatchObject({ status: 'noop' })
    expect(fake.journal()).toEqual(completed)
    expect(fake.calls).toEqual(beforeCalls)
    expect(fake.consumes()).toBe(1)
  })

  it('performs the pre-journal snapshot CAS inside the shared exclusive coordinator', async () => {
    const original = snapshot()
    const changed = snapshot({
      proxyConfig: { ...original.proxyConfig, host: 'changed-before-journal' }
    })
    const fake = makeTransaction({ initial: original, readSnapshots: [original, changed] })

    await expect(
      fake.transaction.apply('scan-1', { accounts: true, inboundApiKey: true, adminApiKey: true })
    ).rejects.toMatchObject({
      code: LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.TARGET_CHANGED
    })
    expect(fake.calls).toEqual([])
    expect(fake.journal()).toBeUndefined()
  })

  it('validates journal hashes and account step fingerprints before any recover or rollback write', async () => {
    const seed = makeTransaction()
    await seed.transaction.apply('scan-1', {
      accounts: true,
      inboundApiKey: true,
      adminApiKey: true
    })
    const tampered = seed.journal()!
    tampered.beforeHash = 'tampered'
    const fake = makeTransaction({ initial: tampered.after, journal: tampered })

    await expect(fake.transaction.recover()).rejects.toMatchObject({
      code: LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.JOURNAL_INVALID
    })
    await expect(fake.transaction.rollback()).rejects.toMatchObject({
      code: LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.JOURNAL_INVALID
    })
    expect(fake.calls).toEqual([])
  })

  it('rejects a write-capable recovery while proxy is running but permits completed read-only recovery', async () => {
    const seed = makeTransaction()
    await seed.transaction.apply('scan-1', {
      accounts: true,
      inboundApiKey: true,
      adminApiKey: true
    })
    const completed = seed.journal()!
    const half = makeTransaction({
      running: true,
      initial: {
        accountData: completed.after.accountData,
        proxyConfig: completed.before.proxyConfig
      },
      journal: { ...completed, state: 'half' }
    })
    await expect(half.transaction.recover()).rejects.toMatchObject({
      code: LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.PROXY_RUNNING
    })
    expect(half.calls).toEqual([])

    const readOnly = makeTransaction({
      running: true,
      initial: completed.after,
      journal: completed
    })
    await expect(readOnly.transaction.recover()).resolves.toMatchObject({
      status: 'rollback_available'
    })
    expect(readOnly.calls).toEqual([])
  })

  it('serializes external writers with apply through the injected coordinator', async () => {
    let tail: Promise<void> = Promise.resolve()
    let releaseExternal: (() => void) | undefined
    const coordinator = {
      runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        const result = tail.then(operation, operation)
        tail = result.then(
          () => undefined,
          () => undefined
        )
        return result
      }
    }
    const fake = makeTransaction({ coordinator })
    const external = coordinator.runExclusive(
      async () =>
        new Promise<string>((resolve) => {
          releaseExternal = () => resolve('external-complete')
        })
    )
    await Promise.resolve()
    const apply = fake.transaction.apply('scan-1', {
      accounts: true,
      inboundApiKey: true,
      adminApiKey: true
    })
    await Promise.resolve()
    expect(fake.consumes()).toBe(0)
    releaseExternal?.()
    await expect(external).resolves.toBe('external-complete')
    await expect(apply).resolves.toMatchObject({ status: 'applied' })

    const followup = makeTransaction({
      coordinator,
      initial: fake.current(),
      journal: fake.journal()
    })
    const [recovery, rollback] = await Promise.all([
      followup.transaction.recover(),
      followup.transaction.rollback()
    ])
    expect(recovery).toMatchObject({ status: 'rollback_available' })
    expect(rollback).toMatchObject({ status: 'rolled_back' })
  })

  it('blocks inbound/admin collisions before journal writes for admin, legacy inbound, and disabled API key targets', async () => {
    const inboundAdmin = makeTransaction({
      initial: snapshot({ proxyConfig: { ...snapshot().proxyConfig, adminApiKey: inboundSecret } })
    })
    await expect(
      inboundAdmin.transaction.apply('scan-1', {
        accounts: false,
        inboundApiKey: true,
        adminApiKey: false
      })
    ).rejects.toMatchObject({
      code: LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.INBOUND_KEY_CONFLICT
    })
    expect(inboundAdmin.calls).toEqual([])

    const legacyAdmin = makeTransaction({
      initial: snapshot({ proxyConfig: { ...snapshot().proxyConfig, apiKey: adminSecret } })
    })
    await expect(
      legacyAdmin.transaction.apply('scan-1', {
        accounts: false,
        inboundApiKey: false,
        adminApiKey: true
      })
    ).rejects.toMatchObject({
      code: LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.ADMIN_KEY_CONFLICT
    })
    expect(legacyAdmin.calls).toEqual([])

    const targetAdmin = makeTransaction({
      initial: snapshot({
        proxyConfig: { ...snapshot().proxyConfig, adminApiKey: 'different-admin' }
      })
    })
    await expect(
      targetAdmin.transaction.apply('scan-1', {
        accounts: false,
        inboundApiKey: false,
        adminApiKey: true
      })
    ).rejects.toMatchObject({
      code: LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.ADMIN_KEY_CONFLICT
    })
    expect(targetAdmin.calls).toEqual([])
  })
})

describe('LegacyKiroRsMigrationTransaction fault compensation', () => {
  it.each([
    'journal:prepared',
    'account',
    'sync',
    'journal:half',
    'proxy',
    'journal:applied',
    'journal:completed'
  ])(
    'keeps a valid recovery instruction or restores disk state when %s fails before or after persistence',
    async (operation) => {
      for (const phase of ['before', 'after'] as const) {
        const fake = makeTransaction({
          fail: (name, count, when) => name === operation && count === 1 && when === phase
        })
        await expect(
          fake.transaction.apply('scan-1', {
            accounts: true,
            inboundApiKey: true,
            adminApiKey: true
          })
        ).rejects.toMatchObject({
          code: LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.WRITE_FAILED
        })
        expect(fake.current()).toEqual(snapshot())
        if (operation === 'journal:prepared' && phase === 'before') {
          expect(fake.journal()).toBeUndefined()
        } else {
          expect(fake.journal()).toBeDefined()
        }
      }
    }
  )

  it('reports manual intervention when compensation itself fails and leaves the journal for recovery', async () => {
    const fake = makeTransaction({
      fail: (operation, count, phase) =>
        (operation === 'proxy' && phase === 'after') ||
        (operation === 'account' && count === 2 && phase === 'before')
    })
    await expect(
      fake.transaction.apply('scan-1', { accounts: true, inboundApiKey: true, adminApiKey: true })
    ).rejects.toMatchObject({
      code: LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.MANUAL_INTERVENTION
    })
    expect(fake.journal()).toBeDefined()
  })
})

describe('LegacyKiroRsMigrationTransaction rollback terminal and sanitized boundary', () => {
  async function expectSanitized(
    operation: () => Promise<unknown>,
    expectedCode: string,
    sentinel: string
  ): Promise<void> {
    try {
      await operation()
      throw new Error('expected failure')
    } catch (error) {
      expect(error).toMatchObject({ code: expectedCode })
      expect(String(error)).not.toContain(sentinel)
      expect((error as Error).message).not.toContain(sentinel)
      expect(JSON.stringify(error)).not.toContain(sentinel)
    }
  }

  it('sanitizes unknown errors from every public dependency boundary', async () => {
    const sentinel = 'fixture-secret-sentinel'
    await expectSanitized(
      () => makeTransaction({ dependencyFailure: 'journal.read', sentinel }).transaction.recover(),
      LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.DEPENDENCY_FAILED,
      sentinel
    )
    await expectSanitized(
      () =>
        makeTransaction({ dependencyFailure: 'scanner.consume', sentinel }).transaction.apply(
          'scan-1',
          { accounts: true, inboundApiKey: false, adminApiKey: false }
        ),
      LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.DEPENDENCY_FAILED,
      sentinel
    )
    await expectSanitized(
      () =>
        makeTransaction({ dependencyFailure: 'snapshot.read', sentinel }).transaction.apply(
          'scan-1',
          { accounts: true, inboundApiKey: false, adminApiKey: false }
        ),
      LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.DEPENDENCY_FAILED,
      sentinel
    )
    await expectSanitized(
      () =>
        makeTransaction({ dependencyFailure: 'coordinator', sentinel }).transaction.apply(
          'scan-1',
          { accounts: true, inboundApiKey: false, adminApiKey: false }
        ),
      LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.DEPENDENCY_FAILED,
      sentinel
    )
    await expectSanitized(
      () =>
        makeTransaction({
          clock: () => {
            throw new Error(sentinel)
          }
        }).transaction.apply('scan-1', {
          accounts: true,
          inboundApiKey: false,
          adminApiKey: false
        }),
      LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.DEPENDENCY_FAILED,
      sentinel
    )
    await expectSanitized(
      () =>
        makeTransaction({
          randomUUID: () => {
            throw new Error(sentinel)
          }
        }).transaction.apply('scan-1', {
          accounts: true,
          inboundApiKey: false,
          adminApiKey: false
        }),
      LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.DEPENDENCY_FAILED,
      sentinel
    )
    await expectSanitized(
      () =>
        makeTransaction({ dependencyFailure: 'journal.write', sentinel }).transaction.apply(
          'scan-1',
          { accounts: true, inboundApiKey: false, adminApiKey: false }
        ),
      LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.WRITE_FAILED,
      sentinel
    )
    await expectSanitized(
      () =>
        makeTransaction({
          dependencyFailure: 'snapshot.writeAccountData',
          sentinel
        }).transaction.apply('scan-1', {
          accounts: true,
          inboundApiKey: false,
          adminApiKey: false
        }),
      LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.WRITE_FAILED,
      sentinel
    )
    await expectSanitized(
      () =>
        makeTransaction({
          dependencyFailure: 'snapshot.syncLastSavedData',
          sentinel
        }).transaction.apply('scan-1', {
          accounts: true,
          inboundApiKey: false,
          adminApiKey: false
        }),
      LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.MANUAL_INTERVENTION,
      sentinel
    )
    await expectSanitized(
      () =>
        makeTransaction({
          dependencyFailure: 'snapshot.writeProxyConfig',
          sentinel
        }).transaction.apply('scan-1', {
          accounts: false,
          inboundApiKey: true,
          adminApiKey: false
        }),
      LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.WRITE_FAILED,
      sentinel
    )
  })

  it('rejects before/after content and account-step journal tampering with zero writes', async () => {
    const seed = makeTransaction()
    await seed.transaction.apply('scan-1', {
      accounts: true,
      inboundApiKey: true,
      adminApiKey: true
    })
    const completed = seed.journal()!
    const tamper = [
      (journal: LegacyKiroRsMigrationJournal) => {
        journal.before.accountData.groups = { changed: true }
      },
      (journal: LegacyKiroRsMigrationJournal) => {
        journal.after.proxyConfig.host = 'tampered-host'
      },
      (journal: LegacyKiroRsMigrationJournal) => {
        journal.accountStepFingerprint = 'tampered-fingerprint'
      }
    ]
    for (const mutate of tamper) {
      const journal = clone(completed)
      mutate(journal)
      const fake = makeTransaction({ initial: completed.after, journal })
      await expect(fake.transaction.recover()).rejects.toMatchObject({
        code: LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.JOURNAL_INVALID
      })
      expect(fake.calls).toEqual([])
    }
  })

  it.each([
    'journal:prepared',
    'account',
    'sync',
    'journal:half',
    'proxy',
    'journal:applied',
    'journal:rolled_back'
  ])(
    'restores completed apply state when rollback %s fails before persistence',
    async (operation) => {
      const seed = makeTransaction()
      await seed.transaction.apply('scan-1', {
        accounts: true,
        inboundApiKey: true,
        adminApiKey: true
      })
      const completed = seed.journal()!
      const fake = makeTransaction({
        initial: completed.after,
        journal: completed,
        fail: (name, count, phase) => name === operation && count === 1 && phase === 'before'
      })

      await expect(fake.transaction.rollback()).rejects.toMatchObject({
        code: LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.WRITE_FAILED
      })
      expect(fake.current()).toEqual(completed.after)
      expect(fake.journal()).toEqual(completed)
    }
  )

  it.each(['journal:prepared', 'account', 'sync', 'journal:half', 'proxy', 'journal:applied'])(
    'restores completed apply state when rollback %s fails after persistence',
    async (operation) => {
      const seed = makeTransaction()
      await seed.transaction.apply('scan-1', {
        accounts: true,
        inboundApiKey: true,
        adminApiKey: true
      })
      const completed = seed.journal()!
      const fake = makeTransaction({
        initial: completed.after,
        journal: completed,
        fail: (name, count, phase) => name === operation && count === 1 && phase === 'after'
      })

      await expect(fake.transaction.rollback()).rejects.toMatchObject({
        code: LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.WRITE_FAILED
      })
      expect(fake.current()).toEqual(completed.after)
      expect(fake.journal()).toEqual(completed)
    }
  )

  it('treats a persisted rollback terminal state as complete when its journal write or cleanup fails, then retries cleanup', async () => {
    for (const [operation, phase, firstStatus, hasTerminalJournal] of [
      ['journal:rolled_back', 'after', 'cleanup_pending', true],
      ['journal:remove', 'before', 'cleanup_pending', true],
      ['journal:remove', 'after', 'rolled_back', false]
    ] as const) {
      const seed = makeTransaction()
      await seed.transaction.apply('scan-1', {
        accounts: true,
        inboundApiKey: true,
        adminApiKey: true
      })
      const completed = seed.journal()!
      const fake = makeTransaction({
        initial: completed.after,
        journal: completed,
        fail: (name, count, when) => name === operation && count === 1 && when === phase
      })
      await expect(fake.transaction.rollback()).resolves.toMatchObject({ status: firstStatus })
      expect(fake.current()).toEqual(completed.before)
      if (hasTerminalJournal) {
        expect(fake.journal()).toMatchObject({ operation: 'rollback', state: 'rolled_back' })
        await expect(fake.transaction.recover()).resolves.toMatchObject({ status: 'recovered' })
      } else {
        expect(fake.journal()).toBeUndefined()
      }
      await expect(fake.transaction.recover()).resolves.toMatchObject({ status: 'none' })
    }
  })

  it('handles recover journal deletion before/after exceptions without undoing terminal data', async () => {
    const seed = makeTransaction()
    await seed.transaction.apply('scan-1', {
      accounts: true,
      inboundApiKey: true,
      adminApiKey: true
    })
    const completed = seed.journal()!
    const terminal = makeTransaction({
      initial: completed.after,
      journal: completed,
      fail: (name, count, phase) => name === 'journal:remove' && count === 1 && phase === 'before'
    })
    await expect(terminal.transaction.rollback()).resolves.toMatchObject({
      status: 'cleanup_pending'
    })
    const rollbackJournal = terminal.journal()!

    const before = makeTransaction({
      initial: terminal.current(),
      journal: rollbackJournal,
      fail: (name, count, phase) => name === 'journal:remove' && count === 1 && phase === 'before'
    })
    await expect(before.transaction.recover()).resolves.toMatchObject({ status: 'cleanup_pending' })
    expect(before.current()).toEqual(completed.before)
    await expect(before.transaction.recover()).resolves.toMatchObject({ status: 'recovered' })
    await expect(before.transaction.recover()).resolves.toMatchObject({ status: 'none' })

    const after = makeTransaction({
      initial: terminal.current(),
      journal: rollbackJournal,
      fail: (name, count, phase) => name === 'journal:remove' && count === 1 && phase === 'after'
    })
    await expect(after.transaction.recover()).resolves.toMatchObject({ status: 'recovered' })
    expect(after.current()).toEqual(completed.before)
    await expect(after.transaction.recover()).resolves.toMatchObject({ status: 'none' })
  })

  it('keeps manual intervention visible when rollback compensation or completed-journal restoration fails', async () => {
    const seed = makeTransaction()
    await seed.transaction.apply('scan-1', {
      accounts: true,
      inboundApiKey: true,
      adminApiKey: true
    })
    const completed = seed.journal()!
    const compensationFailure = makeTransaction({
      initial: completed.after,
      journal: completed,
      fail: (name, count, phase) =>
        (name === 'proxy' && count === 1 && phase === 'after') ||
        (name === 'account' && count === 2 && phase === 'before')
    })
    await expect(compensationFailure.transaction.rollback()).rejects.toMatchObject({
      code: LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.MANUAL_INTERVENTION
    })
    expect(compensationFailure.journal()).toBeDefined()

    const journalRestoreFailure = makeTransaction({
      initial: completed.after,
      journal: completed,
      fail: (name, count, phase) =>
        (name === 'journal:applied' && count === 1 && phase === 'before') ||
        (name === 'journal:completed' && phase === 'before')
    })
    await expect(journalRestoreFailure.transaction.rollback()).rejects.toMatchObject({
      code: LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.MANUAL_INTERVENTION
    })
    expect(journalRestoreFailure.journal()).not.toEqual(completed)
  })
})
