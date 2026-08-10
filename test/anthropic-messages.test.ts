import { describe, expect, test } from 'bun:test'

import { AnthropicMessagesCodec } from '../src/codecs/anthropic-messages'

describe('AnthropicMessagesCodec transport', () => {
  test('通过注入 fetch 发送请求并从原始 SSE 重建响应', async () => {
    let requestBody: unknown
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as unknown
      const body = [
        'event: message_start',
        'data: {"type":"message_start","message":{"content":[],"stop_reason":null,"usage":{"input_tokens":3,"output_tokens":0}}}',
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
        '',
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":0}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n')
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as typeof globalThis.fetch

    const codec = new AnthropicMessagesCodec({
      providerId: 'provider-x',
      model: 'model-a',
      endpoint: 'https://endpoint-a.example',
      apiKey: 'test-key',
      compatMode: 'minimal',
      fetch: fetchImpl,
    })
    const result = await codec.call(
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      {
        vision: true,
        document: 'unsupported',
        toolCalls: true,
        thinking: 'native',
        streaming: true,
      },
    )

    expect(requestBody).toMatchObject({
      model: 'model-a',
      stream: true,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
    })
    expect(result.message.content[0]).toEqual({ type: 'text', text: 'hello' })
    expect(result.usage).toEqual({
      totalInputTokens: 3,
      outputTokens: 2,
      reliable: true,
    })
  })
})
