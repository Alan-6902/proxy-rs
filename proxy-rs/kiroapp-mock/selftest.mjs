#!/usr/bin/env node
/**
 * KiroApp mock 上游的自测。
 *
 *   node kiroapp-mock/selftest.mjs
 *
 * 只用裸 fetch 打真实 HTTPS，不 mock 任何东西。负责的是「mock 服务端自己的行为对不对」；
 * 抢号器与它的对接验证在 test/integration/ksk-hunter-kiroapp.test.ts（那边用真实的
 * KskHunterManager 打这个同一个 server）。
 */

import { readFileSync } from 'node:fs'
import { Agent, fetch as undiciFetch } from 'undici'

const PORT = 12896
const BASE = `https://127.0.0.1:${PORT}`
const TOKEN = 'selftest-token'

process.env.KIROAPP_MOCK_TOKEN = TOKEN
const { CERT_PATH, resetKiroAppMockState, startKiroAppMock } = await import('./server.mjs')

/** 只信任 mock 那张自签证书，而不是把校验整个关掉。 */
const agent = new Agent({ connect: { ca: readFileSync(CERT_PATH) } })

const KSK_PATTERN = /^ksk_[A-Za-z0-9]+$/

let passed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}`)
    return
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
}

async function call(path, { method = 'GET', body } = {}) {
  const response = await undiciFetch(`${BASE}${path}`, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    dispatcher: agent
  })
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: response.status, json }
}

async function main() {
  const server = await startKiroAppMock({ port: PORT })
  console.log(`mock 已启动：${BASE}\n`)

  try {
    console.log('GET /api/status')
    {
      resetKiroAppMockState({ stock_eu: 1, stock_us: 0, price_eu: 30, price_us: 50 })
      const res = await call('/api/status')
      check('返回 200', res.status === 200, `实际 ${res.status}`)
      // 字段名必须和真站点一字不差，否则渠道解析器会认不出
      for (const field of [
        'auto_check',
        'auto_generate',
        'generating',
        'price',
        'price_eu',
        'price_us',
        'started_at',
        'stock',
        'stock_eu',
        'stock_us',
        'uptime_seconds'
      ]) {
        check(`含字段 ${field}`, res.json !== null && field in res.json)
      }
      check('stock_eu 反映当前库存', res.json?.stock_eu === 1, `实际 ${res.json?.stock_eu}`)
      check('price_eu 为 30', res.json?.price_eu === 30, `实际 ${res.json?.price_eu}`)
      check('未登录也能读（不校验 token）', res.status === 200)
    }

    console.log('\nPOST /api/order')
    {
      resetKiroAppMockState({ stock_eu: 1 })
      const noToken = await call('/api/order', { method: 'POST', body: { zone: 'eu', count: 1 } })
      check('缺 token 回 401', noToken.status === 401, `实际 ${noToken.status}`)

      const badZone = await call(`/api/order?token=${TOKEN}`, {
        method: 'POST',
        body: { zone: 'jp', count: 1 }
      })
      check('未知区域回 400', badZone.status === 400, `实际 ${badZone.status}`)

      const ok = await call(`/api/order?token=${TOKEN}`, {
        method: 'POST',
        body: { zone: 'eu', count: 1 }
      })
      check('下单回 200', ok.status === 200, `实际 ${ok.status}`)
      check('业务 code 为 0', ok.json?.code === 0, `实际 ${ok.json?.code}`)
      const key = ok.json?.data?.key ?? ''
      // 格式不合法会被 isUsableHunterCredential 判死，走不到验活
      check('key 形如 ksk_xxx', KSK_PATTERN.test(key), key ? `实际 ${key.slice(0, 8)}…` : '缺失')
      check(
        '回带 region',
        ok.json?.data?.region === 'eu-central-1',
        `实际 ${ok.json?.data?.region}`
      )
      check('回带 price', ok.json?.data?.price === 30, `实际 ${ok.json?.data?.price}`)

      const status = await call('/api/status')
      check('下单后库存扣减', status.json?.stock_eu === 0, `实际 ${status.json?.stock_eu}`)

      const soldOut = await call(`/api/order?token=${TOKEN}`, {
        method: 'POST',
        body: { zone: 'eu', count: 1 }
      })
      check('售罄后回 409', soldOut.status === 409, `实际 ${soldOut.status}`)
    }

    console.log('\n每次下单的 key 不重复')
    {
      resetKiroAppMockState({ stock_eu: 5 })
      const keys = new Set()
      for (let i = 0; i < 5; i++) {
        const res = await call(`/api/order?token=${TOKEN}`, {
          method: 'POST',
          body: { zone: 'eu', count: 1 }
        })
        keys.add(res.json?.data?.key)
      }
      check('5 次下单拿到 5 个不同 key', keys.size === 5, `实际 ${keys.size}`)
    }

    console.log('\n并发下单不超卖')
    {
      resetKiroAppMockState({ stock_eu: 3 })
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          call(`/api/order?token=${TOKEN}`, { method: 'POST', body: { zone: 'eu', count: 1 } })
        )
      )
      const okCount = results.filter((item) => item.status === 200).length
      check('只成功 3 单', okCount === 3, `实际 ${okCount}`)
      const status = await call('/api/status')
      check('库存归零而非负数', status.json?.stock_eu === 0, `实际 ${status.json?.stock_eu}`)
    }

    console.log('\n联调辅助接口')
    {
      resetKiroAppMockState({ stock_eu: 0 })
      const before = await call('/api/status')
      check('初始无货', before.json?.stock_eu === 0)

      await call('/admin/stock', { method: 'POST', body: { stock_eu: 2, price_eu: 42 } })
      const after = await call('/api/status')
      check('改库存生效', after.json?.stock_eu === 2, `实际 ${after.json?.stock_eu}`)
      check('改价格生效', after.json?.price_eu === 42, `实际 ${after.json?.price_eu}`)

      const bad = await call('/admin/stock', { method: 'POST', body: { stock_eu: -1 } })
      check('拒绝负库存', bad.status === 400, `实际 ${bad.status}`)

      const unknown = await call('/nope')
      check('未知路由回 404', unknown.status === 404, `实际 ${unknown.status}`)
    }
  } finally {
    server.close()
    await agent.close()
  }

  console.log(`\n${'='.repeat(50)}`)
  if (failures.length === 0) {
    console.log(`全部通过：${passed} 项`)
    process.exit(0)
  }
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}

void main().catch((error) => {
  console.error('自测本身出错：', error)
  process.exit(1)
})
