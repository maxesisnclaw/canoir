# CanoIR 协议规范

版本：0.1

CanoIR 定义一套与 provider 无关的消息中间表示（IR）、消息序列不变量和能力协商规则。Codec 负责在 IR 与具体 API wire 格式之间双向转换；host 只提供配置、工具执行结果和可选诊断目标，不参与 provider 消息建模。

本文中的“必须”“不得”是规范性要求。“请求历史”指即将发送给模型的完整、可回放消息序列；尚未完成工具执行的临时状态不属于请求历史。

官方协议规范是 vendor wire 行为的先验事实源；实测行为只有在 `normative/registry.json` 中登记为偏差后，才能覆盖对应条件下的官方规则。代码行为与官方规范矛盾且没有对应偏差登记时，视为 bug，不得解释为兼容特性。官方文档更新或端点复测后，相关偏差必须重新评估。

## 1. 数据约定

### 1.1 JSON 值

IR 中需要原样保存或承载结构化参数的值必须是 JSON 可表示值：`null`、布尔值、有限数字、字符串、数组或仅含这些值的对象。`undefined`、函数、循环引用、`NaN` 与无穷值不合法。

```ts
type JsonPrimitive = null | boolean | number | string
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }
```

### 1.2 标识符

- `providerId`：host 注入的稳定 provider 标识，仅用于判断 provider-bound block 是否可回放，不得从显示名推导。
- `model`：发送到 API 的原始模型标识。显示后缀、ANSI 控制字符和能力标签不得写入该字段。
- `tool_call.id`：非空字符串。provider 未提供时由 codec 生成稳定 ID；同一 wire 输入重复解码必须得到相同 ID。

## 2. IR 消息模型

### 2.1 Role 与消息

Role 只有三种：`user`、`assistant`、`tool`。

```ts
type Role = 'user' | 'assistant' | 'tool'

interface Message {
  role: Role
  content: Block[]
}
```

各 role 允许的 block：

| Role | 允许的 block |
|---|---|
| `user` | `text`、`image`、`document` |
| `assistant` | `text`、`thinking`、`tool_call`、`refusal`、`provider_blocks` |
| `tool` | `tool_result`，且每条消息至少一个 |

空 `content` 数组只允许出现在尚未进入历史的临时组装状态；请求历史中不得出现空消息。

### 2.2 Block

#### text

```ts
interface TextBlock {
  type: 'text'
  text: string
}
```

空串合法，语义为“明确没有文本”，不得擅自改写为空格或占位文案。

#### thinking

```ts
interface ThinkingBlock {
  type: 'thinking'
  thinking: string
  signature: string
  providerId: string
}
```

`signature` 是 provider 下发的 opaque provenance token：codec 只记录并在回放策略允许时原样携带，不解释、不校验、不伪造其内容。字段必须是字符串；provider 没有下发 token 时使用空字符串。`providerId` 必须非空。Thinking 是 provider-bound 数据，不可截断，不可跨 provider 回放。

#### tool_call

```ts
interface ToolCallBlock {
  type: 'tool_call'
  id: string
  name: string
  arguments: JsonObject
}
```

`id`、`name` 必须非空。`arguments` 在进入 IR 前必须解析为 object；JSON 数组、标量和未解析字符串均不合法。

#### tool_result

```ts
interface ToolResultBlock {
  type: 'tool_result'
  toolCallId: string
  content: string
  images?: ImageBlock[]
}
```

`toolCallId` 必须非空并关联同一序列内更早的 `tool_call.id`。`content` 可为空串。图片是否能发送由目标 capability 决定。

#### image

```ts
interface ImageBlock {
  type: 'image'
  source: {
    type: 'base64'
    mediaType: string
    data: string
  }
}
```

`mediaType` 与 `data` 必须非空。IR 不接受本机文件路径；host 在构造消息前负责读取并编码文件。

#### document

```ts
type DocumentSource =
  | { type: 'base64'; mediaType: string; data: string }
  | { type: 'url'; url: string }
  | { type: 'text'; mediaType?: string; text: string }

interface DocumentBlock {
  type: 'document'
  source: DocumentSource
}
```

