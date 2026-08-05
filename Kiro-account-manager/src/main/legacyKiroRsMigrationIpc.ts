import type { LegacyKiroRsMigrationService } from './legacyKiroRsMigration'
import type { LegacyKiroRsMigrationTransaction } from './legacyKiroRsMigrationTransaction'
import { LegacyKiroRsMigrationError } from '../shared/legacyKiroRsMigration'
import { LegacyKiroRsMigrationTransactionError } from '../shared/legacyKiroRsMigrationTransaction'
import type {
  LegacyKiroRsMigrationIpcApplyResult,
  LegacyKiroRsMigrationIpcErrorCode,
  LegacyKiroRsMigrationIpcRecoverResult,
  LegacyKiroRsMigrationIpcResult,
  LegacyKiroRsMigrationIpcRollbackResult,
  LegacyKiroRsMigrationIpcScanPreview,
  LegacyKiroRsMigrationIpcSelection
} from '../shared/legacyKiroRsMigrationIpc'

type MigrationDependencies = {
  scanner: Pick<LegacyKiroRsMigrationService, 'scan'>
  transaction: Pick<LegacyKiroRsMigrationTransaction, 'apply' | 'rollback' | 'recover'>
  ensureReady: () => Promise<void>
  proxyIsRunning: () => boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const isScanId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)

function isSelection(value: unknown): value is LegacyKiroRsMigrationIpcSelection {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  return (
    keys.length === 3 &&
    keys.every((key) => key === 'accounts' || key === 'inboundApiKey' || key === 'adminApiKey') &&
    typeof value.accounts === 'boolean' &&
    typeof value.inboundApiKey === 'boolean' &&
    typeof value.adminApiKey === 'boolean'
  )
}

function errorCode(error: unknown): LegacyKiroRsMigrationIpcErrorCode {
  if (
    error instanceof LegacyKiroRsMigrationError ||
    error instanceof LegacyKiroRsMigrationTransactionError
  )
    return error.code
  return 'DEPENDENCY_FAILED'
}

export class LegacyKiroRsMigrationIpc {
  constructor(private readonly dependencies: MigrationDependencies) {}

  async scan(): Promise<LegacyKiroRsMigrationIpcResult<LegacyKiroRsMigrationIpcScanPreview>> {
    try {
      await this.dependencies.ensureReady()
      const preview = await this.dependencies.scanner.scan()
      return {
        ok: true,
        value: {
          scanId: preview.scanId,
          expiresAt: preview.expiresAt,
          accounts: {
            available: preview.accounts.available,
            new: preview.accounts.new,
            existing: preview.accounts.existing,
            duplicate: preview.accounts.duplicate,
            redactedIds: preview.accounts.items.slice(0, 8).map((item) => item.redactedId)
          },
          settings: {
            inboundApiKey: preview.settings.apiKey.state,
            adminApiKey: preview.settings.adminApiKey.state,
            unsupportedCount: preview.settings.unsupportedCount
          }
        }
      }
    } catch (error) {
      return { ok: false, errorCode: errorCode(error) }
    }
  }

  async apply(
    scanId: unknown,
    selection: unknown
  ): Promise<LegacyKiroRsMigrationIpcResult<LegacyKiroRsMigrationIpcApplyResult>> {
    if (!isScanId(scanId) || !isSelection(selection))
      return { ok: false, errorCode: 'INVALID_REQUEST' }
    try {
      await this.dependencies.ensureReady()
      if (this.dependencies.proxyIsRunning()) return { ok: false, errorCode: 'PROXY_RUNNING' }
      const result = await this.dependencies.transaction.apply(scanId, selection)
      return {
        ok: true,
        value: { status: result.status, migratedCount: result.migratedAccountIds.length }
      }
    } catch (error) {
      return { ok: false, errorCode: errorCode(error) }
    }
  }

  async rollback(): Promise<
    LegacyKiroRsMigrationIpcResult<LegacyKiroRsMigrationIpcRollbackResult>
  > {
    try {
      await this.dependencies.ensureReady()
      if (this.dependencies.proxyIsRunning()) return { ok: false, errorCode: 'PROXY_RUNNING' }
      const result = await this.dependencies.transaction.rollback()
      return {
        ok: true,
        value: { status: result.status, migratedCount: result.migratedAccountIds.length }
      }
    } catch (error) {
      return { ok: false, errorCode: errorCode(error) }
    }
  }

  async recover(): Promise<LegacyKiroRsMigrationIpcResult<LegacyKiroRsMigrationIpcRecoverResult>> {
    try {
      await this.dependencies.ensureReady()
      const result = await this.dependencies.transaction.recover()
      const rollbackAvailable = result.status === 'rollback_available'
      return {
        ok: true,
        value: {
          status: result.status,
          migratedCount: result.migratedAccountIds.length,
          proxyRunning: this.dependencies.proxyIsRunning(),
          rollbackAvailable
        }
      }
    } catch (error) {
      return { ok: false, errorCode: errorCode(error) }
    }
  }
}
