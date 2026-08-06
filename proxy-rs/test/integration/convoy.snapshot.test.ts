// 快照构建与原子替换：契约校验、内容哈希、脱敏视图、旧响应不覆盖新响应

import { describe, expect, it } from 'vitest'
import {
  ConvoySnapshotStore,
  SnapshotContractError,
  buildSnapshot,
  toSnapshotView,
  usableCredentials
} from '../../src/main/convoy/snapshot'
import { CONVOY_CREDENTIAL_STATUS } from '../../src/shared/convoyCredentials'
import type { ConvoyCredentialsResponse, RawConvoyCredentialItem } from '../../src/main/convoy/client'

const FETCHED_AT = 1_800_000_000_000

function item(overrides: Partial<RawConvoyCredentialItem> = {}): RawConvoyCredentialItem {
  return {
    credentialId: '9',
    status: 'active',
    newlyCharged: false,
    chargedCents: 0,
    aliveSecs: 600,
    credential: { type: 'api_key', apiKey: 'ksk_abcdef123456' },
    ...overrides
  }
}

function response(
  items: RawConvoyCredentialItem[],
  overrides: Partial<ConvoyCredentialsResponse> = {}
): ConvoyCredentialsResponse {
  return {
    autoConvoyId: '42',
    autoConvoyTitle: '示例自动车',
    credentials: items,
    newlyChargedCount: 0,
    totalChargedCents: 0,
    balanceAfterCents: 9700,
    insufficientCount: 0,
    ...overrides
  }
}

describe('快照构建', () => {
  it('同一轮返回的多个凭证全部进入同一快照', () => {
    const { snapshot } = buildSnapshot(
      response([
        item({ credentialId: '1', credential: { type: 'api_key', apiKey: 'ksk_key1abc' } }),
        item({ credentialId: '2', credential: { type: 'api_key', apiKey: 'ksk_key2abc' } }),
        item({ credentialId: '3', credential: { type: 'api_key', apiKey: 'ksk_key3abc' } })
      ]),
      FETCHED_AT
    )

    expect(snapshot.credentials).toHaveLength(3)
    expect(usableCredentials(snapshot, FETCHED_AT)).toHaveLength(3)
    expect(new Set(snapshot.credentials.map((c) => c.id)).size).toBe(3)
  })

  it('按 aliveSecs 推算过期时间', () => {
    const { snapshot } = buildSnapshot(response([item({ aliveSecs: 120 })]), FETCHED_AT)
    expect(snapshot.credentials[0].expiresAt).toBe(FETCHED_AT + 120_000)
  })

  it('credential=null 标为 unavailable 且不进可分配池', () => {
    const { snapshot, rejected } = buildSnapshot(
      response([item({ credentialId: '1', credential: null, status: 'expired' })]),
      FETCHED_AT
    )
    expect(snapshot.credentials[0].status).toBe(CONVOY_CREDENTIAL_STATUS.UNAVAILABLE)
    expect(usableCredentials(snapshot, FETCHED_AT)).toHaveLength(0)
    expect(rejected[0].reason).toContain('未提供明文')
  })

  it('非 active 状态即便有明文也不进可分配池', () => {
    const { snapshot, rejected } = buildSnapshot(
      response([item({ status: 'suspended' })]),
      FETCHED_AT
    )
    expect(snapshot.credentials[0].status).toBe(CONVOY_CREDENTIAL_STATUS.UNAVAILABLE)
    expect(usableCredentials(snapshot, FETCHED_AT)).toHaveLength(0)
    expect(rejected[0].reason).toContain('suspended')
  })

  it('亚秒级 aliveSecs 视为已过期，负值视为不设过期', () => {
    // 0.4s 向下取整为 0 → expiresAt 等于拉取时刻，即刻判定过期
    const subSecond = buildSnapshot(response([item({ aliveSecs: 0.4 })]), FETCHED_AT)
    expect(subSecond.snapshot.credentials[0].expiresAt).toBe(FETCHED_AT)
    expect(subSecond.snapshot.credentials[0].status).toBe(CONVOY_CREDENTIAL_STATUS.EXPIRED)
    expect(subSecond.rejected[0].reason).toContain('过期')

    // 负值语义不明，按「不设过期」处理，不能凭它把有效凭证判死
    const negative = buildSnapshot(response([item({ aliveSecs: -10 })]), FETCHED_AT)
    expect(negative.snapshot.credentials[0].expiresAt).toBeUndefined()
    expect(negative.snapshot.credentials[0].status).toBe(CONVOY_CREDENTIAL_STATUS.ACTIVE)
    expect(negative.rejected).toHaveLength(0)
  })

  it('过期条目在稍后时刻不再可分配', () => {
    const { snapshot } = buildSnapshot(response([item({ aliveSecs: 60 })]), FETCHED_AT)
    expect(usableCredentials(snapshot, FETCHED_AT + 59_000)).toHaveLength(1)
    expect(usableCredentials(snapshot, FETCHED_AT + 60_000)).toHaveLength(0)
  })

  it('缺 type 但带 apiKey 时按 api_key 推断', () => {
    const { snapshot } = buildSnapshot(
      response([item({ credential: { apiKey: 'ksk_infer123' } })]),
      FETCHED_AT
    )
    expect(snapshot.credentials[0].type).toBe('api_key')
    expect(snapshot.credentials[0].apiKey).toBe('ksk_infer123')
  })

  it('oauth 凭证提取 accessToken', () => {
    const { snapshot } = buildSnapshot(
      response([item({ credential: { type: 'oauth', accessToken: 'oauth-token-value' } })]),
      FETCHED_AT
    )
    expect(snapshot.credentials[0].type).toBe('oauth')
    expect(snapshot.credentials[0].accessToken).toBe('oauth-token-value')
  })

  it('从 payload 读取合法区域，非法区域当作未提供', () => {
    const valid = buildSnapshot(
      response([item({ credential: { type: 'api_key', apiKey: 'ksk_a1', region: 'EU-CENTRAL-1' } })]),
      FETCHED_AT
    )
    expect(valid.snapshot.credentials[0].region).toBe('eu-central-1')

    const invalid = buildSnapshot(
      response([item({ credential: { type: 'api_key', apiKey: 'ksk_a1', region: 'US_EAST_1' } })]),
      FETCHED_AT
    )
    expect(invalid.snapshot.credentials[0].region).toBeUndefined()
  })

  it('合法空列表得到空快照', () => {
    const { snapshot } = buildSnapshot(response([]), FETCHED_AT)
    expect(snapshot.credentials).toEqual([])
    expect(usableCredentials(snapshot, FETCHED_AT)).toEqual([])
  })
})

