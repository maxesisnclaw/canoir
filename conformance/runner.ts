import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  AnthropicMessagesCodec,
  AnthropicProtocolError,
  AnthropicRefusalError,
  type AnthropicCodecConfig,
  type AnthropicEncodeOptions,
  type AnthropicRequestBody,
  type AnthropicSseEvent,
  stringifyAnthropicRequest,
} from '../src/codecs/anthropic-messages'
import {
  OpenAIChatCompletionsCodec,
  OpenAIChatProtocolError,
  sanitizeSchemaForGemini,
  stringifyOpenAIChatRequest,
  type OpenAIChatCodecConfig,
  type OpenAIChatEncodeOptions,
  type OpenAIChatRequestBody,
} from '../src/codecs/openai-chat-completions'
import type { JsonObject, JsonValue, Message } from '../src/types'
import {
  validateMessages,
  type ValidationOptions,
} from '../src/validate'

export interface ConformanceCase {
  name: string
  category: string
  operation: string
  recorded: boolean
  input: JsonObject
  expected: JsonValue
}

export interface ConformanceExecution {
  name: string
  actual: JsonValue
  expected: JsonValue
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toJsonValue(value: unknown, field: string): JsonValue {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new Error(`${field} 不能序列化为 JSON`)
  }
  return JSON.parse(serialized) as JsonValue
}

function parseCase(value: unknown, path: string): ConformanceCase {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.category !== 'string' ||
    typeof value.operation !== 'string' ||
    !isRecord(value.input) ||
    value.expected === undefined
  ) {
    throw new Error(`非法 conformance case: ${path}`)
  }

  return {
    name: value.name,
    category: value.category,
    operation: value.operation,
    recorded: value.recorded === true,
    input: toJsonValue(value.input, `${path}.input`) as JsonObject,
    expected: toJsonValue(value.expected, `${path}.expected`),
  }
}

export function loadConformanceCases(directory: string): ConformanceCase[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const path = join(directory, file)
      return parseCase(JSON.parse(readFileSync(path, 'utf8')), path)
    })
}

function anthropicCodecConfig(input: JsonObject): AnthropicCodecConfig {
  const value = input.config
  if (!isRecord(value)) throw new Error('anthropic case 缺少 input.config')
  if (
    typeof value.providerId !== 'string' ||
    typeof value.model !== 'string' ||
    typeof value.endpoint !== 'string' ||
    typeof value.apiKey !== 'string'
  ) {
    throw new Error('anthropic config 缺少 providerId/model/endpoint/apiKey')
  }

  const headers = isRecord(value.headers)
    ? Object.fromEntries(
        Object.entries(value.headers).map(([key, headerValue]) => {
          if (typeof headerValue !== 'string') {
            throw new Error(`header ${key} 必须是字符串`)
          }
          return [key, headerValue]
        }),
      )
    : undefined

  return {
    providerId: value.providerId,
    model: value.model,
    endpoint: value.endpoint,
    apiKey: value.apiKey,
    ...(value.compatMode === 'minimal' || value.compatMode === 'default'
      ? { compatMode: value.compatMode }
      : {}),
    ...(headers === undefined ? {} : { headers }),
    ...(typeof value.contextWindowTokens === 'number'
      ? { contextWindowTokens: value.contextWindowTokens }
      : {}),
  }
}

function openAIChatCodecConfig(input: JsonObject): OpenAIChatCodecConfig {
  const value = input.config
  if (!isRecord(value)) throw new Error('openai chat case 缺少 input.config')
  if (
    typeof value.providerId !== 'string' ||
    typeof value.model !== 'string' ||
    typeof value.endpoint !== 'string' ||
    typeof value.apiKey !== 'string'
  ) {
    throw new Error('openai chat config 缺少 providerId/model/endpoint/apiKey')
  }

  const headers = isRecord(value.headers)
    ? Object.fromEntries(
        Object.entries(value.headers).map(([key, headerValue]) => {
          if (typeof headerValue !== 'string') {
            throw new Error(`header ${key} 必须是字符串`)
          }
          return [key, headerValue]
        }),
      )
    : undefined

  return {
    providerId: value.providerId,
    model: value.model,
    endpoint: value.endpoint,
    apiKey: value.apiKey,
    ...(headers === undefined ? {} : { headers }),
    ...(value.toolSchemaDialect === 'gemini-openapi'
      ? { toolSchemaDialect: value.toolSchemaDialect }
      : {}),
  }
}

function messages(input: JsonObject): Message[] {
  if (!Array.isArray(input.messages)) {
    throw new Error('conformance case 缺少 input.messages')
  }
  return input.messages as unknown as Message[]
}

function encodeOptions(input: JsonObject): AnthropicEncodeOptions {
  return isRecord(input.options)
    ? (input.options as AnthropicEncodeOptions)
    : {}
}

function openAIChatEncodeOptions(input: JsonObject): OpenAIChatEncodeOptions {
  return isRecord(input.options)
    ? (input.options as OpenAIChatEncodeOptions)
    : {}
}

function sseEvents(input: JsonObject): AnthropicSseEvent[] {
  if (!Array.isArray(input.events)) {
    throw new Error('stream case 缺少 input.events')
  }
  return input.events as unknown as AnthropicSseEvent[]
}

