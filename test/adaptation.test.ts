import { describe, expect, test } from 'bun:test'

import {
  CapabilityRejectionMemory,
  RuntimeCapabilityAdapter,
  type RejectionSignature,
} from '../src/adaptation'
import {
  OpenAIResponsesCodec,
  OpenAIResponsesHttpError,
} from '../src/codecs/openai-responses'

function signature(
  capability: RejectionSignature['capability'],
  bodyMatch: string,
): RejectionSignature {
  const recovery =
    capability === 'document'
      ? 'degrade-document'
      : capability === 'image'
        ? 'strip-image'
        : 'remove-thinking-param'
  return {
    id: `${capability}-rejected`,
    capability,
    rejection: { status: 400, bodyMatch },
    recovery,
    observedAt: '2026-08-11',
    evidence: ['合成 conformance 拒绝响应'],
  }
}

function successfulSse(): string {
  return [
    'event: response.output_text.done',
    'data: {"type":"response.output_text.done","item_id":"msg-a","output_index":0,"content_index":0,"text":"ok"}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1},"output":[{"id":"msg-a","type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]}}',
    '',
  ].join('\n')
}

function responsesCodec(
  fetchImpl: typeof globalThis.fetch,
): OpenAIResponsesCodec {
  return new OpenAIResponsesCodec({
    providerId: 'provider-x',
    model: 'model-a',
    endpoint: 'https://endpoint-a.example',
    apiKey: 'test-key',
    capability: {
      vision: true,
      document: 'native',
      toolCalls: true,
      thinking: 'native',
      thinkingReplay: 'verify-replay',
      promptCaching: 'automatic',
      streaming: true,
    },
    fetch: fetchImpl,
  })
}

function rejectingThenSuccessfulFetch(
  rejectionBody: string,
  requests: unknown[],
): typeof globalThis.fetch {
  let count = 0
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as unknown)
    count += 1
    if (count === 1) return new Response(rejectionBody, { status: 400 })
    return new Response(successfulSse(), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as typeof globalThis.fetch
}

describe('runtime capability adaptation', () => {
  test('document 拒绝后优先转页面图片并只重试一次', async () => {
    const requests: unknown[] = []
    const codec = responsesCodec(
      rejectingThenSuccessfulFetch('document input rejected', requests),
    )
    const adapter = new RuntimeCapabilityAdapter([
      signature('document', 'document input rejected'),
    ])

    const result = await codec.callAdaptive(
      adapter,
      [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', mediaType: 'application/pdf', data: 'AA==' },
            },
          ],
        },
      ],
      {
        documentConverters: {
          toImages: () => [
            {
              type: 'image',
              source: { type: 'base64', mediaType: 'image/png', data: 'AQ==' },
            },
          ],
          toText: () => 'document text',
        },
      },
    )

    expect(result.retried).toBe(true)
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[0])).toContain('input_file')
    expect(JSON.stringify(requests[1])).toContain('input_image')
    expect(result.degradations.map((item) => item.action)).toContain(
      'document-to-images',
    )
  })

  test('image 拒绝后剥离图片并注入文本说明', async () => {
    const requests: unknown[] = []
    const codec = responsesCodec(
      rejectingThenSuccessfulFetch('image input rejected', requests),
    )
    const adapter = new RuntimeCapabilityAdapter([
      signature('image', 'image input rejected'),
    ])

    const result = await codec.callAdaptive(adapter, [
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

    expect(result.retried).toBe(true)
    expect(JSON.stringify(requests[0])).toContain('input_image')
    expect(JSON.stringify(requests[1])).not.toContain('input_image')
    expect(JSON.stringify(requests[1])).toContain('图片已因目标端点拒绝而移除')
    expect(result.degradations.map((item) => item.action)).toContain('filtered')
  })

  test('thinking 参数拒绝后删除 reasoning 再重试', async () => {
    const requests: unknown[] = []
    const codec = responsesCodec(
      rejectingThenSuccessfulFetch('reasoning parameter rejected', requests),
    )
    const adapter = new RuntimeCapabilityAdapter([
      signature('thinking-param', 'reasoning parameter rejected'),
    ])

    const result = await codec.callAdaptive(
      adapter,
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      { reasoningEffort: 'high' },
    )

    expect(result.retried).toBe(true)
    expect(requests[0]).toMatchObject({ reasoning: { effort: 'high' } })
    expect(requests[1]).not.toHaveProperty('reasoning')
    expect(result.degradations.map((item) => item.action)).toContain(
      'thinking-param-removed',
    )
  })

  test('模糊签名触发的重试仍失败时抛第一次原始错误', async () => {
    const errors = ['first opaque error', 'second opaque error']
    let count = 0
    const fetchImpl = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      const body = errors[count] ?? 'unexpected'
      count += 1
      return new Response(body, { status: 400 })
    }) as typeof globalThis.fetch
    const codec = responsesCodec(fetchImpl)
    const adapter = new RuntimeCapabilityAdapter([
      signature('image', 'opaque error'),
    ])

    let thrown: unknown
    try {
      await codec.callAdaptive(adapter, [
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

    expect(count).toBe(2)
    expect(thrown).toBeInstanceOf(OpenAIResponsesHttpError)
    expect((thrown as OpenAIResponsesHttpError).responseBody).toBe(
      'first opaque error',
    )
  })

  test('负面记忆命中时直接降级，TTL 到期后恢复富形态', async () => {
    let now = 1_000
    const memory = new CapabilityRejectionMemory({
      ttlMs: 100,
      now: () => now,
    })
    memory.remember('https://endpoint-a.example', 'model-a', 'image')
    const adapter = new RuntimeCapabilityAdapter([], memory)
    const seen: boolean[] = []

    const execute = () =>
      adapter.execute({
        endpoint: 'https://endpoint-a.example',
        model: 'model-a',
        usedCapabilities: (rejected) => {
          seen.push(rejected.has('image'))
          return rejected.has('image') ? [] : ['image']
        },
        attempt: async () => ({ value: 'ok' }),
      })

    expect((await execute()).retried).toBe(false)
    now += 101
    expect((await execute()).retried).toBe(false)
    expect(seen).toEqual([true, false])
  })
})
