# AGENTS.md — CanoIR

> 本文件是实现 agent 的最高指引。写代码前先读完。本文件的优先级高于你自己的工程直觉。

## 0. 元规则（防三种已知失败模式）

实现本项目的 agent 有三种已被预判的失败模式，对应三条硬规则：

**R1 禁止子步骤蔓延。** §8 的 M0–M8 是唯一合法计划，顺序即依赖序。如果你在 M3 发现地基没打牢，**停下来修地基**——回改 M0–M2 的产物（通常是 SPEC.md 或类型定义），然后继续 M3。禁止创建 3.1/3.2 式子任务来绕过地基问题。发现 spec 缺陷的正确动作是改 spec，不是在代码里加变通层。

**R2 关键承载点不可偷工。** §4 每条不变量附有验收标准（具体测试形态）。里程碑完成判定的第一项就是逐条核对承载点验收——缺一项，该里程碑不算完成，无论代码看起来多完整。

**R3 过度设计黑名单。** 除非本文件明确要求，禁止引入：插件系统、事件总线、依赖注入容器、配置框架、注册表模式、抽象基类（除非有两个真实消费者同时存在）、为"将来可能的需求"预留的字段或参数。每个公开 API 必须能指出一个当前真实消费者。写不出消费者的，删掉。

## 1. 项目使命

CanoIR 是多 LLM API 的**协议中间层**。任何 agent harness 可以把消息建模、编解码、能力协商三件事整个委托给它，自身不需要理解任何一家 API 的消息格式。

边界不由"我们不做什么"定义，而由接入面定义：

- 本包**零 host import**。host 的细节（持久化、路由、密钥、重试策略、UI）全部通过接口注入，不出现在本包类型里。
- **边界元规则**：CanoIR 只回答“这是什么、这怎么编码”，从不回答“上次怎样、下次怎么办”。encode 是纯函数；CanoIR 无运行时记忆、无自动重试、无路由或降级决策状态。
- 验收测试是真实的：第一个消费者接入时不需要任何 shim、全局状态或临时 bridge。接入需要打补丁 = 边界画错了，改边界，不打补丁。

**当前唯一消费者**：一个私有 agent harness 的 direct runtime（身份与路径记录于 `AGENTS.local.md`）。第二个预期消费者：将来的 ReAct loop 组件。不为第三个假想消费者设计任何东西（见 R3）。

## 2. 仓库结构（目标形态，M0 搭建）

```
canoir/
├── AGENTS.md            # 本文件
├── SPEC.md              # 协议规范，单一事实源（M0 产出）
├── README.md            # 一句话正向宣称 + 最小接入示例
├── src/
│   ├── types.ts         # IR 消息模型（§3）
│   ├── validate.ts      # 消息序列合法性校验器（§4 不变量的可执行形态）
│   ├── capability.ts    # capability 矩阵 + 降级策略（§6）
│   ├── rejection.ts     # HTTP capability 拒绝签名 + 类型化识别
│   └── codecs/
│       ├── anthropic-messages.ts
│       ├── openai-chat-completions.ts
│       └── openai-responses.ts
├── conformance/
│   ├── runner.ts        # 语料 runner
│   └── corpus/          # 语料 case，纯 JSON 数据，一个 case 一个文件
├── normative/
│   └── registry.json    # 固定官方来源 + 每条语料的官方/偏差/CanoIR 依据
├── scripts/
│   └── check-official-schema.ts # 用固定官方类型机械校验 encode body
├── .github/workflows/
│   └── ci.yml           # 安装锁定依赖并运行完整检查
└── test/
```

技术栈：TypeScript strict（无 `any`）、零运行时依赖（编解码器自己发 fetch、自己解析 SSE，不引入各家官方 SDK——它们正是要替代的耦合源）。测试用 vitest 或 bun test，选一个，不讨论。

## 3. IR 消息模型（normative 摘要，SPEC.md 以此展开）

**Role**：只有 `user` / `assistant` / `tool` 三种。Anthropic 的 user 内嵌 tool_result、Responses 的 function_call_output 等各家形态，进 IR 时统一映射，出 IR 时由 codec 还原。

**Block 类型**（assistant/user 消息的 content 是 block 数组）：

