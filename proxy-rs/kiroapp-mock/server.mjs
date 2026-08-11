#!/usr/bin/env node
/**
 * KiroApp（kiroapp.io）渠道的本地 mock 上游。
 *
 * 用途：不真花钱就把「查列表 → 下单 → 验活 → 推送下游」整条链路跑通。
 *
 * 为什么要 HTTPS：hunterRunner 的 fetchJson 硬约束商品站点必须 https（明文地址直接
 * 拒绝，不放行 loopback 例外）。所以这里自签一张证书，起 TLS 服务。
 *
 *   node kiroapp-mock/server.mjs
 *
 * 首次运行会用 openssl 在 kiroapp-mock/.cert/ 下生成自签证书（已 gitignore）。
 * 因为是自签，主进程侧要跑通得让 Node 放行该证书，启动脚本会打印具体做法。
 *
 * 契约来自登录后的官方 /api-docs：
 * - GET /api/me/stock：X-API-Key 鉴权，返回库存、价格与余额；
 * - POST /api/me/purchase：X-API-Key 鉴权，body 为
 *   {count, region, client_order_id}，client_order_id 提供幂等语义。
 */

import { createServer } from 'node:https'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CERT_DIR = join(HERE, '.cert')
const KEY_PATH = join(CERT_DIR, 'mock-key.pem')
const CERT_PATH = join(CERT_DIR, 'mock-cert.pem')

const HOST = process.env.KIROAPP_MOCK_HOST ?? '127.0.0.1'
const PORT = Number(process.env.KIROAPP_MOCK_PORT ?? 12890)

/** 官方 API 令牌使用 km_ 前缀，通过 X-API-Key 请求头发送。 */
const TOKEN = process.env.KIROAPP_MOCK_TOKEN ?? 'km_mock_token'

/** 请求体上限：下单体只有几十字节，8KB 足够且能挡住垃圾请求。 */
const MAX_BODY_BYTES = 8 * 1024

/**
 * 可变的库存与价格，联调时通过 /admin/stock 改。
 *
 * 初始给 eu 有货：这样启动后第一轮就能走通下单，不用等人手动放货。
 */
const state = {
  stock_eu: Number(process.env.KIROAPP_MOCK_STOCK_EU ?? 1),
  stock_us: Number(process.env.KIROAPP_MOCK_STOCK_US ?? 0),
  price_eu: Number(process.env.KIROAPP_MOCK_PRICE_EU ?? 30),
  price_us: Number(process.env.KIROAPP_MOCK_PRICE_US ?? 50),
  /** 已卖出的号，仅用于联调时回看。key 只存脱敏形式。 */
  sold: []
}

const ZONE_TO_REGION = { eu: 'eu-central-1', us: 'us-east-1' }
const REGION_TO_ZONE = { eu: 'eu', 'eu-central-1': 'eu', us: 'us', 'us-east-1': 'us' }
const ordersByClientOrderId = new Map()

function log(message) {
  console.log(`[kiroapp-mock ${new Date().toISOString()}] ${message}`)
}

function maskKey(key) {
  return key.length > 12 ? `${key.slice(0, 4)}...${key.slice(-4)}` : `${key.slice(0, 4)}...`
}

/**
 * 造一个格式合法的假 ksk。
 *
 * 必须匹配 shared/kiroApiKey.ts 的 /^ksk_[A-Za-z0-9]+$/，否则会被
 * isUsableHunterCredential 判非法、走不到验活那一步。
 * 用 hex 而不是 base64：base64 有 +/= 会被正则拒掉。
 */
function mintFakeKsk() {
  return `ksk_${randomBytes(20).toString('hex')}`
}

function ensureCert() {
  if (existsSync(KEY_PATH) && existsSync(CERT_PATH)) return
  mkdirSync(CERT_DIR, { recursive: true })
  log('未找到自签证书，正在用 openssl 生成…')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '365',
      '-keyout',
      KEY_PATH,
      '-out',
      CERT_PATH,
      '-subj',
      '/CN=127.0.0.1',
      // SAN 必须带 IP，否则 Node 侧按主机名校验会直接失败
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost'
    ],
    { stdio: 'ignore' }
  )
  log(`证书已生成：${CERT_PATH}`)
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

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

/** GET /api/me/stock —— 官方库存响应的核心字段。 */
function handleStatus(res) {
  const prices = [state.price_eu, state.price_us]
  sendJson(res, 200, {
    stock: state.stock_eu + state.stock_us,
    price: Math.min(...prices),
    price_min: Math.min(...prices),
    price_max: Math.max(...prices),
    balance: 1000,
    stock_eu: state.stock_eu,
    stock_us: state.stock_us,
    // 兼容公开状态接口的区域价格；真实受保护接口可只返回 price。
    price_eu: state.price_eu,
    price_us: state.price_us
  })
}

/**
 * POST /api/me/purchase —— 按官方契约下单并返回一个假 ksk。
 */
