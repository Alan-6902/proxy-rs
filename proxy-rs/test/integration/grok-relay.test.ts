import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  connectStreamHasEndFrame,
  readRelayConfig,
  syncRelayToAccount
} from '../../src/main/grokAccounts/grokRelay'
import { deriveGrokOsCryptKey, encryptGrokSecret } from '../../src/main/grokAccounts/grokLocalState'

const DIR = mkdtempSync(join(tmpdir(), 'proxy-rs-grok-relay-'))
const DESCRIPTOR_PATH = join(DIR, 'gateway-descriptor.json')
const RELAY_PATH = join(DIR, 'grok-box-relay.json')
const KEY = deriveGrokOsCryptKey('relay-test-key')

function seedDescriptor(scope: string, connection: object, savedAtMs = Date.now()): void {
  const disk = {
    version: 2,
    entries: {
      [scope]: { savedAtMs, encrypted: encryptGrokSecret(JSON.stringify(connection), KEY) }
    }
  }
  writeFileSync(DESCRIPTOR_PATH, JSON.stringify(disk, null, 2))
}

beforeEach(() => {
  rmSync(DESCRIPTOR_PATH, { force: true })
  rmSync(RELAY_PATH, { force: true })
})

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true })
})

/** 拼一个 Connect 帧：flags(1) + length(4 BE) + payload。 */
function frame(flags: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(5)
  header[0] = flags
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}

describe('Connect 流结束帧识别', () => {
  it('单个 end-stream 帧（flags=0x02）判为有效', () => {
    expect(connectStreamHasEndFrame(frame(0x02, Buffer.from('{}')))).toBe(true)
  })

  it('数据帧后跟一个 end-stream 帧判为有效', () => {
    const body = Buffer.concat([frame(0x00, Buffer.from('data')), frame(0x02, Buffer.from('{}'))])
    expect(connectStreamHasEndFrame(body)).toBe(true)
  })

  it('只有数据帧、没有结束帧判为无效', () => {
    expect(connectStreamHasEndFrame(frame(0x00, Buffer.from('data')))).toBe(false)
  })

  it('空 body 判为无效（普通 200 页没有帧结构）', () => {
    expect(connectStreamHasEndFrame(Buffer.alloc(0))).toBe(false)
  })

  it('长度声明超出实际 body 判为无效（截断/非帧数据）', () => {
    const header = Buffer.alloc(5)
    header[0] = 0x02
    header.writeUInt32BE(100, 1) // 声明 100 字节但后面没有
    expect(connectStreamHasEndFrame(header)).toBe(false)
  })

  it('HTML 页面这类任意字节流判为无效', () => {
    expect(connectStreamHasEndFrame(Buffer.from('<!doctype html><html></html>'))).toBe(false)
  })
})

describe('relay 配置：从 descriptor 同步再读回', () => {
  const scope = 'a'.repeat(64)

  it('把 box 连接写进 relay 配置，字段与指纹正确', async () => {
    seedDescriptor(scope, {
      baseUrl: 'https://box-1.cursorvm.com/abc',
      token: 'box-token-xyz',
      headers: { 'x-anyrun-network-token': 'net-tok' },
      vncProxy: { primaryUrl: 'https://vnc' } // 多余字段应被忽略
    })
    await syncRelayToAccount(scope, {
      key: KEY,
      descriptorPath: DESCRIPTOR_PATH,
      relayConfigPath: RELAY_PATH
    })
    const config = readRelayConfig(RELAY_PATH)
    expect(config).not.toBeNull()
    expect(config!.baseUrl).toBe('https://box-1.cursorvm.com/abc')
    expect(config!.token).toBe('box-token-xyz')
    expect(config!.headers['x-anyrun-network-token']).toBe('net-tok')
    // accountFingerprint = sha256(scope) 前 16 位
    expect(config!.scope).toHaveLength(16)
  })

  it('目标号还没建 box（descriptor 无该 entry）时抛错', async () => {
    seedDescriptor('b'.repeat(64), { baseUrl: 'https://x', token: 't', headers: {} })
    await expect(
      syncRelayToAccount(scope, {
        key: KEY,
        descriptorPath: DESCRIPTOR_PATH,
        relayConfigPath: RELAY_PATH
      })
    ).rejects.toThrow()
  })

  it('box 连接过期（超 TTL）时抛错', async () => {
    seedDescriptor(
      scope,
      { baseUrl: 'https://x', token: 't', headers: {} },
      Date.now() - 10_081 * 60 * 1000
    )
    await expect(
      syncRelayToAccount(scope, {
        key: KEY,
        descriptorPath: DESCRIPTOR_PATH,
        relayConfigPath: RELAY_PATH
      })
    ).rejects.toThrow()
  })

  it('连接缺少 https baseUrl 时抛错', async () => {
    seedDescriptor(scope, { baseUrl: 'http://insecure', token: 't', headers: {} })
    await expect(
      syncRelayToAccount(scope, {
        key: KEY,
        descriptorPath: DESCRIPTOR_PATH,
        relayConfigPath: RELAY_PATH
      })
    ).rejects.toThrow()
  })

  it('relay 配置不存在时 readRelayConfig 返回 null', () => {
    expect(readRelayConfig(RELAY_PATH)).toBeNull()
  })
})