| Block | 说明 | 关键约束 |
|---|---|---|
| `text` | 纯文本 | 空串合法，语义=无文本 |
| `thinking` | 推理内容 + `signature` opaque provenance token（字符串；无 token 时为空串） | 不可截断或伪造 token；跨 provider 不可移植 |
| `tool_call` | `{id, name, arguments: object}` | id 永非空；arguments 永为已解析 object |
| `tool_result` | `{toolCallId, content, images?}` | 必须能关联到同序列内的 tool_call |
| `image` | base64 source | 可被 capability 门控 |
| `document` | base64/url/text source | 可被 capability 门控 + 降级（§6） |
| `refusal` | `{category?, explanation?}` | stop_reason=refusal 的结构化形态 |
| `provider_blocks` | 同 provider verbatim 回放的原生 block | 跨 provider 必须丢弃 |

**usage 归一化**：`{totalInputTokens, outputTokens, cacheReadTokens?, cacheCreationTokens?, reasoningTokens?}`。各 codec 自己算对（Anthropic total=input+cache_read+cache_creation；OpenAI cached 是 input 子集，不重复相加）。原生分解字段缺失时保持缺省，不填 0；CanoIR 只表达 token，不计算价格。

## 4. 消息序列不变量（关键承载点 + 验收标准）

每条不变量必须在 `validate.ts` 有可执行检查，且 conformance 语料有对应用例。**这是 R2 的核心清单：**

| # | 不变量 | 验收标准 |
|---|---|---|
| I1 | assistant 的每个 tool_call 在后续消息中有配对 tool_result；反之 tool_result 必须能关联到已有 tool_call | 语料：孤儿 tool_call / 孤儿 tool_result / 缺 id 的 tool 消息，三种都必须被校验器捕获 |
| I2 | thinking block 与 provider provenance token 不可截断或伪造；steering 中断导致 partial thinking 时整块丢弃 | 语料：流式中断不输出 partial；无 token 的完整 block 合法进入 IR |
| I3 | assistant + tool_calls 时 content 序列化为 `null`（Chat Completions），不是空串 | 语料：带 tool_calls 的 assistant 消息编码后 wire 上 content 是 `null` |
| I4 | tool_call id 永非空：provider 未返回 id 时 codec 层合成，绝不让空 id 上 wire | 语料：无 id 的 wire tool_call → IR 内 id 非空且稳定 |
| I5 | IR 内 arguments 永为 object；wire 上的 string/`arguments` 字段等 3 种形态（A5）解析结果一致 | 语料：同一 tool_call 的三种 wire 形态 → 解码出相同 IR |
| I6 | thinking/provider_blocks 跨 providerId 不可移植，切换 provider 时过滤 | 语料：混合 provider 历史 → 编码时只保留本 provider 的块 |
| I7 | capability 不支持的 block 在**请求侧**被过滤或显式降级，绝不裸发 | 语料：vision=false + 含图消息 → 图被过滤且有降级记录；document 不支持 → 走 §6 降级格 |
| I8 | 消息序列经 codec 规范化后满足目标 API 的结构约束（Anthropic 严格交替、相邻 user 合并；Responses 空 content 补占位） | 语料：user→user 相邻序列 → Anthropic 编码输出严格交替 |
| I9 | model 字段与能力开关分离：`[1m]` 式显示名/后缀绝不泄漏到 wire；能力走 beta header | 语料：contextWindow≥1M → model 字段干净 + betas 含对应 header |
| I10 | 退化响应五类可检测：max_tokens 截断、refusal partial、runaway thinking（无 text 无 tool 且 thinking 超预算）、空响应、流式组装丢字段 | 语料：五类各至少一条真实录制的 SSE 流 → 检测器全部命中；空响应绝不进入可回放历史 |
| I11 | 400 诊断可回放：codec 支持把出站请求 body 落盘，供事后回放定位 | 单测：开启诊断模式后请求 body 完整落盘且可重新编码 |

## 5. Codec 实现必读（corner case 知识库）

**官方协议规范是 wire 行为的先验事实源。** 动手写每个 codec 之前，先核对 `normative/registry.json` 固定的官方版本，再读以下两类实践材料：

1. 宿主项目的协议勘察报告（三家 API 结构面对照 + 历史坑清单）
2. 宿主项目的现有适配器源码（**参考其行为，不抄其结构**——它们是 host 耦合的，你要写的是 host 无关版）

这些材料用于发现官方规范没有覆盖或兼容端点偏离官方规范的行为，不得无登记地覆盖官方基线。材料位于私有环境，具体路径见 **`AGENTS.local.md`**（本机私有文件，不入库——这是约定：仓库根若存在 `AGENTS.local.md`，实现 agent 必须先读它）。若该文件不存在，停下来向 owner 索取材料，禁止凭记忆臆造 corner case 细节。