async function handleOrder(req, res) {
  let payload
  try {
    payload = await readJsonBody(req)
  } catch (error) {
    sendJson(res, 400, { code: 1, msg: error.message })
    return
  }

  const count = Number(payload.count)
  const clientOrderId =
    typeof payload.client_order_id === 'string' ? payload.client_order_id.trim() : ''
  const requestedRegion = typeof payload.region === 'string' ? payload.region.trim() : ''
  const zone = REGION_TO_ZONE[requestedRegion]
  if (!/^[0-9a-f]{32}$/.test(clientOrderId)) {
    sendJson(res, 400, { error: 'client_order_id 必须是 32 位小写 hex' })
    return
  }
  if (!zone) {
    sendJson(res, 400, { error: `未知区域 region=${requestedRegion || '(空)'}` })
    return
  }

  const previousOrder = ordersByClientOrderId.get(clientOrderId)
  if (previousOrder) {
    if (previousOrder.count !== count || previousOrder.zone !== zone) {
      sendJson(res, 409, { error: 'client_order_id 已用于不同的下单参数' })
      return
    }
    sendJson(res, 200, { ...previousOrder.response, replayed: true })
    return
  }
  if (count !== 1) {
    sendJson(res, 400, { error: 'mock 仅支持 count=1' })
    return
  }

  const region = ZONE_TO_REGION[zone]
  const stockField = `stock_${zone}`
  if (state[stockField] <= 0) {
    sendJson(res, 409, { error: '该区域已售罄' })
    return
  }

  state[stockField] -= 1
  const key = mintFakeKsk()
  const unitPrice = state[`price_${zone}`]
  const response = {
    purchased: 1,
    requested: count,
    remaining: count - 1,
    unit_price: unitPrice,
    total_debit: unitPrice,
    order_id: randomBytes(8).toString('hex'),
    keys: [{ key, price: unitPrice }],
    replayed: false
  }
  ordersByClientOrderId.set(clientOrderId, { count, zone, response })
  state.sold.push({ maskedKey: maskKey(key), region, at: Date.now() })
  log(`卖出 ${maskKey(key)}（${region}），该区域剩余 ${state[stockField]}`)

  sendJson(res, 200, response)
}

/** 联调辅助：改库存与价格，验证「无货 → 有货」的放货边沿与预算拦单。 */
async function handleSetStock(req, res) {
  let payload
  try {
    payload = await readJsonBody(req)
  } catch (error) {
    sendJson(res, 400, { code: 1, msg: error.message })
    return
  }
  for (const field of ['stock_eu', 'stock_us', 'price_eu', 'price_us']) {
    if (payload[field] === undefined) continue
    const value = Number(payload[field])
    if (!Number.isFinite(value) || value < 0) {
      sendJson(res, 400, { code: 1, msg: `${field} 必须是非负数字` })
      return
    }
    state[field] = Math.floor(value)
  }
  log(`状态改为 eu:${state.stock_eu}@${state.price_eu} us:${state.stock_us}@${state.price_us}`)
  sendJson(res, 200, { code: 0, data: { ...state, sold: state.sold.length } })
}

ensureCert()

const server = createServer(
  { key: readFileSync(KEY_PATH), cert: readFileSync(CERT_PATH) },
  (req, res) => {
    const url = new URL(req.url ?? '/', `https://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (path.startsWith('/api/me/') && req.headers['x-api-key'] !== TOKEN) {
      log('拒绝一次 API Key 不匹配的请求')
      sendJson(res, 401, { error: 'API Key 缺失或不匹配' })
      return
    }

    if (req.method === 'GET' && path === '/api/me/stock') {
      handleStatus(res)
      return
    }
    if (req.method === 'POST' && path === '/api/me/purchase') {
      void handleOrder(req, res)
      return
    }
    if (req.method === 'POST' && path === '/admin/stock') {
      void handleSetStock(req, res)
      return
    }
    if (req.method === 'GET' && path === '/admin/sold') {
      sendJson(res, 200, { code: 0, data: state.sold })
      return
    }

    sendJson(res, 404, { code: 1, msg: `未知路由 ${req.method} ${path}` })
  }
)

export function startKiroAppMock({ port = PORT, host = HOST } = {}) {
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server))
  })
}

export function resetKiroAppMockState(overrides = {}) {
  state.stock_eu = overrides.stock_eu ?? 1
  state.stock_us = overrides.stock_us ?? 0
  state.price_eu = overrides.price_eu ?? 30
  state.price_us = overrides.price_us ?? 50
  state.sold = []
  ordersByClientOrderId.clear()
}

export { CERT_PATH, TOKEN }

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())
if (isDirectRun) {
  void startKiroAppMock().then(() => {
    const base = `https://${HOST}:${PORT}`
    log(`监听 ${base}`)
    log(`商品列表地址：${base}/api/me/stock`)
    log(`下单地址：    ${base}/api/me/purchase`)
    log(`鉴权请求头：  X-API-Key: ${TOKEN}`)
    log(`改库存：      POST ${base}/admin/stock {"stock_eu":1}（-k 跳过证书校验）`)
    log('')
    log('证书是自签的，主进程侧要放行它才能连上：')
    log(`  NODE_EXTRA_CA_CERTS=${CERT_PATH} npm run dev`)
  })
}