function normalizeError(error: unknown): JsonValue {
  if (error instanceof AnthropicRefusalError) {
    return toJsonValue(
      {
        error: {
          name: error.name,
          category: error.category,
          explanation: error.explanation,
          partialChars: error.partialChars,
          usage: error.usage,
        },
      },
      'AnthropicRefusalError',
    )
  }
  if (error instanceof AnthropicProtocolError) {
    return { error: { name: error.name, code: error.code } }
  }
  if (error instanceof OpenAIChatProtocolError) {
    return { error: { name: error.name, code: error.code } }
  }
  if (error instanceof Error) {
    return { error: { name: error.name, message: error.message } }
  }
  return { error: { name: 'UnknownError', message: String(error) } }
}

function validationActual(input: JsonObject): JsonValue {
  const options = isRecord(input.options)
    ? (input.options as ValidationOptions)
    : undefined
  const result = validateMessages(input.messages, options)
  return {
    valid: result.valid,
    issueCodes: result.issues.map((issue) => issue.code).sort(),
  }
}

function stringifyActual(input: JsonObject): JsonValue {
  if (!isRecord(input.body)) throw new Error('stringify case 缺少 input.body')
  const json = stringifyAnthropicRequest(input.body as unknown as AnthropicRequestBody)
  const bytes = new TextEncoder().encode(json)
  const replacement = new Uint8Array([0xef, 0xbf, 0xbd])
  let containsReplacementBytes = false
  for (let index = 0; index <= bytes.length - replacement.length; index += 1) {
    if (
      bytes[index] === replacement[0] &&
      bytes[index + 1] === replacement[1] &&
      bytes[index + 2] === replacement[2]
    ) {
      containsReplacementBytes = true
      break
    }
  }
  return {
    containsEscapedLoneSurrogate: json.includes('\\ud800'),
    containsReplacementBytes,
  }
}

export async function runConformanceCase(
  item: ConformanceCase,
): Promise<ConformanceExecution> {
  let actual: JsonValue
  try {
    switch (item.operation) {
      case 'validate':
        actual = validationActual(item.input)
        break
      case 'anthropic-encode': {
        const codec = new AnthropicMessagesCodec(anthropicCodecConfig(item.input))
        const request = codec.encode(messages(item.input), encodeOptions(item.input))
        actual = item.input.includeHeaders === true
          ? toJsonValue(
              { body: request.body, headers: request.headers },
              `${item.name}.actual`,
            )
          : toJsonValue(request.body, `${item.name}.actual`)
        break
      }
      case 'anthropic-decode': {
        const codec = new AnthropicMessagesCodec(anthropicCodecConfig(item.input))
        actual = toJsonValue(codec.decode(item.input.response), `${item.name}.actual`)
        break
      }
      case 'anthropic-decode-stability': {
        const codec = new AnthropicMessagesCodec(anthropicCodecConfig(item.input))
        const first = codec.decode(item.input.response)
        const second = codec.decode(item.input.response)
        const firstTool = first.message.content.find(
          (block) => block.type === 'tool_call',
        )
        const secondTool = second.message.content.find(
          (block) => block.type === 'tool_call',
        )
        actual = {
          nonEmpty:
            firstTool?.type === 'tool_call' && firstTool.id.length > 0,
          stable:
            firstTool?.type === 'tool_call' &&
            secondTool?.type === 'tool_call' &&
            firstTool.id === secondTool.id,
        }
        break
      }
      case 'anthropic-decode-stream': {
        const codec = new AnthropicMessagesCodec(anthropicCodecConfig(item.input))
        actual = toJsonValue(
          codec.decodeStream(sseEvents(item.input)),
          `${item.name}.actual`,
        )
        break
      }
      case 'anthropic-stringify':
        actual = stringifyActual(item.input)
        break
      case 'openai-chat-encode': {
        const codec = new OpenAIChatCompletionsCodec(
          openAIChatCodecConfig(item.input),
        )
        const request = codec.encode(
          messages(item.input),
          openAIChatEncodeOptions(item.input),
        )
        actual = item.input.includeEnvelope === true
          ? toJsonValue(request, `${item.name}.actual`)
          : toJsonValue(request.body, `${item.name}.actual`)
        break
      }
      case 'openai-chat-decode': {
        const codec = new OpenAIChatCompletionsCodec(
          openAIChatCodecConfig(item.input),
        )
        actual = toJsonValue(codec.decode(item.input.response), `${item.name}.actual`)
        break
      }
      case 'openai-chat-decode-stability': {
        const codec = new OpenAIChatCompletionsCodec(
          openAIChatCodecConfig(item.input),
        )
        const first = codec.decode(item.input.response)
        const second = codec.decode(item.input.response)
        const firstTool = first.message.content.find(
          (block) => block.type === 'tool_call',
        )
        const secondTool = second.message.content.find(
          (block) => block.type === 'tool_call',
        )
        actual = {
          nonEmpty:
            firstTool?.type === 'tool_call' && firstTool.id.length > 0,
          stable:
            firstTool?.type === 'tool_call' &&
            secondTool?.type === 'tool_call' &&
            firstTool.id === secondTool.id,
        }
        break
      }
      case 'openai-chat-sanitize-schema':
        actual = toJsonValue(
          sanitizeSchemaForGemini(item.input.schema),
          `${item.name}.actual`,
        )
        break
      case 'openai-chat-stringify': {
        if (!isRecord(item.input.body)) {
          throw new Error('openai stringify case 缺少 input.body')
        }
        const json = stringifyOpenAIChatRequest(
          item.input.body as unknown as OpenAIChatRequestBody,
        )
        actual = {
          containsEscapedLoneSurrogate: json.includes('\\ud800'),
        }
        break
      }
      default:
        throw new Error(`不支持的 conformance operation: ${item.operation}`)
    }
  } catch (error) {
    actual = normalizeError(error)
  }

  return { name: item.name, actual, expected: item.expected }
}
