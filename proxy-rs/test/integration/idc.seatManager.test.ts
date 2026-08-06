// 席位编排测试：幂等性、部分失败隔离、并发上限、取消
//
// awsClient 全部 mock —— 这层的价值在于「AWS 返回什么时我们怎么记账」，
// 不需要真实网络。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AwsApiError } from '../../src/main/idc/awsClient'
import {
  KIRO_TIER,
  type KiroTier,
  type PlannedSeat,
  type ResolvedCredentials
} from '../../src/main/idc/types'

const mocks = vi.hoisted(() => ({
  listInstances: vi.fn(),
  listAllUsers: vi.fn(),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  createAssignment: vi.fn(),
  updateAssignment: vi.fn(),
  deleteAssignment: vi.fn(),
  listUserSubscriptions: vi.fn()
}))

vi.mock('../../src/main/idc/awsClient', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/idc/awsClient')>(
    '../../src/main/idc/awsClient'
  )
  return { ...actual, ...mocks }
})

const { changeTiers, deleteSeats, fetchSeatInventory, provisionSeats, unsubscribeSeats } =
  await import('../../src/main/idc/seatManager')

const CREDS: ResolvedCredentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret',
  region: 'us-east-1'
}

const INSTANCE = { identityStoreId: 'd-1234567890', instanceArn: 'arn:aws:sso:::instance/ssoins-1' }

function seat(seq: string, email: string, tier: KiroTier = KIRO_TIER.PRO): PlannedSeat {
  return {
    rowId: `row-${seq}`,
    seq,
    tier,
    email,
    username: email,
    givenName: 'John',
    familyName: 'Smith',
    displayName: 'John Smith'
  }
}

const conflict = (): AwsApiError =>
  new AwsApiError('already exists', 'ConflictException', 400, 'CreateUser')
const notFound = (target: string): AwsApiError =>
  new AwsApiError('not found', 'ResourceNotFoundException', 400, target)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listInstances.mockResolvedValue(INSTANCE)
  mocks.listAllUsers.mockResolvedValue([])
  mocks.createUser.mockImplementation(
    async (_c, _s, u: { username: string }) => `uid-${u.username}`
  )
  mocks.sendPasswordResetEmail.mockResolvedValue(undefined)
  mocks.createAssignment.mockResolvedValue(undefined)
  mocks.updateAssignment.mockResolvedValue(undefined)
  mocks.deleteAssignment.mockResolvedValue(undefined)
  mocks.deleteUser.mockResolvedValue(undefined)
  mocks.listUserSubscriptions.mockResolvedValue([])
})

