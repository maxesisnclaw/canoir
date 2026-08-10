# CanoIR

多 LLM API 的协议中间层：统一消息模型（Canonical IR）、三家 API 编解码（Anthropic Messages / OpenAI Chat Completions / OpenAI Responses）、provider 能力协商与降级、conformance 语料。供 agent harness 作为中间组件接入。

A protocol middle layer for multi-LLM-API agent harnesses: canonical message IR, codecs, capability negotiation, and a conformance corpus.

**Status**: early development（M1 已完成：IR 类型与基础序列校验器可用；codec 尚未实现，不可用于生产）。协议规范见 [SPEC.md](SPEC.md)，实现约束见 [AGENTS.md](AGENTS.md)。

## License

MIT
