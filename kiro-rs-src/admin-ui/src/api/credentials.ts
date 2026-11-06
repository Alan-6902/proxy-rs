import axios from 'axios'
import { storage } from '@/lib/storage'
import type {
  CredentialsStatusResponse,
  BalanceResponse,
  SuccessResponse,
  SetDisabledRequest,
  SetPriorityRequest,
  AddCredentialRequest,
  AddCredentialResponse,
  StoreInfoResponse,
  ModelCatalogResponse,
  AgAccount,
  AgAccountsResponse,
  AgModelCatalogResponse,
  AgModelScanResponse,
  AgOAuthStart,
  AgOAuthStatus,
  QoderAccount,
  QoderAccountsResponse,
  QoderModelCatalogResponse,
  QoderModelOverride,
} from '@/types/api'

// 创建 axios 实例
const api = axios.create({
  baseURL: '/api/admin',
  headers: {
    'Content-Type': 'application/json',
  },
})

// 请求拦截器添加 API Key
api.interceptors.request.use((config) => {
  const apiKey = storage.getApiKey()
  if (apiKey) {
    config.headers['x-api-key'] = apiKey
  }
  return config
})

/**
 * 获取凭据状态。
 *
 * 共享账号库模式下后端默认只返回号池中的账号（Admin 列表保持"反代号池"语义）；
 * all=true 时连未入池的账号一起返回，用于在界面上把它们加入号池。
 */
export async function getCredentials(all = false): Promise<CredentialsStatusResponse> {
  const { data } = await api.get<CredentialsStatusResponse>('/credentials', {
    params: all ? { all: true } : undefined,
  })
  return data
}

// 共享账号库信息
export async function getStoreInfo(): Promise<StoreInfoResponse> {
  const { data } = await api.get<StoreInfoResponse>('/store/info')
  return data
}

// 加入 / 移出反代号池（仅共享账号库模式）
export async function setCredentialInPool(
  id: number,
  inPool: boolean
): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>(`/credentials/${id}/pool`, { inPool })
  return data
}

// 设置凭据禁用状态
export async function setCredentialDisabled(
  id: number,
  disabled: boolean
): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>(
    `/credentials/${id}/disabled`,
    { disabled } as SetDisabledRequest
  )
  return data
}

// 设置凭据优先级
export async function setCredentialPriority(
  id: number,
  priority: number
): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>(
    `/credentials/${id}/priority`,
    { priority } as SetPriorityRequest
  )
  return data
}

// 重置失败计数
export async function resetCredentialFailure(
  id: number
): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>(`/credentials/${id}/reset`)
  return data
}

// 强制刷新 Token
export async function forceRefreshToken(
  id: number
): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>(`/credentials/${id}/refresh`)
  return data
}

// 获取凭据余额
export async function getCredentialBalance(id: number): Promise<BalanceResponse> {
  const { data } = await api.get<BalanceResponse>(`/credentials/${id}/balance`)
  return data
}

// 添加新凭据
export async function addCredential(
  req: AddCredentialRequest
): Promise<AddCredentialResponse> {
  const { data } = await api.post<AddCredentialResponse>('/credentials', req)
  return data
}

// 删除凭据
/**
 * 删除凭据。共享账号库模式下默认只是移出号池（账号仍由 proxy-rs 管理）；
 * purge=true 才从账号库彻底删除。传统模式忽略该参数。
 */
export async function deleteCredential(
  id: number,
  purge = false
): Promise<SuccessResponse> {
  const { data } = await api.delete<SuccessResponse>(`/credentials/${id}`, {
    params: purge ? { purge: true } : undefined,
  })
  return data
}

// 当前模型目录（即 /v1/models 的输出）
export async function getModelCatalog(): Promise<ModelCatalogResponse> {
  const { data } = await api.get<ModelCatalogResponse>('/models')
  return data
}

// 用选定账号从 Kiro 拉取模型目录（多账号取并集）
export async function refreshModelCatalog(credentialIds: number[]): Promise<ModelCatalogResponse> {
  const { data } = await api.post<ModelCatalogResponse>('/models/refresh', { credentialIds })
  return data
}

// 设置 /v1/models 只输出哪些模型系列
export async function setEnabledModels(families: string[]): Promise<ModelCatalogResponse> {
  const { data } = await api.put<ModelCatalogResponse>('/models/enabled', { families })
  return data
}

