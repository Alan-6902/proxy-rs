import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  KIRO_CLI_AUTH_KEY,
  LEGACY_SOCIAL_V2_MARKER,
  LEGACY_SOCIAL_V2_START_URL,
  buildKiroCliRefreshSyncSql,
  createKiroCliSocialRenewal,
  readKiroCliSocialToken,
  resolveKiroCliDbPath,
  resolveKiroCliSocialProvider,
  sqlQuote,
  switchKiroCliAccount,
  syncRefreshedKiroCliCredentials,
  type KiroCliSocialToken
} from '../../src/main/kiroCli/cliCredentials'

const PROFILE_KEY = 'api.codewhisperer.profile'
const START_URL_KEY = 'auth.idc.start-url'
const SOCIAL_PROFILE = JSON.stringify({ arn: 'arn:aws:codewhisperer:us-east-1:1:profile/SOCIAL' })

let dir: string
let dbPath: string

function sql(statement: string): string {
  return execFileSync('sqlite3', [dbPath], { input: statement, encoding: 'utf-8' }).trim()
}

function authKv(): Record<string, Record<string, unknown>> {
  const rows = sql('SELECT key, value FROM auth_kv ORDER BY key;')
  if (!rows) return {}
  return Object.fromEntries(
    rows.split('\n').map((line) => {
      const [key, ...rest] = line.split('|')
      return [key, JSON.parse(rest.join('|'))]
    })
  )
}

function stateKeys(): string[] {
  return sql('SELECT key FROM state ORDER BY key;').split('\n').filter(Boolean)
}

function putAuth(key: string, value: unknown): void {
  sql(
    `INSERT OR REPLACE INTO auth_kv (key, value) VALUES (${sqlQuote(key)}, ${sqlQuote(JSON.stringify(value))});`
  )
}

function putState(key: string, value: string): void {
  sql(`INSERT OR REPLACE INTO state (key, value) VALUES (${sqlQuote(key)}, ${sqlQuote(value)});`)
}

