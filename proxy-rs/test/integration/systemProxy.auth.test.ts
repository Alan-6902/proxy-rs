import { describe, expect, it } from 'vitest'
import { getElectronProxySettings, redactProxyUrl } from '../../src/main/proxy/systemProxy'

describe('authenticated Electron proxy settings', () => {
  it('separates Chromium proxy rules from HTTP proxy credentials', () => {
    expect(getElectronProxySettings('http://kiro:happy%20password@34.20.173.159:8010')).toEqual({
      proxyRules: 'http://34.20.173.159:8010',
      credentials: {
        host: '34.20.173.159',
        port: 8010,
        username: 'kiro',
        password: 'happy password'
      }
    })
  })

  it('uses protocol defaults and omits credentials when none were configured', () => {
    expect(getElectronProxySettings('socks5://127.0.0.1')).toEqual({
      proxyRules: 'socks5://127.0.0.1',
      credentials: undefined
    })
  })

  it('redacts proxy passwords before logging', () => {
    expect(redactProxyUrl('http://kiro:secret@34.20.173.159:8010')).toBe(
      'http://kiro:***@34.20.173.159:8010'
    )
    expect(redactProxyUrl('not a proxy URL')).toBe('[invalid proxy URL]')
  })
})
