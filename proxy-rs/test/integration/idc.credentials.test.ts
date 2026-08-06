// 凭据解析测试：手填模式 + ~/.aws profile 解析（含不支持的 profile 类型）

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ readFile: vi.fn() }))

vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }))
vi.mock('node:os', () => ({ homedir: () => '/home/tester' }))

const { listAwsProfiles, resolveCredentials } = await import('../../src/main/idc/credentials')

/** 用文件内容表驱动 readFile，未列出的路径视为不存在 */
function mockAwsFiles(files: Record<string, string>): void {
  mocks.readFile.mockImplementation(async (path: string) => {
    const key = String(path)
    if (key in files) return files[key]
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  })
}

const CRED_PATH = '/home/tester/.aws/credentials'
const CONFIG_PATH = '/home/tester/.aws/config'

beforeEach(() => {
  vi.clearAllMocks()
  mockAwsFiles({})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveCredentials — manual', () => {
  it('uses the provided keys and defaults the region', async () => {
    const resolved = await resolveCredentials({
      source: 'manual',
      region: '',
      accessKeyId: 'AKIA1',
      secretAccessKey: 'secret1'
    })
    expect(resolved).toEqual({
      accessKeyId: 'AKIA1',
      secretAccessKey: 'secret1',
      sessionToken: undefined,
      region: 'us-east-1'
    })
  })

  it('keeps the session token for temporary credentials', async () => {
    const resolved = await resolveCredentials({
      source: 'manual',
      region: 'eu-west-1',
      accessKeyId: 'ASIA1',
      secretAccessKey: 'secret1',
      sessionToken: 'token1'
    })
    expect(resolved.sessionToken).toBe('token1')
    expect(resolved.region).toBe('eu-west-1')
  })

  it('rejects missing keys instead of sending unsigned requests', async () => {
    await expect(
      resolveCredentials({
        source: 'manual',
        region: 'us-east-1',
        accessKeyId: '',
        secretAccessKey: 'x'
      })
    ).rejects.toThrow(/Access Key/)
  })
})

describe('resolveCredentials — profile', () => {
  it('reads static keys from ~/.aws/credentials', async () => {
    mockAwsFiles({
      [CRED_PATH]: [
        '[default]',
        'aws_access_key_id = AKIA_DEFAULT',
        'aws_secret_access_key = SECRET_DEFAULT',
        '',
        '[kiro-mother]',
        'aws_access_key_id = AKIA_KIRO',
        'aws_secret_access_key = SECRET_KIRO',
        'aws_session_token = TOKEN_KIRO'
      ].join('\n')
    })

    const resolved = await resolveCredentials({
      source: 'profile',
      region: '',
      profile: 'kiro-mother'
    })
    expect(resolved.accessKeyId).toBe('AKIA_KIRO')
    expect(resolved.sessionToken).toBe('TOKEN_KIRO')
  })

  it('defaults to the default profile', async () => {
    mockAwsFiles({
      [CRED_PATH]: '[default]\naws_access_key_id = AKIA_D\naws_secret_access_key = S_D\n'
    })
    const resolved = await resolveCredentials({ source: 'profile', region: 'us-east-2' })
    expect(resolved.accessKeyId).toBe('AKIA_D')
    expect(resolved.region).toBe('us-east-2')
  })

  it('falls back to the profile region when none is chosen in the app', async () => {
    mockAwsFiles({
      [CRED_PATH]: '[work]\naws_access_key_id = A\naws_secret_access_key = S\n',
      [CONFIG_PATH]: '[profile work]\nregion = ap-southeast-1\n'
    })
    const resolved = await resolveCredentials({ source: 'profile', region: '', profile: 'work' })
    expect(resolved.region).toBe('ap-southeast-1')
  })

  it('prefers the app-selected region over the profile region', async () => {
    mockAwsFiles({
      [CRED_PATH]:
        '[work]\naws_access_key_id = A\naws_secret_access_key = S\nregion = ap-southeast-1\n'
    })
    const resolved = await resolveCredentials({
      source: 'profile',
      region: 'us-west-2',
      profile: 'work'
    })
    expect(resolved.region).toBe('us-west-2')
  })

  it('ignores comments and blank lines', async () => {
    mockAwsFiles({
      [CRED_PATH]: [
        '# a comment',
        '; another comment',
        '',
        '[work]',
        '  aws_access_key_id = AKIA_W  ',
        'AWS_SECRET_ACCESS_KEY = S_W'
      ].join('\n')
    })
    const resolved = await resolveCredentials({
      source: 'profile',
      region: 'us-east-1',
      profile: 'work'
    })
    expect(resolved.accessKeyId).toBe('AKIA_W')
    // key 大小写不敏感
    expect(resolved.secretAccessKey).toBe('S_W')
  })

  it('lists available profiles when the requested one is missing', async () => {
    mockAwsFiles({
      [CRED_PATH]: '[alpha]\naws_access_key_id = A\naws_secret_access_key = S\n',
      [CONFIG_PATH]: '[profile beta]\nregion = us-east-1\n'
    })
    await expect(
      resolveCredentials({ source: 'profile', region: '', profile: 'gamma' })
    ).rejects.toThrow(/alpha.*beta|beta.*alpha/)
  })

  it('explains that SSO profiles are unsupported rather than failing obscurely', async () => {
    mockAwsFiles({
      [CONFIG_PATH]:
        '[profile sso-prof]\nsso_start_url = https://x.awsapps.com/start\nsso_account_id = 1\n'
    })
    await expect(
      resolveCredentials({ source: 'profile', region: '', profile: 'sso-prof' })
    ).rejects.toThrow(/SSO/)
  })

  it('explains that assume-role profiles are unsupported', async () => {
    mockAwsFiles({
      [CONFIG_PATH]:
        '[profile role-prof]\nrole_arn = arn:aws:iam::1:role/r\nsource_profile = default\n'
    })
    await expect(
      resolveCredentials({ source: 'profile', region: '', profile: 'role-prof' })
    ).rejects.toThrow(/assume-role/)
  })

  it('reports when ~/.aws is absent entirely', async () => {
    await expect(
      resolveCredentials({ source: 'profile', region: '', profile: 'default' })
    ).rejects.toThrow(/均不存在或为空/)
  })
})

describe('listAwsProfiles', () => {
  it('merges and dedupes names from both files', async () => {
    mockAwsFiles({
      [CRED_PATH]:
        '[default]\naws_access_key_id=A\naws_secret_access_key=S\n[work]\naws_access_key_id=B\naws_secret_access_key=T\n',
      [CONFIG_PATH]: '[profile work]\nregion=us-east-1\n[profile extra]\nregion=us-east-2\n'
    })
    expect(await listAwsProfiles()).toEqual(['default', 'extra', 'work'])
  })

  it('returns an empty list when nothing is configured', async () => {
    expect(await listAwsProfiles()).toEqual([])
  })
})
