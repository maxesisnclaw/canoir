import type { AssistantMessage, Usage } from './types'

export type ResponseDegradationCode =
  | 'max_tokens'
  | 'refusal'
  | 'runaway_thinking'
  | 'empty_response'
  | 'stream_assembly_loss'

export interface StreamObservation {
  text: boolean
  toolCall: boolean
}

export interface ResponseDegradationOptions {
  thinkingTokenBudget?: number
  thinkingTokens?: number
  streamObserved?: StreamObservation
}

export class ResponseDegradationError extends Error {
  readonly code: ResponseDegradationCode
  readonly stopReason: string | null
  readonly usage: Usage

  constructor(
    code: ResponseDegradationCode,
    message: string,
    stopReason: string | null,
    usage: Usage,
  ) {
    super(message)
    this.name = 'ResponseDegradationError'
    this.code = code
    this.stopReason = stopReason
    this.usage = usage
  }
}

function responseShape(message: AssistantMessage): {
  hasText: boolean
  hasToolCall: boolean
  hasThinking: boolean
  hasRefusal: boolean
} {
  const hasNativeThinking = message.content.some(
    (block) =>
      block.type === 'provider_blocks' &&
      block.blocks.some(
        (raw) =>
          raw !== null &&
          typeof raw === 'object' &&
          !Array.isArray(raw) &&
          raw.type === 'reasoning',
      ),
  )
  return {
    hasText: message.content.some(
      (block) => block.type === 'text' && block.text.trim().length > 0,
    ),
    hasToolCall: message.content.some((block) => block.type === 'tool_call'),
    hasThinking:
      hasNativeThinking ||
      message.content.some(
        (block) => block.type === 'thinking' && block.signature.length > 0,
      ),
    hasRefusal: message.content.some((block) => block.type === 'refusal'),
  }
}

function isMaxTokensStop(stopReason: string | null): boolean {
  return (
    stopReason === 'max_tokens' ||
    stopReason === 'length' ||
    stopReason === 'incomplete:max_output_tokens'
  )
}

export function assertResponseNotDegraded(
  message: AssistantMessage,
  usage: Usage,
  stopReason: string | null,
  options: ResponseDegradationOptions = {},
): void {
  const shape = responseShape(message)

  if (shape.hasRefusal || stopReason === 'refusal' || stopReason === 'content_filter') {
    throw new ResponseDegradationError(
      'refusal',
      'provider 拒绝响应，不得提交 partial 内容',
      stopReason,
      usage,
    )
  }

  if (isMaxTokensStop(stopReason)) {
    throw new ResponseDegradationError(
      'max_tokens',
      'provider 因输出 token 上限截断响应',
      stopReason,
      usage,
    )
  }

  const observed = options.streamObserved
  if (
    (stopReason === 'tool_use' && !shape.hasToolCall) ||
    (observed?.text === true && !shape.hasText) ||
    (observed?.toolCall === true && !shape.hasToolCall)
  ) {
    throw new ResponseDegradationError(
      'stream_assembly_loss',
      '流式事件与最终组装结果不一致',
      stopReason,
      usage,
    )
  }

  const thinkingTokens = options.thinkingTokens ?? usage.outputTokens
  if (
    !shape.hasText &&
    !shape.hasToolCall &&
    shape.hasThinking &&
    options.thinkingTokenBudget !== undefined &&
    thinkingTokens > options.thinkingTokenBudget
  ) {
    throw new ResponseDegradationError(
      'runaway_thinking',
      `thinking 使用 ${thinkingTokens} tokens，超过预算 ${options.thinkingTokenBudget}`,
      stopReason,
      usage,
    )
  }

  if (!shape.hasText && !shape.hasToolCall && !shape.hasRefusal) {
    throw new ResponseDegradationError(
      'empty_response',
      '响应没有可提交的正文或工具调用',
      stopReason,
      usage,
    )
  }
}
