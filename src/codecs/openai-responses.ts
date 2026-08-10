import {
  applyCapability,
  CapabilityError,
  normalizeCapability,
  type CapabilityTransformOptions,
  type DegradationRecord,
  type ProviderCapability,
} from '../capability'
import { cleanWireModelId } from '../model'
import type {
  AssistantBlock,
  AssistantMessage,
  DocumentBlock,
  ImageBlock,
  JsonObject,
  JsonValue,
  Message,
  ProviderBlocksBlock,
  ToolCallBlock,
  Usage,
} from '../types'
import { validateMessages } from '../validate'

export interface OpenAIResponsesCodecConfig {
  providerId: string
  model: string
  endpoint: string
  apiKey: string
  headers?: Record<string, string>
  fetch?: typeof globalThis.fetch
}

export interface OpenAIResponsesToolDefinition {
  name: string
  description: string
  parameters: JsonObject
}

export interface OpenAIResponsesEncodeOptions
  extends CapabilityTransformOptions {
  instructions?: string
  system?: string
  maxOutputTokens?: number
  tools?: OpenAIResponsesToolDefinition[]
  reasoningEffort?: string
  jsonMode?: boolean
  signal?: AbortSignal
}

export interface OpenAIResponsesRequestBody {
  model: string
  store: false
  stream: true
  input: JsonValue[]
  include: ['reasoning.encrypted_content']
  instructions?: string
  max_output_tokens?: number
  tools?: JsonValue[]
  tool_choice?: 'auto'
  reasoning?: { effort: string; summary: 'auto' }
  text?: { format: { type: 'json_object' } }
}

export interface OpenAIResponsesEncodedRequest {
  url: string
  headers: Record<string, string>
  body: OpenAIResponsesRequestBody
  degradations: DegradationRecord[]
}

export interface OpenAIResponsesDecodedResponse {
  message: AssistantMessage
  usage: Usage
  stopReason: string | null
}

export interface OpenAIResponsesSseEvent {
  event?: string
  data: JsonObject
}

export class OpenAIResponsesProtocolError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'OpenAIResponsesProtocolError'
    this.code = code
  }
}

export class OpenAIResponsesHttpError extends Error {
  readonly status: number
  readonly responseBody: string

  constructor(status: number, responseBody: string) {
    super(`OpenAI Responses HTTP ${status}: ${responseBody}`)
    this.name = 'OpenAIResponsesHttpError'
    this.status = status
    this.responseBody = responseBody
  }
}

interface PendingFunctionCall {
  outputIndex: number
  callId?: string
  name?: string
  argumentsBuffer: string
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
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function asJsonValue(value: unknown, field: string): JsonValue {
  if (!isJsonValue(value)) {
    throw new OpenAIResponsesProtocolError(
      'non_json_wire_value',
      `${field} 不是 JSON value`,
    )
  }
  return value
}

function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
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
  outputIndex: number,
  name: string,
  argumentsValue: JsonObject,
): string {
  return `synthetic-${stableHash(
    `${providerId}\n${outputIndex}\n${name}\n${stableJson(argumentsValue)}`,
  )}`
}

