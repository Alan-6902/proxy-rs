import { describe, expect, it } from 'vitest'
import { serializeAccountCredentialsForClipboard } from '../../src/renderer/src/lib/accountCredentialsClipboard'

describe('复制账号凭证', () => {
  it('Kiro API Key 账号复制实际 key，而不是空对象', () => {
    expect(
      serializeAccountCredentialsForClipboard({
        credentialKind: 'kiro_api_key',
        kiroApiKey: 'ksk_Abc123'
      })
    ).toBe('{\n  "kiroApiKey": "ksk_Abc123"\n}')
  })

  it('兼容尚未写入 credentialKind 的 Kiro API Key 账号', () => {
    expect(serializeAccountCredentialsForClipboard({ kiroApiKey: 'ksk_Legacy123' })).toBe(
      '{\n  "kiroApiKey": "ksk_Legacy123"\n}'
    )
  })

  it('OAuth 账号保持原有复制格式', () => {
    expect(
      serializeAccountCredentialsForClipboard({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        clientId: 'client-id',
        clientSecret: 'client-secret'
      })
    ).toBe(
      '{\n  "accessToken": "access-token",\n  "refreshToken": "refresh-token",\n  "clientId": "client-id",\n  "clientSecret": "client-secret"\n}'
    )
  })
})
