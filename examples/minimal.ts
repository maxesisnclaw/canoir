import { OpenAIResponsesCodec, type ProviderCapability } from '../src/index'

const capability: ProviderCapability = {
  vision: false,
  document: 'unsupported',
  toolCalls: true,
  thinking: 'native',
  streaming: true,
}

const codec = new OpenAIResponsesCodec({
  providerId: 'provider-x',
  model: 'model-a',
  endpoint: 'https://endpoint-a.example/v1/responses',
  apiKey: 'replace-at-runtime',
})

export const request = codec.encode(
  [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
  capability,
)

if (import.meta.main) {
  console.log(JSON.stringify(request.body, null, 2))
}
