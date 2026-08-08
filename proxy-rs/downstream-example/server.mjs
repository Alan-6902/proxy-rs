#!/usr/bin/env node
/**
 * KSK 抢号下游接口的参考实现。契约见 API.md。
 *
 * 零依赖，Node 内置 http 即可跑：
 *   DOWNSTREAM_API_KEY=your-secret node server.mjs
 *
 * 只监听 loopback。这两个接口一个能触发真实花钱、一个会收到可直接调用上游的凭据，
 * 不该暴露到局域网；要跨机器部署就在前面挂一层 HTTPS 反代。
 *
 * 存储是进程内的 Map，重启即丢——这是参考实现，生产环境换成数据库，
 * 并给 key 加唯一索引来保证幂等。
 */

import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

const HOST = process.env.DOWNSTREAM_HOST ?? '127.0.0.1'
const PORT = Number(process.env.DOWNSTREAM_PORT ?? 12889)
const API_KEY = process.env.DOWNSTREAM_API_KEY ?? ''

/** base 路径前缀，对应 UI 里配 http://127.0.0.1:12889/hooks 的情况。 */
const BASE_PATH = (process.env.DOWNSTREAM_BASE_PATH ?? '').replace(/\/+$/, '')

/** 请求体大小上限：这两个接口的体都是几十字节，给 8KB 足够且能挡住垃圾请求。 */
const MAX_BODY_BYTES = 8 * 1024

const AUTH_HEADER = 'x-api-key'

/** 与抢号器侧 shared/kiroApiKey.ts 的校验规则保持一致。 */
const KSK_PATTERN = /^ksk_[A-Za-z0-9]+$/
const REGION_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)+$/

/**
 * 需求水位：还想收多少个号。
 *
 * 真实场景下这里应该是你自己的业务信号（池子里可用账号数低于阈值等）。
 * 参考实现用一个可通过 /admin/demand 调整的计数器，方便联调时手动开关。
 */
let wantedCount = Number(process.env.DOWNSTREAM_WANTED ?? 1)

/** 已接收的号，按 key 去重。value 记录首次接收时间，便于观察重试是否被正确幂等。 */
const receivedByKey = new Map()

/** 展示用脱敏，日志里不留 key 明文。 */
function maskKey(key) {
  return key.length > 12 ? `${key.slice(0, 4)}...${key.slice(-4)}` : `${key.slice(0, 4)}...`
}

function log(message) {
  console.log(`[downstream ${new Date().toISOString()}] ${message}`)
}

/** 定长比较，避免用 === 泄漏 Key 前缀信息。 */
function isAuthorized(req) {
  const provided = req.headers[AUTH_HEADER]
  if (typeof provided !== 'string' || !API_KEY) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(API_KEY)
  // timingSafeEqual 要求等长，长度不同直接判负（长度本身不是秘密）
  return a.length === b.length && timingSafeEqual(a, b)
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

/** 读 JSON 请求体；超限直接断开，避免被无界 body 打爆内存。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * GET /need-account —— 问现在要不要号。
 *
 * 必须快且无副作用：抢号器每 3 秒可能问一次，且问了不一定会真的收到号
 * （可能被别人抢先或下单失败），所以这里绝不能预扣库存。
 */
function handleNeedAccount(res) {
  const need = wantedCount > 0
  log(`need-account → ${need}（还想要 ${wantedCount} 个）`)
  sendJson(res, 200, { need })
}

/**
 * POST /ksk —— 接收抢到的号。
 *
 * 按 key 幂等：重试可能把同一个 key 推多次（典型是我们落库成功但响应丢在网络上），
 * 重复推送必须回 ok:true 而不是报错，否则抢号器会一直重试到耗尽。
 */
async function handlePushKsk(req, res) {
  let payload
  try {
    payload = await readJsonBody(req)
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message })
    return
  }

  const key = typeof payload.key === 'string' ? payload.key.trim() : ''
  const region = typeof payload.region === 'string' ? payload.region.trim() : ''

  if (!KSK_PATTERN.test(key)) {
    // 错误信息里不回显 key，避免它进到对方日志
    log('拒绝一条 key 格式非法的推送')
    sendJson(res, 400, { ok: false, error: 'key 不是合法的 ksk_ 密钥' })
    return
  }
  if (!REGION_PATTERN.test(region)) {
    log(`拒绝 ${maskKey(key)}：region 非法`)
    sendJson(res, 400, { ok: false, error: 'region 不是合法的 AWS 区域' })
    return
  }

  const existing = receivedByKey.get(key)
  if (existing) {
    // 幂等命中：不重复落库、不扣需求水位，照样回 ok
    log(`${maskKey(key)} 已接收过（${existing.region}），幂等返回 ok`)
    sendJson(res, 200, { ok: true, duplicate: true })
    return
  }

  // 真实实现在这里落库。落库失败必须回 ok:false 或抛错，让抢号器重试，
  // 绝不能先回 ok 再异步写库——那样写失败就静默丢号了。
  receivedByKey.set(key, { region, receivedAt: Date.now() })
  if (wantedCount > 0) wantedCount--

  log(`已接收 ${maskKey(key)}（${region}），剩余需求 ${wantedCount}`)
  sendJson(res, 200, { ok: true })
}

