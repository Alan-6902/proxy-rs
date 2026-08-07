// OpenAI 格式到 Kiro 格式转换器
import type {
  OpenAIChatRequest,
  OpenAIMessage,
  OpenAITool,
  ClaudeContentBlock,
  KiroPayload,
  KiroHistoryMessage,
  KiroToolWrapper,
  KiroToolResult,
  KiroImage,
  KiroDocument,
  KiroToolUse,
  KiroCachePoint
} from './types'
import { buildKiroPayload, mapModelId } from './kiroApi'
import { ToolNameRegistry } from './toolNameRegistry'

const KIRO_CACHE_POINT: KiroCachePoint = { type: 'default' }

/** 模型 thinking 能力元数据（由 proxyServer 从模型缓存中查询后传入） */
export interface ThinkingConfig {
  schemaPath: 'output_config' | 'reasoning'
  efforts: string[]
  defaultEffort?: string
}

/**
 * 将客户端 effort / thinking 参数 + 模型 schema path 映射为 Kiro additionalModelRequestFields。
 * 官方 Kiro IDE 的 kr() 函数逻辑：
 *   output_config → { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort } }
 *   reasoning     → { reasoning: { effort } }
 */
function buildThinkingFields(
  thinkingConfig: ThinkingConfig | undefined,
  clientThinking?: { type: string; budget_tokens?: number; display?: string },
  clientReasoningEffort?: string
): Record<string, unknown> | undefined {
  // 客户端明确关闭 thinking
  if (clientThinking?.type === 'disabled') return undefined

  // 没有模型元数据时，回退到旧逻辑：仅传 { thinking: { type: 'adaptive' } }
  if (!thinkingConfig) {
    if (clientThinking && clientThinking.type !== 'disabled') {
      return { thinking: { type: 'adaptive' } }
    }
    if (clientReasoningEffort) {
      return { thinking: { type: 'adaptive' } }
    }
    return undefined
  }

  // 客户端没请求 thinking 也没请求 reasoning_effort → 不启用
  const wantsThinking =
    !!(clientThinking && clientThinking.type !== 'disabled') || !!clientReasoningEffort
  if (!wantsThinking) return undefined

  // 映射 effort level（直接使用客户端值，不做强制转换）
  const mapEffort = (input: string): string => input.toLowerCase()

  let effort: string
  if (clientReasoningEffort) {
    effort = mapEffort(clientReasoningEffort)
  } else if (clientThinking?.type === 'enabled' && clientThinking.budget_tokens) {
    // budget_tokens 粗略映射到 effort level
    const b = clientThinking.budget_tokens
    if (b <= 4000) effort = 'low'
    else if (b <= 16000) effort = 'medium'
    else if (b <= 64000) effort = 'high'
    else effort = 'xhigh'
  } else {
    effort = thinkingConfig.defaultEffort || 'high'
  }

  // 确保 effort 在可用范围内，否则取最接近的
  if (!thinkingConfig.efforts.includes(effort)) {
    effort = thinkingConfig.efforts[thinkingConfig.efforts.length - 1] || 'high'
  }

  switch (thinkingConfig.schemaPath) {
    case 'output_config':
      return {
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort }
      }
    case 'reasoning':
      return { reasoning: { effort } }
    default:
      return { thinking: { type: 'adaptive' } }
  }
}

function toKiroCachePoint(cacheControl?: { type: string }): KiroCachePoint | undefined {
  if (!cacheControl) return undefined
  if (cacheControl.type !== 'ephemeral') {
    throw new Error(`Unsupported cache_control type: ${cacheControl.type}`)
  }
  return KIRO_CACHE_POINT
}

function mergeCachePoint(
  first?: KiroCachePoint,
  second?: KiroCachePoint
): KiroCachePoint | undefined {
  return first || second
}

