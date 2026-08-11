import type { JsonObject, JsonValue, Role } from './types'

export type ValidationRule = 'IR' | 'I1' | 'I2' | 'I4' | 'I5' | 'I6'

export interface ValidationIssue {
  rule: ValidationRule
  code: string
  messageIndex: number
  blockIndex?: number
  message: string
}

export interface ValidationOptions {
  targetProviderId?: string
}

export interface ValidationResult {
  valid: boolean
  issues: ValidationIssue[]
}

interface ToolCallState {
  messageIndex: number
  blockIndex: number
  resultCount: number
  /** 该 id 由 provider_blocks verbatim 回放注册；同 id 的 tool_call block 是
   *  codec 自带的结构化表达（encode 时去重），不算重复 id。 */
  fromProviderBlocks?: boolean
}

const allowedBlocksByRole: Record<Role, ReadonlySet<string>> = {
  user: new Set(['text', 'image', 'document']),
  assistant: new Set([
    'text',
    'thinking',
    'redacted_thinking',
    'tool_call',
    'refusal',
    'provider_blocks',
  ]),
  tool: new Set(['tool_result']),
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return true
  }

  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (!isRecord(value)) return false

  return Object.values(value).every(isJsonValue)
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function addIssue(
  issues: ValidationIssue[],
  rule: ValidationRule,
  code: string,
  messageIndex: number,
  blockIndex: number | undefined,
  message: string,
): void {
  const location =
    blockIndex === undefined ? { messageIndex } : { messageIndex, blockIndex }

  issues.push({ rule, code, ...location, message })
}

function validateImage(
  value: unknown,
  issues: ValidationIssue[],
  messageIndex: number,
  blockIndex: number,
): void {
  if (!isRecord(value) || value.type !== 'image') {
    addIssue(
      issues,
      'IR',
      'invalid_image',
      messageIndex,
      blockIndex,
      'image block 必须是对象且 type=image',
    )
    return
  }

  const source = value.source
  if (
    !isRecord(source) ||
    source.type !== 'base64' ||
    !isNonEmptyString(source.mediaType) ||
    !isNonEmptyString(source.data)
  ) {
    addIssue(
      issues,
      'IR',
      'invalid_image_source',
      messageIndex,
      blockIndex,
      'image source 必须包含非空 base64 mediaType 与 data',
    )
  }
}

function validateDocument(
  block: Record<string, unknown>,
  issues: ValidationIssue[],
  messageIndex: number,
  blockIndex: number,
): void {
  const source = block.source
  if (!isRecord(source)) {
    addIssue(
      issues,
      'IR',
      'invalid_document_source',
      messageIndex,
      blockIndex,
      'document source 必须是对象',
    )
    return
  }

  const valid =
    (source.type === 'base64' &&
      isNonEmptyString(source.mediaType) &&
      isNonEmptyString(source.data)) ||
    (source.type === 'url' && isNonEmptyString(source.url)) ||
    (source.type === 'text' &&
      typeof source.text === 'string' &&
      (source.mediaType === undefined || typeof source.mediaType === 'string'))

  if (!valid) {
    addIssue(
      issues,
      'IR',
      'invalid_document_source',
      messageIndex,
      blockIndex,
      'document source 与声明的 source type 不匹配',
    )
  }
}

function validateProviderBinding(
  block: Record<string, unknown>,
  options: ValidationOptions,
  issues: ValidationIssue[],
  messageIndex: number,
  blockIndex: number,
): void {
  if (!isNonEmptyString(block.providerId)) {
    addIssue(
      issues,
      'I6',
      'missing_provider_id',
      messageIndex,
      blockIndex,
      'provider-bound block 必须包含非空 providerId',
    )
    return
  }

  if (
    options.targetProviderId !== undefined &&
    block.providerId !== options.targetProviderId
  ) {
    addIssue(
      issues,
      'I6',
      'provider_mismatch',
      messageIndex,
      blockIndex,
      `block 属于 ${block.providerId}，目标 provider 为 ${options.targetProviderId}`,
    )
  }
}