function parseToolArguments(value: unknown, field: string): JsonObject {
  if (isJsonObject(value)) return value
  if (typeof value !== 'string') {
    throw new OpenAIResponsesProtocolError(
      'tool_arguments_not_object',
      `${field} 必须是 JSON object 字符串或 object`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new OpenAIResponsesProtocolError(
      'invalid_tool_arguments_json',
      `${field} 不是完整 JSON`,
    )
  }
  if (!isJsonObject(parsed)) {
    throw new OpenAIResponsesProtocolError(
      'tool_arguments_not_object',
      `${field} 解析结果必须是 object`,
    )
  }
  return parsed
}

function normalizeEndpoint(endpoint: string): string {
  const url = new URL(endpoint)
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new OpenAIResponsesProtocolError(
      'invalid_endpoint',
      'OpenAI Responses endpoint 不得包含 query 或 hash',
    )
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (url.pathname === '' || url.pathname === '/') url.pathname = '/v1/responses'
  if (!url.pathname.endsWith('/v1/responses')) {
    throw new OpenAIResponsesProtocolError(
      'invalid_endpoint',
      'OpenAI Responses endpoint 必须是根 URL 或以 /v1/responses 结尾',
    )
  }
  return url.toString()
}

function buildHeaders(config: OpenAIResponsesCodecConfig): Record<string, string> {
  const headers = new Headers({
    authorization: `Bearer ${config.apiKey}`,
    'content-type': 'application/json',
    ...config.headers,
  })
  return Object.fromEntries(
    [...headers.entries()].sort(([left], [right]) => left.localeCompare(right)),
  )
}

function encodeImage(block: ImageBlock): JsonValue {
  return {
    type: 'input_image',
    image_url: `data:${block.source.mediaType};base64,${block.source.data}`,
  }
}

function encodeDocument(block: DocumentBlock): JsonValue {
  switch (block.source.type) {
    case 'base64':
      return {
        type: 'input_file',
        filename: 'document',
        file_data: `data:${block.source.mediaType};base64,${block.source.data}`,
      }
    case 'url':
      return { type: 'input_file', file_url: block.source.url }
    case 'text':
      return { type: 'input_text', text: block.source.text }
  }
}

function sameProviderRawBlocks(
  content: readonly AssistantBlock[],
  providerId: string,
): ProviderBlocksBlock | undefined {
  return content.find(
    (block): block is ProviderBlocksBlock =>
      block.type === 'provider_blocks' && block.providerId === providerId,
  )
}

function encodeToolCall(block: ToolCallBlock): JsonValue {
  return {
    type: 'function_call',
    call_id: block.id,
    name: block.name,
    arguments: JSON.stringify(block.arguments),
  }
}

function encodeInput(
  messages: readonly Message[],
  providerId: string,
  degradations: DegradationRecord[],
): JsonValue[] {
  const input: JsonValue[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const content = message.content.map((block): JsonValue => {
        switch (block.type) {
          case 'text':
            return { type: 'input_text', text: block.text }
          case 'image':
            return encodeImage(block)
          case 'document':
            return encodeDocument(block)
        }
      })
      if (content.length === 0) content.push({ type: 'input_text', text: '' })
      input.push({ role: 'user', content })
      continue
    }

    if (message.role === 'tool') {
      for (const block of message.content) {
        let output: JsonValue = block.content
        if ((block.images?.length ?? 0) > 0) {
          const blocks: JsonValue[] = []
          if (block.content.length > 0) {
            blocks.push({ type: 'input_text', text: block.content })
          }
          for (const image of block.images ?? []) blocks.push(encodeImage(image))
          output = blocks
        }
        input.push({
          type: 'function_call_output',
          call_id: block.toolCallId,
          output,
        })
      }
      continue
    }

    const raw = sameProviderRawBlocks(message.content, providerId)
    if (raw !== undefined) {
      input.push(...raw.blocks)
      continue
    }

    let text = ''
    let hasToolCall = false
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          text += block.text
          break
        case 'tool_call':
          hasToolCall = true
          input.push(encodeToolCall(block))
          break
        case 'thinking':
          degradations.push({
            blockType: 'thinking',
            action: 'filtered',
            reason: 'Responses reasoning 回放需要同 provider 的原生 encrypted_content',
          })
          break
        case 'provider_blocks':
          degradations.push({
            blockType: 'provider_blocks',
            action: 'filtered',
            reason: 'provider_blocks 来源与目标 provider 不同',
          })
          break
        case 'refusal':
          throw new OpenAIResponsesProtocolError(
            'refusal_not_replayable',
            'refusal block 不得作为普通 assistant 历史发送',
          )
      }
    }
    if (text.length > 0 || !hasToolCall) {
      input.push({
        role: 'assistant',
        phase: hasToolCall ? 'commentary' : 'final_answer',
        content: [{ type: 'output_text', text }],
      })
    }
  }
  return input
}

function encodeTools(
  localTools: readonly OpenAIResponsesToolDefinition[],
  hostedTools: readonly string[],
): JsonValue[] {
  const tools: JsonValue[] = []
  for (const hosted of new Set(hostedTools)) tools.push({ type: hosted })
  for (const tool of localTools) {
    tools.push({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })
  }
  return tools
}