export function openaiToKiro(
  request: OpenAIChatRequest,
  profileArn?: string,
  toolNameRegistry: ToolNameRegistry = new ToolNameRegistry(),
  thinkingConfig?: ThinkingConfig
): KiroPayload {
  const modelId = mapModelId(request.model)
  const origin = 'AI_EDITOR'

  // 提取系统提示
  let systemPrompt = ''
  let systemCachePoint: KiroCachePoint | undefined
  const nonSystemMessages: OpenAIMessage[] = []

  for (const msg of request.messages) {
    if (msg.role === 'system') {
      systemCachePoint = mergeCachePoint(systemCachePoint, toKiroCachePoint(msg.cache_control))
      if (typeof msg.content === 'string') {
        systemPrompt += (systemPrompt ? '\n' : '') + msg.content
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          systemCachePoint = mergeCachePoint(systemCachePoint, toKiroCachePoint(part.cache_control))
          if (part.type === 'text' && part.text) {
            systemPrompt += (systemPrompt ? '\n' : '') + part.text
          }
        }
      }
    } else {
      nonSystemMessages.push(msg)
    }
  }

  // 注入时间戳
  const timestamp = new Date().toISOString()
  systemPrompt = `[Context: Current time is ${timestamp}]\n\n${systemPrompt}`

  // 注入执行导向指令（防止 AI 在探索过程中丢失目标）
  const executionDirective = `
<execution_discipline>
当用户要求执行特定任务时，你必须遵循以下纪律：
1. **目标锁定**：在整个会话中始终牢记用户的原始目标，不要在代码探索过程中迷失方向
2. **行动优先**：优先执行任务而非仅分析或总结，除非用户明确只要求分析
3. **计划执行**：为任务创建明确的步骤计划，逐步执行并标记完成状态
4. **禁止确认性收尾**：在任务未完成前，禁止输出"需要我继续吗？"、"需要深入分析吗？"等确认性问题
5. **持续推进**：如果发现部分任务已完成，立即继续执行剩余未完成的任务
6. **完整交付**：直到所有任务步骤都执行完毕才算完成
</execution_discipline>
`
  systemPrompt = systemPrompt + '\n\n' + executionDirective

  // 构建历史消息（参考 Proxycast 实现）
  const history: KiroHistoryMessage[] = []
  const toolResults: KiroToolResult[] = []
  let currentContent = ''
  let currentCachePoint: KiroCachePoint | undefined
  const images: KiroImage[] = []
  const documents: KiroDocument[] = []
  for (let i = 0; i < nonSystemMessages.length; i++) {
    const msg = nonSystemMessages[i]
    const isLast = i === nonSystemMessages.length - 1

    if (msg.role === 'user') {
      const {
        content: userContent,
        images: userImages,
        documents: userDocuments,
        cachePoint
      } = extractOpenAIContent(msg)

      const mergedContent = userContent || 'Continue'
      const messageCachePoint = cachePoint

      if (isLast) {
        currentContent = mergedContent
        currentCachePoint = messageCachePoint
        images.push(...userImages)
        documents.push(...userDocuments)
      } else {
        history.push({
          userInputMessage: {
            content: mergedContent,
            modelId,
            origin,
            images: userImages.length > 0 ? userImages : undefined,
            documents: userDocuments.length > 0 ? userDocuments : undefined,
            ...(messageCachePoint ? { cachePoint: messageCachePoint } : {})
          }
        })
      }
    } else if (msg.role === 'assistant') {
      // Kiro API 要求 content 非空
      // 注意: 故意不读取 msg.reasoning_content (history 中不传给 Kiro)
      // Kiro 后端 schema 仅在响应输出中支持 assistantResponseMessage.reasoningContent，
      // 在请求 history 中传入此字段会触发 400 "Improperly formed request"
      let assistantContent = typeof msg.content === 'string' ? msg.content : ''
      if (!assistantContent.trim() && msg.tool_calls && msg.tool_calls.length > 0) {
        assistantContent = ' '
      } else if (!assistantContent.trim()) {
        assistantContent = 'I understand.'
      }
      const toolUses: KiroToolUse[] = []

      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.type === 'function') {
            let input = {}
            try {
              input = JSON.parse(tc.function.arguments)
            } catch {
              /* ignore */
            }
            toolUses.push({
              toolUseId: tc.id,
              name: toolNameRegistry.toKiroName(tc.function.name),
              input
            })
          }
        }
      }

      history.push({
        assistantResponseMessage: {
          content: assistantContent,
          toolUses: toolUses.length > 0 ? toolUses : undefined
        }
      })
    } else if (msg.role === 'tool') {
      // Tool result - 收集到待处理列表
      if (msg.tool_call_id) {
        let rawText = ''
        let extractedImageCount = 0
        // content 是数组时（部分客户端把图像/多模态结果挂在这里）：
        // 提取所有 text 块拼接为文本；image_url 块提取到外层 images，避免被 JSON.stringify 序列化丢失
        if (Array.isArray(msg.content)) {
          const textParts: string[] = []
          for (const part of msg.content) {
            if (part.type === 'text' && typeof part.text === 'string') {
              textParts.push(part.text)
            } else if (part.type === 'image_url' && part.image_url?.url) {
              const img = parseImageUrl(part.image_url.url)
              if (img) {
                images.push(img)
                extractedImageCount++
              }
            }
          }
          rawText = textParts.join('')
          if (!rawText && extractedImageCount === 0) {
            // 退化：把不识别的结构 stringify 让模型至少看到原始结构
            rawText = JSON.stringify(msg.content)
          }
          if (extractedImageCount > 0) {
            rawText =
              (rawText ? rawText + '\n\n' : '') +
              `[Tool returned ${extractedImageCount} image${extractedImageCount > 1 ? 's' : ''}, attached to this message]`
          }
        } else {
          rawText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        }
        toolResults.push({
          toolUseId: msg.tool_call_id,
          content: [{ text: rawText || '(no output)' }],
          status: 'success'
        })
      }

      // 检查下一条消息：如果不是 tool 消息或已到末尾，将收集的 toolResults 添加为 user 消息
      const nextMsg = nonSystemMessages[i + 1]
      const shouldFlush = !nextMsg || nextMsg.role !== 'tool'

      if (shouldFlush && toolResults.length > 0 && !isLast) {
        // 将 toolResults 作为 user 消息添加到 history
        history.push({
          userInputMessage: {
            content: 'Tool results provided.',
            modelId,
            origin,
            userInputMessageContext: {
              toolResults: [...toolResults]
            }
          }
        })
        // 清空已处理的 toolResults
        toolResults.length = 0
      }
    }
  }

  // 如果最后一条是 assistant 消息，自动发送 Continue（参考 Proxycast）
  if (
    history.length > 0 &&
    history[history.length - 1].assistantResponseMessage &&
    !currentContent
  ) {
    currentContent = 'Continue.'
  }

  // 如果没有当前内容但有工具结果（最后一轮的），保留它们传给 currentMessage
  if (!currentContent && toolResults.length > 0) {
    currentContent = 'Tool results provided.'
  }

  // System prompt 以 Kiro 官方方式注入：作为 Human/AI pair 插入到 history 头部
  if (systemPrompt) {
    const systemMessages: KiroHistoryMessage[] = [
      {
        userInputMessage: {
          content: systemPrompt,
          userInputMessageContext: {},
          origin,
          ...(systemCachePoint ? { cachePoint: systemCachePoint } : {})
        }
      },
      {
        assistantResponseMessage: {
          content: 'I will follow these instructions.'
        }
      }
    ]
    history.unshift(...systemMessages)
  }
  const finalContent = currentContent || 'Continue.'

  // 转换工具定义
  const kiroTools = convertOpenAITools(request.tools, toolNameRegistry)

  // OpenAI 兼容请求的 thinking/reasoning_effort 映射到 Kiro additionalModelRequestFields
  const additionalModelRequestFields = buildThinkingFields(
    thinkingConfig,
    request.thinking as { type: string; budget_tokens?: number },
    request.reasoning_effort
  )

  return buildKiroPayload(
    finalContent,
    modelId,
    origin,
    history,
    kiroTools,
    toolResults,
    images,
    profileArn,
    {
      maxTokens: request.max_tokens,
      temperature: request.temperature,
      topP: request.top_p
    },
    {
      cachePoint: currentCachePoint,
      documents,
      conversationId: request.conversation_id,
      context: request.kiro_context
    },
    additionalModelRequestFields
  )
}

