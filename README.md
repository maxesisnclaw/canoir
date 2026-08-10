# CanoIR

多 LLM API 的协议中间层：统一消息模型（Canonical IR）、三家 API 编解码（Anthropic Messages / OpenAI Chat Completions / OpenAI Responses）、provider 能力协商与降级、缓存计量分解与 encode 期 cache hint、conformance 语料。供 agent harness 作为中间组件接入。

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
    promptCaching: 'automatic',
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

## 规范层

`normative/registry.json` 固定官方协议来源与版本，并把每条 conformance 语料登记为官方规则、实测偏差或 CanoIR 自身规则。运行：

```sh
bun run official-schema
```

该检查用锁定版本的官方 SDK request 类型机械校验 encode body。官方 SDK 仅是开发期依赖；CanoIR 运行时仍为零依赖。

## License

MIT
