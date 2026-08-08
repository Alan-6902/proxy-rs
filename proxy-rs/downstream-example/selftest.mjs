#!/usr/bin/env node
/**
 * 下游参考实现的自测。
 *
 *   node selftest.mjs
 *
 * 只用裸 fetch 打真实 HTTP，不 mock 任何东西。这里刻意不 import 抢号器的
 * downstreamClient（那是 TypeScript，Node 直接跑不了）——真正的两边对接验证
 * 在 test/integration/ksk-hunter-downstream.test.ts 里，那边用编译后的客户端
 * 打这个同一个 server。本脚本负责的是「服务端自己的行为对不对」。
 */

const PORT = 12899
const BASE = `http://127.0.0.1:${PORT}`
const API_KEY = 'selftest-secret-key'

const KSK_ONE = 'ksk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const KSK_TWO = 'ksk_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

// server.mjs 在模块初始化时就读 DOWNSTREAM_API_KEY，而静态 import 会被提升到
// 赋值语句之前，所以必须先设环境变量再动态 import，否则服务端拿到空 Key、拒绝一切请求。
process.env.DOWNSTREAM_API_KEY = API_KEY
const { resetDownstreamState, startDownstreamServer } = await import('./server.mjs')

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

async function call(path, { method = 'GET', body, apiKey = API_KEY } = {}) {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' }
  if (apiKey !== null) headers['x-api-key'] = apiKey
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 保留 text 供断言 */
  }
  return { status: response.status, json, text }
}

