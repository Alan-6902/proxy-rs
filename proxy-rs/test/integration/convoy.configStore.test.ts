// 配置归一化：非法值不得把轮询打成死循环，也不得绕过计费门禁

import { describe, expect, it } from 'vitest'
import { normalizeConvoyConfig } from '../../src/main/convoy/configStore'
import {
  DEFAULT_CONVOY_SYNC_CONFIG,
  MIN_POLL_INTERVAL_SECONDS
} from '../../src/shared/convoyCredentials'

describe('配置归一化', () => {
  it('空输入回落到默认配置', () => {
    expect(normalizeConvoyConfig(null)).toEqual(DEFAULT_CONVOY_SYNC_CONFIG)
    expect(normalizeConvoyConfig(undefined)).toEqual(DEFAULT_CONVOY_SYNC_CONFIG)
    expect(normalizeConvoyConfig({})).toEqual(DEFAULT_CONVOY_SYNC_CONFIG)
  })

  it('轮询间隔不得低于接口冷却时间', () => {
    expect(normalizeConvoyConfig({ pollIntervalSeconds: 0 }).pollIntervalSeconds).toBe(
      MIN_POLL_INTERVAL_SECONDS
    )
    expect(normalizeConvoyConfig({ pollIntervalSeconds: -10 }).pollIntervalSeconds).toBe(
      MIN_POLL_INTERVAL_SECONDS
    )
    expect(normalizeConvoyConfig({ pollIntervalSeconds: 1 }).pollIntervalSeconds).toBe(
      MIN_POLL_INTERVAL_SECONDS
    )
    expect(normalizeConvoyConfig({ pollIntervalSeconds: 120 }).pollIntervalSeconds).toBe(120)
  })

  it('超时至少 1 秒', () => {
    expect(normalizeConvoyConfig({ requestTimeoutSeconds: 0 }).requestTimeoutSeconds).toBe(1)
    expect(normalizeConvoyConfig({ requestTimeoutSeconds: 30 }).requestTimeoutSeconds).toBe(30)
  })

  it('三个安全开关默认关闭，只有严格 true 才打开', () => {
    const normalized = normalizeConvoyConfig({})
    expect(normalized.enabled).toBe(false)
    expect(normalized.allowInsecureHttp).toBe(false)
    expect(normalized.allowInitialCharge).toBe(false)

    // 从 JSON 读回来的脏值（字符串 'true'、1）不得被当成开启
    const dirty = normalizeConvoyConfig({
      enabled: 'true',
      allowInsecureHttp: 1,
      allowInitialCharge: 'yes'
    } as never)
    expect(dirty.enabled).toBe(false)
    expect(dirty.allowInsecureHttp).toBe(false)
    expect(dirty.allowInitialCharge).toBe(false)

    const explicit = normalizeConvoyConfig({
      enabled: true,
      allowInsecureHttp: true,
      allowInitialCharge: true
    })
    expect(explicit.enabled).toBe(true)
    expect(explicit.allowInsecureHttp).toBe(true)
    expect(explicit.allowInitialCharge).toBe(true)
  })

  it('空白 baseUrl 回落到默认地址', () => {
    expect(normalizeConvoyConfig({ baseUrl: '   ' }).baseUrl).toBe(
      DEFAULT_CONVOY_SYNC_CONFIG.baseUrl
    )
    expect(normalizeConvoyConfig({ baseUrl: '  http://h/api/user  ' }).baseUrl).toBe(
      'http://h/api/user'
    )
  })

  it('负数上限被抬到 0，而不是绕过门禁', () => {
    const normalized = normalizeConvoyConfig({
      maxNewCredentialsPerPull: -3,
      maxChargePerPullCents: -100,
      dailyChargeLimitCents: -1,
      minBalanceAlertCents: -1
    })
    expect(normalized.maxNewCredentialsPerPull).toBe(0)
    expect(normalized.maxChargePerPullCents).toBe(0)
    expect(normalized.dailyChargeLimitCents).toBe(0)
    expect(normalized.minBalanceAlertCents).toBe(0)
  })

  it('非数值上限回落到默认值', () => {
    const normalized = normalizeConvoyConfig({ maxChargePerPullCents: Number.NaN })
    expect(normalized.maxChargePerPullCents).toBe(DEFAULT_CONVOY_SYNC_CONFIG.maxChargePerPullCents)
  })

  it('小数上限向下取整，避免分级金额出现分以下的位', () => {
    expect(normalizeConvoyConfig({ maxChargePerPullCents: 1999.7 }).maxChargePerPullCents).toBe(
      1999
    )
  })
})
