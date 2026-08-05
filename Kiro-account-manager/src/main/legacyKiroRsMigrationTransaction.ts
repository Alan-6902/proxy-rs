import { createHash } from 'node:crypto'
import type { ApiKey, ProxyConfig } from './proxy/types'
import type { PreparedMigrationPlan } from './legacyKiroRsMigration'
import { LegacyKiroRsMigrationError } from '../shared/legacyKiroRsMigration'
import {
  LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES,
  LegacyKiroRsMigrationTransactionError,
  type LegacyKiroRsMigrationApplyResult,
  type LegacyKiroRsMigrationRecoveryResult,
  type LegacyKiroRsMigrationRollbackResult,
  type LegacyKiroRsMigrationSelection
} from '../shared/legacyKiroRsMigrationTransaction'

type AccountData = Record<string, unknown> & {
  accounts: Record<string, Record<string, unknown>>
  activeAccountId: string | null
}

export interface LegacyKiroRsMigrationSnapshot {
  accountData: AccountData
  proxyConfig: ProxyConfig
}

/**
 * Internal secret-bearing recovery record. Persist only through protected,
 * encrypted-at-rest storage; public results and errors never expose it.
 */

export interface LegacyKiroRsMigrationJournal {
  version: 1
  operation: 'apply' | 'rollback'
  state: 'prepared' | 'half' | 'applied' | 'completed' | 'rolled_back'
  scanId: string
  timestamps: { preparedAt: number; updatedAt: number }
  before: LegacyKiroRsMigrationSnapshot
  after: LegacyKiroRsMigrationSnapshot
  beforeHash: string
  afterHash: string
  accountStepFingerprint: string
  migratedAccountIds: string[]
  inboundApiKey: 'skipped' | 'appended'
  adminApiKey: 'skipped' | 'written'
}

