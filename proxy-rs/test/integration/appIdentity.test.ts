import { describe, expect, it } from 'vitest'
import { APP_SOCIAL_AUTH_REDIRECT_URI, isAppCallbackUrl } from '../../src/shared/appIdentity'

describe('social auth redirect uri', () => {
  it('uses the Kiro IDE callback that the Kiro Cognito client whitelists', () => {
    // 其它 scheme 会被 Cognito 以 redirect_mismatch 拒绝，页面只显示
    // "An error was encountered with the requested page."
    expect(APP_SOCIAL_AUTH_REDIRECT_URI).toBe('kiro://kiro.kiroAgent/authenticate-success')
  })
})

describe('isAppCallbackUrl', () => {
  it('recognizes the social auth callback carrying code and state', () => {
    expect(isAppCallbackUrl(`${APP_SOCIAL_AUTH_REDIRECT_URI}?code=abc&state=xyz`)).toBe(true)
    expect(isAppCallbackUrl(APP_SOCIAL_AUTH_REDIRECT_URI)).toBe(true)
  })

  it('recognizes the app own protocol', () => {
    expect(isAppCallbackUrl('proxy-rs://auth/callback?code=abc&state=xyz')).toBe(true)
  })

  it('ignores ordinary pages and other kiro:// links', () => {
    expect(isAppCallbackUrl('https://github.com/login')).toBe(false)
    expect(isAppCallbackUrl('kiro://kiro.kiroAgent/other')).toBe(false)
    expect(isAppCallbackUrl(`${APP_SOCIAL_AUTH_REDIRECT_URI}-evil?code=abc`)).toBe(false)
  })
})
