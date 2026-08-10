# CanoIR

多 LLM API 的协议中间层：统一消息模型（Canonical IR）、三家 API 编解码（Anthropic Messages / OpenAI Chat Completions / OpenAI Responses）、provider 能力协商与降级、conformance 语料。供 agent harness 作为中间组件接入。

A protocol middle layer for multi-LLM-API agent harnesses: canonical message IR, codecs, capability negotiation, and a conformance corpus.

**Status**: v0.1.0。协议规范见 [SPEC.md](SPEC.md)，实现约束见 [AGENTS.md](AGENTS.md)。

## 最小接入

```ts
import { OpenAIResponsesCodec } from 'canoir'

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
    streaming: true,
  },
})

const request = codec.encode([
  { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
])
```

仓库内的可执行版本位于 `examples/minimal.ts`：

```sh
bun run example
```

## License

MIT
