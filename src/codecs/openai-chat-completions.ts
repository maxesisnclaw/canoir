import { cleanWireModelId } from '../model'
import {
  assertResponseNotDegraded,
  type ResponseDegradationOptions,
} from '../degradation'
import {
  writeRequestDiagnostic,
  type RequestDiagnosticWriter,
} from '../diagnostic'
import {
  applyCapability,
  CapabilityError,
  normalizeCapability,
  type CapabilityTransformOptions,
  type DegradationRecord,
  type ProviderCapability,
} from '../capability'
import type {
  AssistantBlock,
  AssistantMessage,
  ImageBlock,
  JsonObject,
  JsonValue,
  Message,
  ToolCallBlock,
  Usage,
} from '../types'
import { validateMessages } from '../validate'

export type OpenAIToolSchemaDialect = 'json-schema' | 'gemini-openapi'

export interface OpenAIChatCodecConfig {
  providerId: string
  model: string
  endpoint: string
  apiKey: string
  headers?: Record<string, string>
  toolSchemaDialect?: OpenAIToolSchemaDialect
  fetch?: typeof globalThis.fetch
}

export interface OpenAIChatToolDefinition {
  name: string
  description: string
  parameters: JsonObject
}

export interface OpenAIChatEncodeOptions extends CapabilityTransformOptions {
  system?: string
  maxOutputTokens?: number
  tools?: OpenAIChatToolDefinition[]
  reasoningEffort?: string
  signal?: AbortSignal
  degradation?: ResponseDegradationOptions
  diagnosticWriter?: RequestDiagnosticWriter
}

export interface OpenAIChatNotice {
  code:
    | 'discarded_reasoning_content'
    | 'discarded_thinking_block'
    | 'discarded_provider_blocks'
  detail: string
}

export type OpenAIChatWireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | JsonValue[] }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: JsonValue[]
    }
  | { role: 'tool'; content: string; tool_call_id: string }

export interface OpenAIChatRequestBody {
  model: string
  messages: OpenAIChatWireMessage[]
  stream: false
  max_tokens?: number
  tools?: JsonValue[]
  reasoning_effort?: string
  reasoning?: { effort: string }
}

export interface OpenAIChatEncodedRequest {
  url: string
  headers: Record<string, string>
  body: OpenAIChatRequestBody
  notices: OpenAIChatNotice[]
  degradations: DegradationRecord[]
}

export interface OpenAIChatDecodedResponse {
  message: AssistantMessage
  usage: Usage
  stopReason: string | null
  notices: OpenAIChatNotice[]
}

export class OpenAIChatProtocolError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'OpenAIChatProtocolError'
    this.code = code
  }
}

export class OpenAIChatHttpError extends Error {
  readonly status: number
  readonly responseBody: string

  constructor(status: number, responseBody: string) {
    super(`OpenAI Chat HTTP ${status}: ${responseBody}`)
    this.name = 'OpenAIChatHttpError'
    this.status = status
    this.responseBody = responseBody
  }
}

const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'definitions',
  'propertyNames',
  'patternProperties',
  'additionalProperties',
  'unevaluatedProperties',
  'dependencies',
  'dependentSchemas',
  'dependentRequired',
  'if',
  'then',
  'else',
  'not',
  'anyOf',
  'oneOf',
  'allOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'exclusiveMinimum',
  'exclusiveMaximum',
])

const GEMINI_TYPES: Record<string, string> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT',
  null: 'NULL',
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
    throw new OpenAIChatProtocolError(
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
  index: number,
  name: string,
  argumentsValue: JsonObject,
): string {
  return `synthetic-${stableHash(
    `${providerId}\n${index}\n${name}\n${stableJson(argumentsValue)}`,
  )}`
}

function sanitizeGeminiType(value: unknown): {
  type?: string
  nullable?: true
} {
  if (typeof value === 'string') {
    return { type: GEMINI_TYPES[value.toLowerCase()] ?? value.toUpperCase() }
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return {}
  }
  const values = [...new Set(value.map((item) => item.toLowerCase()))]
  const nullable = values.includes('null')
  const concrete = values.filter((item) => item !== 'null')
  if (concrete.length !== 1) return nullable ? { nullable: true } : {}
  const type = GEMINI_TYPES[concrete[0] ?? '']
  return {
    ...(type === undefined ? {} : { type }),
    ...(nullable ? { nullable: true as const } : {}),
  }
}