// 获取负载均衡模式
export async function getLoadBalancingMode(): Promise<{ mode: 'priority' | 'balanced' }> {
  const { data } = await api.get<{ mode: 'priority' | 'balanced' }>('/config/load-balancing')
  return data
}

// 设置负载均衡模式
export async function setLoadBalancingMode(mode: 'priority' | 'balanced'): Promise<{ mode: 'priority' | 'balanced' }> {
  const { data } = await api.put<{ mode: 'priority' | 'balanced' }>('/config/load-balancing', { mode })
  return data
}

// === Antigravity 账号池 ===

export async function getAgAccounts(): Promise<AgAccountsResponse> {
  const { data } = await api.get<AgAccountsResponse>('/antigravity/accounts')
  return data
}


export async function getAgModelCatalog(): Promise<AgModelCatalogResponse> {
  const { data } = await api.get<AgModelCatalogResponse>('/antigravity/models')
  return data
}

// 逐个刷新启用账号的模型列表；只在用户手动点「扫描账号」时调用
export async function scanAgModels(): Promise<AgModelScanResponse> {
  const { data } = await api.post<AgModelScanResponse>('/antigravity/models/scan')
  return data
}

export async function setAgEnabledModels(enabledModelIds: string[]): Promise<AgModelCatalogResponse> {
  const { data } = await api.put<AgModelCatalogResponse>('/antigravity/models', { enabledModelIds })
  return data
}

// 开始 Google 登录：后端在本机回环地址监听回调，返回需要在浏览器打开的授权地址
export async function startAgOAuth(): Promise<AgOAuthStart> {
  const { data } = await api.post<AgOAuthStart>('/antigravity/oauth/start')
  return data
}

export async function getAgOAuthStatus(sessionId: string): Promise<AgOAuthStatus> {
  const { data } = await api.get<AgOAuthStatus>(`/antigravity/oauth/${sessionId}`)
  return data
}

// 刷新 token、projectId 与额度
export async function refreshAgAccount(id: number): Promise<AgAccount> {
  const { data } = await api.post<AgAccount>(`/antigravity/accounts/${id}/refresh`)
  return data
}

export async function setAgAccountDisabled(id: number, disabled: boolean): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>(`/antigravity/accounts/${id}/disabled`, { disabled })
  return data
}

export async function resetAgAccountFailures(id: number): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>(`/antigravity/accounts/${id}/reset`)
  return data
}

export async function deleteAgAccount(id: number): Promise<SuccessResponse> {
  const { data } = await api.delete<SuccessResponse>(`/antigravity/accounts/${id}`)
  return data
}

// === Qoder 账号池 ===

export async function getQoderAccounts(): Promise<QoderAccountsResponse> {
  const { data } = await api.get<QoderAccountsResponse>('/qoder/accounts')
  return data
}

/** 粘贴 PAT 添加账号；后端换证并拉取身份与额度 */
export async function addQoderAccount(pat: string): Promise<QoderAccount> {
  const { data } = await api.post<QoderAccount>('/qoder/accounts', { pat })
  return data
}

export async function refreshQoderAccount(id: number): Promise<QoderAccount> {
  const { data } = await api.post<QoderAccount>(`/qoder/accounts/${id}/refresh`)
  return data
}

export async function setQoderAccountDisabled(id: number, disabled: boolean): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>(`/qoder/accounts/${id}/disabled`, { disabled })
  return data
}

export async function deleteQoderAccount(id: number): Promise<SuccessResponse> {
  const { data } = await api.delete<SuccessResponse>(`/qoder/accounts/${id}`)
  return data
}

export async function getQoderModelCatalog(): Promise<QoderModelCatalogResponse> {
  const { data } = await api.get<QoderModelCatalogResponse>('/qoder/models')
  return data
}

export async function setQoderModelOverrides(
  overrides: Record<string, QoderModelOverride>,
): Promise<QoderModelCatalogResponse> {
  const { data } = await api.put<QoderModelCatalogResponse>('/qoder/models/overrides', { overrides })
  return data
}

export async function setQoderEnabledModels(enabledModelIds: string[]): Promise<QoderModelCatalogResponse> {
  const { data } = await api.put<QoderModelCatalogResponse>('/qoder/models', { enabledModelIds })
  return data
}
