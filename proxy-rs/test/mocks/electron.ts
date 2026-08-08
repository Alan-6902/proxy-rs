// Minimal Electron surface for Node-only proxy integration tests.
export const app = {
  getPath: () => '/tmp/proxy-rs-vitest',
  isPackaged: false
}

export const ipcMain = { handle: () => undefined, on: () => undefined }

export const shell = { showItemInFolder: () => undefined, openPath: async () => '' }

export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return []
  }
  webContents = { send: () => undefined }
}