describe('契约违规整体拒绝', () => {
  it('不认识的凭证类型', () => {
    expect(() =>
      buildSnapshot(response([item({ credential: { type: 'magic', value: 'x' } })]), FETCHED_AT)
    ).toThrow(SnapshotContractError)
  })

  it('声明 api_key 但缺 key 字段', () => {
    expect(() =>
      buildSnapshot(response([item({ credential: { type: 'api_key' } })]), FETCHED_AT)
    ).toThrow(/缺少 key/)
  })

  it('API Key 格式非法', () => {
    expect(() =>
      buildSnapshot(
        response([item({ credential: { type: 'api_key', apiKey: 'not-a-kiro-key' } })]),
        FETCHED_AT
      )
    ).toThrow(/格式非法/)
  })

  it('声明 oauth 但缺 accessToken', () => {
    expect(() =>
      buildSnapshot(response([item({ credential: { type: 'oauth' } })]), FETCHED_AT)
    ).toThrow(/缺少 accessToken/)
  })
})

describe('内容哈希与版本', () => {
  it('同内容得到同版本，键顺序变化不影响', () => {
    const a = buildSnapshot(
      response([item({ credential: { type: 'api_key', apiKey: 'ksk_stable1' } })]),
      FETCHED_AT
    ).snapshot
    const b = buildSnapshot(
      response([item({ credential: { apiKey: 'ksk_stable1', type: 'api_key' } })]),
      FETCHED_AT + 5_000
    ).snapshot
    expect(a.version).toBe(b.version)
  })

  it('计费字段变化不影响版本：否则 version 永不重复', () => {
    const a = buildSnapshot(response([item()], { totalChargedCents: 0 }), FETCHED_AT).snapshot
    const b = buildSnapshot(
      response([item()], { totalChargedCents: 500, newlyChargedCount: 2 }),
      FETCHED_AT
    ).snapshot
    expect(a.version).toBe(b.version)
  })

  it('同 ID 内容变化会得到新版本', () => {
    const a = buildSnapshot(
      response([item({ credential: { type: 'api_key', apiKey: 'ksk_old111' } })]),
      FETCHED_AT
    ).snapshot
    const b = buildSnapshot(
      response([item({ credential: { type: 'api_key', apiKey: 'ksk_new222' } })]),
      FETCHED_AT
    ).snapshot
    expect(a.version).not.toBe(b.version)
    expect(a.credentials[0].contentHash).not.toBe(b.credentials[0].contentHash)
  })

  it('条目状态变化会得到新版本', () => {
    const a = buildSnapshot(response([item({ status: 'active' })]), FETCHED_AT).snapshot
    const b = buildSnapshot(response([item({ status: 'expired' })]), FETCHED_AT).snapshot
    expect(a.version).not.toBe(b.version)
  })
})

