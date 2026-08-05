import { describe, expect, it } from 'vitest'
import { detectModelRemap, mapModelId, MODEL_REMAP_HEADER } from '../../src/main/proxy/kiroApi'

/** 走一遍真实链路：请求的模型 → mapModelId → 是否判定为跨模型替换 */
function remapOf(requested: string): { from: string; to: string } | null {
  return detectModelRemap(requested, mapModelId(requested))
}

describe('内置模型降级检测', () => {
  it('响应头名固定，供客户端与 CORS 白名单引用', () => {
    expect(MODEL_REMAP_HEADER).toBe('X-Proxy-Model-Remapped')
  })

  describe('应当报告降级：客户端点的和实际用的不是同一个模型', () => {
    it.each([
      ['claude-3-opus', 'claude-sonnet-4.5'],
      ['claude-3-5-sonnet', 'claude-sonnet-4.5'],
      ['claude-3-haiku', 'claude-haiku-4.5'],
      ['claude-3-sonnet', 'claude-sonnet-4'],
      ['gpt-4', 'claude-sonnet-4.5'],
      ['gpt-4o', 'claude-sonnet-4.5'],
      ['gpt-4-turbo', 'claude-sonnet-4.5'],
      ['gpt-3.5-turbo', 'claude-sonnet-4.5']
    ])('%s → %s', (requested, expected) => {
      expect(remapOf(requested)).toEqual({ from: requested, to: expected })
    })

    it('完全未知的模型兜底到 default 也算降级', () => {
      expect(remapOf('llama-3-70b')).toEqual({ from: 'llama-3-70b', to: 'claude-sonnet-4.5' })
    })
  })

  describe('不应报告：指向同一模型的等价变换', () => {
    it.each([
      // 版本号短横归一化（Claude Code 不允许模型名带 "."）
      'claude-opus-4-6',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-opus-4-5',
      // alias 指向自身
      'claude-sonnet-4.5',
      'claude-haiku-4.5',
      'claude-opus-4.5',
      // 原样透传
      'claude-sonnet-4',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna'
    ])('%s 视为等价，不报警', (requested) => {
      expect(remapOf(requested)).toBeNull()
    })

    it('大小写差异不算降级', () => {
      expect(remapOf('Claude-Sonnet-4.5')).toBeNull()
    })

    it('CodeWhisperer 原生 modelId 原样透传', () => {
      expect(remapOf('CLAUDE_SONNET_4_20250514_V1_0')).toBeNull()
    })

    it('空模型名不产生报警（由上游兜底）', () => {
      expect(detectModelRemap('', mapModelId(''))).toBeNull()
      expect(detectModelRemap('   ', mapModelId('   '))).toBeNull()
    })
  })

  it('gpt-5.6 简写归一到 sol，属于跨模型替换需报告', () => {
    // gpt-5.6 → gpt-5.6-sol 是换了具体模型（sol/terra/luna 是不同模型），应当告知
    expect(remapOf('gpt-5.6')).toEqual({ from: 'gpt-5.6', to: 'gpt-5.6-sol' })
  })
})
