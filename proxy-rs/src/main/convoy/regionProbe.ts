/**
 * 上游 Kiro API Key 的区域探测
 *
 * 场景：用户填 key 时不指定区域（「国家」），由这里按候选顺序试，
 * 哪个区域先验活成功（上游返回 200）就用哪个。
 *
 * 探测动作复用 verify 回调（主进程注入的 getUsageAndLimits），
 * 因为它本身就是「用这把 key 打一次上游 REST 接口」——额外造一个探测请求
 * 只会多一次上游调用，还得自己维护端点映射。
 */

import {
  maskSecretTail,
  resolveRegionProbeOrder,
  type ManualConvoyKeyResult
} from '../../shared/convoyCredentials'
import { isValidKiroApiKey, isValidKiroRegion, maskKiroApiKey } from '../../shared/kiroApiKey'

/** 单区域验活结果 */
export interface RegionVerifyOutcome {
  ok: boolean
  email?: string
  error?: string
}

/** 用某个区域验活一把 key；由主进程注入真实实现 */
export type RegionVerifier = (input: {
  apiKey: string
  region: string
}) => Promise<RegionVerifyOutcome>

export interface ProbeResult {
  ok: boolean
  /** 命中的区域；ok=false 时为 undefined */
  region?: string
  /** 实际尝试过的区域，按顺序 */
  probedRegions: string[]
  email?: string
  /** 最后一次失败原因 */
  error?: string
}

/**
 * 探测一把 key 的可用区域。
 *
 * 显式指定区域时只试该区域（用户明确要求，不该悄悄换到别的区域）；
 * 未指定时按候选顺序逐个试，命中即停。
 */
export async function probeKeyRegion(
  apiKey: string,
  explicitRegion: string | undefined,
  verify: RegionVerifier
): Promise<ProbeResult> {
  const key = apiKey.trim()
  if (!isValidKiroApiKey(key)) {
    return { ok: false, probedRegions: [], error: 'Kiro API Key 格式非法（应形如 ksk_xxx）' }
  }
  const normalizedExplicit = explicitRegion?.trim().toLowerCase()
  if (normalizedExplicit && !isValidKiroRegion(normalizedExplicit)) {
    return { ok: false, probedRegions: [], error: `区域格式非法：${normalizedExplicit}` }
  }

  const candidates = resolveRegionProbeOrder(normalizedExplicit)
  const probedRegions: string[] = []
  let lastError: string | undefined

  for (const region of candidates) {
    probedRegions.push(region)
    try {
      const outcome = await verify({ apiKey: key, region })
      if (outcome.ok) {
        return { ok: true, region, probedRegions, email: outcome.email }
      }
      lastError = outcome.error || '验活失败'
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }

  return {
    ok: false,
    probedRegions,
    error: candidates.length > 1
      ? `所有候选区域均验活失败（${probedRegions.join(', ')}）：${lastError || '未知原因'}`
      : lastError || '验活失败'
  }
}

/** 把探测结果转成 UI 结果条目，key 只以脱敏形式出现 */
export function toManualKeyResult(
  id: string,
  apiKey: string,
  probe: ProbeResult
): ManualConvoyKeyResult {
  return {
    id,
    maskedKey: isValidKiroApiKey(apiKey.trim())
      ? maskKiroApiKey(apiKey.trim())
      : maskSecretTail(apiKey.trim()),
    ok: probe.ok,
    resolvedRegion: probe.region,
    probedRegions: probe.probedRegions,
    email: probe.email,
    error: probe.error
  }
}
