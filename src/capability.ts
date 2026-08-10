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
  streaming: boolean
  hostedTools?: string[]
}

export interface DegradationRecord {
  blockType: 'image' | 'document' | 'thinking' | 'provider_blocks'
  action: 'filtered' | 'document-to-images' | 'document-to-text'
  reason: string
}

export interface DocumentConverters {
  toImages?: (document: DocumentBlock) => ImageBlock[]
  toText?: (document: DocumentBlock) => string
}

export interface CapabilityTransformOptions {
  documentConverters?: DocumentConverters
  preferDocumentImages?: boolean
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
  degradations: DegradationRecord[],
): AssistantBlock[] {
  const transformed: AssistantBlock[] = []
  for (const block of blocks) {
    if (block.type === 'tool_call' && !capability.toolCalls) {
      throw new CapabilityError(
        'tool_calls_unsupported',
        '该 provider 不支持 tool calls',
      )
    }
    if (block.type === 'thinking' && capability.thinking === 'unsupported') {
      degradations.push({
        blockType: 'thinking',
        action: 'filtered',
        reason: '目标 provider 不支持 thinking 回放',
      })
      continue
    }
    if (
      block.type === 'provider_blocks' &&
      capability.thinking === 'unsupported'
    ) {
      degradations.push({
        blockType: 'provider_blocks',
        action: 'filtered',
        reason: '目标 provider 不支持 provider-bound reasoning 回放',
      })
      continue
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
            degradations,
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
