import net from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProxyServer } from '../../src/main/proxy/proxyServer'
import { stripAdminApiKey } from '../../src/main/proxy/adminApiKey'
import { makeApiKey } from '../helpers/proxyFixtures'

const LOOPBACK_HOST = '127.0.0.1'
const ADMIN_KEY = 'adm_test_admin_key'
const USER_KEY = 'sk_test_regular_key'

describe('ProxyServer 管理 API 鉴权隔离', () => {
  let server: ProxyServer

  beforeEach(async () => {
    server = new ProxyServer({ host: LOOPBACK_HOST, port: 0, logRequests: false })
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  async function request(
    path: string,
    key?: string,
    method = 'GET',
    body?: unknown,
    useXApiKey = false
  ): Promise<Response> {
    const headers: Record<string, string> = {}
    if (key) {
      if (useXApiKey) headers['X-Api-Key'] = key
      else headers.Authorization = `Bearer ${key}`
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    return fetch(`http://${LOOPBACK_HOST}:${server.getListeningPort()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  }

  async function rawRequest(requestTarget: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: LOOPBACK_HOST, port: server.getListeningPort() })
      const chunks: Buffer[] = []
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('raw request timeout'))
      }, 2_000)
      socket.on('connect', () =>
        socket.end(
          `GET ${requestTarget} HTTP/1.1\r\nHost: ${LOOPBACK_HOST}\r\nConnection: close\r\n\r\n`
        )
      )
      socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      socket.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      socket.on('close', () => {
        clearTimeout(timer)
        resolve(Buffer.concat(chunks).toString('utf8'))
      })
    })
  }

  it('未配置管理员密钥时，所有令牌访问管理 API 都以相同 401 失败', async () => {
    server.updateConfig({
      apiKeys: [makeApiKey({ key: USER_KEY })]
    })
    const anonymous = await request('/admin/stats')
    const ordinary = await request('/admin/stats', USER_KEY)

    expect(anonymous.status).toBe(401)
    expect(ordinary.status).toBe(401)
    expect(await anonymous.text()).toBe(await ordinary.text())
  })

  it('普通密钥与管理员密钥严格隔离，且管理员密钥不能访问业务端点', async () => {
    server.updateConfig({
      apiKeys: [makeApiKey({ key: USER_KEY })],
      adminApiKey: ADMIN_KEY
    })

    expect((await request('/admin/stats', USER_KEY)).status).toBe(401)
    expect((await request('/admin/stats', ADMIN_KEY)).status).toBe(200)
    expect((await request('/admin/stats', ADMIN_KEY, 'GET', undefined, true)).status).toBe(200)
    expect((await request('/api/event_logging/batch', ADMIN_KEY, 'POST')).status).toBe(401)
    expect((await request('/api/event_logging/batch', USER_KEY, 'POST')).status).toBe(200)
  })

  it('管理配置不泄露密钥或 TLS 私钥，且不能通过管理 API 写入管理员密钥', async () => {
    server.updateConfig({
      apiKey: 'legacy-plain-secret',
      adminApiKey: ADMIN_KEY,
      apiKeys: [makeApiKey({ key: USER_KEY })],
      tls: { enabled: false, key: 'tls-private-secret' }
    })

    const config = await request('/admin/config', ADMIN_KEY)
    const text = await config.text()
    expect(config.status).toBe(200)
    expect(text).not.toContain('legacy-plain-secret')
    expect(text).not.toContain(ADMIN_KEY)
    expect(text).not.toContain('tls-private-secret')
    expect(text).not.toContain(USER_KEY)
    expect(JSON.parse(text).adminApiKeyConfigured).toBe(true)

    const update = await request('/admin/config', ADMIN_KEY, 'POST', {
      adminApiKey: 'attempted-overwrite'
    })
    expect(update.status).toBe(200)
    const updateText = await update.text()
    expect(updateText).not.toContain('legacy-plain-secret')
    expect(updateText).not.toContain(ADMIN_KEY)
    expect(updateText).not.toContain(USER_KEY)
    expect(updateText).not.toContain('tls-private-secret')
    expect((await request('/admin/stats', ADMIN_KEY)).status).toBe(200)
    expect((await request('/admin/stats', 'attempted-overwrite')).status).toBe(401)
  })

  it('IP 拒绝优先于管理员认证，管理员与普通密钥限流桶互不碰撞', async () => {
    await server.stop()
    server = new ProxyServer({
      host: LOOPBACK_HOST,
      port: 0,
      logRequests: false,
      deniedIPs: [LOOPBACK_HOST],
      adminApiKey: ADMIN_KEY
    })
    await server.start()
    expect((await request('/admin/stats', ADMIN_KEY)).status).toBe(403)

    await server.stop()
    server = new ProxyServer({
      host: LOOPBACK_HOST,
      port: 0,
      logRequests: false,
      rateLimitPerKeyPerMinute: 1,
      adminApiKey: ADMIN_KEY,
      apiKeys: [makeApiKey({ id: 'admin:control', name: 'collision', key: USER_KEY })]
    })
    await server.start()
    expect((await request('/api/event_logging/batch', USER_KEY, 'POST')).status).toBe(200)
    expect((await request('/admin/stats', ADMIN_KEY)).status).toBe(200)
    expect((await request('/api/event_logging/batch', USER_KEY, 'POST')).status).toBe(429)
    expect((await request('/admin/stats', ADMIN_KEY)).status).toBe(429)
  })

  it('畸形 request-target 返回 400 且服务器继续服务健康检查', async () => {
    const response = await rawRequest('http://[')
    expect(response).toMatch(/^HTTP\/1\.1 400 /)
    expect((await request('/health')).status).toBe(200)
  })

  it('拒绝管理员密钥与普通密钥同值，含初始配置和双向更新', () => {
    expect(() => new ProxyServer({ adminApiKey: ADMIN_KEY, apiKey: ADMIN_KEY })).toThrow(
      'Invalid admin API key configuration'
    )
    expect(
      () =>
        new ProxyServer({
          adminApiKey: ADMIN_KEY,
          apiKeys: [makeApiKey({ key: ADMIN_KEY, enabled: false })]
        })
    ).toThrow('Invalid admin API key configuration')

    server.updateConfig({ apiKeys: [makeApiKey({ key: USER_KEY })] })
    expect(() => server.updateConfig({ adminApiKey: USER_KEY })).toThrow(
      'Invalid admin API key configuration'
    )
    server.updateConfig({ adminApiKey: ADMIN_KEY })
    expect(() => server.updateConfig({ apiKeys: [makeApiKey({ key: ADMIN_KEY })] })).toThrow(
      'Invalid admin API key configuration'
    )
  })

  it('失败的普通密钥候选不会污染运行配置或获得业务访问', async () => {
    server.updateConfig({ adminApiKey: ADMIN_KEY, apiKeys: [makeApiKey({ key: USER_KEY })] })
    const before = server.getConfig().apiKeys
    const failedCandidate = [
      ...(server.getConfig().apiKeys || []),
      makeApiKey({ id: 'candidate', key: ADMIN_KEY })
    ]

    expect(() => server.updateConfig({ apiKeys: failedCandidate })).toThrow(
      'Invalid admin API key configuration'
    )
    expect(server.getConfig().apiKeys).toEqual(before)
    expect((await request('/api/event_logging/batch', ADMIN_KEY, 'POST')).status).toBe(401)
    expect((await request('/api/event_logging/batch', USER_KEY, 'POST')).status).toBe(200)
  })

  it('通用配置剥离 adminApiKey', () => {
    const publicConfig = stripAdminApiKey({ port: 5580, adminApiKey: ADMIN_KEY })
    expect(publicConfig).toEqual({ port: 5580 })
    expect('adminApiKey' in publicConfig).toBe(false)
  })
})
