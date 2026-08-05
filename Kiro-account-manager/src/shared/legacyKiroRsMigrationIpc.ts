import type { LegacyKiroRsMigrationErrorCode } from './legacyKiroRsMigration'
import type { LegacyKiroRsMigrationTransactionErrorCode } from './legacyKiroRsMigrationTransaction'

export const LEGACY_KIRO_RS_MIGRATION_IPC_CHANNELS = {
  scan: 'legacy-kiro-rs-migration:scan',
  apply: 'legacy-kiro-rs-migration:apply',
  rollback: 'legacy-kiro-rs-migration:rollback',
  finalize: 'legacy-kiro-rs-migration:finalize',
  acknowledgeRollback: 'legacy-kiro-rs-migration:acknowledge-rollback',
  resumeCredentialRefreshes: 'legacy-kiro-rs-migration:resume-credential-refreshes',
  recover: 'legacy-kiro-rs-migration:recover'
} as const

export type LegacyKiroRsMigrationIpcErrorCode =
  | 'INVALID_REQUEST'
  | LegacyKiroRsMigrationErrorCode
  | LegacyKiroRsMigrationTransactionErrorCode

export type LegacyKiroRsMigrationIpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; errorCode: LegacyKiroRsMigrationIpcErrorCode }

export interface LegacyKiroRsMigrationIpcSelection {
  accounts: boolean
  inboundApiKey: boolean
  adminApiKey: boolean
}

export interface LegacyKiroRsMigrationIpcScanPreview {
  scanId: string
  expiresAt: number
  accounts: {
    available: number
    new: number
    existing: number
    duplicate: number
    redactedIds: string[]
  }
  settings: {
    inboundApiKey: 'absent' | 'target_empty' | 'matches' | 'conflict'
    adminApiKey: 'absent' | 'target_empty' | 'matches' | 'conflict'
    unsupportedCount: number
  }
}

export interface LegacyKiroRsMigrationIpcApplyResult {
  status: 'applied' | 'noop'
  migratedCount: number
}

export interface LegacyKiroRsMigrationIpcRollbackResult {
  status: 'rolled_back' | 'cleanup_pending'
  migratedCount: number
}

export interface LegacyKiroRsMigrationIpcFinalizeResult {
  status: 'finalized' | 'cleanup_pending'
  migratedCount: number
}

export interface LegacyKiroRsMigrationIpcRollbackAckResult {
  status: 'acknowledged' | 'cleanup_pending'
  migratedCount: number
}

export interface LegacyKiroRsMigrationIpcResumeCredentialRefreshesResult {
  resumed: boolean
}

export interface LegacyKiroRsMigrationIpcRecoverResult {
  status:
    | 'none'
    | 'recovered'
    | 'manual_intervention'
    | 'rollback_available'
    | 'rollback_sync_required'
    | 'cleanup_pending'
  migratedCount: number
  proxyRunning: boolean
  rollbackAvailable: boolean
  rollbackSyncRequired: boolean
}
