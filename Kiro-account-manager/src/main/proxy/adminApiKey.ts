import type { ProxyConfig } from './types'

export const ADMIN_API_KEY_PREFIX = 'kam_admin_'
export const ADMIN_KEY_UPDATE_ERROR = 'Unable to update admin API key'

/** 所有 renderer 通用配置入口都必须剥离高权限字段。 */
export function stripAdminApiKey<TConfig extends { adminApiKey?: unknown }>(config: TConfig): Omit<TConfig, 'adminApiKey'> {
  const { adminApiKey: _adminApiKey, ...publicConfig } = config
  return publicConfig
}

export interface AdminKeyPersistence<TConfig> {
  write(config: TConfig): void
}

export interface AdminKeyRuntime {
  update(adminApiKey: string | undefined): void
}

/** 管理员凭证必须独立于所有普通凭证（包括已禁用项）。 */
export function assertDistinctAdminApiKey(config: Pick<ProxyConfig, 'adminApiKey' | 'apiKey' | 'apiKeys'>): void {
  const adminApiKey = config.adminApiKey
  if (!adminApiKey) return
  if (adminApiKey === config.apiKey || config.apiKeys?.some(apiKey => apiKey.key === adminApiKey)) {
    throw new Error('Invalid admin API key configuration')
  }
}

/** 纯切换事务：持久化成功后才生效；运行时失败则尽力回滚两端。 */
export function switchAdminApiKey<TConfig extends { adminApiKey?: string }>(
  previousConfig: TConfig,
  adminApiKey: string | undefined,
  persistence: AdminKeyPersistence<TConfig>,
  runtime: AdminKeyRuntime
): { success: boolean; error?: string } {
  const nextConfig = { ...previousConfig, adminApiKey }
  try {
    persistence.write(nextConfig)
  } catch {
    return { success: false, error: ADMIN_KEY_UPDATE_ERROR }
  }

  try {
    runtime.update(adminApiKey)
    return { success: true }
  } catch {
    try { persistence.write(previousConfig) } catch { /* 只能返回泛化错误 */ }
    try { runtime.update(previousConfig.adminApiKey) } catch { /* 只能返回泛化错误 */ }
    return { success: false, error: ADMIN_KEY_UPDATE_ERROR }
  }
}
