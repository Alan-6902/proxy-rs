import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.hoisted 先于顶层 import 执行，只能在里面动态引入
const mocks = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-rs-cursor-store-'))
  return { dir, encryptionAvailable: true }
})

// safeStorage 用明文占位：这里验证的是存储逻辑，不是系统加密本身
vi.mock('electron', () => ({
  app: { getPath: () => mocks.dir },
  safeStorage: {
    isEncryptionAvailable: () => mocks.encryptionAvailable,
    encryptString: (value: string) => Buffer.from(value, 'utf-8'),
    decryptString: (value: Buffer) => value.toString('utf-8')
  }
}))

import {
  cursorAccountsStorePath,
  exportCursorAccountsJson,
  findCursorAccountByIdentity,
  loadCursorAccounts,
  loadCursorAutoRefreshSettings,
  normalizeCursorAutoRefreshSettings,
  parseCursorImportJson,
  removeCursorAccounts,
  updateCursorAccountTags,
  updateCursorAutoRefreshSettings,
  upsertCursorAccount,
  upsertCursorAccounts,
  withTags
} from '../../src/main/cursorAccounts/accountStore'

function fakeJwt(sub: string): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256' })}.${encode({ sub, exp: 9999999999 })}.sig`
}

afterAll(() => {
  rmSync(mocks.dir, { recursive: true, force: true })
})

beforeEach(() => {
  mocks.encryptionAvailable = true
  rmSync(cursorAccountsStorePath(), { force: true })
})

describe('Cursor 账号导入 JSON 解析', () => {
  it('接受 cockpit-tools 导出的 snake_case 数组，秒级时间戳换成毫秒', () => {
    const payloads = parseCursorImportJson(
      JSON.stringify([
        {
          id: 'cursor_x',
          email: 'a@example.com',
          access_token: 'at',
          refresh_token: 'rt',
          membership_type: 'pro',
          cursor_auth_raw: { authId: 'auth0|user_A' },
          tags: ['团队', '团队', ' 备用 '],
          created_at: 1_700_000_000
        }
      ])
    )
    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toMatchObject({
      email: 'a@example.com',
      accessToken: 'at',
      refreshToken: 'rt',
      membershipType: 'pro',
      tags: ['团队', '备用'],
      createdAt: 1_700_000_000_000
    })
    expect(payloads[0].authRaw).toEqual({ authId: 'auth0|user_A' })
  })

  it('接受单个对象、accounts 包装与最简 token 数组', () => {
    expect(parseCursorImportJson('{"accessToken":"at","email":"b@example.com"}')).toHaveLength(1)
    expect(
      parseCursorImportJson('{"accounts":[{"token":"t1","email":"c@example.com"},{"token":"t2"}]}')
    ).toHaveLength(2)
  })

  it('缺 token、空数组、非 JSON 都给出定位到条目的错误', () => {
    expect(() => parseCursorImportJson('[{"email":"x@example.com"}]')).toThrow('第 1 条')
    expect(() => parseCursorImportJson('[]')).toThrow('导入数组为空')
    expect(() => parseCursorImportJson('nope')).toThrow('无法解析 JSON')
    expect(() => parseCursorImportJson('"str"')).toThrow('必须是对象或数组')
  })
})

