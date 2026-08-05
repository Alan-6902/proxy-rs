/**
 * 代理池数据模型（再导出）
 *
 * 定义已移到 src/shared/proxyPool.ts，因为定时验活搬到主进程后两侧需要共用
 * 同一套类型与验活结果判定规则。此文件保留以维持渲染进程既有 import 路径。
 */

export type {
  ProxyProtocol,
  ProxyStatus,
  ProxyEntry,
  ProxyValidationResult,
  ProxyPoolStrategy,
  IpDetectEndpoint,
  ProxyPoolConfig
} from '../../../shared/proxyPool'

export {
  IP_DETECT_ENDPOINTS,
  DEFAULT_PROXY_POOL_CONFIG,
  SLOW_LATENCY_THRESHOLD_MS,
  applyValidationResult
} from '../../../shared/proxyPool'