async function main() {
  const server = await startDownstreamServer({ port: PORT })
  console.log(`下游参考实现自测 · ${BASE}\n`)

  try {
    console.log('鉴权')
    resetDownstreamState({ wanted: 1 })
    {
      const missing = await call('/need-account', { apiKey: null })
      check('缺 x-api-key 时回 401', missing.status === 401, `实际 ${missing.status}`)

      const wrong = await call('/need-account', { apiKey: 'wrong-key' })
      check('Key 不匹配时回 401', wrong.status === 401, `实际 ${wrong.status}`)

      // 长度不同会走 timingSafeEqual 的长度短路分支，单独覆盖一次
      const shorter = await call('/need-account', { apiKey: 'short' })
      check('Key 长度不同时回 401', shorter.status === 401, `实际 ${shorter.status}`)

      const push = await call('/ksk', {
        method: 'POST',
        apiKey: null,
        body: { key: KSK_ONE, region: 'eu-central-1' }
      })
      check('未授权时也不接收推送', push.status === 401, `实际 ${push.status}`)
      const after = await call('/admin/received')
      check('未授权的推送没有落库', after.json?.received.length === 0)
    }

    console.log('\nGET /need-account')
    {
      resetDownstreamState({ wanted: 2 })
      const need = await call('/need-account')
      check('水位 > 0 时回 need:true', need.json?.need === true, JSON.stringify(need.json))
      check('need 是 boolean 而非字符串', typeof need.json?.need === 'boolean')

      // 契约要求这个接口无副作用：连问三次，水位不能动
      await call('/need-account')
      await call('/need-account')
      const state = await call('/admin/received')
      check(
        '连续查询不消耗需求水位（无副作用）',
        state.json?.wanted === 2,
        `实际 ${state.json?.wanted}`
      )

      resetDownstreamState({ wanted: 0 })
      const noNeed = await call('/need-account')
      check('水位为 0 时回 need:false', noNeed.json?.need === false, JSON.stringify(noNeed.json))
    }

    console.log('\nPOST /ksk')
    {
      resetDownstreamState({ wanted: 2 })
      const ok = await call('/ksk', {
        method: 'POST',
        body: { key: KSK_ONE, region: 'eu-central-1' }
      })
      check('正常推送回 200 + ok:true', ok.status === 200 && ok.json?.ok === true)

      const listed = await call('/admin/received')
      check('号已落库', listed.json?.received.length === 1)
      check('落库的 region 正确', listed.json?.received[0]?.region === 'eu-central-1')
      check(
        '落库记录里 key 是脱敏的',
        !JSON.stringify(listed.json).includes(KSK_ONE),
        '响应里出现了 key 明文'
      )
      check('接收后水位递减', listed.json?.wanted === 1, `实际 ${listed.json?.wanted}`)
    }

    console.log('\n幂等（重试会推同一个 key）')
    {
      resetDownstreamState({ wanted: 5 })
      const first = await call('/ksk', {
        method: 'POST',
        body: { key: KSK_ONE, region: 'eu-central-1' }
      })
      const second = await call('/ksk', {
        method: 'POST',
        body: { key: KSK_ONE, region: 'eu-central-1' }
      })
      const third = await call('/ksk', {
        method: 'POST',
        body: { key: KSK_ONE, region: 'eu-central-1' }
      })
      check('首次推送 ok:true', first.json?.ok === true)
      check(
        '重复推送同样回 ok:true（不能报错）',
        second.json?.ok === true && third.json?.ok === true
      )
      check('重复推送被标记 duplicate', second.json?.duplicate === true)

      const state = await call('/admin/received')
      check(
        '重复推送没有产生重复记录',
        state.json?.received.length === 1,
        `实际 ${state.json?.received.length}`
      )
      check('重复推送没有重复扣水位', state.json?.wanted === 4, `实际 ${state.json?.wanted}`)

      // 不同 key 必须各自落库，别把幂等做成「只收第一个」
      await call('/ksk', { method: 'POST', body: { key: KSK_TWO, region: 'us-east-1' } })
      const twoKeys = await call('/admin/received')
      check('不同 key 各自落库', twoKeys.json?.received.length === 2)
    }

    console.log('\n入参校验')
    {
      resetDownstreamState({ wanted: 5 })
      const badKey = await call('/ksk', {
        method: 'POST',
        body: { key: 'not-a-ksk', region: 'eu-central-1' }
      })
      check('非法 key 回 400', badKey.status === 400, `实际 ${badKey.status}`)
      check('非法 key 时 ok 为 false', badKey.json?.ok === false)

      const badRegion = await call('/ksk', {
        method: 'POST',
        body: { key: KSK_ONE, region: 'nope' }
      })
      check('非法 region 回 400', badRegion.status === 400, `实际 ${badRegion.status}`)
      check(
        '错误信息里不回显 key 明文',
        !JSON.stringify(badRegion.json).includes(KSK_ONE),
        '错误响应里出现了 key 明文'
      )

      const missing = await call('/ksk', { method: 'POST', body: {} })
      check('缺字段回 400', missing.status === 400, `实际 ${missing.status}`)

      const notJson = await fetch(`${BASE}/ksk`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
        body: '{ 坏掉的 json'
      })
      check('非法 JSON 回 400 而不是崩溃', notJson.status === 400, `实际 ${notJson.status}`)

      const state = await call('/admin/received')
      check('所有非法请求都没有落库', state.json?.received.length === 0)
    }

    console.log('\n健壮性')
    {
      resetDownstreamState({ wanted: 1 })
      const unknown = await call('/nope')
      check('未知路由回 404', unknown.status === 404, `实际 ${unknown.status}`)

      const wrongMethod = await call('/need-account', { method: 'POST', body: {} })
      check('need-account 用错方法回 404', wrongMethod.status === 404, `实际 ${wrongMethod.status}`)

      // 抢号器请求 /ksk 时带 Content-Type，但 query 串不该影响路由
      const withQuery = await call('/need-account?t=123')
      check('带 query 参数仍能命中路由', withQuery.status === 200, `实际 ${withQuery.status}`)

      const oversize = await fetch(`${BASE}/ksk`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: KSK_ONE, region: 'eu-central-1', pad: 'x'.repeat(16 * 1024) })
      }).catch((error) => ({ status: 0, error }))
      check(
        '超大请求体被拒（400 或连接断开）',
        oversize.status === 400 || oversize.status === 0,
        `实际 ${oversize.status}`
      )

      // 超大体被拒后服务必须还活着
      const alive = await call('/need-account')
      check('拒绝超大请求后服务仍存活', alive.status === 200, `实际 ${alive.status}`)
    }

    console.log('\n并发（抢号器可能同时推多条）')
    {
      resetDownstreamState({ wanted: 10 })
      const keys = Array.from(
        { length: 8 },
        (_, index) => `ksk_CONCURRENT${String(index).padStart(20, '0')}`
      )
      const responses = await Promise.all(
        keys.map((key) => call('/ksk', { method: 'POST', body: { key, region: 'eu-central-1' } }))
      )
      check(
        '并发推送全部成功',
        responses.every((response) => response.json?.ok === true)
      )
      const state = await call('/admin/received')
      check(
        '并发推送落库条数正确',
        state.json?.received.length === 8,
        `实际 ${state.json?.received.length}`
      )

      // 同一个 key 并发重推，幂等不能被打穿
      resetDownstreamState({ wanted: 10 })
      const dupes = await Promise.all(
        Array.from({ length: 6 }, () =>
          call('/ksk', { method: 'POST', body: { key: KSK_ONE, region: 'eu-central-1' } })
        )
      )
      check(
        '同 key 并发重推全部回 ok',
        dupes.every((response) => response.json?.ok === true)
      )
      const dupeState = await call('/admin/received')
      check(
        '同 key 并发重推只落一条',
        dupeState.json?.received.length === 1,
        `实际 ${dupeState.json?.received.length}`
      )
    }

    console.log('\n联调辅助接口')
    {
      resetDownstreamState({ wanted: 0 })
      const before = await call('/need-account')
      check('水位 0 时不要号', before.json?.need === false)

      await call('/admin/demand', { method: 'POST', body: { wanted: 3 } })
      const after = await call('/need-account')
      check('调高水位后开始要号', after.json?.need === true)

      const bad = await call('/admin/demand', { method: 'POST', body: { wanted: -1 } })
      check('拒绝负数水位', bad.status === 400, `实际 ${bad.status}`)
    }
  } finally {
    server.close()
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
