import { app, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IpcResult } from '../../shared/ipcResult'
import { SERENA_CHANNEL } from '../../shared/serena'
import { SerenaError, SerenaInspector } from './runtimeInspector'
import { SerenaManagement } from './management'
import { installNativeCli, installResumeAgent, NATIVE_CLI_NAME } from './nativeServices'

export function isSerenaSender(event: IpcMainInvokeEvent, window: BrowserWindow | null): boolean {
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== event.sender.mainFrame
  )
    return false
  const url = event.senderFrame?.url
  if (!url) return false
  try {
    const expected =
      !app.isPackaged && process.env.ELECTRON_RENDERER_URL
        ? process.env.ELECTRON_RENDERER_URL
        : pathToFileURL(join(__dirname, '../renderer/index.html')).href
    const actual = new URL(url)
    const trusted = new URL(expected)
    return (
      actual.protocol === trusted.protocol &&
      actual.host === trusted.host &&
      actual.pathname === trusted.pathname
    )
  } catch {
    return false
  }
}

export function registerSerenaIpcHandlers(getWindow: () => BrowserWindow | null): void {
  const inspector = new SerenaInspector()
  const management = new SerenaManagement(inspector)
  if (app.isPackaged)
    void installNativeCli(inspector.home, join(process.resourcesPath, NATIVE_CLI_NAME))
      .then(() =>
        // 打包中间产物（dist/）也可能被拉起，不能把临时路径写进登录任务。
        app.isInApplicationsFolder() ? installResumeAgent(inspector.home, process.execPath) : false
      )
      .catch((error) => console.warn('[Serena] Failed to install bundled CLI:', error))
  const handle = <T>(channel: string, handler: (...args: unknown[]) => Promise<T>): void => {
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<IpcResult<T>> => {
      if (!isSerenaSender(event, getWindow())) return { success: false, error: 'invalidRequest' }
      try {
        return { success: true, data: await handler(...args) }
      } catch (error) {
        return {
          success: false,
          error: error instanceof SerenaError ? error.code : 'sourceUnavailable'
        }
      }
    })
  }
  const id = (value: unknown): string => {
    if (typeof value !== 'string' || value.length > 128 || !/^[a-zA-Z0-9:-]+$/.test(value))
      throw new SerenaError('invalidRequest')
    return value
  }
  handle(SERENA_CHANNEL.snapshot, async () => (await management.snapshot()).snapshot)
  handle(SERENA_CHANNEL.setExempt, async (instanceId, exempt) => {
    if (typeof exempt !== 'boolean') throw new SerenaError('invalidRequest')
    await management.setExempt(id(instanceId), exempt)
  })
  handle(SERENA_CHANNEL.previewNative, async (instanceId, action) => {
    if (
      action !== 'startNative' &&
      action !== 'stopNative' &&
      action !== 'restartNative' &&
      action !== 'unregisterNative'
    )
      throw new SerenaError('invalidRequest')
    return management.previewNative(id(instanceId), action)
  })
  handle(SERENA_CHANNEL.previewLanguages, async (previewId, languages) => {
    if (!Array.isArray(languages) || languages.some((value) => typeof value !== 'string'))
      throw new SerenaError('invalidRequest')
    return management.previewLanguages(id(previewId), languages)
  })
  handle(SERENA_CHANNEL.chooseProject, async () => {
    const window = getWindow()
    if (!window) throw new SerenaError('invalidRequest')
    const result = await dialog.showOpenDialog(window, {
      title: 'Serena · 选择项目 / Select project',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length !== 1) return null
    return management.previewProject(result.filePaths[0])
  })
  handle(SERENA_CHANNEL.execute, async (previewId) => {
    const actionId = id(previewId)
    const preview = management.confirmation(actionId)
    if (preview.action !== 'startNative') {
      const window = getWindow()
      if (!window) throw new SerenaError('invalidRequest')
      const result = await dialog.showMessageBox(window, {
        type: 'warning',
        title: 'Serena · 确认操作 / Confirm action',
        message:
          preview.action === 'registerProject'
            ? '登记原生 Serena 项目？ / Register native Serena project?'
            : `确认原生服务操作 / Native service: ${preview.action}`,
        detail: `${preview.root}\n${
          preview.action === 'registerProject'
            ? `${preview.fileCount} files · ${preview.languages?.join(', ')}\n仅本机可信 HTTP；将生成项目连接并启动服务，之后登录时自动恢复。 / Trusted loopback HTTP; the service starts now and resumes at login.`
            : preview.action === 'unregisterNative'
              ? '删除本机服务登记及对应的宿主连接，服务配置移入废纸篓；保留项目源码。 / Remove the registration and matching host connections, move service configuration to Trash, and keep project source files.'
              : `PID ${preview.pid} · 客户端数量未知 / Client count unknown\n共享会话可能中断，需要宿主重连。 / Reconnect shared sessions afterwards.`
        }`,
        buttons: ['取消 / Cancel', '确认 / Confirm'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      if (result.response !== 1) throw new SerenaError('cancelled')
    }
    return management.execute(actionId)
  })
}