Base64 与 URL source 的载荷必须非空；text source 允许空文本。Codec 不得假定所有 provider 都支持同一种 document wire 形态。

#### refusal

```ts
interface RefusalBlock {
  type: 'refusal'
  category?: string
  explanation?: string
}
```

`refusal` 是 `stop_reason=refusal` 等 provider 拒绝信号的结构化形态。流中已产生的 partial text、thinking 和 tool call 不得与 refusal 一同进入可回放历史。

#### provider_blocks

```ts
interface ProviderBlocksBlock {
  type: 'provider_blocks'
  providerId: string
  blocks: JsonValue[]
}
```

该 block 用于同 provider verbatim 回放原生 output item 或 block，必须保留原始顺序。`providerId` 必须非空；跨 provider 编码时整块丢弃。

OpenAI Responses 的 reasoning item 必须作为一个完整原生 item 保存并回放，不能只提取 summary。实测返回字段包含 `type`、`id`、`summary`、`content` 与 `encrypted_content`；仅把该 item 原样放入下一轮 `input`，再追加新的 user item，端点即可继续使用上一轮推理结果。Codec 请求必须包含 `include: ['reasoning.encrypted_content']`，且不得改写、截断或跨 provider 发送该密文。

### 2.3 Usage

```ts
interface Usage {
  totalInputTokens: number
  outputTokens: number
  reliable: boolean
  cacheReadTokens?: number
  cacheCreationTokens?: number
  reasoningTokens?: number
}
```

- 所有 token 数必须是非负整数。
- Anthropic 的 `totalInputTokens` 等于 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`，缺失项按 0 计。
- OpenAI Chat Completions 与 Responses 使用 API 给出的单次 input 总值，不与 cached token 字段叠加。
- `cacheReadTokens` 映射 Anthropic `cache_read_input_tokens` 或 OpenAI `cached_tokens`；`cacheCreationTokens` 映射 Anthropic `cache_creation_input_tokens`；`reasoningTokens` 映射各 API 的 reasoning/thinking token 明细。
- Provider 没有返回某项分解数据时字段必须缺省；明确返回 0 时保留 0。不得用推测值补齐分解字段。
- 全 0 占位、字段缺失或 provider 明示估算值时，`reliable=false`。上层不得用不可靠 usage 覆盖已知可靠状态。
- Usage 只表达 token 计量，不表达价格或金额。定价属于 host 配置，CanoIR 不计算费用。

## 3. Capability 与降级记录

### 3.1 ProviderCapability

Capability 由 host 按 provider 维度注入，codec 不从模型显示名、历史消息或 endpoint 猜测。

```ts
interface ProviderCapability {
  vision: boolean
  document: 'native' | 'degrade' | 'unsupported'
  toolCalls: boolean
  thinking: 'native' | 'disabled-param' | 'unsupported'
  thinkingReplay: 'verify-replay' | 'replay' | 'drop'
  promptCaching: 'explicit-markers' | 'automatic' | 'none'
  streaming: boolean
  hostedTools?: string[]
}
```

字段缺失按最保守值处理：布尔值为 `false`，`document='unsupported'`，`thinking='unsupported'`，`thinkingReplay='drop'`，`promptCaching='none'`，`hostedTools=[]`。未知 hosted tool 不得发送。

`thinking` 只描述端点的 thinking 控制参数：`disabled-param` 表示关闭 thinking 时必须发送目标 API 的显式 disabled 参数；host 的 `off` 字符串不得原样进入 wire；`unsupported` 时不得发送 thinking 控制参数。

`thinkingReplay` 独立描述历史回放策略：

1. `verify-replay`：provider 会校验 provenance token；只有非空 token 的 thinking 可回放。
2. `replay`：provider 容忍原样回放；空 token thinking 也可回放。
3. `drop`：回放时丢弃 thinking；未知端点默认使用该档。

Capability 在 codec constructor 中固定。Host 主动改变先验声明时只能通过 `updateCapability()` 显式整体替换；`encode()` 与 `call()` 不接受 per-call capability override。§3.5 的运行时适应是 CanoIR 对已观测拒绝的后验修正，不向 caller 暴露任意 capability override。

`promptCaching` 描述请求侧缓存控制机制：

1. `explicit-markers`：codec 可把 encode 期 cache hint 翻译为目标 API 的显式 breakpoint。
2. `automatic`：provider 自动决定缓存前缀，不接受 CanoIR 显式 marker。
3. `none`：端点不提供可用的 prompt cache。

### 3.2 降级记录

每次请求侧过滤或降级都产生 host 可读记录：

```ts
interface DegradationRecord {
  blockType: 'image' | 'document' | 'thinking' | 'provider_blocks' | 'prompt_cache'
  action: 'filtered' | 'document-to-images' | 'document-to-text' | 'thinking-param-removed' | 'cache-hint-ignored'
  reason: string
}
```

记录只描述已经发生的转换，不包含自动重试或路由策略。

### 3.3 Document 降级格

1. `document='native'`：按目标 API 的原生 document 形态发送。
2. `document='degrade'`：版式敏感且 `vision=true` 时优先逐页转 image；否则提取纯文本。实际采用的路径必须记录。
3. `document='unsupported'`，或声明可降级但没有可执行转换器：fail-loud，返回“该 provider 不支持 document”。
4. `vision=false`：请求侧过滤所有 image block，包括 tool result 附带图片，并记录原因。

转换器必须由真实调用方提供；codec 不伪造图片或文档文本。

### 3.4 Prompt cache hint

Cache breakpoint 是单次请求的优化策略，不是消息语义，不进入 IR block。Host 可在 encode options 传入：

```ts
type PromptCacheAnchor =
  | { kind: 'system' }
  | { kind: 'tools' }
  | { kind: 'history' }
  | { kind: 'message'; nthFromEnd: number }

