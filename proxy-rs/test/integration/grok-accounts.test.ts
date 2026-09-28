import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  decryptGrokSecret,
  deriveGrokOsCryptKey,
  encryptGrokSecret,
  grokAccountScope,
  parseGrokAccountsField,
  readActiveGrokAccountScope,
  readGrokAccounts,
  removeGrokAccount,
  setActiveGrokAccount,
  upsertGrokAccount
} from '../../src/main/grokAccounts/grokLocalState'

// 单元测试只验证纯逻辑：加解密往返、scope、账号库解析、写盘再读回。不碰钥匙串、不碰真实
// Grok 文件。做法是把 sand-secrets 写到临时目录（所有入口都支持传 path），并注入一个固定的
// OSCrypt 密钥（所有入口都支持传 key）。
const SECRETS_DIR = mkdtempSync(join(tmpdir(), 'proxy-rs-grok-'))
const SECRETS_PATH = join(SECRETS_DIR, 'sand-secrets.json')

/** 造一个结构合法的 JWT（sub 决定 scope）。 */
function fakeJwt(sub: string): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub, exp: 9999999999 })}.sig`
}

const KEY = deriveGrokOsCryptKey('unit-test-key')

/** 用注入的 KEY 铺一个初始 sand-secrets.json，模拟客户端已登录一个号。 */
function seedSecrets(
  accounts: Record<string, Record<string, string>>,
  active: string | null
): void {
  const secrets = {
    'cursor-machine-id': 'machine-xyz',
    'cursor-accounts': JSON.stringify({ active, accounts }),
    'local-exec-file-key': 'exec-key'
  }
  writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2))
}

function encAccount(
  accessToken: string,
  refreshToken: string,
  profile: object
): Record<string, string> {
  return {
    'cursor-access-token': encryptGrokSecret(accessToken, KEY),
    'cursor-refresh-token': encryptGrokSecret(refreshToken, KEY),
    'cursor-account-profile': encryptGrokSecret(JSON.stringify(profile), KEY)
  }
}

beforeEach(() => {
  rmSync(SECRETS_PATH, { force: true })
})

afterAll(() => {
  rmSync(SECRETS_DIR, { recursive: true, force: true })
})

describe('Grok OSCrypt 加解密', () => {
  it('合成串加密→解密往返一致', () => {
    const plain = 'hello-' + 'x'.repeat(500)
    expect(decryptGrokSecret(encryptGrokSecret(plain, KEY), KEY)).toBe(plain)
  })

  it('加密结果是 base64 的 v10 信封', () => {
    const b64 = encryptGrokSecret('abc', KEY)
    const raw = Buffer.from(b64, 'base64')
    expect(raw.subarray(0, 3).toString('ascii')).toBe('v10')
  })

  it('相同输入确定性输出（同 IV/Key 逐字节一致，才能复现客户端格式）', () => {
    expect(encryptGrokSecret('same-input', KEY)).toBe(encryptGrokSecret('same-input', KEY))
  })

  it('信封头不是 v10 时拒绝解密', () => {
    const notV10 = Buffer.concat([Buffer.from('v11'), Buffer.from('garbage')]).toString('base64')
    expect(() => decryptGrokSecret(notV10, KEY)).toThrow()
  })
})

describe('Grok scope 计算', () => {
  it('JWT 用 sha256(sub) 作 scope', () => {
    const token = fakeJwt('user_abc')
    expect(grokAccountScope(token)).toBe(createHash('sha256').update('user_abc').digest('hex'))
  })

  it('非 JWT 退化为整段 token 的 sha256', () => {
    expect(grokAccountScope('not-a-jwt')).toBe(
      createHash('sha256').update('not-a-jwt').digest('hex')
    )
  })
})

describe('Grok 账号库解析', () => {
  it('cursor-accounts 是 JSON 字符串时正常解出 active 与 accounts', () => {
    const parsed = parseGrokAccountsField(
      JSON.stringify({ active: 's1', accounts: { s1: { 'cursor-access-token': 'x' } } })
    )
    expect(parsed.active).toBe('s1')
    expect(parsed.accounts.s1['cursor-access-token']).toBe('x')
  })

  it('兼容直接存对象的老结构', () => {
    const parsed = parseGrokAccountsField({ active: null, accounts: {} })
    expect(parsed.active).toBeNull()
    expect(parsed.accounts).toEqual({})
  })

  it('非法输入回落为空库', () => {
    expect(parseGrokAccountsField('not-json').accounts).toEqual({})
    expect(parseGrokAccountsField(undefined).active).toBeNull()
  })
})

describe('Grok 读账号', () => {
  it('解密现有账号并解析出邮箱/名字', async () => {
    const token = fakeJwt('user_read')
    const scope = grokAccountScope(token)
    seedSecrets(
      { [scope]: encAccount(token, 'refresh-1', { email: 'a@outlook.com', name: 'Alice' }) },
      scope
    )
    const accounts = await readGrokAccounts(SECRETS_PATH, KEY)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({
      scope,
      email: 'a@outlook.com',
      name: 'Alice',
      accessToken: token,
      refreshToken: 'refresh-1'
    })
    expect(readActiveGrokAccountScope(SECRETS_PATH)).toBe(scope)
  })

  it('文件不存在时读到空数组', async () => {
    expect(await readGrokAccounts(SECRETS_PATH, KEY)).toEqual([])
    expect(readActiveGrokAccountScope(SECRETS_PATH)).toBeUndefined()
  })
})

describe('Grok upsert 写盘再读回', () => {
  it('新增一个账号后能再读回，且不动其它顶层键', async () => {
    const existingToken = fakeJwt('user_existing')
    const existingScope = grokAccountScope(existingToken)
    seedSecrets(
      { [existingScope]: encAccount(existingToken, 'r0', { email: 'old@x.com' }) },
      existingScope
    )

    const newToken = fakeJwt('user_new')
    const result = await upsertGrokAccount(
      { accessToken: newToken, refreshToken: 'r-new', email: 'new@outlook.com', name: 'Neo' },
      KEY,
      SECRETS_PATH
    )
    expect(result.scope).toBe(grokAccountScope(newToken))

    const accounts = await readGrokAccounts(SECRETS_PATH, KEY)
    const scopes = accounts.map((a) => a.scope).sort()
    expect(scopes).toEqual([existingScope, grokAccountScope(newToken)].sort())
    // 新号能被完整解回
    const neo = accounts.find((a) => a.scope === grokAccountScope(newToken))
    expect(neo).toMatchObject({ email: 'new@outlook.com', name: 'Neo', refreshToken: 'r-new' })

    // 顶层非账号键必须原样保留
    const disk = JSON.parse(readFileSync(SECRETS_PATH, 'utf-8'))
    expect(disk['cursor-machine-id']).toBe('machine-xyz')
    expect(disk['local-exec-file-key']).toBe('exec-key')

    // upsert 不改 active
    expect(readActiveGrokAccountScope(SECRETS_PATH)).toBe(existingScope)
  })

  it('同 scope 再次 upsert 覆盖 token 而不新增条目', async () => {
    seedSecrets({}, null)
    const token = fakeJwt('user_same')
    await upsertGrokAccount(
      { accessToken: token, refreshToken: 'r1', email: 'v1@x.com' },
      KEY,
      SECRETS_PATH
    )
    await upsertGrokAccount(
      { accessToken: token, refreshToken: 'r2', email: 'v2@x.com' },
      KEY,
      SECRETS_PATH
    )
    const accounts = await readGrokAccounts(SECRETS_PATH, KEY)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({ refreshToken: 'r2', email: 'v2@x.com' })
  })
})

describe('Grok setActive / remove', () => {
  it('active 只能指向已存在的 scope，否则报错', async () => {
    const token = fakeJwt('user_a')
    const scope = grokAccountScope(token)
    seedSecrets({ [scope]: encAccount(token, 'r', {}) }, null)
    await setActiveGrokAccount(scope, SECRETS_PATH)
    expect(readActiveGrokAccountScope(SECRETS_PATH)).toBe(scope)
    await expect(setActiveGrokAccount('nonexistent-scope', SECRETS_PATH)).rejects.toThrow()
  })

  it('删除当前 active 账号会把 active 置空', async () => {
    const token = fakeJwt('user_del')
    const scope = grokAccountScope(token)
    seedSecrets({ [scope]: encAccount(token, 'r', {}) }, scope)
    await removeGrokAccount(scope, SECRETS_PATH)
    expect(await readGrokAccounts(SECRETS_PATH, KEY)).toEqual([])
    expect(readActiveGrokAccountScope(SECRETS_PATH)).toBeUndefined()
  })
})
