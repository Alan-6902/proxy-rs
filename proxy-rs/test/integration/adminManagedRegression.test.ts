import { describe, expect, it, vi } from 'vitest'
import {
  reconcileAdminManagedEntries,
  normalizeAdminManagedEntry
} from '../../src/shared/adminManaged'
import { pushAccountToLocalAdmin } from '../../src/main/kskAutomation/localAdminClient'
import { toCredentialStats } from '../../src/main/localAdminStats/statsClient'

const managed = {
  accountId: 'local-account',
  credentialId: '7',
  authMethod: 'social' as const,
  remoteCredentialIdentity: 'identity-original',
  remoteRefreshTokenHash: 'before-rotation',
  pushedAt: 1
}

describe('托管身份不依赖可轮换 token', () => {
  it('正常轮换以及首次推送后的轮换均保持托管', () => {
    const remote = toCredentialStats({
      id: 7,
      credentialIdentity: 'identity-original',
      refreshTokenHash: 'after-rotation'
    })!
    const result = reconcileAdminManagedEntries([managed], [remote], 2)
    expect(result.dropped).toEqual([])
    expect(result.kept).toEqual([{ ...managed, lastSeenRemoteAt: 2 }])
    expect(normalizeAdminManagedEntry(result.kept[0])?.remoteCredentialIdentity).toBe(
      'identity-original'
    )
  })

  it('即使 token 相同，删除重建后复用数字 ID 也解除旧绑定', () => {
    const remote = {
      id: '7',
      credentialIdentity: 'identity-recreated',
      refreshTokenHash: 'before-rotation'
    }
    expect(reconcileAdminManagedEntries([managed], [remote], 2).dropped).toEqual([
      { accountId: managed.accountId, credentialId: '7', reason: 'identity_changed' }
    ])
  })

  it('旧版反代没有身份字段时不能因 OAuth token 变化解除托管', () => {
    const legacy = { ...managed, remoteCredentialIdentity: undefined }
    const result = reconcileAdminManagedEntries(
      [legacy],
      [{ id: '7', refreshTokenHash: 'rotated' }],
      2
    )
    expect(result.dropped).toEqual([])
    expect(result.kept).toHaveLength(1)
  })
})

describe('OAuth 推送使用反代凭据验活', () => {
  it.each([
    { balanceStatus: 200, message: '', verified: true },
    { balanceStatus: 503, message: 'temporarily unavailable', verified: false },
    { balanceStatus: 502, message: '权限不足，无法获取使用额度: 403 Forbidden', verified: false }
  ])(
    '余额状态 $balanceStatus 时不使用本地旧 token 删除凭据',
    async ({ balanceStatus, message, verified }) => {
      const requests: string[] = []
      const probe = vi.fn(async () => ({
        verdict: 'permanently_invalid' as const,
        error: '401 expired local access token'
      }))
      const result = await pushAccountToLocalAdmin({
        candidate: {
          accountId: managed.accountId,
          authMethod: 'social',
          refreshToken: 'valid-refresh-token',
          accessToken: 'expired-access-token'
        },
        baseUrl: 'http://127.0.0.1:8990',
        adminApiKey: 'test-only',
        timeoutSeconds: 3,
        probeLiveness: probe,
        fetchImpl: async (url, init) => {
          requests.push(`${init?.method ?? 'GET'} ${url}`)
          if (url.endsWith('/balance')) {
            return new Response(JSON.stringify({ error: { message } }), { status: balanceStatus })
          }
          const body =
            init?.method === 'POST'
              ? { credentialId: 7, credentialIdentity: 'identity-original' }
              : { credentials: [] }
          return new Response(JSON.stringify(body), { status: 200 })
        }
      })
      expect(probe).not.toHaveBeenCalled()
      expect(result).toMatchObject({
        status: 'created',
        credentialIdentity: 'identity-original',
        verified,
        probeVerdict: 'skipped'
      })
      expect(
        requests.some((request) => request.startsWith('DELETE') || request.endsWith('/disabled'))
      ).toBe(false)
    }
  )
})