export function encodeOpenAIResponsesRequest(
  config: OpenAIResponsesCodecConfig,
  messages: readonly Message[],
  capabilityInput: Partial<ProviderCapability>,
  options: OpenAIResponsesEncodeOptions = {},
): OpenAIResponsesEncodedRequest {
  const validation = validateMessages(messages)
  if (!validation.valid) {
    throw new OpenAIResponsesProtocolError(
      'invalid_ir',
      validation.issues
        .map((issue) => `${issue.rule}:${issue.code}@${issue.messageIndex}`)
        .join(', '),
    )
  }
  const capability = normalizeCapability(capabilityInput)
  if (!capability.streaming) {
    throw new CapabilityError(
      'streaming_required',
      'OpenAI Responses codec 需要 streaming capability',
    )
  }
  const transformed = applyCapability(messages, capability, options)
  const degradations = [...transformed.degradations]
  const input = encodeInput(transformed.messages, config.providerId, degradations)
  if (options.instructions !== undefined) {
    if (options.system !== undefined) {
      input.unshift({ role: 'developer', content: options.system })
    }
  } else if (options.system !== undefined) {
    input.unshift({ role: 'system', content: options.system })
  }

  const body: OpenAIResponsesRequestBody = {
    model: cleanWireModelId(config.model),
    store: false,
    stream: true,
    input,
    include: ['reasoning.encrypted_content'],
  }
  if (options.instructions !== undefined) body.instructions = options.instructions
  if (options.maxOutputTokens !== undefined) {
    if (!Number.isInteger(options.maxOutputTokens) || options.maxOutputTokens <= 0) {
      throw new OpenAIResponsesProtocolError(
        'invalid_max_output_tokens',
        'maxOutputTokens 必须是正整数',
      )
    }
    body.max_output_tokens = options.maxOutputTokens
  }
  if ((options.tools?.length ?? 0) > 0 && !capability.toolCalls) {
    throw new CapabilityError(
      'tool_calls_unsupported',
      '目标 provider 不支持本地工具定义',
    )
  }
  const tools = encodeTools(
    capability.toolCalls ? options.tools ?? [] : [],
    capability.hostedTools ?? [],
  )
  if (tools.length > 0) {
    body.tools = tools
    body.tool_choice = 'auto'
  }
  if (
    options.reasoningEffort !== undefined &&
    capability.thinking !== 'unsupported'
  ) {
    body.reasoning = { effort: options.reasoningEffort, summary: 'auto' }
  }
  if (options.jsonMode === true) {
    body.text = { format: { type: 'json_object' } }
  }
  return {
    url: normalizeEndpoint(config.endpoint),
    headers: buildHeaders(config),
    body,
    degradations,
  }
}

function eventType(event: OpenAIResponsesSseEvent): string {
  return event.event ?? (typeof event.data.type === 'string' ? event.data.type : '')
}

function numberField(value: unknown, key: string): number {
  if (!isRecord(value)) return 0
  const field = value[key]
  return typeof field === 'number' && Number.isInteger(field) && field >= 0
    ? field
    : 0
}