describe('Cursor 账号加密存储', () => {
  it('首次读取返回空列表；写入后文件权限为 0600 且不含明文以外的包装', async () => {
    expect(await loadCursorAccounts()).toEqual([])
    const saved = await upsertCursorAccount({
      email: 'a@example.com',
      accessToken: fakeJwt('auth0|user_A')
    })
    expect(saved.id).toMatch(/^cursor_[0-9a-f]{32}$/)
    expect(existsSync(cursorAccountsStorePath())).toBe(true)
    const persisted = JSON.parse(readFileSync(cursorAccountsStorePath(), 'utf-8'))
    expect(persisted).toMatchObject({ version: 1 })
    expect(persisted.accounts).toHaveLength(1)
  })

  it('同一 authId 的账号再次导入合并到原记录：保留 id / 标签 / 创建时间，更新 token', async () => {
    const first = await upsertCursorAccount({
      email: 'a@example.com',
      accessToken: fakeJwt('auth0|user_A'),
      tags: ['主力']
    })
    await updateCursorAccountTags(first.id, ['主力', 'vip'])

    const second = await upsertCursorAccount({
      // 邮箱不同也不影响：authId 一致就是同一个号
      email: 'renamed@example.com',
      accessToken: fakeJwt('auth0|user_A'),
      refreshToken: 'new-rt',
      tags: ['备用']
    })

    expect(second.id).toBe(first.id)
    expect(second.email).toBe('renamed@example.com')
    expect(second.refreshToken).toBe('new-rt')
    expect(second.tags).toEqual(['主力', 'vip', '备用'])
    expect(second.createdAt).toBe(first.createdAt)
    expect(await loadCursorAccounts()).toHaveLength(1)
  })

  it('新增时带的标签随入库一次写上：与 payload 自带、库里已有的标签去重合并，标签内空格保留', async () => {
    const plain = { email: 'b@example.com', accessToken: fakeJwt('auth0|user_B') }
    // 没有标签时不制造拷贝
    expect(withTags(plain, [])).toBe(plain)

    const [first] = await upsertCursorAccounts([
      withTags({ email: 'a@example.com', accessToken: fakeJwt('auth0|user_A'), tags: ['主力'] }, [
        '赏帽 token2',
        ' 主力 '
      ])
    ])
    expect(first.tags).toEqual(['主力', '赏帽 token2'])

    // 同一账号再导一次并带新标签：旧标签不丢，新的追加
    const again = await upsertCursorAccount(
      withTags({ email: 'a@example.com', accessToken: fakeJwt('auth0|user_A') }, ['vip', 'VIP'])
    )
    expect(again.id).toBe(first.id)
    expect(again.tags).toEqual(['主力', '赏帽 token2', 'vip'])
  })

  it('更新标签是整体替换：删掉的不会回来，空数组即清空', async () => {
    const saved = await upsertCursorAccount({
      email: 'a@example.com',
      accessToken: fakeJwt('auth0|user_A'),
      tags: ['主力', '备用']
    })
    const replaced = await updateCursorAccountTags(saved.id, ['备用', '  ', 'grok'])
    expect(replaced.tags).toEqual(['备用', 'grok'])
    expect((await loadCursorAccounts())[0].tags).toEqual(['备用', 'grok'])

    await updateCursorAccountTags(saved.id, [])
    expect((await loadCursorAccounts())[0].tags).toEqual([])
    await expect(updateCursorAccountTags('cursor_missing', ['x'])).rejects.toThrow('账号不存在')
  })

  it('没有 authId 时按邮箱匹配；邮箱不同则新建', async () => {
    await upsertCursorAccount({ email: 'a@example.com', accessToken: 'opaque-1' })
    await upsertCursorAccount({ email: 'A@Example.com', accessToken: 'opaque-2' })
    await upsertCursorAccount({ email: 'b@example.com', accessToken: 'opaque-3' })
    const accounts = await loadCursorAccounts()
    expect(accounts).toHaveLength(2)
    // 匹配不分大小写，但保存的是最新一次导入给的写法
    const merged = accounts.find((item) => item.email.toLowerCase() === 'a@example.com')
    expect(merged?.email).toBe('A@Example.com')
    expect(merged?.accessToken).toBe('opaque-2')
  })

  it('邮箱相同即同一账号：authId 不同或只有一边有都合并；邮箱不同且 authId 不同才新建', async () => {
    // 本机导入拿到的 authId 与登录握手 JWT 的 sub 实测不一致，靠邮箱兜住
    const local = await upsertCursorAccount({
      email: 'a@example.com',
      accessToken: fakeJwt('grok|user_LOCAL'),
      authId: 'grok|user_LOCAL'
    })
    const handshake = await upsertCursorAccount({
      email: 'a@example.com',
      accessToken: fakeJwt('grok|user_JWT'),
      refreshToken: 'rt'
    })
    expect(handshake.id).toBe(local.id)

    await upsertCursorAccount({ email: 'a@example.com', accessToken: 'opaque-no-authid' })
    expect(await loadCursorAccounts()).toHaveLength(1)

    await upsertCursorAccount({ email: 'b@example.com', accessToken: fakeJwt('auth0|user_B') })
    expect(await loadCursorAccounts()).toHaveLength(2)
  })

  it('没有邮箱时只认 authId：一边有一边没有不合并', async () => {
    await upsertCursorAccount({ email: '', accessToken: fakeJwt('auth0|user_A') })
    await upsertCursorAccount({ email: '', accessToken: 'opaque' })
    await upsertCursorAccount({
      email: '',
      accessToken: fakeJwt('auth0|user_A'),
      refreshToken: 'rt'
    })
    const accounts = await loadCursorAccounts()
    expect(accounts).toHaveLength(2)
    expect(accounts.find((item) => item.authId === 'auth0|user_A')?.refreshToken).toBe('rt')
  })

  it('批量导入一次落盘，删除按 id 生效，导出为可再导入的 JSON', async () => {
    const saved = await upsertCursorAccounts([
      { email: 'a@example.com', accessToken: fakeJwt('auth0|user_A') },
      { email: 'b@example.com', accessToken: fakeJwt('auth0|user_B') }
    ])
    expect(saved).toHaveLength(2)

    const json = exportCursorAccountsJson(await loadCursorAccounts())
    expect(parseCursorImportJson(json)).toHaveLength(2)

    await removeCursorAccounts([saved[0].id])
    const rest = await loadCursorAccounts()
    expect(rest.map((item) => item.email)).toEqual(['b@example.com'])
  })

  it('本机登录态按身份匹配到库里的账号', async () => {
    const saved = await upsertCursorAccount({
      email: 'a@example.com',
      accessToken: fakeJwt('auth0|user_A')
    })
    const accounts = await loadCursorAccounts()
    expect(
      findCursorAccountByIdentity(accounts, {
        authId: 'auth0|user_A',
        email: 'whatever@example.com',
        accessToken: 'rotated'
      })?.id
    ).toBe(saved.id)
    expect(findCursorAccountByIdentity(accounts, { authId: 'auth0|user_Z' })).toBeUndefined()
  })

  it('文件损坏时拒绝用空数据覆盖', async () => {
    writeFileSync(cursorAccountsStorePath(), 'not json')
    await expect(loadCursorAccounts()).rejects.toThrow('拒绝用空数据覆盖')
    await expect(upsertCursorAccount({ email: 'a@example.com', accessToken: 'x' })).rejects.toThrow(
      '拒绝用空数据覆盖'
    )
    expect(readFileSync(cursorAccountsStorePath(), 'utf-8')).toBe('not json')
  })

  it('自动刷新设置与账号同文件持久化，互不覆盖', async () => {
    expect(await loadCursorAutoRefreshSettings()).toEqual({ enabled: true, intervalMinutes: 10 })
    await upsertCursorAccount({ email: 'a@example.com', accessToken: fakeJwt('auth0|user_A') })
    await updateCursorAutoRefreshSettings({ intervalMinutes: 30 })
    await updateCursorAutoRefreshSettings({ enabled: false })
    await upsertCursorAccount({ email: 'b@example.com', accessToken: fakeJwt('auth0|user_B') })

    expect(await loadCursorAutoRefreshSettings()).toEqual({ enabled: false, intervalMinutes: 30 })
    expect(await loadCursorAccounts()).toHaveLength(2)
  })

  it('设置归一化：非法间隔回落默认，缺字段用默认', () => {
    expect(normalizeCursorAutoRefreshSettings(undefined)).toEqual({
      enabled: true,
      intervalMinutes: 10
    })
    expect(normalizeCursorAutoRefreshSettings({ enabled: false, intervalMinutes: 7 })).toEqual({
      enabled: false,
      intervalMinutes: 10
    })
    expect(normalizeCursorAutoRefreshSettings({ intervalMinutes: '60' })).toEqual({
      enabled: true,
      intervalMinutes: 60
    })
  })

  it('系统加密不可用时读到空列表、写入被拒绝', async () => {
    mocks.encryptionAvailable = false
    expect(await loadCursorAccounts()).toEqual([])
    await expect(upsertCursorAccount({ email: 'a@example.com', accessToken: 'x' })).rejects.toThrow(
      '系统加密存储不可用'
    )
  })
})
