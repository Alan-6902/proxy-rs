/**
 * Kiro API Key（ksk_...）文本解析：主进程与渲染进程共用，避免两侧校验规则走偏。
 * 对齐 kiro-login 脚本：每行一个 `ksk_xxx` 或 `ksk_xxx----region`，空行与 # 注释忽略。
 */

/** Kiro API Key 前缀。 */
export const KIRO_API_KEY_PREFIX = 'ksk_'

/** 逐 key 指定区域时使用的分隔符，与 kiro-login 卡密风格一致。 */
export const KIRO_API_KEY_REGION_SEPARATOR = '----'

/** 未指定区域时的默认 AWS 区域。 */
export const DEFAULT_KIRO_API_KEY_REGION = 'us-east-1'

const KIRO_API_KEY_PATTERN = /^ksk_[A-Za-z0-9]+$/
const AWS_REGION_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)+$/

export interface ParsedKiroApiKeyEntry {
  /** 归一化后的 key。 */
  key: string
  /** 该 key 显式指定的区域；未指定时为 undefined，由调用方回落到默认区域。 */
  region?: string
}

export interface KiroApiKeyParseError {
  /** 出错行在原文中的行号（1 基），便于 UI 定位。 */
  line: number
  /** 原始行内容（已去空白），用于错误提示时脱敏展示。 */
  raw: string
  reason: 'invalid_key' | 'invalid_region'
}

export interface KiroApiKeyParseResult {
  entries: ParsedKiroApiKeyEntry[]
  errors: KiroApiKeyParseError[]
  /** 去重丢弃的重复 key 行数，便于 UI 汇报。 */
  duplicates: number
}

export function isValidKiroApiKey(value: string): boolean {
  return KIRO_API_KEY_PATTERN.test(value)
}

export function isValidKiroRegion(value: string): boolean {
  return AWS_REGION_PATTERN.test(value)
}

/** 展示用脱敏：`ksk_...xxxx`，与 kiro-login 的 mask_key 对齐。 */
export function maskKiroApiKey(key: string): string {
  return key.length > 12 ? `${key.slice(0, 4)}...${key.slice(-4)}` : `${key.slice(0, 4)}...`
}

/**
 * 解析多行 Kiro API Key 文本。按出现顺序去重，后出现的区域覆盖先前的区域（同 kiro-login）。
 */
export function parseKiroApiKeyEntries(text: string): KiroApiKeyParseResult {
  const entries: ParsedKiroApiKeyEntry[] = []
  const errors: KiroApiKeyParseError[] = []
  const indexByKey = new Map<string, number>()
  let duplicates = 0

  text.split('\n').forEach((rawLine, lineIndex) => {
    // 去掉 # 注释与所有空白/引号，兼容从聊天记录粘贴进来的内容
    const stripped = rawLine.split('#')[0].replace(/["'\s]/g, '')
    if (!stripped) return

    const separatorAt = stripped.indexOf(KIRO_API_KEY_REGION_SEPARATOR)
    const key = separatorAt >= 0 ? stripped.slice(0, separatorAt) : stripped
    const region =
      separatorAt >= 0 ? stripped.slice(separatorAt + KIRO_API_KEY_REGION_SEPARATOR.length) : ''

    if (!isValidKiroApiKey(key)) {
      errors.push({ line: lineIndex + 1, raw: stripped, reason: 'invalid_key' })
      return
    }
    if (region && !isValidKiroRegion(region)) {
      errors.push({ line: lineIndex + 1, raw: region, reason: 'invalid_region' })
      return
    }

    const existing = indexByKey.get(key)
    if (existing !== undefined) {
      duplicates++
      if (region) entries[existing].region = region
      return
    }
    indexByKey.set(key, entries.length)
    entries.push(region ? { key, region } : { key })
  })

  return { entries, errors, duplicates }
}
