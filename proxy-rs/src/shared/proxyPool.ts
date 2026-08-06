/**
 * 代理池共享定义（主进程 + 渲染进程共用）
 *
 * 用途：注册批量任务时为每个账号轮换不同的出口 IP，降低风控关联风险。
 * 与 API 反代和客户端代理不同，这里是出口代理池。
 *
 * 之所以放在 shared/：定时验活已搬到主进程常驻，主进程需要和渲染进程共用
 * 同一套「验活结果如何影响条目状态」的判定规则，避免两边各写一份逐渐走偏。
 */

export type ProxyProtocol = 'http' | 'https' | 'socks5' | 'socks4'

export type ProxyStatus =
  | 'untested' // 未测试
  | 'testing' // 测试中
  | 'alive' // 可用
  | 'dead' // 不可用
  | 'slow' // 可用但延迟较高

/** 代理池条目 */
export interface ProxyEntry {
  id: string
  url: string // 规范化后的完整 URL，如 http://user:pass@host:port
  protocol: ProxyProtocol
  host: string
  port: number
  username?: string
  password?: string

  // 元数据
  label?: string // 用户标注的备注名
  source?: string // 来源标记：manual（单条手动添加）/ import（批量粘贴导入）
  tags?: string[]

  // 验活信息
  status: ProxyStatus
  latencyMs?: number // 最近一次测试的延迟（毫秒）
  lastTestedAt?: number // 时间戳
  lastError?: string // 测试失败原因

  // 统计
  usedCount: number // 累计使用次数
  failCount: number // 累计失败次数
  lastUsedAt?: number
  lastBoundEmail?: string // 最近一次绑定的邮箱（用于关联追溯）

  // 配置
  enabled: boolean // 是否启用（停用的代理不参与轮询）

  createdAt: number
}

/** 代理验活结果 */
export interface ProxyValidationResult {
  success: boolean
  latencyMs?: number
  externalIp?: string // 通过代理出口看到的 IP
  error?: string
}

/** 代理池调度策略 */
export type ProxyPoolStrategy =
  | 'round_robin' // 轮询
  | 'random' // 随机
  | 'least_used' // 最少使用优先
  | 'fastest' // 延迟最低优先

/** 预设 IP 检测端点 */
export interface IpDetectEndpoint {
  id: string
  label: string
  url: string
  /** 响应格式：json 从字段提取 IP，text 用正则匹配 */
  format: 'json' | 'text'
  /** JSON 响应中 IP 所在的字段路径（如 'ip' / 'query' / 'origin'）*/
  ipField?: string
}

export const IP_DETECT_ENDPOINTS: IpDetectEndpoint[] = [
  {
    id: 'ipify',
    label: 'ipify',
    url: 'https://api.ipify.org?format=json',
    format: 'json',
    ipField: 'ip'
  },
  {
    id: 'ip-api',
    label: 'IP-API',
    url: 'http://ip-api.com/json',
    format: 'json',
    ipField: 'query'
  },
  { id: 'ipinfo', label: 'IPinfo', url: 'https://ipinfo.io/json', format: 'json', ipField: 'ip' },
  {
    id: 'ip2location',
    label: 'IP2Location',
    url: 'https://api.ip2location.io',
    format: 'json',
    ipField: 'ip'
  },
  {
    id: 'httpbin',
    label: 'httpbin',
    url: 'https://httpbin.org/ip',
    format: 'json',
    ipField: 'origin'
  },
  { id: 'ifconfig', label: 'ifconfig.me', url: 'https://ifconfig.me/ip', format: 'text' },
  { id: 'icanhazip', label: 'icanhazip', url: 'https://icanhazip.com', format: 'text' },
  { id: 'ipapi-co', label: 'ipapi.co', url: 'https://ipapi.co/json', format: 'json', ipField: 'ip' }
]

/** 代理池配置 */
export interface ProxyPoolConfig {
  enabled: boolean // 是否启用代理池（注册时自动取用）
  strategy: ProxyPoolStrategy
  validateOnStartup: boolean // 启动时自动验活
  autoDisableDead: boolean // 失败代理自动停用
  failureThreshold: number // 累计失败 N 次后停用
  testUrl: string // 验活测试 URL（默认 https://api.ipify.org）
  testTimeoutMs: number // 单次验活超时
  /** 定时自动验活：分钟为单位，0 表示关闭 */
  autoValidateIntervalMin: number
  /** 定时验活的并发数 */
  autoValidateConcurrency: number
  /** 上游中转代理（可选）：配合"目标代理要求非大陆来源 IP"的场景串联代理链；支持 http/socks5 */
  upstreamProxy?: string
}

export const DEFAULT_PROXY_POOL_CONFIG: ProxyPoolConfig = {
  enabled: false,
  strategy: 'round_robin',
  validateOnStartup: false,
  autoDisableDead: true,
  failureThreshold: 3,
  testUrl: 'https://api.ipify.org?format=json',
  testTimeoutMs: 8000,
  autoValidateIntervalMin: 0,
  autoValidateConcurrency: 5,
  upstreamProxy: ''
}

/** 延迟超过该值仍算可用，但标记为 slow */
export const SLOW_LATENCY_THRESHOLD_MS = 3000

/**
 * 把一次验活结果应用到条目上，返回新条目（不修改入参）。
 *
 * 渲染进程手动验活与主进程定时验活共用此函数，保证两条路径对
 * status / failCount / 自动停用的判定完全一致。
 *
 * @param pool 当前池内全部条目，用于「池中可用代理 <= 1 时不自动停用」的保护判定
 */
export function applyValidationResult(
  entry: ProxyEntry,
  result: ProxyValidationResult,
  config: ProxyPoolConfig,
  pool: ProxyEntry[]
): ProxyEntry {
  const latencyMs = result.latencyMs
  const status: ProxyStatus = result.success
    ? latencyMs !== undefined && latencyMs > SLOW_LATENCY_THRESHOLD_MS
      ? 'slow'
      : 'alive'
    : 'dead'
  // 验活失败也累计到 failCount，但不计入 reportProxyResult 的注册失败
  const failCount = result.success ? entry.failCount : entry.failCount + 1
  // 轮换代理保护：池中可用代理 <= 1 时保留，避免自动停用后退化为直连暴露真实 IP
  const aliveCount = pool.filter((p) => p.enabled && p.status !== 'dead').length
  const enabled = result.success
    ? entry.enabled
    : config.autoDisableDead && failCount >= config.failureThreshold && aliveCount > 1
      ? false
      : entry.enabled

  return {
    ...entry,
    status,
    latencyMs: result.latencyMs,
    lastTestedAt: Date.now(),
    lastError: result.success ? undefined : result.error,
    failCount,
    enabled
  }
}
