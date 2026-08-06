/**
 * 自动车同步配置与登录 Key 持久化
 *
 * 登录 Key 等同于账单授权（拉取会真实扣费），所以与 idc/credentialStore.ts 取同一
 * 立场：safeStorage 不可用时拒绝保存，不提供「退化成明文」的兜底。非敏感配置
 * （地址、间隔、上限）也一并写进这个加密文件，省得再维护第二份存储。
 *
 * 手填的 ksk_ Key 与拉取回来的凭证都不落盘（用户明确要求「不落盘」）。
 */

import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_CONVOY_SYNC_CONFIG,
  MIN_POLL_INTERVAL_SECONDS,
  type ConvoySyncConfig
} from '../../shared/convoyCredentials'

const STORE_FILE = 'convoy-sync.enc'

/** 落盘结构：配置 + 登录 Key */
interface PersistedConvoyConfig {
  config: ConvoySyncConfig
  convoyKey: string
}

function storePath(): string {
  return join(app.getPath('userData'), STORE_FILE)
}

export function isConvoyStoreAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function positiveInt(value: unknown, fallback: number, min = 0): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.floor(num))
}

/** 归一化外部传入的配置，避免非法值把轮询打成死循环或绕过门禁 */
export function normalizeConvoyConfig(input: Partial<ConvoySyncConfig> | null | undefined): ConvoySyncConfig {
  const source = input || {}
  return {
    enabled: source.enabled === true,
    baseUrl:
      typeof source.baseUrl === 'string' && source.baseUrl.trim()
        ? source.baseUrl.trim()
        : DEFAULT_CONVOY_SYNC_CONFIG.baseUrl,
    pollIntervalSeconds: Math.max(
      MIN_POLL_INTERVAL_SECONDS,
      positiveInt(source.pollIntervalSeconds, DEFAULT_CONVOY_SYNC_CONFIG.pollIntervalSeconds)
    ),
    requestTimeoutSeconds: Math.max(
      1,
      positiveInt(source.requestTimeoutSeconds, DEFAULT_CONVOY_SYNC_CONFIG.requestTimeoutSeconds)
    ),
    allowInsecureHttp: source.allowInsecureHttp === true,
    allowInitialCharge: source.allowInitialCharge === true,
    maxNewCredentialsPerPull: positiveInt(
      source.maxNewCredentialsPerPull,
      DEFAULT_CONVOY_SYNC_CONFIG.maxNewCredentialsPerPull
    ),
    maxChargePerPullCents: positiveInt(
      source.maxChargePerPullCents,
      DEFAULT_CONVOY_SYNC_CONFIG.maxChargePerPullCents
    ),
    dailyChargeLimitCents: positiveInt(
      source.dailyChargeLimitCents,
      DEFAULT_CONVOY_SYNC_CONFIG.dailyChargeLimitCents
    ),
    minBalanceAlertCents: positiveInt(
      source.minBalanceAlertCents,
      DEFAULT_CONVOY_SYNC_CONFIG.minBalanceAlertCents
    )
  }
}

/** 读取配置与登录 Key；文件不存在或解密失败时回落到默认配置 + 空 Key */
export async function loadConvoyState(): Promise<PersistedConvoyConfig> {
  const fallback: PersistedConvoyConfig = { config: { ...DEFAULT_CONVOY_SYNC_CONFIG }, convoyKey: '' }
  if (!isConvoyStoreAvailable()) return fallback
  try {
    const buffer = await fs.readFile(storePath())
    const parsed = JSON.parse(safeStorage.decryptString(buffer)) as Partial<PersistedConvoyConfig>
    return {
      config: normalizeConvoyConfig(parsed.config),
      convoyKey: typeof parsed.convoyKey === 'string' ? parsed.convoyKey : ''
    }
  } catch {
    return fallback
  }
}

/**
 * 写入配置与登录 Key。加密不可用时抛错，调用方需向用户说明。
 * convoyKey 传 undefined 表示保留原值，传空串表示清除。
 */
export async function saveConvoyState(input: {
  config: Partial<ConvoySyncConfig>
  convoyKey?: string
}): Promise<PersistedConvoyConfig> {
  if (!isConvoyStoreAvailable()) {
    throw new Error(
      '当前系统未提供加密存储（macOS Keychain / Windows DPAPI / Linux libsecret 不可用），拒绝明文保存自动车登录 Key'
    )
  }
  const current = await loadConvoyState()
  const next: PersistedConvoyConfig = {
    config: normalizeConvoyConfig({ ...current.config, ...input.config }),
    convoyKey: input.convoyKey === undefined ? current.convoyKey : input.convoyKey.trim()
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(next))
  await fs.writeFile(storePath(), encrypted, { mode: 0o600 })
  return next
}

/** 清除配置与登录 Key */
export async function clearConvoyState(): Promise<void> {
  try {
    await fs.unlink(storePath())
  } catch {
    /* 不存在即视为已清除 */
  }
}
