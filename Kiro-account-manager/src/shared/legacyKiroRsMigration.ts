export const LEGACY_KIRO_RS_MIGRATION_ERROR_CODES = {
  UNSUPPORTED_PLATFORM: 'UNSUPPORTED_PLATFORM',
  SOURCE_DIRECTORY_UNSAFE: 'SOURCE_DIRECTORY_UNSAFE',
  SOURCE_FILE_MISSING: 'SOURCE_FILE_MISSING',
  SOURCE_FILE_UNSAFE: 'SOURCE_FILE_UNSAFE',
  SOURCE_FILE_TOO_LARGE: 'SOURCE_FILE_TOO_LARGE',
  SOURCE_FILE_CHANGED: 'SOURCE_FILE_CHANGED',
  SOURCE_JSON_INVALID: 'SOURCE_JSON_INVALID',
  SOURCE_SCHEMA_INVALID: 'SOURCE_SCHEMA_INVALID',
  SOURCE_CREDENTIAL_INVALID: 'SOURCE_CREDENTIAL_INVALID',
  TARGET_SNAPSHOT_INVALID: 'TARGET_SNAPSHOT_INVALID',
  STALE_SCAN: 'STALE_SCAN'
} as const

export type LegacyKiroRsMigrationErrorCode =
  typeof LEGACY_KIRO_RS_MIGRATION_ERROR_CODES[keyof typeof LEGACY_KIRO_RS_MIGRATION_ERROR_CODES]

export class LegacyKiroRsMigrationError extends Error {
  constructor(readonly code: LegacyKiroRsMigrationErrorCode) {
    super(`Legacy Kiro RS migration failed: ${code}`)
    this.name = 'LegacyKiroRsMigrationError'
  }
}

export type LegacyKiroRsMigrationAccountState = 'new' | 'existing' | 'duplicate'

export interface LegacyKiroRsMigrationAccountPreview {
  itemId: string
  redactedId: string
  state: LegacyKiroRsMigrationAccountState
}

export type LegacyKiroRsMigrationSettingState = 'absent' | 'target_empty' | 'matches' | 'conflict'

export interface LegacyKiroRsMigrationSettingPreview {
  state: LegacyKiroRsMigrationSettingState
}

export interface LegacyKiroRsMigrationPreview {
  scanId: string
  expiresAt: number
  accounts: {
    available: number
    new: number
    existing: number
    duplicate: number
    items: LegacyKiroRsMigrationAccountPreview[]
  }
  settings: {
    apiKey: LegacyKiroRsMigrationSettingPreview
    adminApiKey: LegacyKiroRsMigrationSettingPreview
    unsupportedCount: number
  }
}
