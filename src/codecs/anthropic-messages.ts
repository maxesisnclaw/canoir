import type {
  AssistantBlock,
  AssistantMessage,
  Block,
  DocumentBlock,
  ImageBlock,
  JsonObject,
  JsonValue,
  Message,
  ProviderBlocksBlock,
  ThinkingBlock,
  ToolCallBlock,
  ToolResultBlock,
  Usage,
} from '../types'
import { cleanWireModelId } from '../model'
import { validateMessages } from '../validate'

export type AnthropicCompatMode = 'default' | 'minimal'

export interface AnthropicCodecConfig {
  providerId: string
  model: string
  endpoint: string
  apiKey: string
  headers?: Record<string, string>
  compatMode?: AnthropicCompatMode
  contextWindowTokens?: number
  fetch?: typeof globalThis.fetch
}

export interface AnthropicToolDefinition {
  name: string
  description: string
  inputSchema: JsonObject
}

export type AnthropicThinkingOption =
  | { type: 'off' }
  | { type: 'enabled'; budgetTokens: number }

export interface AnthropicEncodeOptions {
  maxOutputTokens?: number
  stream?: boolean
  system?: string
  tools?: AnthropicToolDefinition[]
  thinking?: AnthropicThinkingOption
}

export interface AnthropicWireMessage {
  role: 'user' | 'assistant'
  content: JsonValue[]
}

export interface AnthropicRequestBody {
  model: string
  max_tokens: number
  messages: AnthropicWireMessage[]
  stream: boolean
  system?: string | JsonValue[]
  tools?: JsonValue[]
  thinking?: JsonValue
  cache_control?: JsonValue
}

export interface AnthropicEncodedRequest {
  url: string
  headers: Record<string, string>
  body: AnthropicRequestBody
}

export interface AnthropicDecodedResponse {
  message: AssistantMessage
  usage: Usage
  stopReason: string | null
}

export interface AnthropicSseEvent {
  event?: string
  data: JsonObject
}

export class AnthropicProtocolError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AnthropicProtocolError'
    this.code = code
  }
}

export class AnthropicHttpError extends Error {
  readonly status: number
  readonly responseBody: string

  constructor(status: number, responseBody: string) {
    super(`Anthropic HTTP ${status}: ${responseBody}`)
    this.name = 'AnthropicHttpError'
    this.status = status
    this.responseBody = responseBody
  }
}

export class AnthropicRefusalError extends Error {
  readonly category: string | null
  readonly explanation: string | null
  readonly partialChars: number
  readonly usage: Usage

  constructor(
    category: string | null,
    explanation: string | null,
    partialChars: number,
    usage: Usage,
  ) {
    super(
      `Anthropic refusal${category === null ? '' : ` (${category})`}: ${explanation ?? 'no explanation provided'}`,
    )
    this.name = 'AnthropicRefusalError'
    this.category = category
    this.explanation = explanation
    this.partialChars = partialChars
    this.usage = usage
  }
}

interface StreamBlockState {
  index: number
  startOrder: number
  type: string
  start: Record<string, unknown>
  text: string
  thinking: string
  signature: string
  inputBuffer: string
  parsedInput?: JsonObject
  closed: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function requireNonEmptyString(
  value: unknown,
  code: string,
  field: string,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AnthropicProtocolError(code, `${field} 必须是非空字符串`)
  }
  return value
}

function asJsonValue(value: unknown, field: string): JsonValue {
  if (!isJsonValue(value)) {
    throw new AnthropicProtocolError(
      'non_json_wire_value',
      `${field} 不是 JSON value`,
    )
  }
  return value
}

function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key] ?? null)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function stableHash(input: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function syntheticToolCallId(
  providerId: string,
  blockIndex: number,
  name: string,
  argumentsValue: JsonObject,
): string {
  const material = `${providerId}\n${blockIndex}\n${name}\n${stableJson(argumentsValue)}`
  return `synthetic-${stableHash(material)}`
}

function parseJsonObjectString(value: string, field: string): JsonObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new AnthropicProtocolError(
      'invalid_tool_arguments_json',
      `${field} 不是完整 JSON`,
    )
  }
  if (!isJsonObject(parsed)) {
    throw new AnthropicProtocolError(
      'tool_arguments_not_object',
      `${field} 解析结果必须是 object`,
    )
  }
  return parsed
}