export function assembleOpenAIResponsesSse(
  events: readonly OpenAIResponsesSseEvent[],
  providerId: string,
): OpenAIResponsesDecodedResponse {
  const textParts = new Map<string, {
    outputIndex: number
    contentIndex: number
    text: string
  }>()
  const reasoningParts = new Map<string, {
    outputIndex: number
    itemId: string
    text: string
  }>()
  const pending = new Map<number, PendingFunctionCall>()
  const completedByIndex = new Map<number, JsonValue>()
  const toolCalls: ToolCallBlock[] = []
  const seenToolIds = new Set<string>()
  let inputTokens = 0
  let outputTokens = 0
  let stopReason: string | null = null

  const appendToolCall = (
    outputIndex: number,
    callId: unknown,
    name: unknown,
    rawArguments: unknown,
  ): void => {
    if (typeof name !== 'string' || name.length === 0) {
      throw new OpenAIResponsesProtocolError(
        'missing_tool_name',
        `function_call ${outputIndex} 缺少 name`,
      )
    }
    const argumentsValue = parseToolArguments(
      rawArguments,
      `function_call ${outputIndex}.arguments`,
    )
    const id =
      typeof callId === 'string' && callId.length > 0
        ? callId
        : syntheticToolCallId(providerId, outputIndex, name, argumentsValue)
    if (seenToolIds.has(id)) return
    seenToolIds.add(id)
    toolCalls.push({ type: 'tool_call', id, name, arguments: argumentsValue })
  }

  for (const event of events) {
    const data = event.data
    switch (eventType(event)) {
      case 'response.output_item.added': {
        if (
          typeof data.output_index === 'number' &&
          isRecord(data.item) &&
          data.item.type === 'function_call'
        ) {
          pending.set(data.output_index, {
            outputIndex: data.output_index,
            ...(typeof data.item.call_id === 'string'
              ? { callId: data.item.call_id }
              : {}),
            ...(typeof data.item.name === 'string'
              ? { name: data.item.name }
              : {}),
            argumentsBuffer: '',
          })
        }
        break
      }
      case 'response.output_text.delta':
      case 'response.output_text.done': {
        if (
          typeof data.output_index !== 'number' ||
          typeof data.content_index !== 'number' ||
          typeof data.item_id !== 'string'
        ) {
          throw new OpenAIResponsesProtocolError(
            'invalid_text_event',
            'Responses text event 缺少稳定位置字段',
          )
        }
        const key = `${data.output_index}:${data.content_index}:${data.item_id}`
        const text =
          eventType(event) === 'response.output_text.done'
            ? data.text
            : data.delta
        if (typeof text !== 'string') break
        const existing = textParts.get(key)
        if (eventType(event) === 'response.output_text.done' || existing === undefined) {
          textParts.set(key, {
            outputIndex: data.output_index,
            contentIndex: data.content_index,
            text,
          })
        } else {
          existing.text += text
        }
        break
      }
      case 'response.function_call_arguments.delta': {
        if (
          typeof data.output_index === 'number' &&
          typeof data.delta === 'string'
        ) {
          const state = pending.get(data.output_index)
          if (state !== undefined) state.argumentsBuffer += data.delta
        }
        break
      }
      case 'response.function_call_arguments.done': {
        if (typeof data.output_index !== 'number') break
        const state = pending.get(data.output_index)
        appendToolCall(
          data.output_index,
          data.call_id ?? state?.callId,
          data.name ?? state?.name,
          data.arguments ?? state?.argumentsBuffer ?? '',
        )
        pending.delete(data.output_index)
        break
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        if (
          typeof data.delta === 'string' &&
          typeof data.item_id === 'string'
        ) {
          const outputIndex =
            typeof data.output_index === 'number' ? data.output_index : 0
          const key = `${outputIndex}:${data.item_id}`
          const existing = reasoningParts.get(key)
          if (existing === undefined) {
            reasoningParts.set(key, {
              outputIndex,
              itemId: data.item_id,
              text: data.delta,
            })
          } else {
            existing.text += data.delta
          }
        }
        break
      }
      case 'response.output_item.done': {
        if (typeof data.output_index !== 'number' || !isRecord(data.item)) break
        completedByIndex.set(
          data.output_index,
          asJsonValue(data.item, `output item ${data.output_index}`),
        )
        if (data.item.type === 'function_call') {
          const state = pending.get(data.output_index)
          appendToolCall(
            data.output_index,
            data.item.call_id ?? state?.callId,
            data.item.name ?? state?.name,
            data.item.arguments ?? state?.argumentsBuffer ?? '',
          )
          pending.delete(data.output_index)
        }
        break
      }
      case 'response.completed': {
        if (!isRecord(data.response)) break
        inputTokens = numberField(data.response.usage, 'input_tokens')
        outputTokens = numberField(data.response.usage, 'output_tokens')
        stopReason = 'completed'
        if (Array.isArray(data.response.output)) {
          for (const [index, item] of data.response.output.entries()) {
            if (!isRecord(item)) continue
            completedByIndex.set(index, asJsonValue(item, `response.output[${index}]`))
            if (item.type === 'function_call') {
              appendToolCall(
                index,
                item.call_id,
                item.name,
                item.arguments ?? '',
              )
            }
          }
        }
        break
      }
      case 'response.failed':
      case 'error': {
        const message =
          isRecord(data.response) && isRecord(data.response.error)
            ? data.response.error.message
            : data.message
        throw new OpenAIResponsesProtocolError(
          'response_failed',
          typeof message === 'string' ? message : 'Responses stream failed',
        )
      }
    }
  }

  const completedOutput = [...completedByIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, item]) => item)
  let text = [...textParts.values()]
    .sort(
      (left, right) =>
        left.outputIndex - right.outputIndex ||
        left.contentIndex - right.contentIndex,
    )
    .map((part) => part.text)
    .join('')
  if (text.length === 0) {
    for (const item of completedOutput) {
      if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) {
        continue
      }
      for (const block of item.content) {
        if (isRecord(block) && block.type === 'output_text' && typeof block.text === 'string') {
          text += block.text
        }
      }
    }
  }

  const content: AssistantBlock[] = []
  const reasoning = [...reasoningParts.values()]
    .sort((left, right) => left.outputIndex - right.outputIndex)
  for (const part of reasoning) {
    content.push({
      type: 'thinking',
      thinking: part.text,
      signature: `openai-responses:${part.itemId}`,
      providerId,
    })
  }
  if (reasoning.length === 0) {
    for (const item of completedOutput) {
      if (!isRecord(item) || item.type !== 'reasoning' || !Array.isArray(item.summary)) {
        continue
      }
      const summary = item.summary
        .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
        .join('')
      if (summary.length === 0) continue
      content.push({
        type: 'thinking',
        thinking: summary,
        signature: `openai-responses:${
          typeof item.id === 'string' ? item.id : 'reasoning'
        }`,
        providerId,
      })
    }
  }
  if (text.length > 0) content.push({ type: 'text', text })
  content.push(...toolCalls)
  if (completedOutput.length > 0) {
    content.push({
      type: 'provider_blocks',
      providerId,
      blocks: completedOutput,
    })
  }

  return {
    message: { role: 'assistant', content },
    usage: {
      totalInputTokens: inputTokens,
      outputTokens,
      reliable: inputTokens > 0 || outputTokens > 0,
    },
    stopReason,
  }
}

