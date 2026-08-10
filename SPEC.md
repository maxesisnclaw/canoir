# CanoIR 协议规范

版本：0.1

CanoIR 定义一套与 provider 无关的消息中间表示（IR）、消息序列不变量和能力协商规则。Codec 负责在 IR 与具体 API wire 格式之间双向转换；host 只提供配置、工具执行结果和可选诊断目标，不参与 provider 消息建模。

本文中的“必须”“不得”是规范性要求。“请求历史”指即将发送给模型的完整、可回放消息序列；尚未完成工具执行的临时状态不属于请求历史。

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

`signature` 和 `providerId` 必须非空。Anthropic 使用 provider 返回的真实签名；OpenAI Responses 若没有等价签名，codec 使用稳定的 provider-local 伪签名。Thinking 是 provider-bound 数据，不可截断，不可跨 provider 回放。

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

### 2.3 Usage

```ts
interface Usage {
  totalInputTokens: number
  outputTokens: number
  reliable: boolean
}
```

- 所有 token 数必须是非负整数。
- Anthropic 的 `totalInputTokens` 等于 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`，缺失项按 0 计。
- OpenAI Chat Completions 与 Responses 使用 API 给出的单次 input 总值，不与 cached token 字段叠加。
- 全 0 占位、字段缺失或 provider 明示估算值时，`reliable=false`。上层不得用不可靠 usage 覆盖已知可靠状态。

## 3. Capability 与降级记录

### 3.1 ProviderCapability

Capability 由 host 按 provider 维度注入，codec 不从模型显示名、历史消息或 endpoint 猜测。

```ts
interface ProviderCapability {
  vision: boolean
  document: 'native' | 'degrade' | 'unsupported'
  toolCalls: boolean
  thinking: 'native' | 'disabled-param' | 'unsupported'
  streaming: boolean
  hostedTools?: string[]
}
```

字段缺失按最保守值处理：布尔值为 `false`，`document='unsupported'`，`thinking='unsupported'`，`hostedTools=[]`。未知 hosted tool 不得发送。

### 3.2 降级记录

每次请求侧过滤或降级都产生 host 可读记录：

```ts
interface DegradationRecord {
  blockType: 'image' | 'document' | 'thinking' | 'provider_blocks'
  action: 'filtered' | 'document-to-images' | 'document-to-text'
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

## 4. 消息序列不变量

校验错误至少包含不变量编号、消息索引、可选 block 索引和稳定错误码。Codec 正规化、编码与流式组装不得绕过这些规则。

### I1 — tool_call 与 tool_result 成对

每个 assistant `tool_call` 必须在后续 tool 消息中恰好有一个同 ID 的 `tool_result`；每个 `tool_result` 必须关联更早的 `tool_call`。ID 缺失、孤儿、重复结果和结果先于调用均非法。

- 正例：assistant 调用 `call-1`，下一条 tool 消息返回 `call-1`。
- 反例：序列结束时 `call-1` 没有结果；tool 消息引用不存在的 `call-2`；tool result 的 `toolCallId` 为空。

### I2 — thinking 不可截断

流式组装器只能在 thinking block 闭合且取得完整 signature 后把它提交到 IR。steering、abort 或 malformed stream 导致的 partial thinking 必须整块丢弃。校验器拒绝空 signature 或空 providerId；“尽量保留 partial”不是合法降级。

- 正例：完整 `thinking_delta` 后收到对应 `signature_delta`，提交一个完整 block。
- 反例：只收到部分 thinking 后中断；存在 thinking 文本但 signature 为空。两者均不得进入历史。

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

- 正例：provider-x 的 thinking 回放给 provider-x，签名和顺序原样保留。
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
3. runaway thinking：没有 text、没有 tool call，且 thinking 消耗超过配置预算。
4. 空响应：没有可见文本、tool call、完整 thinking 或 refusal 信息。
5. 流式组装丢字段：终止原因与已组装 block 矛盾，或录制事件中存在但最终结果缺失的字段。

- 正例：完整文本响应或完整 tool call 响应进入历史。
- 反例：`stop_reason='tool_use'` 但没有 tool_call；中途 refusal 的 partial 文本被当作答案；高 thinking 消耗后无 text/tool；HTTP 200 空 content。

M5 的每类检测必须由至少一条去标识的真实录制 SSE fixture 验收。

### I11 — 400 诊断请求可回放

诊断模式开启时，codec 必须在发送前保存完整出站 request body，保存结果可再次作为同 codec 的编码输出进行比较。默认模式不得落盘。诊断文件不得包含 host 未显式传入的附加状态。

- 正例：诊断文件解析后的 JSON 与实际发送 body 深度相等，可用于离线重放。
- 反例：只保存日志摘要、截断 tool arguments、遗漏 headers 所需的 beta 决策，或诊断关闭时仍写文件。

诊断产物可能含用户内容和凭据相关 header；是否保存、保存路径与清理由调用方明确决定。

## 5. Codec 边界

- Codec 自己使用 `fetch` 发送请求并解析 SSE，不依赖 provider SDK。
- Codec 接收原始 model ID、providerId、capability 和 provider 所需连接参数；host 的持久化、路由、密钥发现、重试和 UI 类型不得进入 CanoIR。
- 请求编码顺序为：校验 IR → 过滤 provider-bound block → capability 门控与降级 → provider 结构正规化 → 生成 wire body。
- 响应解码顺序为：解析事件 → 完整组装 block → 归一化 usage/stop reason → 退化检测 → 校验可回放 IR。
- 失败必须带稳定分类，禁止用空响应、空 object 或伪造 tool result 掩盖协议错误。

## 6. Conformance 数据契约

Conformance case 是纯 JSON 数据，一个文件一个 case。每个 case 至少包含：

- 唯一名称与类别；
- codec 或 validator 操作；
- IR、wire 消息或原始 SSE 事件输入；
- capability；
- 期望输出、错误码或降级记录。

Fixture 禁止包含内部域名、IP、账号、路径、provider 路由名和 session/channel 标识。所有真实录制数据在入库前去标识，但不得改变与协议行为相关的字段顺序、空值、delta 边界或 token 数。
