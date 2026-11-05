/**
 * Token 计数工具：使用 js-tiktoken cl100k_base 编码精确计算，
 * 失败时降级到字节系数估算；并提供按模型 ID 推断 context 窗口大小，
 * 以便从 Kiro 后端的 contextUsagePercentage 反推真实 input tokens。
 */
import { getEncoding, type Tiktoken } from 'js-tiktoken'

let encoder: Tiktoken | null = null
let encoderInitFailed = false

/** 懒加载 cl100k_base 编码器（GPT-4/Claude 通用近似） */
function getEncoder(): Tiktoken | null {
  if (encoder) return encoder
  if (encoderInitFailed) return null
  try {
    encoder = getEncoding('cl100k_base')
    return encoder
  } catch (err) {
    console.warn('[TokenCounter] Failed to load cl100k_base encoder:', err)
    encoderInitFailed = true
    return null
  }
}

/**
 * 使用 tiktoken cl100k_base 精确计算 token 数。
 * 兜底：UTF-8 字节数 / 3.0（针对 payload JSON 经验值，误差 ±10%）。
 */
export function countTokens(text: string): number {
  if (!text) return 0
  const enc = getEncoder()
  if (enc) {
    try {
      return enc.encode(text).length
    } catch (err) {
      console.warn('[TokenCounter] encode failed, using fallback:', err)
    }
  }
  return Math.ceil(Buffer.byteLength(text, 'utf-8') / 3.0)
}

/**
 * 根据 model ID 返回 context 窗口大小（用于 contextUsagePercentage 反推 inputTokens）。
 * 按模型名关键词静态匹配，未知模型按 200K 处理。
 */
export function getModelContextLength(modelId: string | undefined | null): number {
  if (!modelId) return 200000

  const id = modelId.toLowerCase()

  if (/^gpt-5[.-]6(?:[.-](?:sol|terra|luna))?$/.test(id)) return 272000

  // Sonnet/Opus 4.6+ (including 5+) are 1M; 4.5 and all Haiku stay 200K.
  if (/^claude-(?:sonnet|opus)-(?:4[.-](?:[6-9]|[1-9][0-9]+)|[5-9][0-9]*)(?:$|[.-])/.test(id))
    return 1000000

  // Claude 系列（Haiku 和未列出的 Claude 保持 200K）。
  if (
    id.includes('claude-opus-4') ||
    id.includes('claude-sonnet-4') ||
    id.includes('claude-haiku-4')
  )
    return 200000
  if (id.includes('claude-3-7') || id.includes('claude-3.7')) return 200000
  if (id.includes('claude-3-5') || id.includes('claude-3.5')) return 200000
  if (id.includes('claude-3')) return 200000
  if (id.includes('claude-2.1')) return 200000
  if (id.includes('claude-2')) return 100000
  if (id.includes('claude-instant')) return 100000

  // GPT 系列。
  if (id.includes('gpt-4o') || id.includes('gpt-4-turbo')) return 128000
  if (id.includes('gpt-4.1')) return 1000000
  if (id.includes('gpt-4-32k')) return 32768
  if (id.includes('gpt-4')) return 8192
  if (id.includes('gpt-3.5-turbo-16k')) return 16384
  if (id.includes('gpt-3.5')) return 4096
  if (id.includes('o1') || id.includes('o3')) return 128000

  // Gemini 系列。
  if (id.includes('gemini-2.5') || id.includes('gemini-2.0') || id.includes('gemini-1.5'))
    return 1000000
  if (id.includes('gemini')) return 32768

  // Amazon Titan / Nova 系列。
  if (id.includes('nova-pro') || id.includes('nova-lite')) return 300000
  if (id.includes('nova-micro')) return 128000
  if (id.includes('titan')) return 8000

  return 200000
}