function parseToolArguments(block: Record<string, unknown>): JsonObject {
  if (block.input !== undefined) {
    if (isJsonObject(block.input)) return block.input
    if (typeof block.input === 'string') {
      return parseJsonObjectString(block.input, 'tool_use.input')
    }
    throw new AnthropicProtocolError(
      'tool_arguments_not_object',
      'tool_use.input 必须是 object 或 JSON object 字符串',
    )
  }

  if (block.arguments !== undefined) {
    if (isJsonObject(block.arguments)) return block.arguments
    if (typeof block.arguments === 'string') {
      return parseJsonObjectString(block.arguments, 'tool_use.arguments')
    }
    throw new AnthropicProtocolError(
      'tool_arguments_not_object',
      'tool_use.arguments 必须是 object 或 JSON object 字符串',
    )
  }

  return {}
}

function numberField(value: unknown, key: string): number {
  if (!isRecord(value)) return 0
  const field = value[key]
  return typeof field === 'number' && Number.isFinite(field) && field >= 0
    ? field
    : 0
}

function usageSources(value: unknown): unknown[] {
  if (!isRecord(value)) return []
  return Array.isArray(value.iterations) ? value.iterations : [value]
}

export function normalizeAnthropicUsage(
  initialUsage: unknown,
  deltaUsage?: unknown,
): Usage {
  const sources = usageSources(initialUsage)
  let input = 0
  let output = 0
  let cacheCreation = 0
  let cacheRead = 0

  for (const source of sources) {
    input += numberField(source, 'input_tokens')
    output += numberField(source, 'output_tokens')
    cacheCreation += numberField(source, 'cache_creation_input_tokens')
    cacheRead += numberField(source, 'cache_read_input_tokens')
  }

  if (sources.length <= 1 && deltaUsage !== undefined) {
    const deltaInput = numberField(deltaUsage, 'input_tokens')
    const deltaOutput = numberField(deltaUsage, 'output_tokens')
    const deltaCreation = numberField(deltaUsage, 'cache_creation_input_tokens')
    const deltaRead = numberField(deltaUsage, 'cache_read_input_tokens')
    if (deltaInput > 0) input = deltaInput
    if (deltaOutput > 0) output = deltaOutput
    if (deltaCreation > 0) cacheCreation = deltaCreation
    if (deltaRead > 0) cacheRead = deltaRead
  }

  const totalInputTokens = input + cacheCreation + cacheRead
  return {
    totalInputTokens,
    outputTokens: output,
    reliable: totalInputTokens > 0 || output > 0,
  }
}

function encodeImage(block: ImageBlock): JsonValue {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: block.source.mediaType,
      data: block.source.data,
    },
  }
}

function rejectDocument(_block: DocumentBlock): never {
  throw new AnthropicProtocolError(
    'document_capability_required',
    'document 编码必须等待 capability 矩阵决定原生发送或显式降级',
  )
}

function encodeToolResult(block: ToolResultBlock): JsonValue {
  const content: JsonValue[] = []
  for (const image of block.images ?? []) content.push(encodeImage(image))
  if (block.content.length > 0 || content.length === 0) {
    content.push({ type: 'text', text: block.content })
  }

  return {
    type: 'tool_result',
    tool_use_id: block.toolCallId,
    content,
  }
}

function encodeThinking(block: ThinkingBlock, providerId: string): JsonValue | null {
  if (block.providerId !== providerId) return null
  return {
    type: 'thinking',
    thinking: block.thinking,
    signature: block.signature,
  }
}

function encodeToolCall(block: ToolCallBlock): JsonValue {
  return {
    type: 'tool_use',
    id: block.id,
    name: block.name,
    input: block.arguments,
  }
}

function sameProviderRawBlocks(
  content: readonly Block[],
  providerId: string,
): JsonValue[] | undefined {
  const raw = content.find(
    (block): block is ProviderBlocksBlock =>
      block.type === 'provider_blocks' && block.providerId === providerId,
  )
  return raw?.blocks
}

