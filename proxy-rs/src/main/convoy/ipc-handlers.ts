/**
 * 自动车凭证同步 IPC
 *
 * 在主进程 index.ts 里调用 registerConvoyIpcHandlers({...}) 完成接线。
 *
 * 安全边界：登录 Key 与凭证明文只在主进程内流转。渲染进程能拿到的只有
 * ConvoySyncStatus（脱敏视图），写入方向只接受「设置 Key / 改配置 / 触发同步」。
 */

import { ipcMain, type BrowserWindow } from 'electron'
import type {
  ConvoySyncConfig,
  ConvoySyncStatus,
  ManualConvoyKey,
  ManualConvoyKeyResult
} from '../../shared/convoyCredentials'
import {
  clearConvoyState,
  isConvoyStoreAvailable,
  loadConvoyState,
  normalizeConvoyConfig,
  saveConvoyState
} from './configStore'
import type { ConvoySyncManager } from './syncManager'

/** IPC 频道名集中定义，避免主进程/preload 两处字符串漂移 */
export const CONVOY_CHANNEL = {
  status: 'convoy-status',
  saveConfig: 'convoy-save-config',
  clearConfig: 'convoy-clear-config',
  syncNow: 'convoy-sync-now',
  setManualKeys: 'convoy-set-manual-keys',
  clearManualKeys: 'convoy-clear-manual-keys',
  statusEvent: 'convoy-status-changed'
} as const

type IpcResult<T> = { success: true; data: T } | { success: false; error: string }

function ok<T>(data: T): IpcResult<T> {
  return { success: true, data }
}

function fail(err: unknown): IpcResult<never> {
  return { success: false, error: err instanceof Error ? err.message : String(err) }
}

export interface ConvoyIpcDeps {
  getManager: () => ConvoySyncManager
  getMainWindow: () => BrowserWindow | null
}

/** 推送状态给渲染进程；窗口已销毁时静默丢弃 */
export function sendConvoyStatus(
  getMainWindow: () => BrowserWindow | null,
  status: ConvoySyncStatus
): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(CONVOY_CHANNEL.statusEvent, status)
  }
}

export function registerConvoyIpcHandlers(deps: ConvoyIpcDeps): void {
  ipcMain.handle(
    CONVOY_CHANNEL.status,
    async (): Promise<
      IpcResult<
        ConvoySyncStatus & {
          encryptionAvailable: boolean
          config: ConvoySyncConfig
        }
      >
    > => {
      try {
        const [status, persisted] = await Promise.all([
          deps.getManager().buildStatus(),
          loadConvoyState()
        ])
        return ok({
          ...status,
          encryptionAvailable: isConvoyStoreAvailable(),
          config: persisted.config
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  /**
   * 保存配置与登录 Key。convoyKey 省略表示保留原值；传空串表示清除。
   * 登录 Key 变化时清空快照——旧 Key 拉来的凭证不该继续用新配置分配。
   */
  ipcMain.handle(
    CONVOY_CHANNEL.saveConfig,
    async (_e, input: { config: Partial<ConvoySyncConfig>; convoyKey?: string }) => {
      try {
        const before = await loadConvoyState()
        const saved = await saveConvoyState({
          config: normalizeConvoyConfig({ ...before.config, ...(input?.config || {}) }),
          convoyKey: input?.convoyKey
        })
        const manager = deps.getManager()
        if (saved.convoyKey !== before.convoyKey) manager.clearSnapshot()
        await manager.restart()
        return ok({ config: saved.config, hasConvoyKey: Boolean(saved.convoyKey) })
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(CONVOY_CHANNEL.clearConfig, async () => {
    try {
      await clearConvoyState()
      const manager = deps.getManager()
      manager.clearSnapshot()
      await manager.restart()
      return ok({ cleared: true })
    } catch (err) {
      return fail(err)
    }
  })

  /** 手动触发一轮同步。注意这可能产生真实计费，UI 侧需二次确认 */
  ipcMain.handle(CONVOY_CHANNEL.syncNow, async () => {
    try {
      const result = await deps.getManager().runOnce()
      return result.success ? ok({ synced: true }) : fail(new Error(result.error || '同步失败'))
    } catch (err) {
      return fail(err)
    }
  })

  /** 覆盖手填 Key 列表并做区域探测；返回逐条结果供 UI 展示 */
  ipcMain.handle(
    CONVOY_CHANNEL.setManualKeys,
    async (_e, keys: ManualConvoyKey[]): Promise<IpcResult<ManualConvoyKeyResult[]>> => {
      try {
        if (!Array.isArray(keys)) throw new Error('手填 Key 列表格式非法')
        return ok(await deps.getManager().setManualKeys(keys))
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(CONVOY_CHANNEL.clearManualKeys, async () => {
    try {
      deps.getManager().clearManualKeys()
      return ok({ cleared: true })
    } catch (err) {
      return fail(err)
    }
  })
}