以下 corner case 是各 codec 的**最低覆盖线**，每条都必须有 conformance 语料（括号内是宿主项目实证来源，可去读对应 commit/test——位置见 AGENTS.local.md）：

**通用**
- 流式组装：客户端必须自己从原始 SSE 事件重建缺失字段，不能依赖第三方 SDK 的 accumulate（SDK 不合并 message_delta 的 usage/stop_details 是实证 bug，宿主项目 `b9d2957`/`5b6757f`）
- lone surrogate 安全：UTF-16 孤代理字符在 JSON.stringify/编码路径不得产生非法字节（宿主项目 `0be5344`，某兼容代理线上 500 实证）
- tool_call 增量组装：`arguments` 空串起点的分片 append（宿主项目 `7d01269`）；JSON 完整即解析，不等多余 delta

**Anthropic Messages**
- tool_use input 三种兼容形态解析（A5，`anthropic.ts:1068-1103`）
- 相邻 user 合并（A3，`anthropic.ts:547-558`）
- usage 非标准位置回填：message_start 全 0 占位 + message_delta 真值（GLM-5.2 兼容端点实证，B2）
- thinking 流式：signature_delta 排序在 thinking_delta 之后的乱序处理（宿主项目 `b21891c`）；thinking 回放的 interleaved 约束（宿主项目 `1c09e2e`）；完整但无 token 的 thinking 合法解码，是否回放由 `thinkingReplay` 三档 capability 决定
- 严格 proxy 的 minimal mode（去掉 proxy 不认的字段，`f09a87a`）
- refusal：HTTP 200 ≠ 成功，stop_reason 驱动错误分类，partial 文本丢弃（J1，`ca11797`）

**OpenAI Chat Completions**
- content:null（I3）、tool_call_id 缺失降级（A2）
- reasoning_content 字段无标准形态，当前策略：不支持即丢弃并记录，不臆造映射

**OpenAI Responses**
- 系统提示双模式：`instructions` 顶层字段 vs `input[0]{role:'developer'/'system'}`，代理兼容性优先（A6，`openai-responses.ts:837-857`；实测某些代理会覆盖顶层 `instructions`，`input[role:"system"]` 存活）
- reasoning item 回放必须保留同 provider 返回的完整原生 item，尤其是 `encrypted_content`；实测仅回放该 item 再追加 user 消息即可延续上一轮推理结果
- function_call_output 支持 image block 数组
- thought_signature 类非标准字段必须回传，不得丢弃（C5）

**Gemini schema（经 Completions 兼容层）**
- 嵌套 object 无 properties、type 数组、`$ref`/anyOf 等负例集（C6，`ef35c71`/`baa9b9d`/`2d41004`/`28c08a4`）

## 6. Capability 矩阵与降级策略

**Capability 声明**（provider 维度，由 host 配置注入，codec 消费）：

```ts
interface ProviderCapability {
  vision: boolean
  document: 'native' | 'degrade' | 'unsupported'
  toolCalls: boolean
  thinking: 'native' | 'disabled-param' | 'unsupported'
  thinkingReplay: 'verify-replay' | 'replay' | 'drop'
  promptCaching: 'explicit-markers' | 'automatic' | 'none'
  streaming: boolean
  hostedTools?: string[]  // 该端点支持的 server-side tool 类型
}
```

**降级策略格**（I7 的展开，document 是典型）：

- `document: 'native'` → document block 直发
- `document: 'degrade'` → 按优先级尝试：(1) 逐页转 image（vision=true 且内容版式敏感时优先）；(2) 提取纯文本注入。降级路径必须显式记录（哪种降级、为什么），host 可读
- `document: 'unsupported'` 且无法降级 → **fail-loud**，报出"该 provider 不支持 document"，绝不静默裸发
- `vision: false` → 请求侧过滤所有 image block + 记录（GLM-5.2 400 实证）
- `thinkingReplay: 'verify-replay'` → 仅回放带非空 opaque provenance token 的 thinking
- `thinkingReplay: 'replay'` → 原样回放 thinking，空 token 也合法
- `thinkingReplay: 'drop'` → 丢弃历史 thinking；未知端点默认该档
- `promptCaching: 'explicit-markers'` → encode 期 cache hint 可翻译为目标 API 的 block 级 breakpoint
- `promptCaching: 'automatic' | 'none'` → 忽略显式 hint 并记录；这是唯一允许静默降级的 capability 类别，因为只影响性能和计费，不改变请求语义
- capability 声明缺失的字段 → 按最保守值处理（fail-closed）
- capability 进入 codec constructor，在 codec 生命周期内固定；只有 `updateCapability()` 可显式整体替换，禁止任何 per-call override

