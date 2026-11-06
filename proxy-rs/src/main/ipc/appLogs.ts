import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipcChannels'
import { proxyLogStore } from '../proxy/logger'

/** App 运行日志（系统日志页、kiro-rs 日志页）。category 为空时取全部 */
export function registerAppLogIpcHandlers(): void {
  ipcMain.handle(IPC.appLogsGet, (_event, count?: number, category?: string) => {
    const limit = typeof count === 'number' && count > 0 ? count : undefined
    if (category) return proxyLogStore.getLastOfCategory(category, limit)
    return limit ? proxyLogStore.getLast(limit) : proxyLogStore.getAll()
  })
  ipcMain.handle(IPC.appLogsCount, (_event, category?: string) =>
    category ? proxyLogStore.countOfCategory(category) : proxyLogStore.count()
  )
  ipcMain.handle(IPC.appLogsClear, (_event, category?: string) => {
    if (category) proxyLogStore.clearCategory(category)
    else proxyLogStore.clear()
    return { success: true }
  })
}