/** 旧兼容补丁留下的现场：社交凭据 + 企业兼容副本 + 设备注册 + start-url + Profile */
function seedLegacySocialV2(refreshToken: string): void {
  putAuth(KIRO_CLI_AUTH_KEY.SOCIAL_TOKEN, {
    access_token: 'access-old',
    refresh_token: refreshToken,
    expires_at: '2020-01-01T00:00:00.000Z',
    region: 'us-east-1',
    provider: 'Github'
  })
  putAuth(KIRO_CLI_AUTH_KEY.OIDC_TOKEN, {
    access_token: 'access-old',
    refresh_token: refreshToken,
    oauth_flow: 'Pkce',
    start_url: LEGACY_SOCIAL_V2_START_URL,
    managed_by: LEGACY_SOCIAL_V2_MARKER
  })
  putAuth(KIRO_CLI_AUTH_KEY.OIDC_DEVICE_REGISTRATION, { client_id: 'c', client_secret: 's' })
  putState(START_URL_KEY, JSON.stringify(LEGACY_SOCIAL_V2_START_URL))
  putState(PROFILE_KEY, SOCIAL_PROFILE)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kiro-cli-'))
  dbPath = join(dir, 'data.sqlite3')
  sql(
    'CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE state (key TEXT PRIMARY KEY, value BLOB);'
  )
  putState('unrelated.setting', '"keep"')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('Kiro CLI 切号', () => {
  it('社交账号只写小写 provider 的社交凭据，并清掉旧兼容补丁残留', async () => {
    seedLegacySocialV2('refresh-previous')

    await switchKiroCliAccount(
      {
        accessToken: 'access-new',
        refreshToken: 'refresh-new',
        expiresAt: '2030-01-01T00:00:00.000Z',
        region: 'us-east-1',
        profileArn: 'arn:social',
        socialProvider: 'Github'
      },
      dbPath
    )

    expect(authKv()).toEqual({
      [KIRO_CLI_AUTH_KEY.SOCIAL_TOKEN]: {
        access_token: 'access-new',
        refresh_token: 'refresh-new',
        expires_at: '2030-01-01T00:00:00.000Z',
        region: 'us-east-1',
        provider: 'github',
        profile_arn: 'arn:social'
      }
    })
    expect(stateKeys()).toEqual(['unrelated.setting'])
  })

  it('IdC 账号写 OIDC 凭据与设备注册，删掉社交凭据，保留真实企业 start-url', async () => {
    putAuth(KIRO_CLI_AUTH_KEY.SOCIAL_TOKEN, { refresh_token: 'refresh-social', provider: 'github' })
    putState(START_URL_KEY, JSON.stringify('https://real-enterprise.awsapps.com/start'))

    await switchKiroCliAccount(
      {
        accessToken: 'access-idc',
        refreshToken: 'refresh-idc',
        expiresAt: '2030-01-01T00:00:00.000Z',
        region: 'eu-central-1',
        clientId: 'client-id',
        clientSecret: "secret-with-'quote"
      },
      dbPath
    )

    const kv = authKv()
    expect(Object.keys(kv).sort()).toEqual([
      KIRO_CLI_AUTH_KEY.OIDC_DEVICE_REGISTRATION,
      KIRO_CLI_AUTH_KEY.OIDC_TOKEN
    ])
    expect(kv[KIRO_CLI_AUTH_KEY.OIDC_TOKEN]).toMatchObject({
      refresh_token: 'refresh-idc',
      region: 'eu-central-1'
    })
    expect(kv[KIRO_CLI_AUTH_KEY.OIDC_TOKEN]).not.toHaveProperty('provider')
    expect(kv[KIRO_CLI_AUTH_KEY.OIDC_DEVICE_REGISTRATION]).toEqual({
      client_id: 'client-id',
      client_secret: "secret-with-'quote",
      region: 'eu-central-1'
    })
    expect(stateKeys()).toEqual([START_URL_KEY, 'unrelated.setting'])
  })

  it('IdC 账号缺 clientId/clientSecret 时拒绝写入', async () => {
    await expect(
      switchKiroCliAccount(
        { accessToken: 'a', refreshToken: 'r', expiresAt: 'x', region: 'us-east-1' },
        dbPath
      )
    ).rejects.toThrow(/clientId/)
    expect(authKv()).toEqual({})
  })

  it('数据库不存在时报错，不替 kiro-cli 建库', async () => {
    await expect(
      switchKiroCliAccount(
        {
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: 'x',
          region: 'us-east-1',
          socialProvider: 'Google'
        },
        join(dir, 'missing.sqlite3')
      )
    ).rejects.toThrow(/未找到 Kiro CLI 数据库/)
  })

  it('事务中途失败整体回滚', async () => {
    seedLegacySocialV2('refresh-previous')
    sql('DROP TABLE state;')

    await expect(
      switchKiroCliAccount(
        {
          accessToken: 'access-new',
          refreshToken: 'refresh-new',
          expiresAt: 'x',
          region: 'us-east-1',
          socialProvider: 'Github'
        },
        dbPath
      )
    ).rejects.toThrow(/no such table: state/)
    expect(authKv()[KIRO_CLI_AUTH_KEY.SOCIAL_TOKEN]).toMatchObject({
      refresh_token: 'refresh-previous'
    })
  })
})

describe('Kiro CLI 刷新同步', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z')

  it('匹配 CLI 当前社交凭据：更新 token、provider 转小写、清掉企业兼容副本与 Profile 状态', async () => {
    seedLegacySocialV2('refresh-old')

    await syncRefreshedKiroCliCredentials(
      'refresh-old',
      { accessToken: 'access-new', refreshToken: 'refresh-new', expiresIn: 1800 },
      dbPath
    )

    expect(authKv()).toEqual({
      [KIRO_CLI_AUTH_KEY.SOCIAL_TOKEN]: expect.objectContaining({
        access_token: 'access-new',
        refresh_token: 'refresh-new',
        provider: 'github'
      })
    })
    expect(stateKeys()).toEqual(['unrelated.setting'])
  })

  it('刷新的是别的账号时 CLI 原样不动', async () => {
    seedLegacySocialV2('refresh-cli-account')
    const before = { kv: authKv(), state: stateKeys() }

    await syncRefreshedKiroCliCredentials(
      'refresh-other-account',
      { accessToken: 'access-other', refreshToken: 'refresh-other-next' },
      dbPath
    )

    expect(authKv()).toEqual(before.kv)
    expect(stateKeys()).toEqual(before.state)
  })

  it('真实企业账号只更新 token，不删设备注册', async () => {
    putAuth(KIRO_CLI_AUTH_KEY.OIDC_TOKEN, { refresh_token: 'refresh-idc', region: 'us-east-1' })
    putAuth(KIRO_CLI_AUTH_KEY.OIDC_DEVICE_REGISTRATION, { client_id: 'c', client_secret: 's' })

    await syncRefreshedKiroCliCredentials('refresh-idc', { accessToken: 'access-idc-new' }, dbPath)

    const kv = authKv()
    expect(kv[KIRO_CLI_AUTH_KEY.OIDC_TOKEN]).toMatchObject({
      access_token: 'access-idc-new',
      refresh_token: 'refresh-idc'
    })
    expect(kv).toHaveProperty(KIRO_CLI_AUTH_KEY.OIDC_DEVICE_REGISTRATION)
  })

  it('社交凭据没有 provider 时不写入 null', async () => {
    putAuth(KIRO_CLI_AUTH_KEY.SOCIAL_TOKEN, { refresh_token: 'refresh-old' })

    await syncRefreshedKiroCliCredentials('refresh-old', { accessToken: 'access-new' }, dbPath)

    expect(authKv()[KIRO_CLI_AUTH_KEY.SOCIAL_TOKEN]).not.toHaveProperty('provider')
  })

  it('过期时间按 expiresIn 计算，缺省一小时', () => {
    const withTtl = buildKiroCliRefreshSyncSql('r', { accessToken: 'a', expiresIn: 60 }, now)
    const withoutTtl = buildKiroCliRefreshSyncSql('r', { accessToken: 'a' }, now)
    expect(withTtl).toContain("'2030-01-01T00:01:00.000Z'")
    expect(withoutTtl).toContain("'2030-01-01T01:00:00.000Z'")
  })

  it('CLI 没装时静默跳过', async () => {
    await expect(
      syncRefreshedKiroCliCredentials('r', { accessToken: 'a' }, join(dir, 'missing.sqlite3'))
    ).resolves.toBeUndefined()
  })
})

