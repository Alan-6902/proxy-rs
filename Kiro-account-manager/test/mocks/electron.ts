// Minimal Electron surface for Node-only proxy integration tests.
export const app = {
  getPath: () => '/tmp/kiro-account-manager-vitest',
  isPackaged: false
}

export const ipcMain = { handle: () => undefined, on: () => undefined }

export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] { return [] }
  webContents = { send: () => undefined }
}
