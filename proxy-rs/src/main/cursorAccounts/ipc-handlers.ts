import { ipcMain, shell, type BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import {
  CURSOR_ACCOUNTS_CHANNEL,
  type CursorAccount,
  type CursorAutoRefreshSettings,
  type CursorInjectOptions,
  type CursorInjectResult,
  type CursorOAuthStartResult,
  type CursorRefreshAllSummary
} from '../../shared/cursorAccounts'
import type { IdcIpcResult } from '../../shared/idcSeats'
import {
  addCursorAccountWithToken,
  exportCursorAccounts,
  finishCursorOAuthLogin,
  importCursorAccountFromLocal,
  importCursorAccountsFromJson,
  injectCursorAccount,
  refreshAllCursorAccounts,
  refreshCursorAccount,
  resolveCurrentCursorAccountId
} from './accountManager'
import {
  cursorAccountsStorePath,
  loadCursorAccounts,
  loadCursorAutoRefreshSettings,
  removeCursorAccounts,
  updateCursorAccountTags,
  updateCursorAutoRefreshSettings
} from './accountStore'
import { cancelCursorOAuthLogin, startCursorOAuthLogin } from './cursorOAuth'
import type { CursorAutoRefreshScheduler } from './refreshScheduler'

export interface CursorAccountsIpcDeps {
  getMainWindow: () => BrowserWindow | null
  getScheduler: () => CursorAutoRefreshScheduler
}

/** 账号库有变化时通知渲染层重拉；不携带账号内容。 */
export function sendCursorAccountsChanged(getMainWindow: () => BrowserWindow | null): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(CURSOR_ACCOUNTS_CHANNEL.changed)
  }
}

function toError(error: unknown): IdcIpcResult<never> {
  return { success: false, error: error instanceof Error ? error.message : String(error) }
}

function notifyChanged(deps: CursorAccountsIpcDeps): void {
  sendCursorAccountsChanged(deps.getMainWindow)
}

/** 包一层：成功即通知变更；失败原样回错误信息。 */
function mutating<T>(
  deps: CursorAccountsIpcDeps,
  run: () => Promise<T>
): () => Promise<IdcIpcResult<T>> {
  return async () => {
    try {
      const data = await run()
      notifyChanged(deps)
      return { success: true, data }
    } catch (error) {
      return toError(error)
    }
  }
}

export function registerCursorAccountsIpcHandlers(deps: CursorAccountsIpcDeps): void {
  ipcMain.handle(CURSOR_ACCOUNTS_CHANNEL.list, async (): Promise<IdcIpcResult<CursorAccount[]>> => {
    try {
      return { success: true, data: await loadCursorAccounts() }
    } catch (error) {
      return toError(error)
    }
  })

  ipcMain.handle(
    CURSOR_ACCOUNTS_CHANNEL.currentId,
    async (): Promise<IdcIpcResult<string | null>> => {
      try {
        return { success: true, data: await resolveCurrentCursorAccountId() }
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(CURSOR_ACCOUNTS_CHANNEL.remove, (_event, ids: string[]) =>
    mutating(deps, () => removeCursorAccounts(Array.isArray(ids) ? ids : []))()
  )

  ipcMain.handle(CURSOR_ACCOUNTS_CHANNEL.importJson, (_event, json: string) =>
    mutating(deps, () => importCursorAccountsFromJson(String(json ?? '')))()
  )

  ipcMain.handle(CURSOR_ACCOUNTS_CHANNEL.importLocal, () =>
    mutating(deps, () => importCursorAccountFromLocal())()
  )

  ipcMain.handle(CURSOR_ACCOUNTS_CHANNEL.addToken, (_event, accessToken: string) =>
    mutating(deps, () => addCursorAccountWithToken(String(accessToken ?? '')))()
  )

  ipcMain.handle(
    CURSOR_ACCOUNTS_CHANNEL.export,
    async (_event, ids: string[]): Promise<IdcIpcResult<string>> => {
      try {
        return { success: true, data: await exportCursorAccounts(Array.isArray(ids) ? ids : []) }
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(CURSOR_ACCOUNTS_CHANNEL.refresh, (_event, id: string) =>
    mutating(deps, () => refreshCursorAccount(String(id)))()
  )

  ipcMain.handle(
    CURSOR_ACCOUNTS_CHANNEL.refreshAll,
    (): Promise<IdcIpcResult<CursorRefreshAllSummary>> =>
      mutating(deps, () => refreshAllCursorAccounts())()
  )

  ipcMain.handle(CURSOR_ACCOUNTS_CHANNEL.updateTags, (_event, id: string, tags: string[]) =>
    mutating(deps, () => updateCursorAccountTags(String(id), Array.isArray(tags) ? tags : []))()
  )

  ipcMain.handle(
    CURSOR_ACCOUNTS_CHANNEL.inject,
    (
      _event,
      id: string,
      options?: CursorInjectOptions
    ): Promise<IdcIpcResult<CursorInjectResult>> =>
      mutating(deps, () => injectCursorAccount(String(id), options ?? {}))()
  )

  ipcMain.handle(CURSOR_ACCOUNTS_CHANNEL.oauthStart, (): IdcIpcResult<CursorOAuthStartResult> => {
    try {
      return { success: true, data: startCursorOAuthLogin() }
    } catch (error) {
      return toError(error)
    }
  })

  ipcMain.handle(CURSOR_ACCOUNTS_CHANNEL.oauthComplete, (_event, loginId: string) =>
    mutating(deps, () => finishCursorOAuthLogin(String(loginId)))()
  )

  ipcMain.handle(
    CURSOR_ACCOUNTS_CHANNEL.oauthCancel,
    (_event, loginId?: string): IdcIpcResult<null> => {
      cancelCursorOAuthLogin(typeof loginId === 'string' ? loginId : undefined)
      return { success: true, data: null }
    }
  )

  ipcMain.handle(
    CURSOR_ACCOUNTS_CHANNEL.settingsGet,
    async (): Promise<IdcIpcResult<CursorAutoRefreshSettings>> => {
      try {
        return { success: true, data: await loadCursorAutoRefreshSettings() }
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(
    CURSOR_ACCOUNTS_CHANNEL.settingsUpdate,
    async (
      _event,
      patch: Partial<CursorAutoRefreshSettings>
    ): Promise<IdcIpcResult<CursorAutoRefreshSettings>> => {
      try {
        const before = await loadCursorAutoRefreshSettings()
        const settings = await updateCursorAutoRefreshSettings(
          patch && typeof patch === 'object' ? patch : {}
        )
        await deps.getScheduler().applySettings(settings, settings.enabled && !before.enabled)
        return { success: true, data: settings }
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(CURSOR_ACCOUNTS_CHANNEL.storePath, async (): Promise<IdcIpcResult<string>> => {
    try {
      const path = cursorAccountsStorePath()
      await fs.access(path)
      shell.showItemInFolder(path)
      return { success: true, data: path }
    } catch {
      return { success: false, error: '账号库文件还不存在，添加第一个账号后才会生成' }
    }
  })
}
