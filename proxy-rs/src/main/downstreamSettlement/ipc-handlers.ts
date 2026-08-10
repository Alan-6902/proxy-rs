import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { DownstreamReport } from '../../shared/downstreamSettlement'
import type { DownstreamSettlementManager } from './settlementManager'

export const DOWNSTREAM_SETTLEMENT_CHANNEL = {
  report: 'downstream-settlement-report',
  exportDay: 'downstream-settlement-export-day',
  settleNow: 'downstream-settlement-settle-now',
  pickCsvDir: 'downstream-settlement-pick-csv-dir',
  openCsvDir: 'downstream-settlement-open-csv-dir'
} as const

interface IpcResult<T> {
  success: boolean
  data?: T
  error?: string
}

export interface DownstreamSettlementIpcDeps {
  getManager: () => DownstreamSettlementManager
  getMainWindow: () => BrowserWindow | null
  /** 把用户选的目录写进抢号配置（csvExportDir）。 */
  saveCsvDir: (dir: string) => Promise<void>
}

function toError(error: unknown): IpcResult<never> {
  return { success: false, error: error instanceof Error ? error.message : String(error) }
}

export function registerDownstreamSettlementIpcHandlers(deps: DownstreamSettlementIpcDeps): void {
  ipcMain.handle(
    DOWNSTREAM_SETTLEMENT_CHANNEL.report,
    async (_event, date?: string, days?: number): Promise<IpcResult<DownstreamReport>> => {
      try {
        return { success: true, data: await deps.getManager().report({ date, days }) }
      } catch (error) {
        return toError(error)
      }
    }
  )

  // 导出不推进结算锚点，所以可以随便点：当天导出十次结果一致
  ipcMain.handle(
    DOWNSTREAM_SETTLEMENT_CHANNEL.exportDay,
    async (_event, date: string): Promise<IpcResult<string>> => {
      try {
        return { success: true, data: await deps.getManager().exportDay(date) }
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(
    DOWNSTREAM_SETTLEMENT_CHANNEL.settleNow,
    async (): Promise<IpcResult<DownstreamReport>> => {
      try {
        const manager = deps.getManager()
        await manager.settleNow()
        return { success: true, data: await manager.report() }
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(
    DOWNSTREAM_SETTLEMENT_CHANNEL.pickCsvDir,
    async (): Promise<IpcResult<string | null>> => {
      try {
        const win = deps.getMainWindow()
        if (!win || win.isDestroyed()) throw new Error('窗口不可用')
        const result = await dialog.showOpenDialog(win, {
          title: '选择对账 CSV 的存放目录',
          message: 'CSV 里含完整 KSK 明文；选择云同步目录会把它们上传到云端',
          properties: ['openDirectory', 'createDirectory']
        })
        if (result.canceled || result.filePaths.length === 0) return { success: true, data: null }
        const dir = result.filePaths[0]
        // 目录必须可写，否则等到午夜自动结算才报错，那时用户已经不在看了
        await fs.access(dir)
        if (!isAbsolute(dir)) throw new Error('请选择一个绝对路径目录')
        await deps.saveCsvDir(dir)
        return { success: true, data: dir }
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(DOWNSTREAM_SETTLEMENT_CHANNEL.openCsvDir, async (): Promise<IpcResult<string>> => {
    try {
      const dir = await deps.getManager().resolveCsvDir()
      // 还没结算过时目录不存在，openPath 会静默失败；先建出来再打开，
      // 让用户看到「目录在这里，只是还空着」
      await fs.mkdir(dir, { recursive: true })
      const failure = await shell.openPath(dir)
      if (failure) throw new Error(failure)
      return { success: true, data: dir }
    } catch (error) {
      return toError(error)
    }
  })
}
