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
const TOKEN = 'km_mock_token'

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

async function call(path, { method = 'GET', body, apiKey = TOKEN } = {}) {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' }
  if (apiKey !== null) headers['X-API-Key'] = apiKey

  const response = await undiciFetch(`${BASE}${path}`, {
    method,
    headers,
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
  const STOCK_PATH = '/api/me/stock'
  const PURCHASE_PATH = '/api/me/purchase'
  const clientOrderId = (sequence) => sequence.toString(16).padStart(32, '0')
  const purchaseBody = (sequence, region = 'eu') => ({
    count: 1,
    region,
    client_order_id: clientOrderId(sequence)
  })
  console.log(`mock 已启动：${BASE}\n`)

  try {
    console.log('GET /api/me/stock')
    {
      resetKiroAppMockState({ stock_eu: 1, stock_us: 2, price_eu: 30, price_us: 50 })

      const noApiKey = await call(STOCK_PATH, { apiKey: null })
      check('库存接口缺 X-API-Key 回 401', noApiKey.status === 401, `实际 ${noApiKey.status}`)

      const res = await call(STOCK_PATH)
      check('库存接口返回 200', res.status === 200, `实际 ${res.status}`)
      for (const field of [
        'stock',
        'price',
        'price_min',
        'price_max',
        'balance',
        'stock_eu',
        'stock_us',
        'price_eu',
        'price_us'
      ]) {
        check(`含字段 ${field}`, res.json !== null && field in res.json)
      }
      check('stock 汇总当前库存', res.json?.stock === 3, `实际 ${res.json?.stock}`)
      check('stock_eu 反映当前库存', res.json?.stock_eu === 1, `实际 ${res.json?.stock_eu}`)
      check('stock_us 反映当前库存', res.json?.stock_us === 2, `实际 ${res.json?.stock_us}`)
      check('price_eu 为 30', res.json?.price_eu === 30, `实际 ${res.json?.price_eu}`)
      check('price_us 为 50', res.json?.price_us === 50, `实际 ${res.json?.price_us}`)
    }

    console.log('\nPOST /api/me/purchase')
    {
      resetKiroAppMockState({ stock_eu: 1, stock_us: 1, price_eu: 30, price_us: 50 })

      const noApiKey = await call(PURCHASE_PATH, {
        method: 'POST',
        apiKey: null,
        body: purchaseBody(1)
      })
      check('购买接口缺 X-API-Key 回 401', noApiKey.status === 401, `实际 ${noApiKey.status}`)

      const badRegion = await call(PURCHASE_PATH, {
        method: 'POST',
        body: purchaseBody(2, 'jp')
      })
      check('未知 region 回 400', badRegion.status === 400, `实际 ${badRegion.status}`)

      const badClientOrderId = await call(PURCHASE_PATH, {
        method: 'POST',
        body: { count: 1, region: 'eu', client_order_id: 'A'.repeat(32) }
      })
      check(
        '非小写 hex 的 client_order_id 回 400',
        badClientOrderId.status === 400,
        `实际 ${badClientOrderId.status}`
      )

      const ok = await call(PURCHASE_PATH, {
        method: 'POST',
        body: purchaseBody(3, 'eu')
      })
      check('购买回 200', ok.status === 200, `实际 ${ok.status}`)
      for (const field of [
        'purchased',
        'requested',
        'remaining',
        'unit_price',
        'total_debit',
        'order_id',
        'keys',
        'replayed'
      ]) {
        check(`购买响应含字段 ${field}`, ok.json !== null && field in ok.json)
      }
      check('purchased 为 1', ok.json?.purchased === 1, `实际 ${ok.json?.purchased}`)
      check('requested 为 1', ok.json?.requested === 1, `实际 ${ok.json?.requested}`)
      check('remaining 为 0', ok.json?.remaining === 0, `实际 ${ok.json?.remaining}`)
      check('unit_price 为 30', ok.json?.unit_price === 30, `实际 ${ok.json?.unit_price}`)
      check('total_debit 为 30', ok.json?.total_debit === 30, `实际 ${ok.json?.total_debit}`)
      check('首次购买不是 replay', ok.json?.replayed === false, `实际 ${ok.json?.replayed}`)
      check(
        'order_id 为 16 位小写 hex',
        /^[0-9a-f]{16}$/.test(ok.json?.order_id ?? ''),
        `实际 ${ok.json?.order_id}`
      )
      const key = ok.json?.keys?.[0]?.key ?? ''
      check('keys 返回一个 key', ok.json?.keys?.length === 1, `实际 ${ok.json?.keys?.length}`)
      check('key 形如 ksk_xxx', KSK_PATTERN.test(key), key ? `实际 ${key.slice(0, 8)}…` : '缺失')
      check('key 回带单价', ok.json?.keys?.[0]?.price === 30, `实际 ${ok.json?.keys?.[0]?.price}`)

      const stockAfterEu = await call(STOCK_PATH)
      check(
        '购买后 eu 库存扣减',
        stockAfterEu.json?.stock_eu === 0,
        `实际 ${stockAfterEu.json?.stock_eu}`
      )

      const soldOut = await call(PURCHASE_PATH, {
        method: 'POST',
        body: purchaseBody(4, 'eu')
      })
      check('售罄后回 409', soldOut.status === 409, `实际 ${soldOut.status}`)

      const us = await call(PURCHASE_PATH, {
        method: 'POST',
        body: purchaseBody(5, 'us')
      })
      check('region=us 可购买', us.status === 200, `实际 ${us.status}`)
      check('us 单价为 50', us.json?.unit_price === 50, `实际 ${us.json?.unit_price}`)
    }

    console.log('\nclient_order_id 幂等')
    {
      resetKiroAppMockState({ stock_eu: 2, stock_us: 1 })
      const body = purchaseBody(10, 'eu')
      const first = await call(PURCHASE_PATH, { method: 'POST', body })
      check('首次请求成功', first.status === 200, `实际 ${first.status}`)
      check('首次请求 replayed=false', first.json?.replayed === false)

      const afterFirst = await call(STOCK_PATH)
      check('首次请求只扣一件库存', afterFirst.json?.stock_eu === 1)

      const replay = await call(PURCHASE_PATH, { method: 'POST', body })
      check('相同参数 replay 返回 200', replay.status === 200, `实际 ${replay.status}`)
      check('相同参数 replayed=true', replay.json?.replayed === true)
      check('replay 保持同一 order_id', replay.json?.order_id === first.json?.order_id)
      check('replay 保持同一 key', replay.json?.keys?.[0]?.key === first.json?.keys?.[0]?.key)

      const afterReplay = await call(STOCK_PATH)
      check(
        'replay 不重复扣库存',
        afterReplay.json?.stock_eu === 1,
        `实际 ${afterReplay.json?.stock_eu}`
      )

      const conflict = await call(PURCHASE_PATH, {
        method: 'POST',
        body: { ...body, region: 'us' }
      })
      check('同 id 不同参数回 409', conflict.status === 409, `实际 ${conflict.status}`)

      const afterConflict = await call(STOCK_PATH)
      check('冲突请求不扣 eu 库存', afterConflict.json?.stock_eu === 1)
      check('冲突请求不扣 us 库存', afterConflict.json?.stock_us === 1)
    }

    console.log('\n每次购买的 key 不重复')
    {
      resetKiroAppMockState({ stock_eu: 5 })
      const keys = new Set()
      for (let i = 0; i < 5; i++) {
        const res = await call(PURCHASE_PATH, {
          method: 'POST',
          body: purchaseBody(100 + i)
        })
        check(`第 ${i + 1} 次购买成功`, res.status === 200, `实际 ${res.status}`)
        keys.add(res.json?.keys?.[0]?.key)
      }
      check('5 次购买拿到 5 个不同 key', keys.size === 5, `实际 ${keys.size}`)
    }

    console.log('\n并发购买不超卖')
    {
      resetKiroAppMockState({ stock_eu: 3 })
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          call(PURCHASE_PATH, {
            method: 'POST',
            body: purchaseBody(200 + index)
          })
        )
      )
      const okCount = results.filter((item) => item.status === 200).length
      const soldOutCount = results.filter((item) => item.status === 409).length
      check('只成功 3 单', okCount === 3, `实际 ${okCount}`)
      check('其余 5 单售罄', soldOutCount === 5, `实际 ${soldOutCount}`)
      const stock = await call(STOCK_PATH)
      check('库存归零而非负数', stock.json?.stock_eu === 0, `实际 ${stock.json?.stock_eu}`)
    }

    console.log('\n联调辅助接口')
    {
      resetKiroAppMockState({ stock_eu: 0 })
      const before = await call(STOCK_PATH)
      check('初始无货', before.json?.stock_eu === 0)

      await call('/admin/stock', { method: 'POST', body: { stock_eu: 2, price_eu: 42 } })
      const after = await call(STOCK_PATH)
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
