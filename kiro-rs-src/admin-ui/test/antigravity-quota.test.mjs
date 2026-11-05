import assert from 'node:assert/strict'
import { test } from 'node:test'
import { quotaRows } from '../src/lib/antigravity-quota.ts'

const modelReset = '2026-11-12T07:22:00Z'
const model = (id, fraction, displayName = id, resetTime = modelReset) => ({
  id, displayName, remainingFraction: fraction, resetTime,
})
const bucket = (bucketId, window, fraction, resetTime = null) => ({
  bucketId, window, displayName: null, remainingFraction: fraction, resetTime,
})
const claudeGroup = (five, weekly) => ({
  displayName: 'Claude and GPT models',
  buckets: [bucket('3p-5h', '5h', ...five), bucket('3p-weekly', 'weekly', ...weekly)],
})
const geminiGroup = (five, weekly) => ({
  displayName: 'Gemini Models',
  buckets: [bucket('gemini-5h', '5h', ...five), bucket('gemini-weekly', 'weekly', ...weekly)],
})

const ultraModels = [
  model('claude-opus-4-6-thinking', 1, 'Claude Opus 4.6 (Thinking)'),
  model('claude-sonnet-5-5-high', 0.5, 'Claude Sonnet 5.5 (High)'),
  model('claude-opus-5-5-high', 0.5, 'Claude Opus 5.5 (High)'),
  model('claude-opus-5-5-low', 0.5, 'Claude Opus 5.5 (Low)'),
  model('gemini-3-flash', 1, 'Gemini 3 Flash'),
  model('gemini-3.5-flash-lite', 1, 'Gemini 3.5 Flash Lite'),
  model('gemini-3.8-flash-high', 1, 'Gemini 3.8 Flash (High)'),
  model('gemini-3.8-flash-tiered', 1, null),
  model('gemini-2.5-pro', 1, 'Gemini 2.5 Pro'),
  model('gemini-4-argon-high', 1, 'Gemini 4 Argon (High)'),
  model('gpt-oss-120b-medium', 0.5),
]

test('只出三行：最好的 Claude、Flash、Gemini，名称去掉档位后缀', () => {
  const rows = quotaRows({ quota: { models: ultraModels, groups: [claudeGroup([1], [1]), geminiGroup([1], [1])] } })
  assert.deepEqual(rows.map((r) => [r.key, r.label]), [
    ['claude', 'Claude Opus 5.5'],
    ['flash', 'Gemini 3.8 Flash'],
    ['gemini', 'Gemini 4 Argon'],
  ])
})

test('剩余取模型额度与分组窗口中最紧的一个，恢复时间跟随它', () => {
  const weeklyReset = '2026-11-08T00:00:00Z'
  const rows = quotaRows({ quota: { models: ultraModels, groups: [
    claudeGroup([0.9], [0.3, weeklyReset]),
    geminiGroup([0.8, '2026-11-05T22:16:00Z'], [0.99]),
  ] } })
  assert.deepEqual(rows[0], { key: 'claude', label: 'Claude Opus 5.5', fraction: 0.3, resetTime: weeklyReset })
  assert.equal(rows[1].fraction, 0.8)
  assert.equal(rows[2].resetTime, '2026-11-05T22:16:00Z')

  const modelBound = quotaRows({ quota: { models: ultraModels, groups: [claudeGroup([1], [1])] } })
  assert.deepEqual(modelBound[0], { key: 'claude', label: 'Claude Opus 5.5', fraction: 0.5, resetTime: modelReset })
})

test('没有 Argon 的账号退回 2.5 Pro；分组缺失时只看模型额度', () => {
  const models = ultraModels.filter((m) => !m.id.includes('argon'))
  const rows = quotaRows({ quota: { models } })
  assert.equal(rows[2].label, 'Gemini 2.5 Pro')
  assert.equal(rows[2].fraction, 1)
})

test('缺某一类模型时不出该行；无数据时为空', () => {
  const rows = quotaRows({ quota: { models: [model('claude-sonnet-4-6', 0.4, 'Claude Sonnet 4.6 (Thinking)')] } })
  assert.deepEqual(rows, [{ key: 'claude', label: 'Claude Sonnet 4.6', fraction: 0.4, resetTime: modelReset }])
  assert.deepEqual(quotaRows({ quota: null }), [])
})

test('分组额度未知时不覆盖已知的模型额度', () => {
  const rows = quotaRows({ quota: { models: ultraModels, groups: [claudeGroup([null], [null])] } })
  assert.equal(rows[0].fraction, 0.5)
})