describe('provisionSeats', () => {
  it('runs create → email → subscribe for every seat', async () => {
    const seats = [
      seat('pro-001', 'a@example.com'),
      seat('power-001', 'b@example.com', KIRO_TIER.POWER)
    ]

    const summary = await provisionSeats({ credentials: CREDS, seats, sendPasswordEmail: true })

    expect(summary.usersCreated).toBe(2)
    expect(summary.emailsSent).toBe(2)
    expect(summary.subscribed).toBe(2)
    expect(summary.usersFailed).toBe(0)
    // 档位映射：Pro 与 Power 各自发出对应 subscriptionType
    expect(mocks.createAssignment).toHaveBeenCalledWith(
      CREDS,
      'uid-a@example.com',
      'Q_DEVELOPER_STANDALONE_PRO'
    )
    expect(mocks.createAssignment).toHaveBeenCalledWith(
      CREDS,
      'uid-b@example.com',
      'Q_DEVELOPER_STANDALONE_POWER'
    )
  })

  it('skips password email when disabled', async () => {
    await provisionSeats({
      credentials: CREDS,
      seats: [seat('pro-001', 'a@example.com')],
      sendPasswordEmail: false
    })
    expect(mocks.sendPasswordResetEmail).not.toHaveBeenCalled()
  })

  it('treats an existing user as skipped and still subscribes it', async () => {
    mocks.listAllUsers.mockResolvedValue([
      {
        userId: 'existing-uid',
        username: 'a@example.com',
        email: 'a@example.com',
        displayName: 'A'
      }
    ])
    mocks.createUser.mockRejectedValueOnce(conflict())

    const summary = await provisionSeats({
      credentials: CREDS,
      seats: [seat('pro-001', 'a@example.com')],
      sendPasswordEmail: false
    })

    expect(summary.usersCreated).toBe(0)
    expect(summary.usersSkipped).toBe(1)
    expect(summary.usersFailed).toBe(0)
    // 复用已有 UserId 继续挂订阅，这是幂等重跑的关键
    expect(mocks.createAssignment).toHaveBeenCalledWith(
      CREDS,
      'existing-uid',
      'Q_DEVELOPER_STANDALONE_PRO'
    )
    expect(summary.subscribed).toBe(1)
  })

  it('reports a conflict without a resolvable UserId instead of subscribing blindly', async () => {
    mocks.listAllUsers.mockResolvedValue([])
    mocks.createUser.mockRejectedValueOnce(conflict())

    const summary = await provisionSeats({
      credentials: CREDS,
      seats: [seat('pro-001', 'a@example.com')],
      sendPasswordEmail: true
    })

    expect(summary.usersSkipped).toBe(1)
    expect(summary.results[0].error).toMatch(/UserId/)
    expect(mocks.createAssignment).not.toHaveBeenCalled()
    expect(mocks.sendPasswordResetEmail).not.toHaveBeenCalled()
  })

  it('counts an already-subscribed user as skipped, not failed', async () => {
    mocks.createAssignment.mockRejectedValueOnce(conflict())
    const summary = await provisionSeats({
      credentials: CREDS,
      seats: [seat('pro-001', 'a@example.com')],
      sendPasswordEmail: false
    })
    expect(summary.subscribeSkipped).toBe(1)
    expect(summary.subscribeFailed).toBe(0)
  })

  it('still subscribes when the password email fails', async () => {
    mocks.sendPasswordResetEmail.mockRejectedValueOnce(new Error('smtp down'))
    const summary = await provisionSeats({
      credentials: CREDS,
      seats: [seat('pro-001', 'a@example.com')],
      sendPasswordEmail: true
    })
    expect(summary.emailsFailed).toBe(1)
    expect(summary.subscribed).toBe(1)
    expect(summary.results[0].error).toMatch(/密码邮件/)
  })

  it('isolates a failing seat from the rest of the batch', async () => {
    mocks.createUser
      .mockImplementationOnce(async () => 'uid-1')
      .mockRejectedValueOnce(
        new AwsApiError('quota', 'ServiceQuotaExceededException', 400, 'CreateUser')
      )
      .mockImplementationOnce(async () => 'uid-3')

    const summary = await provisionSeats({
      credentials: CREDS,
      seats: [
        seat('pro-001', 'a@example.com'),
        seat('pro-002', 'b@example.com'),
        seat('pro-003', 'c@example.com')
      ],
      sendPasswordEmail: false,
      concurrency: 1
    })

    expect(summary.usersCreated).toBe(2)
    expect(summary.usersFailed).toBe(1)
    expect(summary.results[1].error).toMatch(/ServiceQuotaExceededException/)
    // 失败的那个不该继续挂订阅
    expect(summary.results[1].subscribe).toBe('not-attempted')
  })

  it('proceeds when listing existing users fails', async () => {
    mocks.listAllUsers.mockRejectedValue(new Error('AccessDenied on ListUsers'))
    const summary = await provisionSeats({
      credentials: CREDS,
      seats: [seat('pro-001', 'a@example.com')],
      sendPasswordEmail: false
    })
    expect(summary.usersCreated).toBe(1)
  })

  it('respects the concurrency ceiling', async () => {
    let inFlight = 0
    let peak = 0
    mocks.createUser.mockImplementation(async (_c, _s, u: { username: string }) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return `uid-${u.username}`
    })

    const seats = Array.from({ length: 12 }, (_, i) => seat(`pro-${i}`, `u${i}@example.com`))
    await provisionSeats({ credentials: CREDS, seats, sendPasswordEmail: false, concurrency: 3 })

    expect(peak).toBeLessThanOrEqual(3)
  })

  it('stops creating users once aborted', async () => {
    const controller = new AbortController()
    mocks.createUser.mockImplementation(async (_c, _s, u: { username: string }) => {
      controller.abort()
      return `uid-${u.username}`
    })

    const seats = Array.from({ length: 5 }, (_, i) => seat(`pro-${i}`, `u${i}@example.com`))
    const summary = await provisionSeats({
      credentials: CREDS,
      seats,
      sendPasswordEmail: false,
      concurrency: 1,
      signal: controller.signal
    })

    expect(summary.aborted).toBe(true)
    expect(mocks.createUser.mock.calls.length).toBeLessThan(seats.length)
  })

  it('emits progress events with a running count', async () => {
    const events: { done?: number; total?: number; kind: string }[] = []
    await provisionSeats({
      credentials: CREDS,
      seats: [seat('pro-001', 'a@example.com'), seat('pro-002', 'b@example.com')],
      sendPasswordEmail: false,
      concurrency: 1,
      onProgress: (e) => events.push(e)
    })

    const seatDone = events.filter((e) => e.kind === 'seat-done')
    expect(seatDone.map((e) => e.done)).toEqual([1, 2])
    expect(seatDone.every((e) => e.total === 2)).toBe(true)
  })
})