function extractOpenAIContent(msg: OpenAIMessage): {
  content: string
  images: KiroImage[]
  documents: KiroDocument[]
  cachePoint?: KiroCachePoint
} {
  const images: KiroImage[] = []
  const documents: KiroDocument[] = []
  let content = ''
  let cachePoint = toKiroCachePoint(msg.cache_control)

  if (typeof msg.content === 'string') {
    content = msg.content
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      cachePoint = mergeCachePoint(cachePoint, toKiroCachePoint(part.cache_control))
      if (part.type === 'text' && part.text) {
        content += part.text
      } else if (part.type === 'image_url' && part.image_url?.url) {
        const image = parseImageUrl(part.image_url.url)
        if (image) {
          images.push(image)
        }
      } else if (part.type === 'file' || part.type === 'document') {
        if (part.file?.file_data) {
          const name = part.file.filename || part.name
          if (!name) {
            throw new Error(`${part.type} requires filename or name`)
          }
          documents.push(parseOpenAIFileData(part.file.file_data, name))
        } else if (part.source) {
          if (!part.name) {
            throw new Error(`${part.type} requires name`)
          }
          documents.push(parseClaudeDocumentSource(part.source, part.name))
        } else {
          throw new Error(`${part.type} requires file_data or source`)
        }
      }
    }
  }

  return { content, images, documents, cachePoint }
}