export function sanitizeSchemaForGemini(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaForGemini)
  if (!isRecord(schema)) return schema

  const cleaned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue
    if (key === 'const') {
      if (typeof value === 'string') cleaned.enum = [value]
      continue
    }
    if (key === 'type') {
      Object.assign(cleaned, sanitizeGeminiType(value))
      continue
    }
    cleaned[key] = sanitizeSchemaForGemini(value)
  }

  if (cleaned.type === 'OBJECT') {
    if (!isRecord(cleaned.properties) || Object.keys(cleaned.properties).length === 0) {
      delete cleaned.type
      delete cleaned.properties
      delete cleaned.required
    }
  }
  return cleaned
}

function parseToolArguments(value: unknown, field: string): JsonObject {
  if (isJsonObject(value)) return value
  if (typeof value !== 'string') {
    throw new OpenAIChatProtocolError(
      'tool_arguments_not_object',
      `${field} 必须是 JSON object 字符串或 object`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new OpenAIChatProtocolError(
      'invalid_tool_arguments_json',
      `${field} 不是完整 JSON`,
    )
  }
  if (!isJsonObject(parsed)) {
    throw new OpenAIChatProtocolError(
      'tool_arguments_not_object',
      `${field} 解析结果必须是 object`,
    )
  }
  return parsed
}

function normalizeEndpoint(endpoint: string): string {
  const url = new URL(endpoint)
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new OpenAIChatProtocolError(
      'invalid_endpoint',
      'OpenAI Chat endpoint 不得包含 query 或 hash',
    )
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (url.pathname === '' || url.pathname === '/') {
    url.pathname = '/v1/chat/completions'
  }
  if (!url.pathname.endsWith('/v1/chat/completions')) {
    throw new OpenAIChatProtocolError(
      'invalid_endpoint',
      'OpenAI Chat endpoint 必须是根 URL 或以 /v1/chat/completions 结尾',
    )
  }
  return url.toString()
}

function buildHeaders(config: OpenAIChatCodecConfig): Record<string, string> {
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
    type: 'image_url',
    image_url: {
      url: `data:${block.source.mediaType};base64,${block.source.data}`,
    },
  }
}

function encodeToolCall(block: ToolCallBlock): JsonValue {
  return {
    id: block.id,
    type: 'function',
    function: {
      name: block.name,
      arguments: JSON.stringify(block.arguments),
    },
  }
}

function encodeMessages(
  messages: readonly Message[],
): { messages: OpenAIChatWireMessage[]; notices: OpenAIChatNotice[] } {
  const wire: OpenAIChatWireMessage[] = []
  const notices: OpenAIChatNotice[] = []

  for (const message of messages) {
    if (message.role === 'tool') {
      for (const block of message.content) {
        if ((block.images?.length ?? 0) > 0) {
          throw new OpenAIChatProtocolError(
            'tool_result_images_unsupported',
            'Chat Completions tool message 不支持图片结果',
          )
        }
        wire.push({
          role: 'tool',
          content: block.content,
          tool_call_id: block.toolCallId,
        })
      }
      continue
    }

    if (message.role === 'user') {
      const parts: JsonValue[] = []
      let textOnly = ''
      let hasImage = false
      for (const block of message.content) {
        if (block.type === 'text') {
          textOnly += block.text
          parts.push({ type: 'text', text: block.text })
        } else if (block.type === 'image') {
          hasImage = true
          parts.push(encodeImage(block))
        } else {
          throw new OpenAIChatProtocolError(
            'document_capability_required',
            'document 编码必须等待 capability 矩阵决定原生发送或显式降级',
          )
        }
      }
      wire.push({ role: 'user', content: hasImage ? parts : textOnly })
      continue
    }

    let text = ''
    const toolCalls: JsonValue[] = []
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          text += block.text
          break
        case 'tool_call':
          toolCalls.push(encodeToolCall(block))
          break
        case 'thinking':
          notices.push({
            code: 'discarded_thinking_block',
            detail: `Chat Completions 不回放 thinking block (${block.providerId})`,
          })
          break
        case 'provider_blocks':
          notices.push({
            code: 'discarded_provider_blocks',
            detail: `Chat Completions 不回放 provider_blocks (${block.providerId})`,
          })
          break
        case 'refusal':
          throw new OpenAIChatProtocolError(
            'refusal_not_replayable',
            'refusal block 不得作为普通 assistant 历史发送',
          )
      }
    }
    wire.push({
      role: 'assistant',
      content: toolCalls.length > 0 && text.length === 0 ? null : text,
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    })
  }
  return { messages: wire, notices }
}

