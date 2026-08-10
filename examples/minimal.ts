import { OpenAIResponsesCodec } from '../src/index'

const codec = new OpenAIResponsesCodec({
  providerId: 'provider-x',
  model: 'model-a',
  endpoint: 'https://endpoint-a.example/v1/responses',
  apiKey: 'replace-at-runtime',
  capability: {
    vision: false,
    document: 'unsupported',
    toolCalls: true,
    thinking: 'native',
    thinkingReplay: 'verify-replay',
    promptCaching: 'automatic',
    streaming: true,
  },
})

export const request = codec.encode([
  { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
])

if (import.meta.main) {
  console.log(JSON.stringify(request.body, null, 2))
}
