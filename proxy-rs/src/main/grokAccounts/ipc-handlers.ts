import { ipcMain, type BrowserWindow } from 'electron'
import {
  GROK_ACCOUNTS_CHANNEL,
  type GrokAccountView,
  type GrokRelayInstallProgress,
  type GrokRelayInstallResult,
  type GrokRelayStatus,
  type GrokRemoveResult,
  type GrokSwitchResult
} from '../../shared/grokAccounts'
import type { IpcResult } from '../../shared/ipcResult'
import {
  listGrokAccounts,
  removeGrokAccountFromClient,
  resolveCurrentGrokScope,
  switchGrokAccount
} from './grokAccountManager'
import { probeRelay, syncRelayToAccount } from './grokRelay'
import { ensureBoxRelayRoute } from './grokRelayInstaller'

export interface GrokAccountsIpcDeps {
  getMainWindow: () => BrowserWindow | null
}

/** 账号库/relay 有变化时通知渲染层重拉；不携带凭据内容。 */
export function sendGrokAccountsChanged(getMainWindow: () => BrowserWindow | null): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(GROK_ACCOUNTS_CHANNEL.changed)
  }
}

function toError(error: unknown): IpcResult<never> {
  return { success: false, error: error instanceof Error ? error.message : String(error) }
}

/** 装 relay 路由要跑几分钟，阶段进展单独推给渲染层，不等最终结果。 */
function sendRelayInstallProgress(
  getMainWindow: () => BrowserWindow | null,
  progress: GrokRelayInstallProgress
): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(GROK_ACCOUNTS_CHANNEL.relayInstallProgress, progress)
  }
}

export function registerGrokAccountsIpcHandlers(deps: GrokAccountsIpcDeps): void {
  ipcMain.handle(GROK_ACCOUNTS_CHANNEL.list, async (): Promise<IpcResult<GrokAccountView[]>> => {
    try {
      return { success: true, data: await listGrokAccounts() }
    } catch (error) {
      return toError(error)
    }
  })

  ipcMain.handle(GROK_ACCOUNTS_CHANNEL.currentScope, (): IpcResult<string | null> => {
    try {
      return { success: true, data: resolveCurrentGrokScope() }
    } catch (error) {
      return toError(error)
    }
  })

  ipcMain.handle(
    GROK_ACCOUNTS_CHANNEL.switch,
    async (
      _event,
      scope: string,
      options?: { closeGrok?: boolean }
    ): Promise<IpcResult<GrokSwitchResult>> => {
      try {
        const result = await switchGrokAccount(String(scope), options ?? {})
        sendGrokAccountsChanged(deps.getMainWindow)
        return { success: true, data: result }
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(
    GROK_ACCOUNTS_CHANNEL.syncRelay,
    async (_event, scope: string): Promise<IpcResult<GrokRelayStatus>> => {
      try {
        await syncRelayToAccount(String(scope))
        const status = await probeRelay()
        sendGrokAccountsChanged(deps.getMainWindow)
        return { success: true, data: status }
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(
    GROK_ACCOUNTS_CHANNEL.relayStatus,
    async (): Promise<IpcResult<GrokRelayStatus>> => {
      try {
        return { success: true, data: await probeRelay() }
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(
    GROK_ACCOUNTS_CHANNEL.ensureRelayRoute,
    async (_event, scope: string): Promise<IpcResult<GrokRelayInstallResult>> => {
      try {
        const result = await ensureBoxRelayRoute(String(scope), (progress) =>
          sendRelayInstallProgress(deps.getMainWindow, progress)
        )
        sendGrokAccountsChanged(deps.getMainWindow)
        return { success: true, data: result }
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(
    GROK_ACCOUNTS_CHANNEL.remove,
    async (
      _event,
      scope: string,
      options?: { closeGrok?: boolean }
    ): Promise<IpcResult<GrokRemoveResult>> => {
      try {
        const result = await removeGrokAccountFromClient(String(scope), options ?? {})
        sendGrokAccountsChanged(deps.getMainWindow)
        return { success: true, data: result }
      } catch (error) {
        return toError(error)
      }
    }
  )
}
