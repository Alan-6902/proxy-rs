export const CLAUDE_CODE_PING_INTERVAL_MS = 25_000
export const CLAUDE_CODE_MAX_BUFFER_BYTES = 8 * 1024 * 1024
export const CLAUDE_CODE_MAX_WAIT_MS = 120_000

export type ClaudeCodeSseWriter = (frame: string) => Promise<void>

export interface ClaudeCodeStreamBufferOptions {
  pingIntervalMs?: number
  maxBufferBytes?: number
  maxWaitMs?: number
}

/**
 * Claude Code needs an accurate input_tokens value in its first business SSE
 * event. This serializes all writes, buffers only until context usage arrives,
 * and releases early with the original estimate when a safety bound is hit.
 */
export class ClaudeCodeStreamBuffer {
  private readonly frames: string[] = []
  private bufferedBytes = 0
  private released = false
  private discarded = false
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly pingTimer: ReturnType<typeof setInterval>
  private readonly timeoutTimer: ReturnType<typeof setTimeout>
  private readonly maxBufferBytes: number

  constructor(
    private readonly writeFrame: ClaudeCodeSseWriter,
    private readonly isClosed: () => boolean,
    private readonly fallbackInputTokens: number,
    options: ClaudeCodeStreamBufferOptions = {}
  ) {
    this.maxBufferBytes = options.maxBufferBytes ?? CLAUDE_CODE_MAX_BUFFER_BYTES
    const pingIntervalMs = options.pingIntervalMs ?? CLAUDE_CODE_PING_INTERVAL_MS
    const maxWaitMs = options.maxWaitMs ?? CLAUDE_CODE_MAX_WAIT_MS
    this.pingTimer = setInterval(() => {
      void this.sendPing()
    }, pingIntervalMs)
    this.timeoutTimer = setTimeout(() => {
      void this.release(this.fallbackInputTokens)
    }, maxWaitMs)
  }

  write(frame: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.discarded || this.isClosed()) {
        this.discardInternal()
        return
      }
      if (this.released) {
        await this.writeFrame(frame)
        return
      }
      this.frames.push(frame)
      this.bufferedBytes += Buffer.byteLength(frame)
      if (this.bufferedBytes > this.maxBufferBytes) {
        await this.releaseInternal(this.fallbackInputTokens)
      }
    })
  }

  release(inputTokens: number): Promise<void> {
    return this.enqueue(() => this.releaseInternal(inputTokens))
  }

  discard(): void {
    this.discarded = true
    this.stopTimers()
    this.frames.length = 0
    this.bufferedBytes = 0
  }

  /**
   * 缓冲是否已释放（即帧是否已真正写入响应流）。
   *
   * 调用方据此判断中途失败时补发收尾帧有无意义：未释放时 discard 会连
   * message_start 一起丢掉，客户端本就收不到任何内容帧，补收尾反而多余。
   */
  get isReleased(): boolean {
    return this.released
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.writeQueue = this.writeQueue.then(operation).catch(() => {
      this.discard()
    })
    return this.writeQueue
  }

  private async releaseInternal(inputTokens: number): Promise<void> {
    if (this.discarded || this.isClosed()) {
      this.discardInternal()
      return
    }
    if (this.released) return
    this.released = true
    this.stopTimers()
    for (const frame of this.frames) {
      await this.writeFrame(this.rewriteMessageStart(frame, inputTokens))
      if (this.isClosed()) {
        this.discardInternal()
        return
      }
    }
    this.frames.length = 0
    this.bufferedBytes = 0
  }

  private sendPing(): Promise<void> {
    return this.enqueue(async () => {
      if (this.discarded || this.isClosed()) {
        this.discardInternal()
        return
      }
      // release 已在同一队列中完成时，ping 不再写入，也绝不能清空已释放帧。
      if (this.released) {
        this.stopTimers()
        return
      }
      await this.writeFrame('event: ping\ndata: {"type":"ping"}\n\n')
    })
  }

  private discardInternal(): void {
    this.discard()
  }

  private stopTimers(): void {
    clearInterval(this.pingTimer)
    clearTimeout(this.timeoutTimer)
  }

  private rewriteMessageStart(frame: string, inputTokens: number): string {
    if (!frame.startsWith('event: message_start\n')) return frame
    const dataPrefix = 'data: '
    const dataStart = frame.indexOf(dataPrefix)
    if (dataStart < 0) return frame
    const jsonStart = dataStart + dataPrefix.length
    const jsonEnd = frame.indexOf('\n', jsonStart)
    if (jsonEnd < 0) return frame
    try {
      const event = JSON.parse(frame.slice(jsonStart, jsonEnd)) as {
        message?: { usage?: { input_tokens?: number } }
      }
      if (!event.message?.usage) return frame
      event.message.usage.input_tokens = inputTokens
      return `${frame.slice(0, jsonStart)}${JSON.stringify(event)}${frame.slice(jsonEnd)}`
    } catch {
      return frame
    }
  }
}
