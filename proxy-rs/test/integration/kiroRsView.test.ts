import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  KIRO_ADMIN_PARTITION,
  adminUiUrlFromApiBase,
  installAdminWebviewGuards,
  isAllowedAdminUrl,
  parseKiroRsLine
} from '../../src/main/accountDb/kiroRsView'
import { proxyLogStore } from '../../src/main/proxy/logger'

const ADMIN_URL = 'http://127.0.0.1:12888/admin'

describe('parseKiroRsLine', () => {
  it('当前格式：去掉时间戳与级别，保留 [Tag] 消息', () => {
    const line =
      '[2026-09-10T09:36:01.649Z] \x1b[34m[INFO]\x1b[0m [POST] /v1/messages?beta=true 200 (3318ms)'
    expect(parseKiroRsLine(line, 'stderr')).toEqual({
      level: 'INFO',
      message: '[POST] /v1/messages?beta=true 200 (3318ms)'
    })
    expect(
      parseKiroRsLine('[2026-09-10T09:36:01.649Z] [WARN] [TokenManager] 凭据 #2 刷新失败', 'stdout')
    ).toEqual({ level: 'WARN', message: '[TokenManager] 凭据 #2 刷新失败' })
  })

  it('去掉颜色码与时间戳，按原级别记录，模块名去掉包前缀', () => {
    const line =
      '\x1b[2m2026-09-29T03:27:51.335845Z\x1b[0m \x1b[33m WARN\x1b[0m \x1b[2mkiro_rs::kiro::token_manager\x1b[0m\x1b[2m:\x1b[0m 凭据 #2 刷新失败'
    expect(parseKiroRsLine(line, 'stdout')).toEqual({
      level: 'WARN',
      message: 'kiro::token_manager: 凭据 #2 刷新失败'
    })
  })

  it('ERROR 保持 ERROR，DEBUG/TRACE 归为 INFO', () => {
    expect(parseKiroRsLine('2026-09-29T03:27:51Z ERROR kiro_rs: boom', 'stdout').level).toBe(
      'ERROR'
    )
    expect(parseKiroRsLine('2026-09-29T03:27:51Z DEBUG kiro_rs::a: x', 'stdout')).toEqual({
      level: 'INFO',
      message: 'a: x'
    })
  })

  it('认不出的行原样保留；stderr 上的记为 WARN', () => {
    expect(parseKiroRsLine("thread 'main' panicked at src/main.rs:1", 'stderr')).toEqual({
      level: 'WARN',
      message: "thread 'main' panicked at src/main.rs:1"
    })
    expect(parseKiroRsLine('plain', 'stdout').level).toBe('INFO')
  })
})

describe('Admin 页面地址', () => {
  it('由 Admin API 基址推出', () => {
    expect(adminUiUrlFromApiBase('http://127.0.0.1:12888/api/admin')).toBe(ADMIN_URL)
    expect(adminUiUrlFromApiBase('http://127.0.0.1:12888/api/admin/')).toBe(ADMIN_URL)
  })

  it('只放行本机 kiro-rs 的 /admin 及其子路径', () => {
    expect(isAllowedAdminUrl(ADMIN_URL, ADMIN_URL)).toBe(true)
    expect(isAllowedAdminUrl(`${ADMIN_URL}/assets/index-abc.js`, ADMIN_URL)).toBe(true)
    expect(isAllowedAdminUrl('http://127.0.0.1:12888/administrator', ADMIN_URL)).toBe(false)
    expect(isAllowedAdminUrl('http://127.0.0.1:12888/v1/models', ADMIN_URL)).toBe(false)
    expect(isAllowedAdminUrl('http://127.0.0.1:9999/admin', ADMIN_URL)).toBe(false)
    expect(isAllowedAdminUrl('https://example.com/admin', ADMIN_URL)).toBe(false)
    expect(isAllowedAdminUrl('not a url', ADMIN_URL)).toBe(false)
  })
})

