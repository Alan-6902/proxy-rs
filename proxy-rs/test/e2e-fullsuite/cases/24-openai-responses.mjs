/**
 * CASE 24: POST /v1/responses (OpenAI Responses API).
 *
 * 验证 handleOpenAIResponses 路径: 把 Responses API 转为内部 chat.completions, 再调上游.
 */
import { DEFAULT_OPENAI_MODEL, SMALL_MAX_TOKENS } from '../lib/fixtures.mjs'
import { assertTrue } from '../lib/assert.mjs'

export default {
  id: 'CASE-24-openai-responses',
  title: 'POST /v1/responses (OpenAI Responses API)',
  tags: ['openai', 'endpoint', 'responses'],
  run: async ({ base, token, log }) => {
    const url = `${base.replace(/\/$/, '')}/v1/responses`
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: DEFAULT_OPENAI_MODEL,
        max_output_tokens: SMALL_MAX_TOKENS,
        input: [{ role: 'user', content: '一句话回答即可.' }],
        stream: true
      })
    })
    const text = await r.text()
    log(`status=${r.status} bytes=${text.length}`)
    assertTrue(
      r.status === 200,
      `responses 流式端点应返回 200, 实际 ${r.status}: ${text.slice(0, 300)}`
    )
    const events = text
      .split('\n\n')
      .map((frame) => frame.split('\n').find((line) => line.startsWith('data: ')))
      .filter(Boolean)
      .map((line) => JSON.parse(line.slice('data: '.length)))
    const eventTypes = events.map((event) => event.type)
    assertTrue(eventTypes.includes('response.created'), '应包含 response.created')
    assertTrue(
      eventTypes.includes('response.output_text.delta'),
      '应包含实时 response.output_text.delta'
    )
    assertTrue(eventTypes.includes('response.completed'), '应包含 response.completed')
    assertTrue(
      events
        .filter((event) => event.type === 'response.output_text.delta')
        .some((event) => event.delta),
      '至少一个文本 delta 应非空'
    )
  }
}