## 7. Conformance 语料

- **纯数据**：一个 case 一个 JSON 文件，零代码。格式：输入（IR 消息序列或录制的 SSE 事件流）+ capability → 期望输出（编码结果 / 解码结果 / 校验错误 / 降级决策）
- **命名**：`<类别>-<序号>-<短语>.json`，类别沿用 §5 的分类（structure/stream/toolcall/thinking/usage/cache/compat/refusal/empty/degrade/rejection）
- **种子来源**（M2 起逐类转化）：protocol-survey.md 的 Part B 清单 + 宿主项目 `*.test.ts` 里的编码断言 + 生产日志锚点（lone surrogate 500、GLM usage 0/0、max_tokens 截断、refusal 记录——把真实错误响应录制成 fixture）
- **去标识纪律**：语料中禁止出现内部域名、IP、路径、账号、内部 provider 命名。统一用 `endpoint-a`/`provider-x` 式通用名。这是公开发布的红线（§9 hook 会拦，但第一责任人是写语料的你）
- **依据登记**：每个 corpus 文件必须且只能在 `normative/registry.json` 中登记一次。`official` 规则引用固定 source 与 anchor；叙述型 `deviation` 写明 condition、testedAt 与 evidence，可运行拒绝签名写明 capability、rejection、recoveryHint、observedAt 与 evidence；`canoir` 规则必须写明 rationale。禁止新增未登记语料或用默认规则隐式继承依据
- **机械校验**：成功 encode case 必须通过固定官方 request type，或显式登记为实测偏差。官方 SDK 只作为 devDependency，不得进入运行时依赖
- 数量预期：M5 完成时 ≥40 条，其中流式录制类 ≥10 条

## 8. 里程碑与完成判定（DoD）

> 顺序即依赖序。每个里程碑完成后 commit。任何里程碑发现更早产物有缺陷 → 回改，见 R1。

**M0 — spec 与骨架**
- SPEC.md v0.1：完整覆盖 §3 模型 + §4 全部 11 条不变量 + §6 capability schema。每条不变量写明正反例
- 仓库结构按 §2 搭好，TS strict + lint + 测试框架跑通空套件
- pre-push hook（§9）就位
- DoD：SPEC.md 中每条不变量能指出对应反例；`bun test`（或 vitest）绿

**M1 — IR 类型 + 校验器**
- `types.ts` + `validate.ts`：§3 全部 block 类型 + I1/I2/I4/I5/I6 的可执行检查
- DoD：I1/I2/I4/I5/I6 各自的验收语料（每类正反 ≥2 条）全绿

**M2 — anthropic-messages codec + 语料 runner**
- codec 覆盖 §5 Anthropic 最低覆盖线全部条目
- conformance runner 成型，Anthropic 类语料 ≥12 条（含 ≥3 条流式录制）
- DoD：语料全绿；§5 Anthropic 清单逐条能指出对应语料文件

**M3 — openai-chat-completions codec**
- 覆盖 §5 Completions 清单 + Gemini schema 负例集
- DoD：新增语料 ≥8 条全绿；I3/I9 验收通过

**M4 — openai-responses codec + capability 矩阵**
- 覆盖 §5 Responses 清单；capability 矩阵接入三个 codec constructor，编码入口统一为 `encode(messages, options?)`；运行中能力迁移只允许 `updateCapability()`
- document 降级格可执行（转 image 用真实 PDF fixture；文本提取可用占位实现但接口必须是真的）
- DoD：I7 验收通过；降级决策语料 ≥4 条

**M5 — 退化检测 + 诊断 + 发布准备**
- I10 五类退化检测器 + I11 请求落盘
- README（一句话宣称 + 最小接入示例，示例代码必须真的能跑）
- 语料总数 ≥40
- DoD：§4 全部 11 条验收逐项核对通过；tag v0.1.0（tag 动作前需项目 owner 确认）

**M6 — 官方规范与实测偏差层**
- 固定 Anthropic SDK、OpenAI OpenAPI 与 OpenAI SDK 的不可变版本、commit、日期和 schema/type anchor
- `normative/registry.json` 精确覆盖全部 corpus case，逐条区分 `official`、`deviation` 与 `canoir`
- 成功 encode case 用固定官方 request type 做机械校验；官方 SDK 仅作开发期校验，运行时继续零依赖
- CI 使用 lockfile 安装依赖并运行完整 `bun run check`
- SPEC 按 vendor 分开写官方规范与实测偏差，明确未登记的规范冲突一律视为 bug
- DoD：registry 全覆盖且无重复；全部适用 encode body 通过官方类型校验；每条偏差具备对应形态所需的时间与 evidence；完整检查与公开扫描通过