function encodeTools(
  tools: readonly OpenAIChatToolDefinition[],
  dialect: OpenAIToolSchemaDialect,
): JsonValue[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters:
        dialect === 'gemini-openapi'
          ? asJsonValue(
              sanitizeSchemaForGemini(tool.parameters),
              `tool ${tool.name}.parameters`,
            )
          : tool.parameters,
    },
  }))
}

export function encodeOpenAIChatRequest(
  config: OpenAIChatCodecConfig,
  messages: readonly Message[],
  capabilityInput: Partial<ProviderCapability>,
  options: OpenAIChatEncodeOptions = {},
): OpenAIChatEncodedRequest {
  const validation = validateMessages(messages)
  if (!validation.valid) {
    throw new OpenAIChatProtocolError(
      'invalid_ir',
      validation.issues
        .map((issue) => `${issue.rule}:${issue.code}@${issue.messageIndex}`)
        .join(', '),
    )
  }

  const capability = normalizeCapability(capabilityInput)
  const transformed = applyCapability(messages, capability, options)
  const encoded = encodeMessages(transformed.messages)
  const requestMessages: OpenAIChatWireMessage[] = []
  if (options.system !== undefined) {
    requestMessages.push({ role: 'system', content: options.system })
  }
  requestMessages.push(...encoded.messages)

  const model = cleanWireModelId(config.model)
  const body: OpenAIChatRequestBody = {
    model,
    messages: requestMessages,
    stream: false,
  }
  if (options.maxOutputTokens !== undefined) {
    if (!Number.isInteger(options.maxOutputTokens) || options.maxOutputTokens <= 0) {
      throw new OpenAIChatProtocolError(
        'invalid_max_output_tokens',
        'maxOutputTokens 必须是正整数',
      )
    }
    body.max_tokens = options.maxOutputTokens
  }
  if (options.tools !== undefined && options.tools.length > 0) {
    if (!capability.toolCalls) {
      throw new CapabilityError(
        'tool_calls_unsupported',
        '目标 provider 不支持工具定义',
      )
    }
    body.tools = encodeTools(
      options.tools,
      config.toolSchemaDialect ?? 'json-schema',
    )
  }
  if (options.reasoningEffort !== undefined) {
    if (capability.thinking === 'unsupported') {
      // 不发送 provider 不支持的 thinking 控制参数。
    } else if (model.startsWith('o1') || model.startsWith('o3')) {
      body.reasoning_effort = options.reasoningEffort
    } else {
      body.reasoning = { effort: options.reasoningEffort }
    }
  }

  return {
    url: normalizeEndpoint(config.endpoint),
    headers: buildHeaders(config),
    body,
    notices: encoded.notices,
    degradations: transformed.degradations,
  }
}

function numberField(value: unknown, key: string): number {
  if (!isRecord(value)) return 0
  const field = value[key]
  return typeof field === 'number' && Number.isInteger(field) && field >= 0
    ? field
    : 0
}

function decodeUsage(value: unknown): Usage {
  const totalInputTokens = numberField(value, 'prompt_tokens')
  const outputTokens = numberField(value, 'completion_tokens')
  return {
    totalInputTokens,
    outputTokens,
    reliable: totalInputTokens > 0 || outputTokens > 0,
  }
}

