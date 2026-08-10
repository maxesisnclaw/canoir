import { describe, expect, test } from 'bun:test'

import { OpenAIChatCompletionsCodec } from '../src/codecs/openai-chat-completions'

describe('OpenAIChatCompletionsCodec transport', () => {
  test('通过注入 fetch 发送非流式请求并解码响应', async () => {
    let requestBody: unknown
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as unknown
      return Response.json({
        choices: [
          { message: { content: 'hello' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      })
    }) as typeof globalThis.fetch

    const codec = new OpenAIChatCompletionsCodec({
      providerId: 'provider-x',
      model: 'model-a',
      endpoint: 'https://endpoint-a.example',
      apiKey: 'test-key',
      fetch: fetchImpl,
    })
    const result = await codec.call([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ])

    expect(requestBody).toEqual({
      model: 'model-a',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(result.usage).toEqual({
      totalInputTokens: 3,
      outputTokens: 2,
      reliable: true,
    })
  })
})
