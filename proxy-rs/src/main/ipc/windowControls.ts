import { ipcMain, type BrowserWindow } from 'electron'
import { IPC, IPC_EVENT } from '../../shared/ipcChannels'

/** 自定义 titlebar 的窗口控制：最小化 / 最大化切换 / 关闭 / 查询状态与平台 */
export function registerWindowControlIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.on(IPC_EVENT.windowMinimize, () => getMainWindow()?.minimize())
  ipcMain.on(IPC_EVENT.windowMaximizeToggle, () => {
    const win = getMainWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on(IPC_EVENT.windowClose, () => getMainWindow()?.close())
  ipcMain.handle(IPC.windowIsMaximized, () => !!getMainWindow()?.isMaximized())
  ipcMain.handle(IPC.windowGetPlatform, () => process.platform)
}
