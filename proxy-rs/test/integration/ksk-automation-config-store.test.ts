import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  decryptString: vi.fn(),
  encryptString: vi.fn((value: string) => Buffer.from(value))
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/proxy-rs-config-test' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    decryptString: mocks.decryptString,
    encryptString: mocks.encryptString
  }
}))

vi.mock('node:fs', () => ({
  promises: { readFile: mocks.readFile, writeFile: mocks.writeFile }
}))

import {
  createKskAutomationTask,
  loadKskAutomationStore
} from '../../src/main/kskAutomation/configStore'

describe('KSK 自动任务加密存储故障边界', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('文件不存在时按首次使用返回空任务列表', async () => {
    mocks.readFile.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    await expect(loadKskAutomationStore()).resolves.toMatchObject({ tasks: [] })
  })

  it('解密或 JSON 损坏时拒绝按空配置覆盖原文件', async () => {
    mocks.readFile.mockResolvedValue(Buffer.from('corrupt'))
    mocks.decryptString.mockImplementation(() => {
      throw new Error('decrypt failed')
    })

    await expect(loadKskAutomationStore()).rejects.toThrow('拒绝用空配置覆盖')
    await expect(
      createKskAutomationTask('task-new', {
        name: '新任务',
        config: { providerEnabled: false }
      })
    ).rejects.toThrow('拒绝用空配置覆盖')
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })
})