function encodeMessage(
  message: Message,
  providerId: string,
): AnthropicWireMessage | undefined {
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: message.content.map(encodeToolResult),
    }
  }

  if (message.role === 'assistant') {
    const rawBlocks = sameProviderRawBlocks(message.content, providerId)
    if (rawBlocks !== undefined) {
      return { role: 'assistant', content: rawBlocks }
    }
  }

  const content: JsonValue[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text })
        break
      case 'image':
        content.push(encodeImage(block))
        break
      case 'document':
        rejectDocument(block)
        break
      case 'thinking': {
        const encoded = encodeThinking(block, providerId)
        if (encoded !== null) content.push(encoded)
        break
      }
      case 'tool_call':
        content.push(encodeToolCall(block))
        break
      case 'provider_blocks':
        break
      case 'refusal':
        throw new AnthropicProtocolError(
          'refusal_not_replayable',
          'refusal block 不得作为普通 assistant 历史发送',
        )
    }
  }

  if (content.length === 0) return undefined
  return { role: message.role, content }
}

function mergeAdjacentMessages(
  messages: AnthropicWireMessage[],
): AnthropicWireMessage[] {
  const merged: AnthropicWireMessage[] = []
  for (const message of messages) {
    const previous = merged.at(-1)
    if (previous?.role === message.role) {
      if (message.role === 'assistant') {
        throw new AnthropicProtocolError(
          'consecutive_assistant_messages',
          'Anthropic 请求不能包含连续 assistant 消息，且不得合并已签名 assistant block',
        )
      }
      previous.content.push(...message.content)
    } else {
      merged.push({ role: message.role, content: [...message.content] })
    }
  }
  return merged
}

function normalizeEndpoint(endpoint: string): string {
  const url = new URL(endpoint)
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new AnthropicProtocolError(
      'invalid_endpoint',
      'Anthropic endpoint 不得包含 query 或 hash',
    )
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (url.pathname === '') url.pathname = '/v1/messages'
  if (url.pathname === '/') url.pathname = '/v1/messages'
  if (!url.pathname.endsWith('/v1/messages')) {
    throw new AnthropicProtocolError(
      'invalid_endpoint',
      'Anthropic endpoint 必须是根 URL 或以 /v1/messages 结尾',
    )
  }
  return url.toString()
}

function buildHeaders(config: AnthropicCodecConfig): Record<string, string> {
  const headers = new Headers({
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
    'x-api-key': config.apiKey,
    ...config.headers,
  })

  if (config.compatMode === 'minimal') {
    headers.delete('user-agent')
    for (const key of Array.from(headers.keys())) {
      if (key.startsWith('x-stainless-')) headers.delete(key)
    }
  }

  if ((config.contextWindowTokens ?? 0) >= 1_000_000) {
    const beta = 'context-1m-2025-08-07'
    const existing = headers.get('anthropic-beta')
    const values = new Set(
      existing
        ?.split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0) ?? [],
    )
    values.add(beta)
    headers.set('anthropic-beta', [...values].join(','))
  }

  return Object.fromEntries(
    [...headers.entries()].sort(([left], [right]) => left.localeCompare(right)),
  )
}

function addDefaultCacheControls(body: AnthropicRequestBody): void {
  body.cache_control = { type: 'ephemeral' }
  if (typeof body.system === 'string' && body.system.length > 0) {
    body.system = [
      { type: 'text', text: body.system, cache_control: { type: 'ephemeral' } },
    ]
  }
  const lastTool = body.tools?.at(-1)
  if (lastTool !== undefined && isRecord(lastTool)) {
    lastTool.cache_control = { type: 'ephemeral' }
  }
}

