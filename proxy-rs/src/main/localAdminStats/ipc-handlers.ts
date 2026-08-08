import { ipcMain, type BrowserWindow } from 'electron'
import type {
  LocalAdminStatsSnapshot,
  LocalAdminUsageRefreshSummary
} from '../../shared/localAdminStats'
import type { LocalAdminStatsManager } from './statsManager'

export const LOCAL_ADMIN_STATS_CHANNEL = {
  snapshot: 'local-admin-stats-snapshot',
  refreshNow: 'local-admin-stats-refresh-now',
  refreshUsage: 'local-admin-stats-refresh-usage',
  clearSamples: 'local-admin-stats-clear-samples',
  snapshotEvent: 'local-admin-stats-changed'
} as const

interface IpcResult<T> {
  success: boolean
  data?: T
  error?: string
}

export interface LocalAdminStatsIpcDeps {
  getManager: () => LocalAdminStatsManager
  getMainWindow: () => BrowserWindow | null
}

function toError(error: unknown): IpcResult<never> {
  return { success: false, error: error instanceof Error ? error.message : String(error) }
}

export function sendLocalAdminStatsSnapshot(
  getMainWindow: () => BrowserWindow | null,
  snapshot: LocalAdminStatsSnapshot
): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(LOCAL_ADMIN_STATS_CHANNEL.snapshotEvent, snapshot)
  }
}

export function registerLocalAdminStatsIpcHandlers(deps: LocalAdminStatsIpcDeps): void {
  ipcMain.handle(LOCAL_ADMIN_STATS_CHANNEL.snapshot, (): IpcResult<LocalAdminStatsSnapshot> => {
    try {
      return { success: true, data: deps.getManager().snapshot() }
    } catch (error) {
      return toError(error)
    }
  })

  ipcMain.handle(
    LOCAL_ADMIN_STATS_CHANNEL.refreshNow,
    async (): Promise<IpcResult<LocalAdminStatsSnapshot>> => {
      try {
        return { success: true, data: await deps.getManager().refreshNow() }
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(
    LOCAL_ADMIN_STATS_CHANNEL.refreshUsage,
    async (): Promise<IpcResult<LocalAdminUsageRefreshSummary>> => {
      try {
        return { success: true, data: await deps.getManager().refreshUsageNow() }
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(
    LOCAL_ADMIN_STATS_CHANNEL.clearSamples,
    async (): Promise<IpcResult<LocalAdminStatsSnapshot>> => {
      try {
        return { success: true, data: await deps.getManager().clearSamples() }
      } catch (error) {
        return toError(error)
      }
    }
  )
}