describe('fetchSeatInventory', () => {
  it('joins users with subscriptions and classifies the leftovers', async () => {
    mocks.listAllUsers.mockResolvedValue([
      { userId: 'u1', username: 'a@example.com', email: 'a@example.com', displayName: 'A' },
      { userId: 'u2', username: 'b@example.com', email: 'b@example.com', displayName: 'B' }
    ])
    mocks.listUserSubscriptions.mockResolvedValue([
      {
        userId: 'u1',
        subscriptionType: 'KIRO_ENTERPRISE_POWER',
        status: 'ACTIVE',
        activationDate: '2026-01-01'
      },
      {
        userId: 'ghost',
        subscriptionType: 'KIRO_ENTERPRISE_PRO',
        status: 'ACTIVE',
        activationDate: '2026-01-02'
      }
    ])

    const inventory = await fetchSeatInventory(CREDS)

    expect(inventory.seats).toHaveLength(1)
    expect(inventory.seats[0].tier).toBe(KIRO_TIER.POWER)
    // 订阅存在但用户查不到 → 孤儿记录，单独列出便于排查
    expect(inventory.orphanSubscriptions).toEqual(['ghost'])
    // 建了号但没挂订阅 → 不计费，可补挂
    expect(inventory.unsubscribedUsers.map((u) => u.userId)).toEqual(['u2'])
  })

  it('keeps the raw subscription type when the tier mapping is unknown', async () => {
    mocks.listAllUsers.mockResolvedValue([
      { userId: 'u1', username: 'a@example.com', email: 'a@example.com', displayName: 'A' }
    ])
    mocks.listUserSubscriptions.mockResolvedValue([
      {
        userId: 'u1',
        subscriptionType: 'KIRO_ENTERPRISE_ULTRA',
        status: 'ACTIVE',
        activationDate: ''
      }
    ])

    const inventory = await fetchSeatInventory(CREDS)
    expect(inventory.seats[0].tier).toBeUndefined()
    expect(inventory.seats[0].rawSubscriptionType).toBe('KIRO_ENTERPRISE_ULTRA')
  })

  it('reads both KIRO_ENTERPRISE_* and Q_DEVELOPER_STANDALONE_* prefixes', async () => {
    mocks.listAllUsers.mockResolvedValue([
      { userId: 'u1', username: 'a@example.com', email: 'a@example.com', displayName: 'A' },
      { userId: 'u2', username: 'b@example.com', email: 'b@example.com', displayName: 'B' }
    ])
    mocks.listUserSubscriptions.mockResolvedValue([
      {
        userId: 'u1',
        subscriptionType: 'KIRO_ENTERPRISE_PRO_PLUS',
        status: 'ACTIVE',
        activationDate: ''
      },
      {
        userId: 'u2',
        subscriptionType: 'Q_DEVELOPER_STANDALONE_PRO_PLUS',
        status: 'ACTIVE',
        activationDate: ''
      }
    ])

    const inventory = await fetchSeatInventory(CREDS)
    expect(inventory.seats.map((s) => s.tier)).toEqual([KIRO_TIER.PRO_PLUS, KIRO_TIER.PRO_PLUS])
  })
})