export interface LegacyKiroRsMigrationTransactionDependencies {
  scanner: {
    consumePreparedPlanForApply(scanId: string): Promise<PreparedMigrationPlan | undefined>
  }
  snapshotStore: {
    read(): Promise<LegacyKiroRsMigrationSnapshot>
    writeAccountData(accountData: AccountData): Promise<void>
    writeProxyConfig(proxyConfig: ProxyConfig): Promise<void>
    syncLastSavedData(): Promise<void>
  }
  /** Protected storage: production adapters must encrypt journal snapshots at rest. */
  journal: {
    read(): Promise<LegacyKiroRsMigrationJournal | undefined>
    write(journal: LegacyKiroRsMigrationJournal): Promise<void>
    remove(): Promise<void>
  }
  coordinator: LegacyKiroRsMigrationCoordinator
  proxyIsRunning: () => boolean
  clock?: () => number
  randomUUID?: () => string
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return `string:${JSON.stringify(value)}`
  if (typeof value === 'boolean') return `boolean:${value}`
  if (typeof value === 'number')
    return `number:${Number.isNaN(value) ? 'NaN' : Object.is(value, -0) ? '-0' : String(value)}`
  if (Array.isArray(value)) return `array:[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `object:{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`
  }
  throw new TypeError('Unsupported snapshot value')
}

function snapshotHash(snapshot: LegacyKiroRsMigrationSnapshot): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex')
}

function accountDataHash(accountData: AccountData): string {
  return createHash('sha256').update(canonicalJson(accountData)).digest('hex')
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function emptyUsage(now: number): {
  current: number
  limit: number
  percentUsed: number
  lastUpdated: number
} {
  return { current: 0, limit: 0, percentUsed: 0, lastUpdated: now }
}

function createImportedAccount(
  id: string,
  key: string,
  now: number,
  isActive: boolean
): Record<string, unknown> {
  return {
    id,
    email: '',
    nickname: 'Imported from kiro-rs',
    idp: 'Internal',
    credentials: { credentialKind: 'kiro_api_key', kiroApiKey: key, region: 'us-east-1' },
    subscription: { type: 'Free' },
    usage: emptyUsage(now),
    tags: [],
    status: 'active',
    isActive,
    createdAt: now,
    lastUsedAt: 0
  }
}

function createImportedApiKey(id: string, key: string, now: number): ApiKey {
  return {
    id,
    name: 'Imported from kiro-rs',
    key,
    format: 'simple',
    enabled: true,
    createdAt: now,
    usage: {
      totalRequests: 0,
      totalCredits: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      daily: {}
    }
  }
}

function hasActiveAccount(accountData: AccountData): boolean {
  const id = accountData.activeAccountId
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(accountData.accounts, id)
}

function sameSnapshot(
  left: LegacyKiroRsMigrationSnapshot,
  right: LegacyKiroRsMigrationSnapshot
): boolean {
  return snapshotHash(left) === snapshotHash(right)
}

function makeResult(journal: LegacyKiroRsMigrationJournal): LegacyKiroRsMigrationApplyResult {
  return {
    status: 'applied',
    scanId: journal.scanId,
    migratedAccountIds: [...journal.migratedAccountIds],
    inboundApiKey: journal.inboundApiKey,
    adminApiKey: journal.adminApiKey
  }
}

/**
 * Shared by migration, all main-process snapshot writers, and proxy startup.
 * A production implementation must serialize the protected journal store too.
 */
export interface LegacyKiroRsMigrationCoordinator {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>
}

export class LegacyKiroRsMigrationTransaction {
  private readonly clock: () => number
  private readonly randomUUID: () => string

  constructor(private readonly dependencies: LegacyKiroRsMigrationTransactionDependencies) {
    this.clock = dependencies.clock ?? Date.now
    this.randomUUID = dependencies.randomUUID ?? crypto.randomUUID
  }

  async apply(
    scanId: string,
    selection: LegacyKiroRsMigrationSelection
  ): Promise<LegacyKiroRsMigrationApplyResult> {
    return this.boundary(() =>
      this.dependencies.coordinator.runExclusive(async () => {
        if (!selection.accounts && !selection.inboundApiKey && !selection.adminApiKey) {
          return {
            status: 'noop',
            scanId,
            migratedAccountIds: [],
            inboundApiKey: 'skipped',
            adminApiKey: 'skipped'
          }
        }
        this.assertProxyStopped()
        const existing = await this.readValidJournal()
        if (existing) this.assertCanApplyOverJournal(existing)

        const plan = await this.dependencies.scanner.consumePreparedPlanForApply(scanId)
        if (!plan)
          throw new LegacyKiroRsMigrationTransactionError(
            LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.SCAN_NOT_AVAILABLE
          )
        const before = clone(await this.dependencies.snapshotStore.read())
        const journal = this.prepareApplyJournal(plan, selection, before)
        if (sameSnapshot(before, journal.after)) {
          return {
            status: 'noop',
            scanId,
            migratedAccountIds: [],
            inboundApiKey: 'skipped',
            adminApiKey: 'skipped'
          }
        }
        if (!sameSnapshot(before, await this.dependencies.snapshotStore.read())) {
          throw new LegacyKiroRsMigrationTransactionError(
            LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.TARGET_CHANGED
          )
        }
        try {
          await this.dependencies.journal.write(clone(journal))
        } catch {
          throw new LegacyKiroRsMigrationTransactionError(
            LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.WRITE_FAILED
          )
        }
        try {
          await this.writeAccounts(journal.after.accountData)
          await this.writeJournal(journal, 'half')
          await this.dependencies.snapshotStore.writeProxyConfig(clone(journal.after.proxyConfig))
          await this.writeJournal(journal, 'applied')
          await this.writeJournal(journal, 'completed')
          return makeResult(journal)
        } catch {
          const compensated = await this.compensateApply(journal)
          throw new LegacyKiroRsMigrationTransactionError(
            compensated
              ? LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.WRITE_FAILED
              : LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.MANUAL_INTERVENTION
          )
        }
      })
    )
  }

  async recover(): Promise<LegacyKiroRsMigrationRecoveryResult> {
    return this.boundary(() =>
      this.dependencies.coordinator.runExclusive(async () => {
        const journal = await this.readValidJournal()
        if (!journal) return { status: 'none', migratedAccountIds: [] }
        if (journal.operation === 'apply' && journal.state === 'completed') {
          return {
            status: 'rollback_available',
            scanId: journal.scanId,
            migratedAccountIds: [...journal.migratedAccountIds]
          }
        }

        if (journal.operation === 'rollback' && journal.state === 'rolled_back') {
          this.assertProxyStopped()
          const current = await this.dependencies.snapshotStore.read()
          if (!sameSnapshot(current, journal.after)) {
            return {
              status: 'manual_intervention',
              scanId: journal.scanId,
              migratedAccountIds: [...journal.migratedAccountIds]
            }
          }
          try {
            await this.dependencies.journal.remove()
            return {
              status: 'recovered',
              scanId: journal.scanId,
              migratedAccountIds: [...journal.migratedAccountIds]
            }
          } catch {
            const cleanup = await this.classifyRollbackCleanup(journal)
            if (cleanup === 'removed')
              return {
                status: 'recovered',
                scanId: journal.scanId,
                migratedAccountIds: [...journal.migratedAccountIds]
              }
            if (cleanup === 'pending')
              return {
                status: 'cleanup_pending',
                scanId: journal.scanId,
                migratedAccountIds: [...journal.migratedAccountIds]
              }
            return {
              status: 'manual_intervention',
              scanId: journal.scanId,
              migratedAccountIds: [...journal.migratedAccountIds]
            }
          }
        }
        if (journal.state === 'rolled_back') {
          return {
            status: 'manual_intervention',
            scanId: journal.scanId,
            migratedAccountIds: [...journal.migratedAccountIds]
          }
        }

        this.assertProxyStopped()
        const current = await this.dependencies.snapshotStore.read()
        const position = this.position(current, journal)
        if (position === 'unknown') {
          return {
            status: 'manual_intervention',
            scanId: journal.scanId,
            migratedAccountIds: [...journal.migratedAccountIds]
          }
        }
        try {
          if (position === 'pre') {
            await this.writeAccounts(journal.after.accountData)
            await this.writeJournal(journal, 'half')
          }
          if (position === 'pre' || position === 'half') {
            await this.dependencies.snapshotStore.writeProxyConfig(clone(journal.after.proxyConfig))
            await this.writeJournal(journal, 'applied')
          }
          if (journal.operation === 'rollback') {
            await this.writeJournal(journal, 'rolled_back')
            try {
              await this.dependencies.journal.remove()
              return {
                status: 'recovered',
                scanId: journal.scanId,
                migratedAccountIds: [...journal.migratedAccountIds]
              }
            } catch {
              const cleanup = await this.classifyRollbackCleanup(journal)
              if (cleanup === 'removed')
                return {
                  status: 'recovered',
                  scanId: journal.scanId,
                  migratedAccountIds: [...journal.migratedAccountIds]
                }
              if (cleanup === 'pending')
                return {
                  status: 'cleanup_pending',
                  scanId: journal.scanId,
                  migratedAccountIds: [...journal.migratedAccountIds]
                }
              return {
                status: 'manual_intervention',
                scanId: journal.scanId,
                migratedAccountIds: [...journal.migratedAccountIds]
              }
            }
          }
          await this.writeJournal(journal, 'completed')
          return {
            status: 'recovered',
            scanId: journal.scanId,
            migratedAccountIds: [...journal.migratedAccountIds]
          }
        } catch {
          throw new LegacyKiroRsMigrationTransactionError(
            LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.WRITE_FAILED
          )
        }
      })
    )
  }

  async rollback(): Promise<LegacyKiroRsMigrationRollbackResult> {
    return this.boundary(() =>
      this.dependencies.coordinator.runExclusive(async () => {
        this.assertProxyStopped()
        const applied = await this.readValidJournal()
        if (!applied || applied.operation !== 'apply' || applied.state !== 'completed') {
          throw new LegacyKiroRsMigrationTransactionError(
            LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.ROLLBACK_NOT_AVAILABLE
          )
        }
        if (!sameSnapshot(await this.dependencies.snapshotStore.read(), applied.after)) {
          throw new LegacyKiroRsMigrationTransactionError(
            LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.SNAPSHOT_CHANGED
          )
        }
        const journal: LegacyKiroRsMigrationJournal = {
          ...clone(applied),
          operation: 'rollback',
          state: 'prepared',
          before: clone(applied.after),
          after: clone(applied.before),
          beforeHash: applied.afterHash,
          afterHash: applied.beforeHash,
          accountStepFingerprint: accountDataHash(applied.before.accountData),
          timestamps: { preparedAt: this.clock(), updatedAt: this.clock() }
        }
        try {
          await this.dependencies.journal.write(clone(journal))
        } catch {
          const restored = await this.restoreCompletedJournal(applied)
          throw new LegacyKiroRsMigrationTransactionError(
            restored
              ? LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.WRITE_FAILED
              : LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.MANUAL_INTERVENTION
          )
        }
        try {
          await this.writeAccounts(journal.after.accountData)
          await this.writeJournal(journal, 'half')
          await this.dependencies.snapshotStore.writeProxyConfig(clone(journal.after.proxyConfig))
          await this.writeJournal(journal, 'applied')
        } catch {
          const compensated = await this.compensateRollback(journal, applied)
          throw new LegacyKiroRsMigrationTransactionError(
            compensated
              ? LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.WRITE_FAILED
              : LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.MANUAL_INTERVENTION
          )
        }
        try {
          await this.writeJournal(journal, 'rolled_back')
        } catch {
          const terminal = await this.rollbackTerminalState(journal)
          if (terminal === true) {
            return {
              status: 'cleanup_pending',
              scanId: journal.scanId,
              migratedAccountIds: [...journal.migratedAccountIds]
            }
          }
          if (terminal === undefined) {
            throw new LegacyKiroRsMigrationTransactionError(
              LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.MANUAL_INTERVENTION
            )
          }
          const compensated = await this.compensateRollback(journal, applied)
          throw new LegacyKiroRsMigrationTransactionError(
            compensated
              ? LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.WRITE_FAILED
              : LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.MANUAL_INTERVENTION
          )
        }
        try {
          await this.dependencies.journal.remove()
          return {
            status: 'rolled_back',
            scanId: journal.scanId,
            migratedAccountIds: [...journal.migratedAccountIds]
          }
        } catch {
          const cleanup = await this.classifyRollbackCleanup(journal)
          if (cleanup === 'removed')
            return {
              status: 'rolled_back',
              scanId: journal.scanId,
              migratedAccountIds: [...journal.migratedAccountIds]
            }
          if (cleanup === 'pending')
            return {
              status: 'cleanup_pending',
              scanId: journal.scanId,
              migratedAccountIds: [...journal.migratedAccountIds]
            }
          throw new LegacyKiroRsMigrationTransactionError(
            LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.MANUAL_INTERVENTION
          )
        }
      })
    )
  }

  private async boundary<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof LegacyKiroRsMigrationTransactionError) {
        throw new LegacyKiroRsMigrationTransactionError(error.code)
      }
      if (error instanceof LegacyKiroRsMigrationError) {
        throw new LegacyKiroRsMigrationError(error.code)
      }
      throw new LegacyKiroRsMigrationTransactionError(
        LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.DEPENDENCY_FAILED
      )
    }
  }

  private prepareApplyJournal(
    plan: PreparedMigrationPlan,
    selection: LegacyKiroRsMigrationSelection,
    before: LegacyKiroRsMigrationSnapshot
  ): LegacyKiroRsMigrationJournal {
    const after = clone(before)
    const migratedAccountIds: string[] = []
    const now = this.clock()
    if (selection.accounts) {
      let activateFirst = !hasActiveAccount(after.accountData)
      for (const credential of plan.credentials) {
        if (credential.state !== 'new') continue
        const id = this.randomUUID()
        after.accountData.accounts[id] = createImportedAccount(
          id,
          credential.kiroApiKey,
          now,
          activateFirst
        )
        if (activateFirst) {
          after.accountData.activeAccountId = id
          activateFirst = false
        }
        migratedAccountIds.push(id)
      }
    }

    const proxyApiKeys = after.proxyConfig.apiKeys ?? []
    let inboundApiKey: 'skipped' | 'appended' = 'skipped'
    let adminApiKey: 'skipped' | 'written' = 'skipped'
    const inbound = selection.inboundApiKey ? plan.apiKey : undefined
    const admin = selection.adminApiKey ? plan.adminApiKey : undefined
    if (
      admin &&
      (admin === plan.apiKey ||
        admin === after.proxyConfig.apiKey ||
        proxyApiKeys.some((apiKey) => apiKey.key === admin))
    ) {
      throw new LegacyKiroRsMigrationTransactionError(
        LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.ADMIN_KEY_CONFLICT
      )
    }
    if (inbound && inbound === after.proxyConfig.adminApiKey) {
      throw new LegacyKiroRsMigrationTransactionError(
        LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.INBOUND_KEY_CONFLICT
      )
    }
    if (admin) {
      if (after.proxyConfig.adminApiKey === undefined) {
        after.proxyConfig.adminApiKey = admin
        adminApiKey = 'written'
      } else if (after.proxyConfig.adminApiKey !== admin) {
        throw new LegacyKiroRsMigrationTransactionError(
          LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.ADMIN_KEY_CONFLICT
        )
      }
    }
    if (
      inbound &&
      inbound !== after.proxyConfig.apiKey &&
      !proxyApiKeys.some((apiKey) => apiKey.key === inbound)
    ) {
      after.proxyConfig.apiKeys = [
        ...proxyApiKeys,
        createImportedApiKey(this.randomUUID(), inbound, now)
      ]
      inboundApiKey = 'appended'
    }

    return {
      version: 1,
      operation: 'apply',
      state: 'prepared',
      scanId: plan.scanId,
      timestamps: { preparedAt: now, updatedAt: now },
      before,
      after,
      beforeHash: snapshotHash(before),
      afterHash: snapshotHash(after),
      accountStepFingerprint: accountDataHash(after.accountData),
      migratedAccountIds,
      inboundApiKey,
      adminApiKey
    }
  }

  private async readValidJournal(): Promise<LegacyKiroRsMigrationJournal | undefined> {
    const journal = await this.dependencies.journal.read()
    if (journal && !this.isJournalValid(journal)) {
      throw new LegacyKiroRsMigrationTransactionError(
        LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.JOURNAL_INVALID
      )
    }
    return journal
  }

  private isJournalValid(journal: LegacyKiroRsMigrationJournal): boolean {
    if (
      !journal ||
      journal.version !== 1 ||
      !['apply', 'rollback'].includes(journal.operation) ||
      !['prepared', 'half', 'applied', 'completed', 'rolled_back'].includes(journal.state) ||
      typeof journal.scanId !== 'string' ||
      !journal.timestamps ||
      !Number.isFinite(journal.timestamps.preparedAt) ||
      !Number.isFinite(journal.timestamps.updatedAt) ||
      !Array.isArray(journal.migratedAccountIds) ||
      !journal.migratedAccountIds.every((id) => typeof id === 'string') ||
      !['skipped', 'appended'].includes(journal.inboundApiKey) ||
      !['skipped', 'written'].includes(journal.adminApiKey)
    )
      return false
    try {
      return (
        journal.beforeHash === snapshotHash(journal.before) &&
        journal.afterHash === snapshotHash(journal.after) &&
        journal.accountStepFingerprint === accountDataHash(journal.after.accountData)
      )
    } catch {
      return false
    }
  }

  private assertCanApplyOverJournal(journal: LegacyKiroRsMigrationJournal): void {
    if (journal.operation === 'apply' && journal.state === 'completed') {
      throw new LegacyKiroRsMigrationTransactionError(
        LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.MIGRATION_ALREADY_COMPLETED
      )
    }
    throw new LegacyKiroRsMigrationTransactionError(
      LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.RECOVERY_REQUIRED
    )
  }

  private async writeAccounts(accountData: AccountData): Promise<void> {
    await this.dependencies.snapshotStore.writeAccountData(clone(accountData))
    await this.dependencies.snapshotStore.syncLastSavedData()
  }

  private async writeJournal(
    journal: LegacyKiroRsMigrationJournal,
    state: LegacyKiroRsMigrationJournal['state']
  ): Promise<void> {
    journal.state = state
    journal.timestamps.updatedAt = this.clock()
    await this.dependencies.journal.write(clone(journal))
  }

  private position(
    current: LegacyKiroRsMigrationSnapshot,
    journal: LegacyKiroRsMigrationJournal
  ): 'pre' | 'half' | 'post' | 'unknown' {
    if (sameSnapshot(current, journal.before)) return 'pre'
    if (
      accountDataHash(current.accountData) === journal.accountStepFingerprint &&
      canonicalJson(current.proxyConfig) === canonicalJson(journal.before.proxyConfig)
    )
      return 'half'
    if (sameSnapshot(current, journal.after)) return 'post'
    return 'unknown'
  }

  private async classifyRollbackCleanup(
    journal: LegacyKiroRsMigrationJournal
  ): Promise<'removed' | 'pending' | 'manual'> {
    const current = await this.dependencies.snapshotStore.read()
    if (!sameSnapshot(current, journal.after)) return 'manual'
    const stored = await this.readValidJournal()
    if (!stored) return 'removed'
    if (
      stored.operation === 'rollback' &&
      stored.state === 'rolled_back' &&
      sameSnapshot(stored.after, journal.after)
    ) {
      return 'pending'
    }
    return 'manual'
  }

  private async rollbackTerminalState(
    journal: LegacyKiroRsMigrationJournal
  ): Promise<boolean | undefined> {
    try {
      const stored = await this.readValidJournal()
      if (!stored) return undefined
      return (
        stored.operation === 'rollback' &&
        stored.state === 'rolled_back' &&
        sameSnapshot(stored.after, journal.after)
      )
    } catch {
      return undefined
    }
  }

  private async compensateApply(journal: LegacyKiroRsMigrationJournal): Promise<boolean> {
    try {
      const current = await this.dependencies.snapshotStore.read()
      const position = this.position(current, journal)
      if (position === 'half') await this.writeAccounts(journal.before.accountData)
      else if (position === 'post') {
        await this.dependencies.snapshotStore.writeProxyConfig(clone(journal.before.proxyConfig))
        await this.writeAccounts(journal.before.accountData)
      } else if (position !== 'pre') return false
      await this.writeJournal(journal, 'rolled_back')
      return true
    } catch {
      return false
    }
  }

  private async compensateRollback(
    journal: LegacyKiroRsMigrationJournal,
    completedApply: LegacyKiroRsMigrationJournal
  ): Promise<boolean> {
    try {
      const current = await this.dependencies.snapshotStore.read()
      const position = this.position(current, journal)
      if (position === 'half') await this.writeAccounts(journal.before.accountData)
      else if (position === 'post') {
        await this.dependencies.snapshotStore.writeProxyConfig(clone(journal.before.proxyConfig))
        await this.writeAccounts(journal.before.accountData)
      } else if (position !== 'pre') return false
      return this.restoreCompletedJournal(completedApply)
    } catch {
      return false
    }
  }

  private async restoreCompletedJournal(
    completedApply: LegacyKiroRsMigrationJournal
  ): Promise<boolean> {
    try {
      await this.dependencies.journal.write(clone(completedApply))
      return true
    } catch {
      return false
    }
  }

  private assertProxyStopped(): void {
    if (this.dependencies.proxyIsRunning()) {
      throw new LegacyKiroRsMigrationTransactionError(
        LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.PROXY_RUNNING
      )
    }
  }
}
