import type { LegacyKiroRsMigrationErrorCode } from './legacyKiroRsMigration'
import type { LegacyKiroRsMigrationTransactionErrorCode } from './legacyKiroRsMigrationTransaction'

export const LEGACY_KIRO_RS_MIGRATION_IPC_CHANNELS = {
  scan: 'legacy-kiro-rs-migration:scan',
  apply: 'legacy-kiro-rs-migration:apply',
  rollback: 'legacy-kiro-rs-migration:rollback',
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

export interface LegacyKiroRsMigrationIpcRecoverResult {
  status: 'none' | 'recovered' | 'manual_intervention' | 'rollback_available' | 'cleanup_pending'
  migratedCount: number
  proxyRunning: boolean
  rollbackAvailable: boolean
}