export function decodeOpenAIChatResponse(
  response: unknown,
  providerId: string,
  degradation: ResponseDegradationOptions = {},
): OpenAIChatDecodedResponse {
  if (!isRecord(response) || !Array.isArray(response.choices)) {
    throw new OpenAIChatProtocolError(
      'invalid_response',
      'OpenAI Chat response 必须包含 choices 数组',
    )
  }
  const choice = response.choices[0]
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new OpenAIChatProtocolError(
      'missing_choice_message',
      'OpenAI Chat response 缺少 choices[0].message',
    )
  }
  const message = choice.message
  const content: AssistantBlock[] = []
  const notices: OpenAIChatNotice[] = []
  if (typeof message.content === 'string') {
    content.push({ type: 'text', text: message.content })
  } else if (message.content !== null && message.content !== undefined) {
    throw new OpenAIChatProtocolError(
      'invalid_response_content',
      'OpenAI Chat message.content 必须是 string 或 null',
    )
  }

  if (message.reasoning_content !== undefined) {
    const chars =
      typeof message.reasoning_content === 'string'
        ? message.reasoning_content.length
        : 0
    notices.push({
      code: 'discarded_reasoning_content',
      detail: `丢弃非标准 reasoning_content (${chars} chars)`,
    })
  }

  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) {
      throw new OpenAIChatProtocolError(
        'invalid_tool_calls',
        'OpenAI Chat message.tool_calls 必须是数组',
      )
    }
    for (const [index, value] of message.tool_calls.entries()) {
      if (
        !isRecord(value) ||
        value.type !== 'function' ||
        !isRecord(value.function) ||
        typeof value.function.name !== 'string' ||
        value.function.name.length === 0
      ) {
        throw new OpenAIChatProtocolError(
          'invalid_tool_call',
          `message.tool_calls[${index}] 不是完整 function call`,
        )
      }
      const argumentsValue = parseToolArguments(
        value.function.arguments,
        `message.tool_calls[${index}].function.arguments`,
      )
      const id =
        typeof value.id === 'string' && value.id.length > 0
          ? value.id
          : syntheticToolCallId(
              providerId,
              index,
              value.function.name,
              argumentsValue,
            )
      content.push({
        type: 'tool_call',
        id,
        name: value.function.name,
        arguments: argumentsValue,
      })
    }
  }

  const decoded: OpenAIChatDecodedResponse = {
    message: { role: 'assistant', content },
    usage: decodeUsage(response.usage),
    stopReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    notices,
  }
  assertResponseNotDegraded(
    decoded.message,
    decoded.usage,
    decoded.stopReason,
    degradation,
  )
  return decoded
}

export function stringifyOpenAIChatRequest(body: OpenAIChatRequestBody): string {
  return JSON.stringify(body)
}

export class OpenAIChatCompletionsCodec {
  private readonly config: OpenAIChatCodecConfig

  constructor(config: OpenAIChatCodecConfig) {
    this.config = config
  }

  encode(
    messages: readonly Message[],
    capability: Partial<ProviderCapability>,
    options: OpenAIChatEncodeOptions = {},
  ): OpenAIChatEncodedRequest {
    return encodeOpenAIChatRequest(this.config, messages, capability, options)
  }

  decode(
    response: unknown,
    degradation: ResponseDegradationOptions = {},
  ): OpenAIChatDecodedResponse {
    return decodeOpenAIChatResponse(response, this.config.providerId, degradation)
  }

  async call(
    messages: readonly Message[],
    capability: Partial<ProviderCapability>,
    options: OpenAIChatEncodeOptions = {},
  ): Promise<OpenAIChatDecodedResponse> {
    const request = this.encode(messages, capability, options)
    await writeRequestDiagnostic(options.diagnosticWriter, {
      method: 'POST',
      url: request.url,
      headers: request.headers,
      body: request.body,
    })
    const fetchImpl = this.config.fetch ?? globalThis.fetch
    const response = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: stringifyOpenAIChatRequest(request.body),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    if (!response.ok) {
      throw new OpenAIChatHttpError(response.status, await response.text())
    }
    const decoded = this.decode(await response.json(), options.degradation)
    return {
      ...decoded,
      notices: [...request.notices, ...decoded.notices],
    }
  }
}
