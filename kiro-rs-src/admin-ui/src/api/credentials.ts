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
