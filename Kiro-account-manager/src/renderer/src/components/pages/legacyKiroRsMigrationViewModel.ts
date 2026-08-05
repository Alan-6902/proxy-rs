import type {
  LegacyKiroRsMigrationIpcRecoverResult,
  LegacyKiroRsMigrationIpcScanPreview,
  LegacyKiroRsMigrationIpcSelection
} from '../../../../shared/legacyKiroRsMigrationIpc'

import { legacyKiroRsMigrationErrorBlocksAutoStart } from '../../../../shared/legacyKiroRsMigrationTransaction'
import type { LegacyKiroRsMigrationIpcErrorCode } from '../../../../shared/legacyKiroRsMigrationIpc'

export type LegacyKiroRsMigrationRecoveryStatus = LegacyKiroRsMigrationIpcRecoverResult['status']

export function legacyKiroRsMigrationRecoveryStatusForError(
  errorCode: LegacyKiroRsMigrationIpcErrorCode
): Extract<LegacyKiroRsMigrationRecoveryStatus, 'manual_intervention' | 'cleanup_pending'> | null {
  if (!legacyKiroRsMigrationErrorBlocksAutoStart(errorCode)) return null
  return errorCode === 'CLEANUP_PENDING' ? 'cleanup_pending' : 'manual_intervention'
}

export function isLegacyKiroRsMigrationRecoveryBlocked(
  status: LegacyKiroRsMigrationRecoveryStatus
): boolean {
  return status === 'manual_intervention' || status === 'cleanup_pending'
}

export function defaultLegacyKiroRsMigrationSelection(
  preview: LegacyKiroRsMigrationIpcScanPreview
): LegacyKiroRsMigrationIpcSelection {
  return {
    accounts: preview.accounts.new > 0,
    inboundApiKey: preview.settings.inboundApiKey === 'target_empty',
    adminApiKey: preview.settings.adminApiKey === 'target_empty'
  }
}

export function hasLegacyKiroRsMigrationSelection(
  selection: LegacyKiroRsMigrationIpcSelection
): boolean {
  return selection.accounts || selection.inboundApiKey || selection.adminApiKey
}

export function legacyKiroRsMigrationRecoveryText(
  status: LegacyKiroRsMigrationRecoveryStatus,
  isEn: boolean
): string | null {
  if (status === 'manual_intervention') {
    return isEn
      ? 'Recovery needs manual intervention. Keep the proxy stopped and review migration diagnostics.'
      : '迁移恢复需要人工处理。请保持代理停止，并检查迁移诊断信息。'
  }
  if (status === 'cleanup_pending') {
    return isEn
      ? 'Rollback data is restored, but encrypted journal cleanup is pending. Retry recovery before starting the proxy.'
      : '回滚数据已恢复，但加密迁移日志仍待清理。请重试恢复后再启动代理。'
  }
  return null
}