export function encodeAnthropicRequest(
  config: AnthropicCodecConfig,
  messages: readonly Message[],
  options: AnthropicEncodeOptions = {},
): AnthropicEncodedRequest {
  const validation = validateMessages(messages)
  if (!validation.valid) {
    throw new AnthropicProtocolError(
      'invalid_ir',
      validation.issues
        .map((issue) => `${issue.rule}:${issue.code}@${issue.messageIndex}`)
        .join(', '),
    )
  }

  const encoded = messages
    .map((message) => encodeMessage(message, config.providerId))
    .filter((message): message is AnthropicWireMessage => message !== undefined)
  const requestMessages = mergeAdjacentMessages(encoded)

  if (requestMessages.length === 0 || requestMessages[0]?.role !== 'user') {
    throw new AnthropicProtocolError(
      'conversation_must_start_with_user',
      'Anthropic 请求历史必须以 user 消息开始',
    )
  }

  const body: AnthropicRequestBody = {
    model: cleanWireModelId(config.model),
    max_tokens: options.maxOutputTokens ?? 32_000,
    messages: requestMessages,
    stream: options.stream ?? true,
  }

  if (options.system !== undefined) body.system = options.system
  if (options.tools !== undefined && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }))
  }
  if (options.thinking?.type === 'off') {
    body.thinking = { type: 'disabled' }
  } else if (options.thinking?.type === 'enabled') {
    if (!Number.isInteger(options.thinking.budgetTokens) || options.thinking.budgetTokens <= 0) {
      throw new AnthropicProtocolError(
        'invalid_thinking_budget',
        'thinking budgetTokens 必须是正整数',
      )
    }
    body.thinking = {
      type: 'enabled',
      budget_tokens: options.thinking.budgetTokens,
    }
  }

  if (config.compatMode !== 'minimal') addDefaultCacheControls(body)

  return {
    url: normalizeEndpoint(config.endpoint),
    headers: buildHeaders(config),
    body,
  }
}

export function stringifyAnthropicRequest(body: AnthropicRequestBody): string {
  return JSON.stringify(body)
}

