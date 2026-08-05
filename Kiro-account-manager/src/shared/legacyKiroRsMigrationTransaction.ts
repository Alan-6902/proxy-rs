export const LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES = {
  PROXY_RUNNING: 'PROXY_RUNNING',
  SCAN_NOT_AVAILABLE: 'SCAN_NOT_AVAILABLE',
  ADMIN_KEY_CONFLICT: 'ADMIN_KEY_CONFLICT',
  INBOUND_KEY_CONFLICT: 'INBOUND_KEY_CONFLICT',
  JOURNAL_NOT_FOUND: 'JOURNAL_NOT_FOUND',
  ROLLBACK_NOT_AVAILABLE: 'ROLLBACK_NOT_AVAILABLE',
  SNAPSHOT_CHANGED: 'SNAPSHOT_CHANGED',
  TARGET_CHANGED: 'TARGET_CHANGED',
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED',
  MIGRATION_ALREADY_COMPLETED: 'MIGRATION_ALREADY_COMPLETED',
  JOURNAL_INVALID: 'JOURNAL_INVALID',
  MANUAL_INTERVENTION: 'MANUAL_INTERVENTION',
  MIGRATION_START_BLOCKED: 'MIGRATION_START_BLOCKED',
  DEPENDENCY_FAILED: 'DEPENDENCY_FAILED',
  ENCRYPTION_UNAVAILABLE: 'ENCRYPTION_UNAVAILABLE',
  WRITE_FAILED: 'WRITE_FAILED',
  CLEANUP_PENDING: 'CLEANUP_PENDING'
} as const

export type LegacyKiroRsMigrationTransactionErrorCode =
  (typeof LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES)[keyof typeof LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES]

export class LegacyKiroRsMigrationTransactionError extends Error {
  constructor(readonly code: LegacyKiroRsMigrationTransactionErrorCode) {
    super(`Legacy Kiro RS migration transaction failed: ${code}`)
    this.name = 'LegacyKiroRsMigrationTransactionError'
  }
}

export interface LegacyKiroRsMigrationSelection {
  accounts: boolean
  inboundApiKey: boolean
  adminApiKey: boolean
}

export interface LegacyKiroRsMigrationApplyResult {
  status: 'applied' | 'noop'
  scanId: string
  migratedAccountIds: string[]
  inboundApiKey: 'skipped' | 'appended'
  adminApiKey: 'skipped' | 'written'
}

export interface LegacyKiroRsMigrationRecoveryResult {
  status: 'none' | 'recovered' | 'manual_intervention' | 'rollback_available' | 'cleanup_pending'
  scanId?: string
  migratedAccountIds: string[]
}

export interface LegacyKiroRsMigrationRollbackResult {
  status: 'rolled_back' | 'cleanup_pending'
  scanId: string
  migratedAccountIds: string[]
}
