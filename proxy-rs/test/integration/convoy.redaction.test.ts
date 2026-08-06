// 安全回归：登录 Key、API Key、accessToken 都不得出现在下发渲染进程的状态或日志里

import { describe, expect, it } from 'vitest'
import { ConvoySyncManager } from '../../src/main/convoy/syncManager'
import type { ConvoyFetch } from '../../src/main/convoy/client'
import {
  DEFAULT_CONVOY_SYNC_CONFIG,
  type ConvoySyncStatus
} from '../../src/shared/convoyCredentials'

const CONVOY_KEY = 'convoy-login-secret-AAAA'
const PULLED_API_KEY = 'ksk_pulledSecretBBBB'
const PULLED_ACCESS_TOKEN = 'oauth-access-secret-CCCC'
const MANUAL_API_KEY = 'ksk_manualSecretDDDD'

const SECRETS = [CONVOY_KEY, PULLED_API_KEY, PULLED_ACCESS_TOKEN, MANUAL_API_KEY]

function upstream(): ConvoyFetch {
  return async (url) => {
    const body = url.endsWith('/credentials')
      ? {
          autoConvoyId: 42,
          credentials: [
            {
              credentialId: '1',
              status: 'active',
              newlyCharged: true,
              charged: 2.0,
              aliveSecs: 600,
              credential: { type: 'api_key', apiKey: PULLED_API_KEY }
            },
            {
              credentialId: '2',
              status: 'active',
              newlyCharged: true,
              charged: 2.0,
              aliveSecs: 600,
              credential: { type: 'oauth', accessToken: PULLED_ACCESS_TOKEN }
            }
          ],
          newlyChargedCount: 2,
          totalCharged: 4.0,
          balanceAfter: 90.0,
          insufficientCount: 0
        }
      : {
          onBoard: true,
          autoConvoyId: 42,
          convoy: { fare: 2.0 },
          credentialSummary: [
            { credentialId: '1', status: 'active' },
            { credentialId: '2', status: 'active' }
          ]
        }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(body)
    }
  }
}

describe('凭证明文不泄露', () => {
  it('状态、日志与告警都不含任何明文', async () => {
    const logLines: string[] = []
    const statuses: ConvoySyncStatus[] = []

    const manager = new ConvoySyncManager({
      readConfig: async () => ({
        ...DEFAULT_CONVOY_SYNC_CONFIG,
        enabled: true,
        baseUrl: 'http://kiro.example.com/api/user',
        allowInsecureHttp: true,
        allowInitialCharge: true
      }),
      readConvoyKey: async () => CONVOY_KEY,
      fetchImpl: upstream(),
      verifyKeyRegion: async () => ({ ok: true, email: 'probe@example.com' }),
      applyToAccountPool: () => {},
      notifyStatus: (status) => statuses.push(status),
      log: (message) => logLines.push(message)
    })

    await manager.runOnce()
    await manager.setManualKeys([{ id: 'a', key: MANUAL_API_KEY }])

    const status = await manager.buildStatus()
    const serializedStatus = JSON.stringify(status)
    const serializedPushed = JSON.stringify(statuses)
    const serializedLogs = logLines.join('\n')

    for (const secret of SECRETS) {
      expect(serializedStatus).not.toContain(secret)
      expect(serializedPushed).not.toContain(secret)
      expect(serializedLogs).not.toContain(secret)
    }

    // 快照确实拉到了，不是因为空数据才「没泄露」
    expect(status.snapshot?.activeCount).toBe(2)
    expect(status.manualKeys[0].ok).toBe(true)
    // 只暴露尾 4 位
    expect(status.snapshot?.credentials.map((c) => c.maskedCredential)).toEqual([
      '***BBBB',
      '***CCCC'
    ])
    expect(status.convoyKeyTail).toBe('***AAAA')
  })

  it('上游错误信息里的明文不会被回显', async () => {
    const logLines: string[] = []
    const manager = new ConvoySyncManager({
      readConfig: async () => ({
        ...DEFAULT_CONVOY_SYNC_CONFIG,
        enabled: true,
        baseUrl: 'http://kiro.example.com/api/user',
        allowInsecureHttp: true,
        allowInitialCharge: true
      }),
      readConvoyKey: async () => CONVOY_KEY,
      // 上游把 Key 回显在错误体里（真实服务出过这种事）
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({ error: { message: `invalid apiKey=${CONVOY_KEY}` } })
      }),
      verifyKeyRegion: async () => ({ ok: true }),
      applyToAccountPool: () => {},
      notifyStatus: () => {},
      log: (message) => logLines.push(message)
    })

    await manager.runOnce()
    const status = await manager.buildStatus()

    expect(status.lastError).toBeTruthy()
    expect(status.lastError).not.toContain(CONVOY_KEY)
    expect(JSON.stringify(status.alerts)).not.toContain(CONVOY_KEY)
    expect(logLines.join('\n')).not.toContain(CONVOY_KEY)
  })
})