function decodeContentBlocks(
  content: unknown,
  providerId: string,
): {
  normalized: AssistantBlock[]
  raw: JsonValue[]
  partialTextChars: number
} {
  if (!Array.isArray(content)) {
    throw new AnthropicProtocolError(
      'invalid_response_content',
      'Anthropic response.content 必须是数组',
    )
  }

  const normalized: AssistantBlock[] = []
  const raw: JsonValue[] = []
  let partialTextChars = 0

  for (const [blockIndex, value] of content.entries()) {
    if (!isRecord(value) || typeof value.type !== 'string') {
      throw new AnthropicProtocolError(
        'invalid_response_block',
        `response.content[${blockIndex}] 缺少 block type`,
      )
    }
    let rawValue: unknown = value

    switch (value.type) {
      case 'text': {
        if (typeof value.text !== 'string') {
          throw new AnthropicProtocolError(
            'invalid_text_block',
            `response.content[${blockIndex}].text 必须是字符串`,
          )
        }
        normalized.push({ type: 'text', text: value.text })
        partialTextChars += value.text.trim().length
        break
      }
      case 'thinking': {
        if (typeof value.thinking !== 'string' || !isNonEmptyString(value.signature)) {
          throw new AnthropicProtocolError(
            'incomplete_thinking',
            `response.content[${blockIndex}] thinking 缺少完整 signature`,
          )
        }
        normalized.push({
          type: 'thinking',
          thinking: value.thinking,
          signature: value.signature,
          providerId,
        })
        break
      }
      case 'tool_use': {
        const name = requireNonEmptyString(
          value.name,
          'missing_tool_name',
          `response.content[${blockIndex}].name`,
        )
        const argumentsValue = parseToolArguments(value)
        const id =
          typeof value.id === 'string' && value.id.length > 0
            ? value.id
            : syntheticToolCallId(providerId, blockIndex, name, argumentsValue)
        if (value.id !== id) rawValue = { ...value, id }
        normalized.push({
          type: 'tool_call',
          id,
          name,
          arguments: argumentsValue,
        })
        break
      }
      case 'redacted_thinking':
        break
    }
    raw.push(asJsonValue(rawValue, `response.content[${blockIndex}]`))
  }

  return { normalized, raw, partialTextChars }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function refusalDetails(value: unknown): {
  category: string | null
  explanation: string | null
} {
  if (!isRecord(value)) return { category: null, explanation: null }
  return {
    category: typeof value.category === 'string' ? value.category : null,
    explanation:
      typeof value.explanation === 'string' ? value.explanation : null,
  }
}

export function decodeAnthropicResponse(
  response: unknown,
  providerId: string,
  deltaUsage?: unknown,
  streamedStopDetails?: unknown,
): AnthropicDecodedResponse {
  if (!isRecord(response)) {
    throw new AnthropicProtocolError(
      'invalid_response',
      'Anthropic response 必须是对象',
    )
  }

  const stopReason =
    response.stop_reason === null || typeof response.stop_reason === 'string'
      ? response.stop_reason
      : null
  const usage = normalizeAnthropicUsage(response.usage, deltaUsage)
  const decoded = decodeContentBlocks(response.content, providerId)

  if (stopReason === 'refusal') {
    const details = refusalDetails(response.stop_details ?? streamedStopDetails)
    throw new AnthropicRefusalError(
      details.category,
      details.explanation,
      decoded.partialTextChars,
      usage,
    )
  }

  const content = [...decoded.normalized]
  if (decoded.raw.length > 0) {
    content.push({
      type: 'provider_blocks',
      providerId,
      blocks: decoded.raw,
    })
  }

  return {
    message: { role: 'assistant', content },
    usage,
    stopReason,
  }
}

function streamBlockFromStart(
  index: number,
  startOrder: number,
  block: Record<string, unknown>,
): StreamBlockState {
  const type = requireNonEmptyString(
    block.type,
    'missing_stream_block_type',
    'content_block.type',
  )
  const state: StreamBlockState = {
    index,
    startOrder,
    type,
    start: block,
    text: type === 'text' && typeof block.text === 'string' ? block.text : '',
    thinking:
      type === 'thinking' && typeof block.thinking === 'string'
        ? block.thinking
        : '',
    signature:
      type === 'thinking' && typeof block.signature === 'string'
        ? block.signature
        : '',
    inputBuffer: '',
    closed: false,
  }
  if (type === 'tool_use' && isJsonObject(block.input)) {
    state.parsedInput = block.input
  }
  return state
}

function appendToolInput(state: StreamBlockState, partialJson: string): void {
  state.inputBuffer += partialJson
  if (state.inputBuffer.length === 0) return
  try {
    const parsed: unknown = JSON.parse(state.inputBuffer)
    if (isJsonObject(parsed)) state.parsedInput = parsed
  } catch {
    return
  }
}

function finishStreamBlock(
  state: StreamBlockState,
  providerId: string,
): JsonValue | undefined {
  state.closed = true
  switch (state.type) {
    case 'text':
      return { type: 'text', text: state.text }
    case 'thinking':
      if (state.signature.length === 0) return undefined
      return {
        type: 'thinking',
        thinking: state.thinking,
        signature: state.signature,
      }
    case 'tool_use': {
      const name = requireNonEmptyString(
        state.start.name,
        'missing_tool_name',
        'stream tool_use.name',
      )
      let argumentsValue = state.parsedInput
      if (state.inputBuffer.length > 0) {
        argumentsValue = parseJsonObjectString(
          state.inputBuffer,
          'stream tool_use.partial_json',
        )
      }
      argumentsValue ??= {}
      const id =
        typeof state.start.id === 'string' && state.start.id.length > 0
          ? state.start.id
          : syntheticToolCallId(providerId, state.index, name, argumentsValue)
      return { type: 'tool_use', id, name, input: argumentsValue }
    }
    default:
      return asJsonValue(state.start, `stream block ${state.index}`)
  }
}

export function assembleAnthropicSse(
  events: readonly AnthropicSseEvent[],
  providerId: string,
): AnthropicDecodedResponse {
  const states = new Map<number, StreamBlockState>()
  const completed: Array<{ order: number; block: JsonValue }> = []
  let startOrder = 0
  let initialUsage: unknown
  let deltaUsage: unknown
  let stopReason: string | null = null
  let stopDetails: unknown

  for (const event of events) {
    const data = event.data
    switch (data.type) {
      case 'message_start': {
        const message = data.message
        if (isRecord(message)) initialUsage = message.usage
        break
      }
      case 'content_block_start': {
        const index = data.index
        if (typeof index !== 'number' || !Number.isInteger(index)) {
          throw new AnthropicProtocolError(
            'invalid_stream_index',
            'content_block_start.index 必须是整数',
          )
        }
        if (!isRecord(data.content_block)) {
          throw new AnthropicProtocolError(
            'invalid_stream_block',
            'content_block_start 缺少 content_block',
          )
        }
        states.set(
          index,
          streamBlockFromStart(index, startOrder, data.content_block),
        )
        startOrder += 1
        break
      }
      case 'content_block_delta': {
        const index = data.index
        if (typeof index !== 'number' || !isRecord(data.delta)) {
          throw new AnthropicProtocolError(
            'invalid_stream_delta',
            'content_block_delta 缺少 index 或 delta',
          )
        }
        const state = states.get(index)
        if (state === undefined || state.closed) {
          throw new AnthropicProtocolError(
            'orphan_stream_delta',
            `content_block_delta 引用了未打开的 index ${index}`,
          )
        }
        switch (data.delta.type) {
          case 'text_delta':
            if (typeof data.delta.text === 'string') state.text += data.delta.text
            break
          case 'thinking_delta':
            if (typeof data.delta.thinking === 'string') {
              state.thinking += data.delta.thinking
            }
            break
          case 'signature_delta':
            if (typeof data.delta.signature === 'string') {
              state.signature += data.delta.signature
            }
            break
          case 'input_json_delta':
            if (typeof data.delta.partial_json === 'string') {
              appendToolInput(state, data.delta.partial_json)
            }
            break
        }
        break
      }
      case 'content_block_stop': {
        const index = data.index
        if (typeof index !== 'number') {
          throw new AnthropicProtocolError(
            'invalid_stream_index',
            'content_block_stop.index 必须是整数',
          )
        }
        const state = states.get(index)
        if (state === undefined || state.closed) {
          throw new AnthropicProtocolError(
            'orphan_stream_stop',
            `content_block_stop 引用了未打开的 index ${index}`,
          )
        }
        const block = finishStreamBlock(state, providerId)
        if (block !== undefined) completed.push({ order: state.startOrder, block })
        break
      }
      case 'message_delta': {
        if (isRecord(data.delta)) {
          if (
            data.delta.stop_reason === null ||
            typeof data.delta.stop_reason === 'string'
          ) {
            stopReason = data.delta.stop_reason
          }
          if (data.delta.stop_details !== undefined) {
            stopDetails = data.delta.stop_details
          }
        }
        if (data.usage !== undefined) deltaUsage = data.usage
        break
      }
    }
  }

  const response = {
    content: completed
      .sort((left, right) => left.order - right.order)
      .map((item) => item.block),
    stop_reason: stopReason,
    stop_details: stopDetails ?? null,
    usage: initialUsage ?? {},
  }
  return decodeAnthropicResponse(response, providerId, deltaUsage, stopDetails)
}

export function parseAnthropicSse(text: string): AnthropicSseEvent[] {
  const events: AnthropicSseEvent[] = []
  let eventName: string | undefined
  let dataLines: string[] = []

  const flush = (): void => {
    if (dataLines.length === 0) {
      eventName = undefined
      return
    }
    const raw = dataLines.join('\n')
    dataLines = []
    if (raw === '[DONE]') {
      eventName = undefined
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new AnthropicProtocolError(
        'invalid_sse_json',
        'SSE data 不是合法 JSON',
      )
    }
    if (!isJsonObject(parsed)) {
      throw new AnthropicProtocolError(
        'invalid_sse_event',
        'SSE data 必须是 JSON object',
      )
    }
    events.push(
      eventName === undefined
        ? { data: parsed }
        : { event: eventName, data: parsed },
    )
    eventName = undefined
  }

  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) {
      flush()
    } else if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart())
    }
  }
  flush()
  return events
}

