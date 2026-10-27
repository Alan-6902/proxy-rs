import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { SERENA_CHANNEL } from '../../src/shared/serena'
import { SerenaManagement } from '../../src/main/serena/management'
import { isSerenaSender, registerSerenaIpcHandlers } from '../../src/main/serena/ipc-handlers'

const electron = vi.hoisted(() => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() }
}))
vi.mock('electron', () => electron)

function sender(url = 'http://localhost:5173/'): {
  event: IpcMainInvokeEvent
  window: BrowserWindow
} {
  const frame = { url }
  const webContents = { mainFrame: frame }
  return {
    event: { sender: webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent,
    window: { webContents, isDestroyed: () => false } as unknown as BrowserWindow
  }
}
function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  return electron.ipcMain.handle.mock.calls.find(([name]) => name === channel)![1]
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/'
})

describe('Serena IPC boundary', () => {
  it('accepts the main trusted renderer only', () => {
    const { event, window } = sender()
    expect(isSerenaSender(event, window)).toBe(true)
    expect(isSerenaSender(event, null)).toBe(false)
    expect(
      isSerenaSender(
        { ...event, senderFrame: { url: 'http://localhost:5173/' } } as IpcMainInvokeEvent,
        window
      )
    ).toBe(false)
    expect(isSerenaSender(sender('https://untrusted.invalid/').event, window)).toBe(false)
    const navigated = sender('http://localhost:5173/other-document')
    expect(isSerenaSender(navigated.event, navigated.window)).toBe(false)
  })
  it('rejects malformed arguments without executing any management command', async () => {
    const { event, window } = sender()
    registerSerenaIpcHandlers(() => window)
    expect(await handler(SERENA_CHANNEL.previewLanguages)(event, 'x', 'typescript')).toEqual({
      success: false,
      error: 'invalidRequest'
    })
    expect(await handler(SERENA_CHANNEL.execute)(event, '../../file')).toEqual({
      success: false,
      error: 'invalidRequest'
    })
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
  })
  it('does not allow a renderer to bypass native confirmation', async () => {
    const { event, window } = sender()
    const execute = vi.spyOn(SerenaManagement.prototype, 'execute')
    vi.spyOn(SerenaManagement.prototype, 'confirmation').mockReturnValue({
      id: 'confirmed-id',
      action: 'stopNative',
      root: '/projects/example',
      pid: 12,
      expiresAt: Date.now() + 60_000
    })
    electron.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    registerSerenaIpcHandlers(() => window)
    expect(await handler(SERENA_CHANNEL.execute)(event, 'confirmed-id')).toEqual({
      success: false,
      error: 'cancelled'
    })
    expect(execute).not.toHaveBeenCalled()
    expect(electron.dialog.showMessageBox.mock.calls[0][1]).toMatchObject({
      defaultId: 0,
      cancelId: 0
    })
  })
  it('requires native confirmation before removing a service', async () => {
    const { event, window } = sender()
    const preview = {
      id: 'remove-id',
      action: 'unregisterNative' as const,
      root: '/projects/example',
      pid: null,
      expiresAt: Date.now() + 60_000
    }
    vi.spyOn(SerenaManagement.prototype, 'previewNative').mockResolvedValue(preview)
    vi.spyOn(SerenaManagement.prototype, 'confirmation').mockReturnValue(preview)
    const execute = vi.spyOn(SerenaManagement.prototype, 'execute').mockResolvedValue({
      action: 'unregisterNative',
      outcome: 'completed'
    })
    electron.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    registerSerenaIpcHandlers(() => window)
    expect(
      await handler(SERENA_CHANNEL.previewNative)(event, 'native:123', 'unregisterNative')
    ).toEqual({
      success: true,
      data: preview
    })
    expect(await handler(SERENA_CHANNEL.execute)(event, preview.id)).toEqual({
      success: false,
      error: 'cancelled'
    })
    expect(execute).not.toHaveBeenCalled()
    electron.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    expect(await handler(SERENA_CHANNEL.execute)(event, preview.id)).toMatchObject({
      success: true
    })
    expect(execute).toHaveBeenCalledWith(preview.id)
  })
  it('starts a native service without asking for confirmation', async () => {
    const { event, window } = sender()
    const execute = vi.spyOn(SerenaManagement.prototype, 'execute').mockResolvedValue({
      action: 'startNative',
      outcome: 'completed'
    })
    vi.spyOn(SerenaManagement.prototype, 'confirmation').mockReturnValue({
      id: 'confirmed-id',
      action: 'startNative',
      root: '/projects/example',
      pid: null,
      expiresAt: Date.now() + 60_000
    })
    registerSerenaIpcHandlers(() => window)
    expect(await handler(SERENA_CHANNEL.execute)(event, 'confirmed-id')).toEqual({
      success: true,
      data: { action: 'startNative', outcome: 'completed' }
    })
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledWith('confirmed-id')
  })
})
