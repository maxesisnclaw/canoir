import type {
  AssistantBlock,
  DocumentBlock,
  ImageBlock,
  Message,
  ToolResultBlock,
  UserBlock,
} from './types'

export interface ProviderCapability {
  vision: boolean
  document: 'native' | 'degrade' | 'unsupported'
  toolCalls: boolean
  thinking: 'native' | 'disabled-param' | 'unsupported'
  thinkingReplay: 'verify-replay' | 'replay' | 'drop'
  promptCaching: 'explicit-markers' | 'automatic' | 'none'
  streaming: boolean
  hostedTools?: string[]
}

export type PromptCacheAnchor =
  | { kind: 'system' }
  | { kind: 'tools' }
  | { kind: 'history' }
  | { kind: 'message'; nthFromEnd: number }

export interface PromptCacheHint {
  anchors: PromptCacheAnchor[]
}

export interface DegradationRecord {
  blockType:
    | 'image'
    | 'document'
    | 'thinking'
    | 'provider_blocks'
    | 'prompt_cache'
  action:
    | 'filtered'
    | 'document-to-images'
    | 'document-to-text'
    | 'cache-hint-ignored'
  reason: string
}

export interface DocumentConverters {
  toImages?: (document: DocumentBlock) => ImageBlock[]
  toText?: (document: DocumentBlock) => string
}

export interface CapabilityTransformOptions {
  documentConverters?: DocumentConverters
  preferDocumentImages?: boolean
  promptCache?: PromptCacheHint
}

export interface CapabilityTransformResult {
  messages: Message[]
  degradations: DegradationRecord[]
}

export class CapabilityError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CapabilityError'
    this.code = code
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function promptCacheAnchorKey(anchor: PromptCacheAnchor): string {
  return anchor.kind === 'message'
    ? `message:${anchor.nthFromEnd}`
    : anchor.kind
}

export function resolvePromptCacheAnchors(
  hint: PromptCacheHint | undefined,
  capability: ProviderCapability,
  degradations: DegradationRecord[],
): PromptCacheAnchor[] {
  if (hint === undefined) return []
  if (!isRecord(hint) || !Array.isArray(hint.anchors)) {
    throw new CapabilityError(
      'invalid_prompt_cache_hint',
      'promptCache 必须包含 anchors 数组',
    )
  }

  const anchors: PromptCacheAnchor[] = []
  const seen = new Set<string>()
  for (const value of hint.anchors) {
    if (!isRecord(value)) {
      throw new CapabilityError(
        'invalid_prompt_cache_anchor',
        'prompt cache anchor 必须包含 kind',
      )
    }
    const raw = value as Record<string, unknown>
    if (typeof raw.kind !== 'string') {
      throw new CapabilityError(
        'invalid_prompt_cache_anchor',
        'prompt cache anchor 必须包含 kind',
      )
    }
    let anchor: PromptCacheAnchor
    if (
      raw.kind === 'system' ||
      raw.kind === 'tools' ||
      raw.kind === 'history'
    ) {
      anchor = { kind: raw.kind }
    } else if (raw.kind === 'message') {
      if (
        typeof raw.nthFromEnd !== 'number' ||
        !Number.isInteger(raw.nthFromEnd) ||
        raw.nthFromEnd <= 0
      ) {
        throw new CapabilityError(
          'invalid_prompt_cache_anchor',
          'message cache anchor 的 nthFromEnd 必须是正整数',
        )
      }
      anchor = { kind: 'message', nthFromEnd: raw.nthFromEnd }
    } else {
      throw new CapabilityError(
        'invalid_prompt_cache_anchor',
        `未知 prompt cache anchor: ${raw.kind}`,
      )
    }
    const key = promptCacheAnchorKey(anchor)
    if (!seen.has(key)) {
      seen.add(key)
      anchors.push(anchor)
    }
  }

  if (anchors.length === 0) return []
  if (capability.promptCaching !== 'explicit-markers') {
    degradations.push({
      blockType: 'prompt_cache',
      action: 'cache-hint-ignored',
      reason:
        capability.promptCaching === 'automatic'
          ? '目标 provider 自动管理 prompt cache，忽略显式锚点'
          : '目标 provider 不支持 prompt cache，忽略缓存锚点',
    })
    return []
  }
  return anchors
}

