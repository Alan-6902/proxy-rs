// IdC 凭据持久化
//
// AK/SK 是长期凭据，泄露等于把整个 AWS 账号交出去，所以这里不提供
// 「safeStorage 不可用就写明文」的兜底（与 secureBackup.ts 的取舍不同：
// 那边优先保证备份不丢，这边优先保证不泄露）。加密不可用时拒绝保存，
// 让用户每次手填或改用 ~/.aws profile。

import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { IdcCredentialConfig } from './types'

const STORE_FILE = 'idc-credentials.enc'

/** 不落盘的字段：profile 模式下凭据本来就在 ~/.aws，不用复制一份 */
type PersistedConfig = IdcCredentialConfig

function storePath(): string {
  return join(app.getPath('userData'), STORE_FILE)
}

export function isCredentialStoreAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * 保存凭据配置。加密不可用时抛错，调用方需向用户说明。
 * source=profile 时不会写入任何密钥材料，只记 profile 名与 region。
 */
export async function saveCredentialConfig(config: IdcCredentialConfig): Promise<void> {
  if (!isCredentialStoreAvailable()) {
    throw new Error(
      '当前系统未提供加密存储（macOS Keychain / Windows DPAPI / Linux libsecret 不可用），拒绝明文保存 AWS 凭据'
    )
  }

  const toPersist: PersistedConfig =
    config.source === 'profile'
      ? { source: 'profile', region: config.region, profile: config.profile }
      : config

  const encrypted = safeStorage.encryptString(JSON.stringify(toPersist))
  await fs.writeFile(storePath(), encrypted, { mode: 0o600 })
}

/** 读取凭据配置，不存在或解密失败返回 null */
export async function loadCredentialConfig(): Promise<IdcCredentialConfig | null> {
  if (!isCredentialStoreAvailable()) return null
  try {
    const buf = await fs.readFile(storePath())
    return JSON.parse(safeStorage.decryptString(buf)) as IdcCredentialConfig
  } catch {
    return null
  }
}

/** 清除已保存的凭据 */
export async function clearCredentialConfig(): Promise<void> {
  try {
    await fs.unlink(storePath())
  } catch {
    /* 不存在即视为已清除 */
  }
}