**M7 — 缓存计量分解与 encode 期 hint**
- IR `Usage` 增加可选 cache read、cache creation 与 reasoning token 分解；三家 codec 各自映射原生 usage，缺失字段不填 0
- `totalInputTokens` 继续表达上下文水位；OpenAI cached tokens 不重复计入；价格与金额永不进入 CanoIR
- capability 增加 `promptCaching` 三档；cache anchor 只存在于 encode options，不进入 IR block
- Anthropic 把 system/tools/history/message 锚点翻译为 block 级 `cache_control`；无 hint 不隐式添加 marker，实际 breakpoint 超过 4 时 fail-loud
- automatic/none 端点忽略合法 hint 并记录，这是唯一允许静默降级的 capability 类别
- DoD：usage 分解每 codec 至少一条语料；cache marker、合并后 message 边界、automatic 忽略、越界与 breakpoint 上限语料全绿；官方 schema、完整检查与公开扫描通过

**M8 — 运行时能力适应层**
- registry 支持把有可靠 HTTP 证据的 deviation 表达为 capability 拒绝签名；无法形成稳定 status/body/error code 的条目保留叙述形态，不硬凑
- 拒绝签名固定包含 capability、rejection、recoveryHint、observedAt、evidence；`recoveryHint` 只提供语义提示，不执行内容转换或策略动作
- `call()` 仅在“请求实际使用 capability X”且 HTTP 响应匹配 X 的签名时抛 `CapabilityRejectionError`；不匹配时保留原始 HTTP 错误
- CanoIR 不自动重试、不保存负面记忆、不决定换模型或降级内容；host 可用更弱 capability 或既有 `DocumentConverters` 处理后重新调用纯 encode/call
- DoD：三类 capability 的签名识别、error code 精确匹配与“请求未使用该能力时不命中”语料全绿；现有 deviation 逐条审计，不能可靠改写的在对应 issue 说明

## 9. Pre-push hook（公开发布防线）

M0 就位，拦截以下模式的任何文件内容：

- 内部域名与内网 IP 段（具体清单见 AGENTS.local.md；`10.x`/`192.168.x` 出现于非示例上下文一律拦）
- 本机用户目录绝对路径
- 密钥模式（常见 API key/token 正则）
- 内部命名：宿主项目的内部 provider id、channel/session id、 IM 账号 id 等
- `keys.env` / `.env` 文件名引用

hook 本身随仓库公开维护。被拦时不允许绕过（`--no-verify` 视为事故）。

**私有指引的存放约定**：本机路径、内部材料位置等私有信息一律放 `AGENTS.local.md`（已在 .gitignore，永不入库），AGENTS.md 只保留通用描述 + 读取约定。入库文件从第一个 commit 起就必须能整体通过 §9 检查，不允许"先污染后清理"。

## 10. 工作方式

- 所有注释、commit message、文档：中文（SPEC.md/README 的对外语言由项目 owner 另行决定，初版中文即可）
- 每个里程碑一个 commit 或一组小 commit，message 写清"为什么"而不只是"做了什么"
- 遇到 §5 标注 🔬（待实测验证）的条目：设计实验实测，把结果写成语料，并在 SPEC.md 把该条从"待验证"改为实证结论。**禁止**把 🔬 条目当已验证知识直接编码
- 事实性偏差自行修正，不停下：commit 引用、file:line、API 行为描述等可验证错误（包括本文件中的错误），经源码、测试或实测确认后直接修正，并在 commit message 写明验证依据
- 需要停下裁决的仅限：需求/范围/spec 语义冲突、规则本身存废、实测结果与 spec 矛盾且改 spec 会影响里程碑结构。不要静默绕过
- 裁决请求以本仓库 GitHub issue 为 state layer：issue 必须自包含陈述冲突点与建议方案，裁决以 issue comment 给出。issue 状态变化后，用 `wake_channel` 通知对方 channel；实现 agent 提问时通知 `AGENTS.local.md` 指定的 owner 裁决 channel，message 只带 issue 指针与一句话摘要，不展开讨论
- 裁决 issue 遵守 §9 同等的公开去标识纪律：不出现内部域名、路径、私有仓库名或内部命名；commit 仅引用裸 hash，不附私有 remote 链接
