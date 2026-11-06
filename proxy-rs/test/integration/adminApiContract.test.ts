import { describe, expect, it } from 'vitest'
import {
  KiroRsAdminError,
  adoptCredential,
  fetchStoreInfo,
  importAccount,
  setExternalRefreshAccount,
  type KiroRsAdminTarget
} from '../../src/main/accountDb/adminApi'

const target: KiroRsAdminTarget = {
  baseUrl: 'http://127.0.0.1:1/api/admin',
  adminApiKey: 'test',
  timeoutMs: 1000
}

function respond(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    })) as unknown as typeof fetch
}

describe('kiro-rs Admin 响应契约校验', () => {
  it('符合 admin/types.rs 形状的响应原样返回（serde 的 None 为 null）', async () => {
    const info = await fetchStoreInfo(
      target,
      respond(200, {
        enabled: true,
        databaseId: 'db',
        path: null,
        externalRefreshCredentialId: null
      })
    )
    expect(info).toEqual({
      enabled: true,
      databaseId: 'db',
      path: null,
      externalRefreshCredentialId: null
    })

    const adopted = await adoptCredential(
      target,
      { authMethod: 'social', accessToken: 'a', refreshToken: 'r' },
      respond(200, { outcome: 'adopted', credentialId: 3, credentialVersion: 7 })
    )
    expect(adopted.outcome).toBe('adopted')
  })

  it('字段缺失或类型不对时抛 KiroRsAdminError，并指出请求与字段', async () => {
    await expect(
      importAccount(target, {}, respond(200, { credentialId: '9', created: true }))
    ).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringMatching(
        /响应格式不符（POST \/accounts\/import）.*credentialId.*replaced/
      )
    })

    const error = await adoptCredential(
      target,
      { authMethod: 'idc', accessToken: 'a', refreshToken: 'r' },
      respond(200, { outcome: 'exploded' })
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(KiroRsAdminError)
    expect((error as KiroRsAdminError).status).toBeUndefined()
  })

  it('HTTP 错误仍按原逻辑透出状态码与上游 message，不进入 schema 校验', async () => {
    const error = await setExternalRefreshAccount(
      target,
      null,
      respond(404, { error: { message: '账号不在库中' } })
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(KiroRsAdminError)
    expect((error as KiroRsAdminError).status).toBe(404)
    expect((error as KiroRsAdminError).message).toBe('账号不在库中')
  })
})