function validateBlockSchema(
  block: Record<string, unknown>,
  role: Role,
  options: ValidationOptions,
  issues: ValidationIssue[],
  messageIndex: number,
  blockIndex: number,
): void {
  const type = block.type
  if (typeof type !== 'string') {
    addIssue(
      issues,
      'IR',
      'missing_block_type',
      messageIndex,
      blockIndex,
      'block.type 必须是字符串',
    )
    return
  }

  if (!allowedBlocksByRole[role].has(type)) {
    addIssue(
      issues,
      'IR',
      'block_not_allowed_for_role',
      messageIndex,
      blockIndex,
      `${role} 消息不允许 ${type} block`,
    )
    return
  }

  switch (type) {
    case 'text':
      if (typeof block.text !== 'string') {
        addIssue(
          issues,
          'IR',
          'invalid_text',
          messageIndex,
          blockIndex,
          'text block 必须包含字符串 text',
        )
      }
      break
    case 'redacted_thinking':
      if (typeof block.data !== 'string' || block.data.length === 0) {
        addIssue(
          issues,
          'IR',
          'invalid_redacted_thinking',
          messageIndex,
          blockIndex,
          'redacted_thinking.data 必须是非空字符串',
        )
      }
      validateProviderBinding(
        block,
        options,
        issues,
        messageIndex,
        blockIndex,
      )
      break
    case 'thinking':
      if (typeof block.thinking !== 'string') {
        addIssue(
          issues,
          'I2',
          'invalid_thinking',
          messageIndex,
          blockIndex,
          'thinking 必须是字符串',
        )
      }
      if (typeof block.signature !== 'string') {
        addIssue(
          issues,
          'I2',
          'invalid_thinking_provenance',
          messageIndex,
          blockIndex,
          'thinking.signature 必须是 provider 下发的 opaque provenance token；无 token 时使用空字符串',
        )
      }
      validateProviderBinding(
        block,
        options,
        issues,
        messageIndex,
        blockIndex,
      )
      break
    case 'tool_call':
      if (!isNonEmptyString(block.id)) {
        addIssue(
          issues,
          'I4',
          'empty_tool_call_id',
          messageIndex,
          blockIndex,
          'tool_call.id 必须非空',
        )
      }
      if (!isNonEmptyString(block.name)) {
        addIssue(
          issues,
          'IR',
          'empty_tool_name',
          messageIndex,
          blockIndex,
          'tool_call.name 必须非空',
        )
      }
      if (!isJsonObject(block.arguments)) {
        addIssue(
          issues,
          'I5',
          'arguments_not_object',
          messageIndex,
          blockIndex,
          'tool_call.arguments 必须是 JSON object',
        )
      }
      break
    case 'tool_result':
      if (!isNonEmptyString(block.toolCallId)) {
        addIssue(
          issues,
          'I1',
          'missing_tool_call_id',
          messageIndex,
          blockIndex,
          'tool_result.toolCallId 必须非空',
        )
      }
      if (typeof block.content !== 'string') {
        addIssue(
          issues,
          'IR',
          'invalid_tool_result_content',
          messageIndex,
          blockIndex,
          'tool_result.content 必须是字符串',
        )
      }
      if (block.images !== undefined) {
        if (!Array.isArray(block.images)) {
          addIssue(
            issues,
            'IR',
            'invalid_tool_result_images',
            messageIndex,
            blockIndex,
            'tool_result.images 必须是数组',
          )
        } else {
          for (const image of block.images) {
            validateImage(image, issues, messageIndex, blockIndex)
          }
        }
      }
      break
    case 'image':
      validateImage(block, issues, messageIndex, blockIndex)
      break
    case 'document':
      validateDocument(block, issues, messageIndex, blockIndex)
      break
    case 'refusal':
      if (
        (block.category !== undefined &&
          typeof block.category !== 'string') ||
        (block.explanation !== undefined &&
          typeof block.explanation !== 'string')
      ) {
        addIssue(
          issues,
          'IR',
          'invalid_refusal',
          messageIndex,
          blockIndex,
          'refusal 的 category 与 explanation 必须是字符串',
        )
      }
      break
    case 'provider_blocks':
      validateProviderBinding(
        block,
        options,
        issues,
        messageIndex,
        blockIndex,
      )
      if (
        !Array.isArray(block.blocks) ||
        !block.blocks.every((value) => isJsonValue(value))
      ) {
        addIssue(
          issues,
          'IR',
          'invalid_provider_blocks',
          messageIndex,
          blockIndex,
          'provider_blocks.blocks 必须是 JSON value 数组',
        )
      }
      break
  }
}