export class AnthropicMessagesCodec {
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(private readonly config: AnthropicCodecConfig) {
    this.fetchImpl = config.fetch ?? globalThis.fetch
  }

  encode(
    messages: readonly Message[],
    options: AnthropicEncodeOptions = {},
  ): AnthropicEncodedRequest {
    return encodeAnthropicRequest(this.config, messages, options)
  }

  decode(response: unknown): AnthropicDecodedResponse {
    return decodeAnthropicResponse(response, this.config.providerId)
  }

  decodeStream(events: readonly AnthropicSseEvent[]): AnthropicDecodedResponse {
    return assembleAnthropicSse(events, this.config.providerId)
  }

  async call(
    messages: readonly Message[],
    options: AnthropicEncodeOptions = {},
  ): Promise<AnthropicDecodedResponse> {
    const request = this.encode(messages, options)
    const response = await this.fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: stringifyAnthropicRequest(request.body),
    })
    const responseText = await response.text()
    if (!response.ok) {
      throw new AnthropicHttpError(response.status, responseText)
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) {
      return this.decodeStream(parseAnthropicSse(responseText))
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(responseText)
    } catch {
      throw new AnthropicProtocolError(
        'invalid_response_json',
        'Anthropic 非流式响应不是合法 JSON',
      )
    }
    return this.decode(parsed)
  }
}
