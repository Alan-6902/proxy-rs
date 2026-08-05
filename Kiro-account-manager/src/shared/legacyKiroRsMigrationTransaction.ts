export const LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES = {
  PROXY_RUNNING: 'PROXY_RUNNING',
  SCAN_NOT_AVAILABLE: 'SCAN_NOT_AVAILABLE',
  ADMIN_KEY_CONFLICT: 'ADMIN_KEY_CONFLICT',
  INBOUND_KEY_CONFLICT: 'INBOUND_KEY_CONFLICT',
  JOURNAL_NOT_FOUND: 'JOURNAL_NOT_FOUND',
  ROLLBACK_NOT_AVAILABLE: 'ROLLBACK_NOT_AVAILABLE',
  FINALIZE_NOT_AVAILABLE: 'FINALIZE_NOT_AVAILABLE',
  ROLLBACK_ACK_NOT_AVAILABLE: 'ROLLBACK_ACK_NOT_AVAILABLE',
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
  CLEANUP_PENDING: 'CLEANUP_PENDING',
  MIGRATION_CONFIRMATION_REQUIRED: 'MIGRATION_CONFIRMATION_REQUIRED'
} as const

export type LegacyKiroRsMigrationTransactionErrorCode =
  (typeof LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES)[keyof typeof LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES]

export class LegacyKiroRsMigrationTransactionError extends Error {
  constructor(readonly code: LegacyKiroRsMigrationTransactionErrorCode) {
    super(`Legacy Kiro RS migration transaction failed: ${code}`)
    this.name = 'LegacyKiroRsMigrationTransactionError'
  }
}

export const LEGACY_KIRO_RS_MIGRATION_AUTO_START_BLOCKING_ERROR_CODES: readonly LegacyKiroRsMigrationTransactionErrorCode[] =
  [
    LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.CLEANUP_PENDING,
    LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.DEPENDENCY_FAILED,
    LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.ENCRYPTION_UNAVAILABLE,
    LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.JOURNAL_INVALID,
    LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.MANUAL_INTERVENTION,
    LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.MIGRATION_START_BLOCKED,
    LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.RECOVERY_REQUIRED,
    LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.SNAPSHOT_CHANGED,
    LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.WRITE_FAILED
  ]

export function legacyKiroRsMigrationErrorBlocksAutoStart(errorCode: string): boolean {
  return (LEGACY_KIRO_RS_MIGRATION_AUTO_START_BLOCKING_ERROR_CODES as readonly string[]).includes(
    errorCode
  )
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
  status:
    | 'none'
    | 'recovered'
    | 'manual_intervention'
    | 'rollback_available'
    | 'rollback_sync_required'
    | 'cleanup_pending'
  scanId?: string
  migratedAccountIds: string[]
}

export interface LegacyKiroRsMigrationRollbackResult {
  status: 'rolled_back' | 'cleanup_pending'
  scanId: string
  migratedAccountIds: string[]
}

export interface LegacyKiroRsMigrationFinalizeResult {
  status: 'finalized' | 'cleanup_pending'
  scanId: string
  migratedAccountIds: string[]
}

export interface LegacyKiroRsMigrationRollbackAckResult {
  status: 'acknowledged' | 'cleanup_pending'
  scanId: string
  migratedAccountIds: string[]
}

export function legacyKiroRsMigrationRecoveryRequiresCheckpoint(status: string): boolean {
  return status !== 'none' && status !== 'recovered'
}