/** 联调辅助：手动调需求水位，方便验证 need:false 时抢号器不下单。 */
async function handleSetDemand(req, res) {
  let payload
  try {
    payload = await readJsonBody(req)
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message })
    return
  }
  const wanted = Number(payload.wanted)
  if (!Number.isFinite(wanted) || wanted < 0) {
    sendJson(res, 400, { ok: false, error: 'wanted 必须是非负数字' })
    return
  }
  wantedCount = Math.floor(wanted)
  log(`需求水位改为 ${wantedCount}`)
  sendJson(res, 200, { ok: true, wanted: wantedCount })
}

/** 联调辅助：看已收到哪些号（脱敏）。 */
function handleListReceived(res) {
  sendJson(res, 200, {
    wanted: wantedCount,
    received: [...receivedByKey.entries()].map(([key, value]) => ({
      maskedKey: maskKey(key),
      region: value.region,
      receivedAt: value.receivedAt
    }))
  })
}

const server = createServer((req, res) => {
  // 只取 pathname，忽略 query
  const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname
  const route =
    BASE_PATH && pathname.startsWith(BASE_PATH) ? pathname.slice(BASE_PATH.length) : pathname
  const normalized = route.replace(/\/+$/, '') || '/'

  if (!isAuthorized(req)) {
    log(`拒绝未授权请求 ${req.method} ${normalized}`)
    sendJson(res, 401, { ok: false, error: 'x-api-key 缺失或不匹配' })
    return
  }

  if (req.method === 'GET' && normalized === '/need-account') {
    handleNeedAccount(res)
    return
  }
  if (req.method === 'POST' && normalized === '/ksk') {
    void handlePushKsk(req, res)
    return
  }
  // 以下两个不属于契约，仅供联调
  if (req.method === 'POST' && normalized === '/admin/demand') {
    void handleSetDemand(req, res)
    return
  }
  if (req.method === 'GET' && normalized === '/admin/received') {
    handleListReceived(res)
    return
  }

  sendJson(res, 404, { ok: false, error: `未知路由 ${req.method} ${normalized}` })
})

/** 供自测脚本以模块方式起停，不必开子进程。 */
export function startDownstreamServer({ port = PORT, host = HOST } = {}) {
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server))
  })
}

export function resetDownstreamState({ wanted = 1 } = {}) {
  receivedByKey.clear()
  wantedCount = wanted
}

// 直接 node server.mjs 启动时才自动监听；被 import 时交给调用方决定
const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())
if (isDirectRun) {
  if (!API_KEY) {
    console.error('必须设置 DOWNSTREAM_API_KEY，否则所有请求都会被拒。')
    console.error('例如：DOWNSTREAM_API_KEY=your-secret node server.mjs')
    process.exit(1)
  }
  void startDownstreamServer().then(() => {
    log(`监听 http://${HOST}:${PORT}${BASE_PATH}`)
    log(`把这个地址填进抢号监控页的「下游地址」，Key 填 DOWNSTREAM_API_KEY 的值`)
    log(`当前需求水位 ${wantedCount}；改水位：POST ${BASE_PATH}/admin/demand {"wanted":N}`)
  })
}
