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
import {
  CapabilityError,
  type CapabilityTransformOptions,
  type ProviderCapability,
} from '../src/capability'
import {
  ResponseDegradationError,
  type ResponseDegradationOptions,
} from '../src/degradation'
import {
  OpenAIResponsesCodec,
  OpenAIResponsesProtocolError,
  type OpenAIResponsesCodecConfig,
  type OpenAIResponsesEncodeOptions,
  type OpenAIResponsesSseEvent,
} from '../src/codecs/openai-responses'
import type { JsonObject, JsonValue, Message } from '../src/types'
import {
  validateMessages,
  type ValidationOptions,
} from '../src/validate'

export interface ConformanceCase {
  file: string
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

function parseCase(value: unknown, path: string, file: string): ConformanceCase {
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
    file,
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
      return parseCase(JSON.parse(readFileSync(path, 'utf8')), path, file)
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
    capability: providerCapability(input, anthropicDefaultCapability),
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
    capability: providerCapability(input, openAIChatDefaultCapability),
    ...(headers === undefined ? {} : { headers }),
    ...(value.toolSchemaDialect === 'gemini-openapi'
      ? { toolSchemaDialect: value.toolSchemaDialect }
      : {}),
  }
}

function openAIResponsesCodecConfig(
  input: JsonObject,
): OpenAIResponsesCodecConfig {
  const value = input.config
  if (!isRecord(value)) throw new Error('responses case 缺少 input.config')
  if (
    typeof value.providerId !== 'string' ||
    typeof value.model !== 'string' ||
    typeof value.endpoint !== 'string' ||
    typeof value.apiKey !== 'string'
  ) {
    throw new Error('responses config 缺少 providerId/model/endpoint/apiKey')
  }
  return {
    providerId: value.providerId,
    model: value.model,
    endpoint: value.endpoint,
    apiKey: value.apiKey,
    capability: providerCapability(input, openAIResponsesDefaultCapability),
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
  const options = isRecord(input.options)
    ? (input.options as OpenAIChatEncodeOptions)
    : {}
  return { ...options, ...capabilityTransformOptions(input) }
}

function openAIResponsesEncodeOptions(
  input: JsonObject,
): OpenAIResponsesEncodeOptions {
  const options = isRecord(input.options)
    ? (input.options as OpenAIResponsesEncodeOptions)
    : {}
  return { ...options, ...capabilityTransformOptions(input) }
}

function capabilityTransformOptions(
  input: JsonObject,
): CapabilityTransformOptions {
  const value = input.documentConversion
  if (!isRecord(value)) return {}
  const toText = typeof value.text === 'string' ? () => value.text as string : undefined
  const images = Array.isArray(value.images)
    ? (value.images as unknown as import('../src/types').ImageBlock[])
    : undefined
  return {
    ...(toText === undefined ? {} : { documentConverters: { toText } }),
    ...(images === undefined
      ? {}
      : {
          documentConverters: {
            ...(toText === undefined ? {} : { toText }),
            toImages: () => images,
          },
        }),
  }
}

function providerCapability(
  input: JsonObject,
  defaults: ProviderCapability,
): ProviderCapability {
  const value = input.capability
  if (!isRecord(value)) return defaults
  return {
    vision: value.vision === true,
    document:
      value.document === 'native' || value.document === 'degrade'
        ? value.document
        : 'unsupported',
    toolCalls: value.toolCalls === true,
    thinking:
      value.thinking === 'native' || value.thinking === 'disabled-param'
        ? value.thinking
        : 'unsupported',
    thinkingReplay:
      value.thinkingReplay === 'verify-replay' ||
      value.thinkingReplay === 'replay'
        ? value.thinkingReplay
        : 'drop',
    promptCaching:
      value.promptCaching === 'explicit-markers' ||
      value.promptCaching === 'automatic'
        ? value.promptCaching
        : 'none',
    streaming: value.streaming === true,
    ...(Array.isArray(value.hostedTools) &&
    value.hostedTools.every((item) => typeof item === 'string')
      ? { hostedTools: value.hostedTools }
      : {}),
  }
}

const anthropicDefaultCapability: ProviderCapability = {
  vision: true,
  document: 'unsupported',
  toolCalls: true,
  thinking: 'native',
  thinkingReplay: 'verify-replay',
  promptCaching: 'explicit-markers',
  streaming: true,
}

const openAIChatDefaultCapability: ProviderCapability = {
  vision: true,
  document: 'unsupported',
  toolCalls: true,
  thinking: 'native',
  thinkingReplay: 'drop',
  promptCaching: 'automatic',
  streaming: false,
}

const openAIResponsesDefaultCapability: ProviderCapability = {
  vision: true,
  document: 'native',
  toolCalls: true,
  thinking: 'native',
  thinkingReplay: 'verify-replay',
  promptCaching: 'automatic',
  streaming: true,
}

function responsesEvents(input: JsonObject): OpenAIResponsesSseEvent[] {
  if (!Array.isArray(input.events)) {
    throw new Error('responses stream case 缺少 input.events')
  }
  return input.events.map((data) => ({
    data: data as JsonObject,
  }))
}

function degradationOptions(input: JsonObject): ResponseDegradationOptions {
  const value = input.degradation
  if (!isRecord(value)) return {}
  return {
    ...(typeof value.thinkingTokenBudget === 'number'
      ? { thinkingTokenBudget: value.thinkingTokenBudget }
      : {}),
    ...(typeof value.thinkingTokens === 'number'
      ? { thinkingTokens: value.thinkingTokens }
      : {}),
  }
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
  if (error instanceof ResponseDegradationError) {
    return {
      error: {
        name: error.name,
        code: error.code,
        stopReason: error.stopReason,
        usage: toJsonValue(error.usage, 'ResponseDegradationError.usage'),
      },
    }
  }
  if (error instanceof AnthropicProtocolError) {
    return { error: { name: error.name, code: error.code } }
  }
  if (error instanceof OpenAIChatProtocolError) {
    return { error: { name: error.name, code: error.code } }
  }
  if (error instanceof OpenAIResponsesProtocolError) {
    return { error: { name: error.name, code: error.code } }
  }
  if (error instanceof CapabilityError) {
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
        const request = codec.encode(
          messages(item.input),
          encodeOptions(item.input),
        )
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
        actual = toJsonValue(
          codec.decode(item.input.response, degradationOptions(item.input)),
          `${item.name}.actual`,
        )
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
          codec.decodeStream(
            sseEvents(item.input),
            degradationOptions(item.input),
          ),
          `${item.name}.actual`,
        )
        break
      }
      case 'anthropic-decode-reencode': {
        const codec = new AnthropicMessagesCodec(anthropicCodecConfig(item.input))
        const decoded = codec.decodeStream(
          sseEvents(item.input),
          degradationOptions(item.input),
        )
        const replay = codec.encode(
          [
            {
              role: 'user',
              content: [{ type: 'text', text: 'continue' }],
            },
            decoded.message,
          ],
          encodeOptions(item.input),
        )
        actual = toJsonValue(
          {
            decoded,
            replayBody: replay.body,
            degradations: replay.degradations,
          },
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
          ? toJsonValue(
              {
                body: request.body,
                notices: request.notices,
                degradations: request.degradations,
              },
              `${item.name}.actual`,
            )
          : toJsonValue(request.body, `${item.name}.actual`)
        break
      }
      case 'openai-chat-decode': {
        const codec = new OpenAIChatCompletionsCodec(
          openAIChatCodecConfig(item.input),
        )
        actual = toJsonValue(
          codec.decode(item.input.response, degradationOptions(item.input)),
          `${item.name}.actual`,
        )
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
      case 'responses-encode': {
        const codec = new OpenAIResponsesCodec(
          openAIResponsesCodecConfig(item.input),
        )
        const request = codec.encode(
          messages(item.input),
          openAIResponsesEncodeOptions(item.input),
        )
        actual = item.input.includeEnvelope === true
          ? toJsonValue(
              { body: request.body, degradations: request.degradations },
              `${item.name}.actual`,
            )
          : toJsonValue(request.body, `${item.name}.actual`)
        break
      }
      case 'responses-decode-stream': {
        const codec = new OpenAIResponsesCodec(
          openAIResponsesCodecConfig(item.input),
        )
        actual = toJsonValue(
          codec.decodeStream(
            responsesEvents(item.input),
            degradationOptions(item.input),
          ),
          `${item.name}.actual`,
        )
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
