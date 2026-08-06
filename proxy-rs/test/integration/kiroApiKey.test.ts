import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KIRO_API_KEY_REGION,
  isValidKiroApiKey,
  isValidKiroRegion,
  maskKiroApiKey,
  parseKiroApiKeyEntries
} from '../../src/shared/kiroApiKey'

describe('Kiro API Key 文本解析', () => {
  it('每行一个 key，忽略空行与 # 注释', () => {
    const result = parseKiroApiKeyEntries(
      ['# 这是注释', 'ksk_aaa111', '', '   ', 'ksk_bbb222   # 行尾注释', '# ksk_ccc333'].join('\n')
    )

    expect(result.entries).toEqual([{ key: 'ksk_aaa111' }, { key: 'ksk_bbb222' }])
    expect(result.errors).toEqual([])
  })

  it('支持 ksk----region 逐 key 指定区域', () => {
    const result = parseKiroApiKeyEntries('ksk_aaa111----eu-central-1\nksk_bbb222')

    expect(result.entries).toEqual([
      { key: 'ksk_aaa111', region: 'eu-central-1' },
      { key: 'ksk_bbb222' }
    ])
    expect(result.errors).toEqual([])
  })

  it('去重时保留首次出现顺序，后出现的区域覆盖先前区域', () => {
    const result = parseKiroApiKeyEntries(
      ['ksk_aaa111', 'ksk_bbb222----us-west-2', 'ksk_aaa111----ap-northeast-1'].join('\n')
    )

    expect(result.entries).toEqual([
      { key: 'ksk_aaa111', region: 'ap-northeast-1' },
      { key: 'ksk_bbb222', region: 'us-west-2' }
    ])
    expect(result.duplicates).toBe(1)
  })

  it('剥离粘贴引入的引号与内部空白', () => {
    const result = parseKiroApiKeyEntries('  "ksk_aaa111"  \n\'ksk_bbb 222\'')

    expect(result.entries).toEqual([{ key: 'ksk_aaa111' }, { key: 'ksk_bbb222' }])
    expect(result.errors).toEqual([])
  })

  it('非 ksk_ 开头的行标为 invalid_key 且不进入结果', () => {
    const result = parseKiroApiKeyEntries('sk-not-a-kiro-key\nksk_good111\nksk_bad!!!')

    expect(result.entries).toEqual([{ key: 'ksk_good111' }])
    expect(result.errors).toEqual([
      { line: 1, raw: 'sk-not-a-kiro-key', reason: 'invalid_key' },
      { line: 3, raw: 'ksk_bad!!!', reason: 'invalid_key' }
    ])
  })

  it('区域格式非法时标为 invalid_region 且不进入结果', () => {
    const result = parseKiroApiKeyEntries('ksk_aaa111----US_EAST_1')

    expect(result.entries).toEqual([])
    expect(result.errors).toEqual([{ line: 1, raw: 'US_EAST_1', reason: 'invalid_region' }])
  })

  it('全空输入返回空结果而非抛错', () => {
    expect(parseKiroApiKeyEntries('')).toEqual({ entries: [], errors: [], duplicates: 0 })
    expect(parseKiroApiKeyEntries('\n# only comment\n')).toEqual({
      entries: [],
      errors: [],
      duplicates: 0
    })
  })
})

describe('Kiro API Key 校验与脱敏', () => {
  it('key 格式校验对齐 ^ksk_[A-Za-z0-9]+$', () => {
    expect(isValidKiroApiKey('ksk_Abc123')).toBe(true)
    expect(isValidKiroApiKey('ksk_')).toBe(false)
    expect(isValidKiroApiKey('ksk_with-dash')).toBe(false)
    expect(isValidKiroApiKey('KSK_UPPER123')).toBe(false)
    expect(isValidKiroApiKey('sk_other123')).toBe(false)
  })

  it('区域格式校验只接受小写连字符形式', () => {
    expect(isValidKiroRegion('us-east-1')).toBe(true)
    expect(isValidKiroRegion('ap-northeast-1')).toBe(true)
    expect(isValidKiroRegion('useast1')).toBe(false)
    expect(isValidKiroRegion('us_east_1')).toBe(false)
  })

  it('脱敏只暴露首尾片段', () => {
    expect(maskKiroApiKey('ksk_abcdefghijklmnop')).toBe('ksk_...mnop')
    expect(maskKiroApiKey('ksk_short')).toBe('ksk_...')
  })

  it('默认区域与主进程回落值一致', () => {
    expect(DEFAULT_KIRO_API_KEY_REGION).toBe('us-east-1')
  })
})
