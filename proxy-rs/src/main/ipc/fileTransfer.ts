import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { IPC } from '../../shared/ipcChannels'

const IMPORT_FILE_FILTERS = [
  { name: '所有支持的格式', extensions: ['json', 'csv', 'txt'] },
  { name: 'JSON Files', extensions: ['json'] },
  { name: 'CSV Files', extensions: ['csv'] },
  { name: 'TXT Files', extensions: ['txt'] }
]
const DEFAULT_IMPORT_FORMAT = 'json'

/** 账号数据的导出 / 导入文件对话框 */
export function registerFileTransferIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.exportToFile, async (_event, data: string, filename: string) => {
    try {
      const result = await dialog.showSaveDialog(getMainWindow()!, {
        title: '导出账号数据',
        defaultPath: filename,
        filters: [{ name: 'JSON Files', extensions: ['json'] }]
      })

      if (!result.canceled && result.filePath) {
        await writeFile(result.filePath, data, 'utf-8')
        return true
      }
      return false
    } catch (error) {
      console.error('Failed to export:', error)
      return false
    }
  })

  ipcMain.handle(IPC.importFromFile, async () => {
    try {
      const result = await dialog.showOpenDialog(getMainWindow()!, {
        title: '导入账号数据',
        filters: IMPORT_FILE_FILTERS,
        properties: ['openFile']
      })

      if (!result.canceled && result.filePaths.length > 0) {
        const filePath = result.filePaths[0]
        const content = await readFile(filePath, 'utf-8')
        const ext = filePath.split('.').pop()?.toLowerCase() || DEFAULT_IMPORT_FORMAT
        return { content, format: ext }
      }
      return null
    } catch (error) {
      console.error('Failed to import:', error)
      return null
    }
  })
}