describe('changeTiers', () => {
  it('updates in place', async () => {
    const results = await changeTiers({
      credentials: CREDS,
      targets: [{ userId: 'u1', username: 'a@example.com' }],
      tier: KIRO_TIER.POWER
    })
    expect(results[0].status).toBe('ok')
    expect(mocks.updateAssignment).toHaveBeenCalledWith(CREDS, 'u1', 'Q_DEVELOPER_STANDALONE_POWER')
    expect(mocks.createAssignment).not.toHaveBeenCalled()
  })

  it('falls back to create when there is no existing assignment', async () => {
    mocks.updateAssignment.mockRejectedValueOnce(notFound('UpdateAssignment'))
    const results = await changeTiers({
      credentials: CREDS,
      targets: [{ userId: 'u1', username: 'a@example.com' }],
      tier: KIRO_TIER.PRO
    })
    expect(results[0].status).toBe('ok')
    expect(mocks.createAssignment).toHaveBeenCalledWith(CREDS, 'u1', 'Q_DEVELOPER_STANDALONE_PRO')
  })

  it('surfaces non-recoverable errors', async () => {
    mocks.updateAssignment.mockRejectedValueOnce(
      new AwsApiError('denied', 'AccessDeniedException', 400, 'UpdateAssignment')
    )
    const results = await changeTiers({
      credentials: CREDS,
      targets: [{ userId: 'u1', username: 'a@example.com' }],
      tier: KIRO_TIER.PRO
    })
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toMatch(/AccessDeniedException/)
  })
})

describe('unsubscribeSeats', () => {
  it('treats a missing assignment as already unsubscribed', async () => {
    mocks.deleteAssignment.mockRejectedValueOnce(notFound('DeleteAssignment'))
    const results = await unsubscribeSeats({
      credentials: CREDS,
      targets: [{ userId: 'u1', username: 'a@example.com' }]
    })
    expect(results[0].status).toBe('skipped')
  })
})

describe('deleteSeats', () => {
  it('cancels the subscription before deleting the user', async () => {
    const order: string[] = []
    mocks.deleteAssignment.mockImplementation(async () => {
      order.push('deleteAssignment')
    })
    mocks.deleteUser.mockImplementation(async () => {
      order.push('deleteUser')
    })

    const results = await deleteSeats({
      credentials: CREDS,
      identityStoreId: INSTANCE.identityStoreId,
      targets: [{ userId: 'u1', username: 'a@example.com' }]
    })

    expect(results[0].status).toBe('ok')
    expect(order).toEqual(['deleteAssignment', 'deleteUser'])
  })

  it('deletes the user even when cancelling the subscription fails', async () => {
    mocks.deleteAssignment.mockRejectedValueOnce(new Error('boom'))
    const results = await deleteSeats({
      credentials: CREDS,
      identityStoreId: INSTANCE.identityStoreId,
      targets: [{ userId: 'u1', username: 'a@example.com' }]
    })
    expect(results[0].status).toBe('ok')
    expect(mocks.deleteUser).toHaveBeenCalled()
  })
})