export function normalizeCapability(
  capability: Partial<ProviderCapability>,
): ProviderCapability {
  return {
    vision: capability.vision === true,
    document:
      capability.document === 'native' || capability.document === 'degrade'
        ? capability.document
        : 'unsupported',
    toolCalls: capability.toolCalls === true,
    thinking:
      capability.thinking === 'native' ||
      capability.thinking === 'disabled-param'
        ? capability.thinking
        : 'unsupported',
    thinkingReplay:
      capability.thinkingReplay === 'verify-replay' ||
      capability.thinkingReplay === 'replay'
        ? capability.thinkingReplay
        : 'drop',
    promptCaching:
      capability.promptCaching === 'explicit-markers' ||
      capability.promptCaching === 'automatic'
        ? capability.promptCaching
        : 'none',
    streaming: capability.streaming === true,
    ...(capability.hostedTools === undefined
      ? {}
      : { hostedTools: [...new Set(capability.hostedTools)] }),
  }
}

function degradeDocument(
  block: DocumentBlock,
  capability: ProviderCapability,
  options: CapabilityTransformOptions,
  degradations: DegradationRecord[],
): UserBlock[] {
  if (capability.document === 'native') return [block]
  if (capability.document === 'unsupported') {
    throw new CapabilityError(
      'document_unsupported',
      '该 provider 不支持 document',
    )
  }

  const converters = options.documentConverters
  if (
    options.preferDocumentImages === true &&
    capability.vision &&
    converters?.toImages !== undefined
  ) {
    const images = converters.toImages(block)
    if (images.length === 0) {
      throw new CapabilityError(
        'document_image_conversion_empty',
        'document 转图片结果为空',
      )
    }
    degradations.push({
      blockType: 'document',
      action: 'document-to-images',
      reason: '目标 provider 不原生支持 document，按版式优先转换为图片',
    })
    return images
  }

  if (converters?.toText !== undefined) {
    degradations.push({
      blockType: 'document',
      action: 'document-to-text',
      reason: '目标 provider 不原生支持 document，转换为纯文本',
    })
    return [{ type: 'text', text: converters.toText(block) }]
  }

  throw new CapabilityError(
    'document_converter_missing',
    'document 声明为可降级，但没有可执行转换器',
  )
}

function transformUserBlocks(
  blocks: readonly UserBlock[],
  capability: ProviderCapability,
  options: CapabilityTransformOptions,
  degradations: DegradationRecord[],
): UserBlock[] {
  const transformed: UserBlock[] = []
  for (const block of blocks) {
    if (block.type === 'image' && !capability.vision) {
      degradations.push({
        blockType: 'image',
        action: 'filtered',
        reason: '目标 provider 的 vision capability 为 false',
      })
      continue
    }
    if (block.type === 'document') {
      transformed.push(
        ...degradeDocument(block, capability, options, degradations),
      )
      continue
    }
    transformed.push(block)
  }
  if (transformed.length === 0) transformed.push({ type: 'text', text: '' })
  return transformed
}

function transformAssistantBlocks(
  blocks: readonly AssistantBlock[],
  capability: ProviderCapability,
): AssistantBlock[] {
  const transformed: AssistantBlock[] = []
  for (const block of blocks) {
    if (block.type === 'tool_call' && !capability.toolCalls) {
      throw new CapabilityError(
        'tool_calls_unsupported',
        '该 provider 不支持 tool calls',
      )
    }
    transformed.push(block)
  }
  if (transformed.length === 0) transformed.push({ type: 'text', text: '' })
  return transformed
}

function transformToolBlock(
  block: ToolResultBlock,
  capability: ProviderCapability,
  degradations: DegradationRecord[],
): ToolResultBlock {
  if (!capability.toolCalls) {
    throw new CapabilityError(
      'tool_calls_unsupported',
      '该 provider 不支持 tool results',
    )
  }
  if (capability.vision || (block.images?.length ?? 0) === 0) return block
  degradations.push({
    blockType: 'image',
    action: 'filtered',
    reason: '目标 provider 的 vision capability 为 false，过滤 tool result 图片',
  })
  const { images: _images, ...withoutImages } = block
  return withoutImages
}

export function applyCapability(
  messages: readonly Message[],
  capabilityInput: Partial<ProviderCapability>,
  options: CapabilityTransformOptions = {},
): CapabilityTransformResult {
  const capability = normalizeCapability(capabilityInput)
  const degradations: DegradationRecord[] = []
  const transformed: Message[] = messages.map((message): Message => {
    switch (message.role) {
      case 'user':
        return {
          role: 'user',
          content: transformUserBlocks(
            message.content,
            capability,
            options,
            degradations,
          ),
        }
      case 'assistant':
        return {
          role: 'assistant',
          content: transformAssistantBlocks(
            message.content,
            capability,
          ),
        }
      case 'tool':
        return {
          role: 'tool',
          content: message.content.map((block) =>
            transformToolBlock(block, capability, degradations),
          ) as [ToolResultBlock, ...ToolResultBlock[]],
        }
    }
  })
  return { messages: transformed, degradations }
}