// 解析图像 URL（支持 data URL 和 HTTP URL）
function parseImageUrl(url: string): KiroImage | null {
  if (url.startsWith('data:')) {
    // 解析 data URL: data:image/png;base64,xxxxx
    const match = url.match(/^data:image\/(\w+);base64,(.+)$/)
    if (match) {
      return {
        format: normalizeImageFormat(match[1]),
        source: { bytes: match[2] }
      }
    }
  }
  return null
}

function parseOpenAIFileData(fileData: string, name: string): KiroDocument {
  const dataUrlMatch = fileData.match(/^data:([^;]+);base64,(.+)$/)
  if (dataUrlMatch) {
    return {
      format: normalizeDocumentFormat(dataUrlMatch[1], name),
      name,
      source: { bytes: dataUrlMatch[2] }
    }
  }

  return {
    format: normalizeDocumentFormat(undefined, name),
    name,
    source: { bytes: fileData }
  }
}

function parseClaudeDocumentSource(
  source: NonNullable<ClaudeContentBlock['source']>,
  name: string
): KiroDocument {
  if (source.type === 'base64') {
    return {
      format: normalizeDocumentFormat(source.media_type, name),
      name,
      source: { bytes: source.data }
    }
  }
  if (source.type === 'text') {
    return {
      format: normalizeDocumentFormat(source.media_type, name),
      name,
      source: { bytes: Buffer.from(source.data, 'utf8').toString('base64') }
    }
  }
  throw new Error(`Unsupported document source type: ${source.type}`)
}

// 标准化图像格式
function normalizeImageFormat(format: string): string {
  const lower = format.toLowerCase()
  const formatMap: Record<string, string> = {
    jpg: 'jpeg',
    jpeg: 'jpeg',
    png: 'png',
    gif: 'gif',
    webp: 'webp'
  }
  const normalized = formatMap[lower]
  if (!normalized) {
    throw new Error(`Unsupported image format: ${format}`)
  }
  return normalized
}

function normalizeDocumentFormat(mediaType: string | undefined, name: string): string {
  const lowerMediaType = mediaType?.toLowerCase()
  if (lowerMediaType === 'application/pdf') return 'pdf'
  if (lowerMediaType === 'text/markdown') return 'md'
  if (lowerMediaType === 'text/csv') return 'csv'
  if (lowerMediaType === 'text/html') return 'html'
  if (lowerMediaType?.startsWith('text/')) return 'txt'
  const extension = name.split('.').pop()?.toLowerCase()
  if (extension === 'pdf') return 'pdf'
  if (extension === 'md' || extension === 'markdown') return 'md'
  if (extension === 'csv') return 'csv'
  if (extension === 'html' || extension === 'htm') return 'html'
  return 'txt'
}

// Kiro API 工具描述最大长度
const KIRO_MAX_TOOL_DESC_LEN = 10237 // 留出 "..." 的空间

function convertOpenAITools(
  tools: OpenAITool[] | undefined,
  toolNameRegistry: ToolNameRegistry
): KiroToolWrapper[] {
  if (!tools) return []

  return tools.flatMap((tool) => {
    let description = tool.function.description || `Tool: ${tool.function.name}`
    // 截断过长的描述
    if (description.length > KIRO_MAX_TOOL_DESC_LEN) {
      description = description.substring(0, KIRO_MAX_TOOL_DESC_LEN) + '...'
    }
    const kiroTool: KiroToolWrapper = {
      toolSpecification: {
        name: shortenToolName(tool.function.name, toolNameRegistry),
        description,
        inputSchema: { json: tool.function.parameters }
      }
    }
    const cachePoint = toKiroCachePoint(tool.cache_control)
    return cachePoint ? [kiroTool, { cachePoint }] : [kiroTool]
  })
}

function shortenToolName(name: string, toolNameRegistry: ToolNameRegistry): string {
  return toolNameRegistry.toKiroName(name)
}
