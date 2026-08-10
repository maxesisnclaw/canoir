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
})