/** 最小的 WebContents 替身：只实现 guards 用到的事件与方法 */
function fakeGuest(url: string): EventEmitter & {
  executed: string[]
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  getURL: () => string
  executeJavaScript: (code: string) => Promise<void>
} {
  const guest = new EventEmitter() as EventEmitter & {
    executed: string[]
    setWindowOpenHandler: ReturnType<typeof vi.fn>
    getURL: () => string
    executeJavaScript: (code: string) => Promise<void>
  }
  guest.executed = []
  guest.setWindowOpenHandler = vi.fn()
  guest.getURL = () => url
  guest.executeJavaScript = async (code) => {
    guest.executed.push(code)
  }
  return guest
}

describe('installAdminWebviewGuards', () => {
  const resolve = (): { adminUiUrl: string; adminApiKey: string } => ({
    adminUiUrl: ADMIN_URL,
    adminApiKey: 'test-admin-key'
  })

  function attach(
    src: string,
    partition: string,
    ready = resolve
  ): {
    prevented: boolean
    webPreferences: Record<string, unknown>
  } {
    const host = new EventEmitter()
    installAdminWebviewGuards(host as never, { resolve: ready as never })
    let prevented = false
    const webPreferences: Record<string, unknown> = { preload: '/evil.js', nodeIntegration: true }
    host.emit('will-attach-webview', { preventDefault: () => (prevented = true) }, webPreferences, {
      src,
      partition
    })
    return { prevented, webPreferences }
  }

  it('放行 Admin 页面，并去掉 preload / Node 能力', () => {
    const { prevented, webPreferences } = attach(ADMIN_URL, KIRO_ADMIN_PARTITION)
    expect(prevented).toBe(false)
    expect(webPreferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    })
    expect(webPreferences.preload).toBeUndefined()
  })

  it('拦下其它地址、其它会话，以及 kiro-rs 未就绪时的加载', () => {
    expect(attach('https://example.com', KIRO_ADMIN_PARTITION).prevented).toBe(true)
    expect(attach(ADMIN_URL, 'persist:other').prevented).toBe(true)
    expect(attach(ADMIN_URL, KIRO_ADMIN_PARTITION, () => null as never).prevented).toBe(true)
  })

  it('页面就绪后写入 Admin Key；外部导航被拦下', () => {
    const host = new EventEmitter()
    installAdminWebviewGuards(host as never, { resolve })
    const guest = fakeGuest(ADMIN_URL)
    host.emit('did-attach-webview', {}, guest)

    guest.emit('dom-ready')
    expect(guest.executed).toHaveLength(1)
    expect(guest.executed[0]).toContain('"adminApiKey"')
    expect(guest.executed[0]).toContain('"test-admin-key"')

    let prevented = false
    guest.emit('will-navigate', { preventDefault: () => (prevented = true) }, 'file:///etc/passwd')
    expect(prevented).toBe(true)
    prevented = false
    guest.emit('will-navigate', { preventDefault: () => (prevented = true) }, `${ADMIN_URL}#x`)
    expect(prevented).toBe(false)
  })

  it('不在 Admin 页面上时不注入 Key', () => {
    const host = new EventEmitter()
    installAdminWebviewGuards(host as never, { resolve })
    const guest = fakeGuest('https://example.com/')
    host.emit('did-attach-webview', {}, guest)
    guest.emit('dom-ready')
    expect(guest.executed).toHaveLength(0)
  })
})

describe('日志按分类读写', () => {
  it('按分类取最近 N 条、计数、只清该分类', () => {
    proxyLogStore.initialize(mkdtempSync(join(tmpdir(), 'proxy-rs-logs-')))
    proxyLogStore.clear()
    const entry = (category: string, message: string): Parameters<typeof proxyLogStore.add>[0] => ({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      category,
      message
    })
    proxyLogStore.add(entry('kiro-rs', 'a'))
    proxyLogStore.add(entry('App', 'b'))
    proxyLogStore.add(entry('kiro-rs', 'c'))

    expect(proxyLogStore.countOfCategory('kiro-rs')).toBe(2)
    expect(proxyLogStore.getLastOfCategory('kiro-rs').map((e) => e.message)).toEqual(['a', 'c'])
    expect(proxyLogStore.getLastOfCategory('kiro-rs', 1).map((e) => e.message)).toEqual(['c'])

    proxyLogStore.clearCategory('kiro-rs')
    expect(proxyLogStore.countOfCategory('kiro-rs')).toBe(0)
    expect(proxyLogStore.count()).toBe(1)
    proxyLogStore.clear()
  })
})