describe('脱敏视图', () => {
  it('只暴露尾 4 位，不含任何明文', () => {
    const { snapshot } = buildSnapshot(
      response([
        item({ credentialId: '1', credential: { type: 'api_key', apiKey: 'ksk_verysecret9999' } }),
        item({ credentialId: '2', credential: { type: 'oauth', accessToken: 'oauth-secret-8888' } })
      ]),
      FETCHED_AT
    )
    const view = toSnapshotView(snapshot, FETCHED_AT)!
    const serialized = JSON.stringify(view)

    expect(serialized).not.toContain('ksk_verysecret9999')
    expect(serialized).not.toContain('oauth-secret-8888')
    expect(view.credentials[0].maskedCredential).toBe('***9999')
    expect(view.credentials[1].maskedCredential).toBe('***8888')
    expect(view.versionShort).toHaveLength(8)
    expect(view.activeCount).toBe(2)
    expect(view.totalCount).toBe(2)
  })

  it('无快照时返回 null', () => {
    expect(toSnapshotView(null)).toBeNull()
  })
})

describe('原子快照存储', () => {
  it('版本变化才通知消费者', () => {
    const store = new ConvoySnapshotStore()
    const versions: (string | undefined)[] = []
    store.onSnapshotUpdated((snapshot) => versions.push(snapshot?.version))

    const first = buildSnapshot(response([item()]), FETCHED_AT).snapshot
    const sameContent = buildSnapshot(response([item()]), FETCHED_AT + 60_000).snapshot
    const changed = buildSnapshot(
      response([item({ credential: { type: 'api_key', apiKey: 'ksk_changed1' } })]),
      FETCHED_AT + 120_000
    ).snapshot

    expect(store.replaceSnapshot(first)).toBe(true)
    expect(store.replaceSnapshot(sameContent)).toBe(true)
    expect(store.replaceSnapshot(changed)).toBe(true)

    // 内容未变的那轮不通知，但快照本身（含计费字段）已更新
    expect(versions).toEqual([first.version, changed.version])
    expect(store.snapshot?.fetchedAt).toBe(FETCHED_AT + 120_000)
  })

  it('更旧的响应不能覆盖更新的快照', () => {
    const store = new ConvoySnapshotStore()
    const newer = buildSnapshot(response([item()]), FETCHED_AT + 60_000).snapshot
    const older = buildSnapshot(
      response([item({ credential: { type: 'api_key', apiKey: 'ksk_stale111' } })]),
      FETCHED_AT
    ).snapshot

    expect(store.replaceSnapshot(newer)).toBe(true)
    expect(store.replaceSnapshot(older)).toBe(false)
    expect(store.snapshot?.version).toBe(newer.version)
  })

  it('替换失败不破坏当前快照；clear 后回到空', () => {
    const store = new ConvoySnapshotStore()
    const current = buildSnapshot(response([item()]), FETCHED_AT).snapshot
    store.replaceSnapshot(current)

    // 模拟校验失败：调用方压根不会调 replaceSnapshot
    expect(() =>
      buildSnapshot(response([item({ credential: { type: 'magic' } })]), FETCHED_AT + 1000)
    ).toThrow(SnapshotContractError)
    expect(store.snapshot?.version).toBe(current.version)

    store.clear()
    expect(store.snapshot).toBeNull()
  })

  it('空快照替换会清空可分配池', () => {
    const store = new ConvoySnapshotStore()
    store.replaceSnapshot(buildSnapshot(response([item()]), FETCHED_AT).snapshot)
    expect(usableCredentials(store.snapshot, FETCHED_AT)).toHaveLength(1)

    store.replaceSnapshot(buildSnapshot(response([]), FETCHED_AT + 60_000).snapshot)
    expect(usableCredentials(store.snapshot, FETCHED_AT + 60_000)).toHaveLength(0)
  })

  it('监听器抛错不影响替换', () => {
    const store = new ConvoySnapshotStore()
    store.onSnapshotUpdated(() => {
      throw new Error('listener boom')
    })
    const snapshot = buildSnapshot(response([item()]), FETCHED_AT).snapshot
    expect(store.replaceSnapshot(snapshot)).toBe(true)
    expect(store.snapshot?.version).toBe(snapshot.version)
  })
})
