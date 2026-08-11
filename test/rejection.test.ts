import { describe, expect, test } from 'bun:test'

import {
  AnthropicHttpError,
  AnthropicMessagesCodec,
} from '../src/codecs/anthropic-messages'
import {
  OpenAIChatCompletionsCodec,
} from '../src/codecs/openai-chat-completions'
import { OpenAIResponsesCodec } from '../src/codecs/openai-responses'
import {
  CapabilityRejectionError,
  type RejectionSignature,
  type RuntimeCapability,
} from '../src/rejection'

function signature(
  capability: RuntimeCapability,
  rejection: RejectionSignature['rejection'],
): RejectionSignature {
  return {
    id: `${capability}-rejected`,
    capability,
    rejection,
    recoveryHint:
      capability === 'document'
        ? 'degrade-document'
        : capability === 'image'
          ? 'strip-image'
          : 'remove-thinking-param',
    observedAt: '2026-08-11',
    evidence: ['合成拒绝响应'],
  }
}

function rejectingFetch(body: string): typeof globalThis.fetch {
  return (async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(body, { status: 400 })) as typeof globalThis.fetch
}

describe('capability rejection recognition', () => {
  test('Anthropic document 请求命中签名后抛类型化错误', async () => {
    const codec = new AnthropicMessagesCodec({
      providerId: 'provider-x',
      model: 'model-a',
      endpoint: 'https://endpoint-a.example',
      apiKey: 'test-key',
      capability: {
        vision: true,
        document: 'native',
        toolCalls: true,
        thinking: 'native',
        streaming: false,
      },
      rejectionSignatures: [
        signature('document', { status: 400, bodyMatch: 'document rejected' }),
      ],
      fetch: rejectingFetch('document rejected'),
    })

    let thrown: unknown
    try {
      await codec.call([
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', mediaType: 'application/pdf', data: 'AA==' },
            },
          ],
        },
      ])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CapabilityRejectionError)
    expect((thrown as CapabilityRejectionError).capability).toBe('document')
  })

  test('Chat Completions image 请求命中模糊签名后抛类型化错误', async () => {
    const codec = new OpenAIChatCompletionsCodec({
      providerId: 'provider-x',
      model: 'model-a',
      endpoint: 'https://endpoint-a.example',
      apiKey: 'test-key',
      capability: {
        vision: true,
        document: 'unsupported',
        toolCalls: true,
        thinking: 'native',
        streaming: false,
      },
      rejectionSignatures: [
        signature('image', { status: 400, bodyMatch: 'Invalid request' }),
      ],
      fetch: rejectingFetch('Invalid request: image input'),
    })

    let thrown: unknown
    try {
      await codec.call([
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', mediaType: 'image/png', data: 'AQ==' },
            },
          ],
        },
      ])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CapabilityRejectionError)
    expect((thrown as CapabilityRejectionError).evidence.recoveryHint).toBe(
      'strip-image',
    )
  })

  test('Responses thinking 参数命中精确 error code 后抛类型化错误', async () => {
    const codec = new OpenAIResponsesCodec({
      providerId: 'provider-x',
      model: 'model-a',
      endpoint: 'https://endpoint-a.example',
      apiKey: 'test-key',
      capability: {
        vision: true,
        document: 'native',
        toolCalls: true,
        thinking: 'native',
        streaming: true,
      },
      rejectionSignatures: [
        signature('thinking-param', {
          status: 400,
          errorCode: 'unsupported_parameter',
        }),
      ],
      fetch: rejectingFetch(
        '{"error":{"code":"unsupported_parameter"}}',
      ),
    })

    let thrown: unknown
    try {
      await codec.call(
        [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        { reasoningEffort: 'high' },
      )
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CapabilityRejectionError)
    expect((thrown as CapabilityRejectionError).capability).toBe(
      'thinking-param',
    )
  })

  test('请求未使用签名对应 capability 时保留原始 HTTP 错误', async () => {
    const codec = new AnthropicMessagesCodec({
      providerId: 'provider-x',
      model: 'model-a',
      endpoint: 'https://endpoint-a.example',
      apiKey: 'test-key',
      capability: {
        vision: true,
        document: 'unsupported',
        toolCalls: true,
        thinking: 'native',
        streaming: false,
      },
      rejectionSignatures: [
        signature('image', { status: 400, bodyMatch: 'Invalid request' }),
      ],
      fetch: rejectingFetch('Invalid request'),
    })

    let thrown: unknown
    try {
      await codec.call([
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AnthropicHttpError)
  })
})
