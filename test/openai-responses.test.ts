import { describe, expect, test } from 'bun:test'

import { OpenAIResponsesCodec } from '../src/codecs/openai-responses'

describe('OpenAIResponsesCodec transport', () => {
  test('发送流式请求并从原始 SSE 组装响应', async () => {
    let requestBody: unknown
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as unknown
      const body = [
        'event: response.output_text.done',
        'data: {"type":"response.output_text.done","item_id":"msg-a","output_index":0,"content_index":0,"text":"hello"}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2},"output":[{"id":"msg-a","type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}]}}',
        '',
      ].join('\n')
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as typeof globalThis.fetch

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
      fetch: fetchImpl,
    })
    const result = await codec.call([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ])

    expect(requestBody).toMatchObject({
      model: 'model-a',
      stream: true,
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      ],
    })
    expect(result.message.content[0]).toEqual({ type: 'text', text: 'hello' })
    expect(result.usage).toEqual({
      totalInputTokens: 3,
      outputTokens: 2,
      reliable: true,
    })
  })

  test('结构化回放把 assistant 文本放在 function_call 之前', () => {
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
    })
    const encoded = codec.encode([
      { role: 'user', content: [{ type: 'text', text: 'lookup x' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will check.' },
          { type: 'tool_call', id: 'call_prev', name: 'lookup', arguments: { query: 'x' } },
        ],
      },
      { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'call_prev', content: '{"ok":true}' }] },
    ])
    const types = encoded.body.input.map((item) =>
      typeof item === 'object' && item !== null && 'type' in item && typeof item.type === 'string'
        ? item.type
        : typeof item === 'object' && item !== null && 'role' in item && typeof item.role === 'string'
          ? item.role
          : 'unknown',
    )
    expect(types).toEqual([
      'user',
      'assistant',
      'function_call',
      'function_call_output',
    ])
    expect(encoded.body.input[2]).toMatchObject({ type: 'function_call', call_id: 'call_prev' })
    expect(encoded.body.input[3]).toMatchObject({ type: 'function_call_output', call_id: 'call_prev' })
  })
})