export function validateMessages(
  messages: unknown,
  options: ValidationOptions = {},
): ValidationResult {
  const issues: ValidationIssue[] = []
  const calls = new Map<string, ToolCallState>()

  if (!Array.isArray(messages)) {
    addIssue(
      issues,
      'IR',
      'messages_not_array',
      -1,
      undefined,
      '消息序列必须是数组',
    )
    return { valid: false, issues }
  }

  for (const [messageIndex, message] of messages.entries()) {
    if (!isRecord(message)) {
      addIssue(
        issues,
        'IR',
        'invalid_message',
        messageIndex,
        undefined,
        '消息必须是对象',
      )
      continue
    }

    const role = message.role
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') {
      addIssue(
        issues,
        'IR',
        'invalid_role',
        messageIndex,
        undefined,
        'role 只能是 user、assistant 或 tool',
      )
      continue
    }

    if (!Array.isArray(message.content) || message.content.length === 0) {
      addIssue(
        issues,
        'IR',
        'empty_message_content',
        messageIndex,
        undefined,
        '请求历史中的消息必须包含至少一个 block',
      )
      continue
    }

    for (const [blockIndex, block] of message.content.entries()) {
      if (!isRecord(block)) {
        addIssue(
          issues,
          'IR',
          'invalid_block',
          messageIndex,
          blockIndex,
          'block 必须是对象',
        )
        continue
      }

      validateBlockSchema(
        block,
        role,
        options,
        issues,
        messageIndex,
        blockIndex,
      )

      if (role === 'assistant' && block.type === 'tool_call') {
        const id = block.id
        if (isNonEmptyString(id)) {
          const existing = calls.get(id)
          if (existing !== undefined && !existing.fromProviderBlocks) {
            addIssue(
              issues,
              'I1',
              'duplicate_tool_call_id',
              messageIndex,
              blockIndex,
              `tool_call.id ${id} 在序列中重复`,
            )
          } else if (existing === undefined) {
            calls.set(id, { messageIndex, blockIndex, resultCount: 0 })
          }
        }
      }

      // verbatim 回放块内嵌的 function_call 同样构成 I1 配对来源；两种合法形态：
      // (a) function_call 在 provider_blocks、配对 function_call_output 以 tool_result 出现
      //     （回放后模型再次发起 tool loop 的中间态）；
      // (b) function_call 与 function_call_output 同在 provider_blocks（完整历史回放）。
      if (role === 'assistant' && block.type === 'provider_blocks') {
        const rawCalls: string[] = []
        const rawOutputs: string[] = []
        for (const raw of block.blocks as unknown[]) {
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
          const rawType = (raw as { type?: unknown }).type
          if (rawType === 'function_call' || rawType === 'tool_use') {
            // Responses function_call 用 call_id；Anthropic tool_use 用 id
            const callId = (raw as { call_id?: unknown }).call_id ?? (raw as { id?: unknown }).id
            if (typeof callId === 'string' && callId.length > 0) rawCalls.push(callId)
          } else if (rawType === 'function_call_output' || rawType === 'tool_result') {
            const callId = (raw as { call_id?: unknown }).call_id ?? (raw as { tool_use_id?: unknown }).tool_use_id
            if (typeof callId === 'string' && callId.length > 0) rawOutputs.push(callId)
          }
        }
        for (const callId of rawCalls) {
          if (!calls.has(callId)) {
            calls.set(callId, { messageIndex, blockIndex, resultCount: 0, fromProviderBlocks: true })
          }
        }
        for (const callId of rawOutputs) {
          const call = calls.get(callId)
          if (call !== undefined && call.resultCount === 0) {
            call.resultCount = 1
          }
        }
      }

      if (role === 'tool' && block.type === 'tool_result') {
        const toolCallId = block.toolCallId
        if (isNonEmptyString(toolCallId)) {
          const call = calls.get(toolCallId)
          if (call === undefined) {
            addIssue(
              issues,
              'I1',
              'orphan_tool_result',
              messageIndex,
              blockIndex,
              `tool_result 引用了不存在或尚未出现的 ${toolCallId}`,
            )
          } else if (call.resultCount > 0) {
            addIssue(
              issues,
              'I1',
              'duplicate_tool_result',
              messageIndex,
              blockIndex,
              `tool_call ${toolCallId} 存在多个 tool_result`,
            )
            call.resultCount += 1
          } else {
            call.resultCount = 1
          }
        }
      }
    }
  }

  for (const [id, call] of calls) {
    if (call.resultCount === 0) {
      addIssue(
        issues,
        'I1',
        'orphan_tool_call',
        call.messageIndex,
        call.blockIndex,
        `tool_call ${id} 没有后续 tool_result`,
      )
    }
  }

  return { valid: issues.length === 0, issues }
}