interface PromptCacheHint {
  anchors: PromptCacheAnchor[]
}
```

Anchors 是无序集合，重复值去重：

- `system`：system 内容的最后一个 wire block。
- `tools`：最后一个 tool definition。
- `history`：编码后最后一条 message 的最后一个 wire content block。
- `message`：输入 IR 消息倒序的 1-based 位置；marker 跟随该消息正规化后的最后一个 wire content block，即使相邻消息随后合并也不改变边界。

`nthFromEnd` 非正整数、越界、锚点没有实际 wire target，或实际 breakpoint 数超过目标 API 上限时必须在编码前 fail-loud。Anthropic Messages 当前上限为 4 个实际 breakpoint；多个锚点落到同一 block 时只计一个。没有 hint 时不得隐式添加 marker。

合法 hint 遇到 `automatic` 或 `none` capability 时，codec 保持请求语义与 wire body 不变，并记录 `prompt_cache/cache-hint-ignored`。这是唯一允许静默忽略并记录而不是 fail-loud 的 capability 降级：cache hint 只影响性能和计费，不改变模型可见内容或工具语义。

### 3.5 运行时能力适应

Capability 声明是先验；运行时适应只处理“声明支持、实际请求被端点拒绝”的后验反证。拒绝签名形态为：

```ts
interface RejectionSignature {
  id: string
  capability: 'document' | 'image' | 'thinking-param'
  rejection: { status: number; bodyMatch?: string; errorCode?: string }
  recovery: 'degrade-document' | 'strip-image' | 'remove-thinking-param'
  observedAt: string
  evidence: string[]
}
```

`bodyMatch` 是响应 body 的子串匹配；`errorCode` 从顶层 `code` 或 `error.code` 精确匹配。两者至少存在一个，同时存在时必须全部匹配。只有本次出站请求实际使用 capability X，且 HTTP 响应匹配 X 的签名，才能认定 X 被拒绝。单凭相同 status/body、但请求没有使用 X，不得触发降级。

每次 `callAdaptive()` 最多增加一次请求：

1. 初次请求失败且命中签名时，记录负面记忆并按对应 recovery 重编请求。
2. 降级请求成功时返回结果、降级记录与 `retried=true`。
3. 降级请求仍失败时不再重试，并抛出第一次请求的原始 HTTP 错误。第二次失败若匹配其实际使用的另一能力，可记录该拒绝供后续请求使用。

| capability | recovery | wire 变化 |
|---|---|---|
| `document` | `degrade-document` | 有页面转换器且 vision 可用时转逐页图片；否则用文本转换器提取纯文本 |
| `image` | `strip-image` | 移除 user/tool result 图片，并在原位置或 tool result 文本末尾加入明确注记 |
| `thinking-param` | `remove-thinking-param` | 移除 Anthropic `thinking` 或 OpenAI `reasoning` / `reasoning_effort` 控制参数 |

所有实际转换继续产生 `DegradationRecord`。运行时适应不得修改 codec 的 constructor capability，也不得把后验记忆伪装成 host 配置。

负面记忆键为 `(endpoint, model, capability)`，值为 `rejectedAt`。默认 TTL 为 24 小时，可在创建 memory 时配置；只记拒绝，不记成功。到期条目立即删除且不留墓碑，因此下一次请求恢复富形态并可自然发现端点已升级。v1 只使用进程内 `Map`，不持久化。

非目标：不维护 endpoint profile，不定期 probe，不跟踪长期行为，不自动发现“声明不支持、端点实际新增”的能力，也不提供 probe 工具。

## 4. Vendor 协议规范与实测偏差

固定来源、不可变版本、规则依据和对应语料统一登记在 `normative/registry.json`。本节只定义来源层级与已确认边界，不复制 registry 中可机械审计的逐 case 映射。

### 4.1 Anthropic Messages

#### 官方规范

- 请求结构以 `@anthropic-ai/sdk@0.116.0` 的 `MessageCreateParams` 为机械校验类型，固定到 registry 记录的 tag commit；API version 固定为 `2023-06-01`。
- 标准请求字段、content block、thinking 配置、tool use、usage、refusal 和流式事件以该版本公开类型为依据。

#### 实测偏差

- 兼容端点的 minimal proxy 模式、`message_start` 全零 usage 后由 `message_delta` 回填、tool input 的 JSON 字符串或 `arguments` 形态，均是条件化偏差。
- 完整但没有 provenance token 的 thinking 可以合法进入 IR；能否回放由 `thinkingReplay` 三档 capability 决定，而不是假定所有端点都执行签名校验。

### 4.2 OpenAI Chat Completions

#### 官方规范

- 请求结构以 `openai@7.4.0` 的 `ChatCompletionCreateParams` 做机械校验，其上游规范锚定 registry 中固定 commit 的 OpenAI OpenAPI `CreateChatCompletionRequest`。
- 官方字段与响应结构不因兼容端点的方言而扩张；`reasoning_effort` 等字段按固定版本类型解释。

#### 实测偏差

- Gemini 兼容层只接受收窄后的 OpenAPI 3.0 schema 子集，属于端点方言，不改写官方基线。
- `reasoning` object 与响应中的 `reasoning_content` 是兼容端点扩展，必须按登记条件处理；未登记的相似字段不得凭名称臆造映射。

### 4.3 OpenAI Responses

#### 官方规范

- 请求结构以 `openai@7.4.0` 的 `ResponseCreateParams` 做机械校验，其上游规范锚定 registry 中固定 commit 的 OpenAI OpenAPI `CreateResponse`。
- reasoning item 的 `encrypted_content` 属于官方结构；需要延续推理时应请求并原样回放同 provider 返回的完整 item。
- function tool 的 `strict` 是该固定版本 request 类型的必填字段。CanoIR 默认发送 `strict: false`，保持现有宽松 JSON Schema 语义。

#### 实测偏差

- function call item 上的 `thought_signature` 是兼容端点扩展；仅在同 provider verbatim 回放中保留，不把它提升为 OpenAI 官方字段。

## 5. 消息序列不变量

校验错误至少包含不变量编号、消息索引、可选 block 索引和稳定错误码。Codec 正规化、编码与流式组装不得绕过这些规则。

### I1 — tool_call 与 tool_result 成对

每个 assistant `tool_call` 必须在后续 tool 消息中恰好有一个同 ID 的 `tool_result`；每个 `tool_result` 必须关联更早的 `tool_call`。ID 缺失、孤儿、重复结果和结果先于调用均非法。

- 正例：assistant 调用 `call-1`，下一条 tool 消息返回 `call-1`。
- 反例：序列结束时 `call-1` 没有结果；tool 消息引用不存在的 `call-2`；tool result 的 `toolCallId` 为空。

### I2 — thinking 不可截断

流式组装器只能在 thinking block 闭合后把它提交到 IR。steering、abort 或 malformed stream 导致的 partial thinking 必须整块丢弃。provider 下发的 provenance token 不得截断、补写或伪造；没有 token 是合法事实，以空字符串记录。校验器拒绝非字符串 token 或空 providerId；“尽量保留 partial”不是合法降级。

- 正例：完整 `thinking_delta` 后 block 正常闭合；有 `signature_delta` 时原样记录，无 token 时记录空字符串。
- 反例：只收到部分 thinking 后中断；把 provider token 截短或合成一个替代 token。两者均不得进入历史。

### I3 — Chat Completions 的 tool-call assistant content 为 null

编码 OpenAI Chat Completions 时，只要 assistant 消息含 `tool_call`，wire message 的 `content` 必须为 `null`，不得为空字符串。可见文本若存在，按 API 支持的文本值发送；没有文本时仍用 `null`。

- 正例：`{role:'assistant', content:null, tool_calls:[...]}`。
- 反例：`{role:'assistant', content:'', tool_calls:[...]}`。

### I4 — tool_call ID 永非空

解码时若 provider 未返回 ID，codec 必须根据 providerId、响应内稳定位置和调用内容生成非空、可重复的合成 ID。随机数和当前时间不得参与稳定 ID。

- 正例：同一无 ID wire 响应重复解码，两次得到相同的 `synthetic-*` ID。
- 反例：IR 中 ID 为空；重放相同 fixture 得到不同 ID；编码时把空 ID 发回 provider。

### I5 — arguments 在 IR 中永为 object

Codec 必须兼容已验证的三种 wire 形态：原生 object、JSON object 字符串、兼容端点的 `arguments` 字段。三种形态应解码为相同 `JsonObject`。解析完成即提交，不等待无意义的后续 delta。

- 正例：`{"city":"Shanghai"}` object 与其 JSON 字符串都得到 `{city:'Shanghai'}`。
- 反例：未解析字符串进入 IR；解析结果为数组或标量；不完整 JSON 在流结束时被当成空对象。

### I6 — provider-bound block 不可跨 provider

`thinking` 与 `provider_blocks` 必须携带来源 providerId。编码到目标 provider 时，仅保留 providerId 完全相同的 block；其余 block 过滤并记录。校验器在提供目标 providerId 的上下文中报告 mismatch。

- 正例：provider-x 的 thinking 回放给 provider-x，并按 `thinkingReplay` 策略原样保留或丢弃 provenance token 与 block。
- 反例：provider-x 的签名发送给 provider-y；缺 providerId 的 provider block 被视为可移植。

### I7 — 不支持的 block 在请求侧过滤、降级或报错

Codec 必须在构造 wire body 时执行 capability 门控，不能依赖 provider 返回 400。

- 正例：`vision=false` 时过滤图片并产生记录；document 按 §3.3 转成逐页图片或文本。
- 反例：向 text-only provider 裸发 image；document 无原生支持且无转换器时静默丢弃或裸发。

### I8 — 目标 API 结构约束必须成立

正规化后的 wire 消息必须满足目标 API 的序列规则。Anthropic 输出严格 user/assistant 交替，相邻 user 内容合并，tool result 归入 user 内容；OpenAI Responses 不接受空 content 的位置必须补 API 允许的最小占位。

- 正例：IR 中两个连续 tool 消息编码为一个 Anthropic user message，包含两个 tool_result block。
- 反例：Anthropic wire 出现连续 user 消息；Responses 输出不允许的空 input item。

### I9 — model 与能力开关分离

`model` 只承载 API 模型 ID。显示用后缀、颜色控制字符和 `[1m]` 等能力标记不得进入 wire。1M context 等能力通过 codec 已知的 beta header 发送，不能通过改写 model 表达。

- 正例：wire model 为原始 ID，beta header 单独包含 1M context 开关。
- 反例：wire model 为 `model-name[1m]` 或带 ANSI 转义序列；仅凭 model 字符串猜 capability。

### I10 — 五类退化响应可检测

以下响应不得作为正常 assistant 历史提交：

1. `max_tokens` 截断，尤其未闭合 tool arguments。
2. refusal，包括已有 partial 输出的中途 refusal；partial 全部丢弃。
3. runaway thinking：没有可见 text、没有 tool call，只有 thinking，且 thinking 消耗超过配置预算。
4. 空响应：没有可见 text、tool call 或 refusal；未超过预算的 reasoning-only 响应也属于空响应，因为它没有可提交给调用方的结果。
5. 流式组装丢字段：终止原因与已组装 block 矛盾，或录制事件中存在但最终结果缺失的字段。

- 正例：完整文本响应或完整 tool call 响应进入历史。
- 反例：`stop_reason='tool_use'` 但没有 tool_call；中途 refusal 的 partial 文本被当作答案；高 thinking 消耗后无 text/tool；HTTP 200 空 content。

M5 的每类检测必须由至少一条去标识的真实录制 SSE fixture 验收。

### I11 — 400 诊断请求可回放

诊断模式开启时，codec 必须在发送前把完整出站 URL、headers 与 request body 交给调用方注入的 writer，writer 可按 host 指定路径落盘。保存结果可再次作为同 codec 的编码输出进行比较。默认模式不调用 writer。诊断产物不得包含 host 未显式传入的附加状态。

- 正例：诊断文件解析后的 JSON 与实际发送 body 深度相等，可用于离线重放。
- 反例：只保存日志摘要、截断 tool arguments、遗漏 headers 所需的 beta 决策，或诊断关闭时仍写文件。

诊断产物可能含用户内容和凭据相关 header；是否保存、保存路径与清理由调用方明确决定。

## 6. Codec 边界

- Codec 自己使用 `fetch` 发送请求并解析 SSE，不依赖 provider SDK。
- Codec constructor 接收原始 model ID、providerId、capability 和 provider 所需连接参数；host 的持久化、路由、密钥发现、重试和 UI 类型不得进入 CanoIR。
- Capability 在 codec 生命周期内稳定；只有 `updateCapability()` 可显式整体替换，任何请求方法都不得提供 per-call override。
- 请求编码顺序为：校验 IR → 过滤 provider-bound block → capability 门控与降级 → provider 结构正规化 → 生成 wire body。
- Prompt cache hint 在 provider 结构正规化完成后解析到实际 wire block；不得把 marker 写入 IR 或跨 provider 回放。
- 响应解码顺序为：解析事件 → 完整组装 block → 归一化 usage/stop reason → 退化检测 → 校验可回放 IR。
- 失败必须带稳定分类，禁止用空响应、空 object 或伪造 tool result 掩盖协议错误。

## 7. Conformance 数据契约

Conformance case 是纯 JSON 数据，一个文件一个 case。每个 case 至少包含：

- 唯一名称与类别；
- codec 或 validator 操作；
- IR、wire 消息或原始 SSE 事件输入；
- capability；
- 期望输出、错误码或降级记录。

Fixture 禁止包含内部域名、IP、账号、路径、provider 路由名和 session/channel 标识。所有真实录制数据在入库前去标识，但不得改变与协议行为相关的字段顺序、空值、delta 边界或 token 数。

每个 corpus 文件必须且只能被 `normative/registry.json` 中一条规则精确登记，禁止按目录、文件名前缀或默认值隐式继承依据。规则分为三类：

- `official`：引用固定官方 source 与具体类型或 schema anchor；成功的 encode case 必须通过对应官方 request 类型的机械校验。
- `deviation`：叙述型条目记录适用条件、实测日期与可复核 evidence；具备稳定 HTTP 证据的能力拒绝可登记为 `capability + rejection + recovery + observedAt + evidence`，供运行时提取为拒绝签名。偏差只在所登记条件下覆盖官方规则；不能可靠匹配的行为不得硬写成签名。
- `canoir`：记录 CanoIR 自身 IR、不变量、门控或退化检测规则及其设计理由。

新增语料未登记、重复登记、官方来源未固定到不可变 commit，或成功 encode case 既没有 schema 校验也没有显式偏差登记时，conformance 检查必须失败。