describe('Kiro CLI 社交凭据读取与续期', () => {
  it('读取社交凭据；没有时返回 null', async () => {
    expect(await readKiroCliSocialToken(dbPath)).toBeNull()
    putAuth(KIRO_CLI_AUTH_KEY.SOCIAL_TOKEN, {
      refresh_token: 'refresh',
      expires_at: '2030-01-01T00:00:00.000Z',
      provider: 'github'
    })
    expect(await readKiroCliSocialToken(dbPath)).toMatchObject({
      refresh_token: 'refresh',
      provider: 'github'
    })
    expect(await readKiroCliSocialToken(join(dir, 'missing.sqlite3'))).toBeNull()
  })

  function renewalWith(
    token: KiroCliSocialToken | null,
    renew: (token: KiroCliSocialToken) => Promise<void> = vi.fn(async () => {})
  ): { renew: typeof renew; renewal: ReturnType<typeof createKiroCliSocialRenewal> } {
    return {
      renew,
      renewal: createKiroCliSocialRenewal({
        renew,
        readToken: async () => token,
        now: () => Date.parse('2030-01-01T00:00:00.000Z'),
        logger: { warn: vi.fn() }
      })
    }
  }

  it('剩余有效期不超过 10 分钟才续期', async () => {
    const far = renewalWith({ refresh_token: 'r', expires_at: '2030-01-01T00:10:01.000Z' })
    await far.renewal.tick()
    expect(far.renew).not.toHaveBeenCalled()

    const near = renewalWith({ refresh_token: 'r', expires_at: '2030-01-01T00:10:00.000Z' })
    await near.renewal.tick()
    expect(near.renew).toHaveBeenCalledTimes(1)

    const unknown = renewalWith({ refresh_token: 'r' })
    await unknown.renewal.tick()
    expect(unknown.renew).toHaveBeenCalledTimes(1)
  })

  it('没有社交凭据时不续期', async () => {
    const { renew, renewal } = renewalWith(null)
    await renewal.tick()
    expect(renew).not.toHaveBeenCalled()
  })

  it('上一次续期未结束时不重叠执行', async () => {
    let release: () => void = () => {}
    const renew = vi.fn(() => new Promise<void>((resolve) => (release = resolve)))
    const { renewal } = renewalWith({ refresh_token: 'r' }, renew)

    const first = renewal.tick()
    await vi.waitFor(() => expect(renew).toHaveBeenCalledTimes(1))
    await renewal.tick()
    expect(renew).toHaveBeenCalledTimes(1)

    release()
    await first
    const second = renewal.tick()
    await vi.waitFor(() => expect(renew).toHaveBeenCalledTimes(2))
    release()
    await second
  })

  it('续期抛错时记日志，不影响下一轮', async () => {
    const renew = vi.fn(async () => {
      throw new Error('network down')
    })
    const { renewal } = renewalWith({ refresh_token: 'r' }, renew)
    await expect(renewal.tick()).resolves.toBeUndefined()
    await renewal.tick()
    expect(renew).toHaveBeenCalledTimes(2)
  })
})

describe('Kiro CLI 辅助函数', () => {
  it('没有 sqlite3 命令时回退到 Node 内置 SQLite', async () => {
    seedLegacySocialV2('refresh-old')
    const originalPath = process.env.PATH
    process.env.PATH = dir
    try {
      await syncRefreshedKiroCliCredentials(
        'refresh-old',
        { accessToken: 'access-new', refreshToken: 'refresh-new' },
        dbPath
      )
      expect(await readKiroCliSocialToken(dbPath)).toMatchObject({
        refresh_token: 'refresh-new',
        provider: 'github'
      })
    } finally {
      process.env.PATH = originalPath
    }
    expect(Object.keys(authKv())).toEqual([KIRO_CLI_AUTH_KEY.SOCIAL_TOKEN])
  })

  it('数据库路径与 kiro-cli 一致', () => {
    expect(resolveKiroCliDbPath('darwin', '/Users/u')).toBe(
      '/Users/u/Library/Application Support/kiro-cli/data.sqlite3'
    )
    expect(resolveKiroCliDbPath('linux', '/home/u')).toBe(
      '/home/u/.local/share/kiro-cli/data.sqlite3'
    )
  })

  it('从 provider / idp 认出社交 provider', () => {
    expect(resolveKiroCliSocialProvider(undefined, 'Google')).toBe('Google')
    expect(resolveKiroCliSocialProvider('Github', 'BuilderId')).toBe('Github')
    expect(resolveKiroCliSocialProvider('BuilderId', 'Enterprise')).toBeUndefined()
  })
})
