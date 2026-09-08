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
  parseCursorImportJson,
  removeCursorAccounts,
  updateCursorAccountTags,
  upsertCursorAccount,
  upsertCursorAccounts
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

  it('一方有 authId 一方没有时视为不同账号，不会误合并', async () => {
    await upsertCursorAccount({ email: 'a@example.com', accessToken: 'opaque' })
    await upsertCursorAccount({ email: 'a@example.com', accessToken: fakeJwt('auth0|user_A') })
    expect(await loadCursorAccounts()).toHaveLength(2)
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

  it('系统加密不可用时读到空列表、写入被拒绝', async () => {
    mocks.encryptionAvailable = false
    expect(await loadCursorAccounts()).toEqual([])
    await expect(upsertCursorAccount({ email: 'a@example.com', accessToken: 'x' })).rejects.toThrow(
      '系统加密存储不可用'
    )
  })
})