export function parseOpenAIResponsesSse(text: string): OpenAIResponsesSseEvent[] {
  const events: OpenAIResponsesSseEvent[] = []
  for (const part of text.replace(/\r\n/g, '\n').split('\n\n')) {
    if (part.trim().length === 0) continue
    let event: string | undefined
    const dataLines: string[] = []
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    const dataText = dataLines.join('\n')
    if (dataText.length === 0 || dataText === '[DONE]') continue
    let data: unknown
    try {
      data = JSON.parse(dataText)
    } catch {
      throw new OpenAIResponsesProtocolError(
        'invalid_sse_json',
        'Responses SSE data 不是完整 JSON',
      )
    }
    if (!isJsonObject(data)) {
      throw new OpenAIResponsesProtocolError(
        'invalid_sse_event',
        'Responses SSE data 必须是 JSON object',
      )
    }
    events.push({ ...(event === undefined ? {} : { event }), data })
  }
  return events
}

export function stringifyOpenAIResponsesRequest(
  body: OpenAIResponsesRequestBody,
): string {
  return JSON.stringify(body)
}

export class OpenAIResponsesCodec {
  private readonly config: OpenAIResponsesCodecConfig

  constructor(config: OpenAIResponsesCodecConfig) {
    this.config = config
  }

  encode(
    messages: readonly Message[],
    capability: Partial<ProviderCapability>,
    options: OpenAIResponsesEncodeOptions = {},
  ): OpenAIResponsesEncodedRequest {
    return encodeOpenAIResponsesRequest(
      this.config,
      messages,
      capability,
      options,
    )
  }

  decodeStream(
    events: readonly OpenAIResponsesSseEvent[],
  ): OpenAIResponsesDecodedResponse {
    return assembleOpenAIResponsesSse(events, this.config.providerId)
  }

  async call(
    messages: readonly Message[],
    capability: Partial<ProviderCapability>,
    options: OpenAIResponsesEncodeOptions = {},
  ): Promise<OpenAIResponsesDecodedResponse> {
    const request = this.encode(messages, capability, options)
    const fetchImpl = this.config.fetch ?? globalThis.fetch
    const response = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: stringifyOpenAIResponsesRequest(request.body),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    if (!response.ok) {
      throw new OpenAIResponsesHttpError(response.status, await response.text())
    }
    if (response.body === null) {
      throw new OpenAIResponsesProtocolError(
        'missing_response_body',
        'OpenAI Responses SSE response body 为空',
      )
    }
    return this.decodeStream(parseOpenAIResponsesSse(await response.text()))
  }
}
