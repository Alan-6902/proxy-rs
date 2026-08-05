import { describe, expect, it } from 'vitest'
import type { LegacyKiroRsMigrationIpcScanPreview } from '../../src/shared/legacyKiroRsMigrationIpc'
import {
  defaultLegacyKiroRsMigrationSelection,
  hasLegacyKiroRsMigrationSelection,
  isLegacyKiroRsMigrationCheckpointPending,
  isLegacyKiroRsMigrationRecoveryBlocked,
  legacyKiroRsMigrationRecoveryText
} from '../../src/renderer/src/components/pages/legacyKiroRsMigrationViewModel'

import { legacyKiroRsMigrationRecoveryStatusForError } from '../../src/renderer/src/components/pages/legacyKiroRsMigrationViewModel'

const preview: LegacyKiroRsMigrationIpcScanPreview = {
  scanId: 'a'.repeat(32),
  expiresAt: 123,
  accounts: {
    available: 3,
    new: 1,
    existing: 1,
    duplicate: 1,
    redactedIds: ['redacted-only']
  },
  settings: {
    inboundApiKey: 'target_empty',
    adminApiKey: 'conflict',
    unsupportedCount: 2
  }
}

describe('legacy kiro-rs migration view model', () => {
  it('treats manual intervention and cleanup pending as blocking recovery states', () => {
    expect(isLegacyKiroRsMigrationRecoveryBlocked('manual_intervention')).toBe(true)
    expect(isLegacyKiroRsMigrationRecoveryBlocked('cleanup_pending')).toBe(true)
    expect(isLegacyKiroRsMigrationRecoveryBlocked('rollback_sync_required')).toBe(true)
    expect(isLegacyKiroRsMigrationRecoveryBlocked('none')).toBe(false)
    expect(isLegacyKiroRsMigrationRecoveryBlocked('recovered')).toBe(false)
    expect(isLegacyKiroRsMigrationRecoveryBlocked('rollback_available')).toBe(false)
    expect(isLegacyKiroRsMigrationCheckpointPending('rollback_available')).toBe(true)
    expect(isLegacyKiroRsMigrationCheckpointPending('rollback_sync_required')).toBe(true)
    expect(isLegacyKiroRsMigrationCheckpointPending('none')).toBe(false)
  })

  it('selects only new accounts and settings with an empty target', () => {
    const selection = defaultLegacyKiroRsMigrationSelection(preview)
    expect(selection).toEqual({
      accounts: true,
      inboundApiKey: true,
      adminApiKey: false
    })
    expect(hasLegacyKiroRsMigrationSelection(selection)).toBe(true)
    expect(
      hasLegacyKiroRsMigrationSelection({
        accounts: false,
        inboundApiKey: false,
        adminApiKey: false
      })
    ).toBe(false)
  })

  it('maps blocking IPC errors to a recovery-blocked UI state', () => {
    expect(legacyKiroRsMigrationRecoveryStatusForError('CLEANUP_PENDING')).toBe('cleanup_pending')
    expect(legacyKiroRsMigrationRecoveryStatusForError('MANUAL_INTERVENTION')).toBe(
      'manual_intervention'
    )
    expect(legacyKiroRsMigrationRecoveryStatusForError('RECOVERY_REQUIRED')).toBe(
      'manual_intervention'
    )
    expect(legacyKiroRsMigrationRecoveryStatusForError('JOURNAL_INVALID')).toBe(
      'manual_intervention'
    )
    expect(legacyKiroRsMigrationRecoveryStatusForError('PROXY_RUNNING')).toBeNull()
  })

  it('returns explicit bilingual guidance for blocked recovery states', () => {
    expect(legacyKiroRsMigrationRecoveryText('manual_intervention', true)).toContain(
      'manual intervention'
    )
    expect(legacyKiroRsMigrationRecoveryText('cleanup_pending', false)).toContain('日志仍待清理')
    expect(legacyKiroRsMigrationRecoveryText('rollback_sync_required', false)).toContain(
      '重新加载'
    )
    expect(legacyKiroRsMigrationRecoveryText('none', false)).toBeNull()
  })
})
