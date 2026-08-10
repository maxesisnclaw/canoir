export type JsonPrimitive = null | boolean | number | string

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue }

export type JsonObject = { [key: string]: JsonValue }

export type Role = 'user' | 'assistant' | 'tool'

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
  signature: string
  providerId: string
}

/** Anthropic redacted_thinking：服务端加密的不透明思考块。同 provider 原样回放，
 *  跨 provider 丢弃（I6）。IR 一等 block——不得以 provider_blocks 打包承载，
 *  避免被 verbatim 快车道误判为整条 assistant 的替身。 */
export interface RedactedThinkingBlock {
  type: 'redacted_thinking'
  data: string
  providerId: string
}

export interface ToolCallBlock {
  type: 'tool_call'
  id: string
  name: string
  arguments: JsonObject
}

export interface ImageBlock {
  type: 'image'
  source: {
    type: 'base64'
    mediaType: string
    data: string
  }
}

export interface ToolResultBlock {
  type: 'tool_result'
  toolCallId: string
  content: string
  images?: ImageBlock[]
}

export type DocumentSource =
  | { type: 'base64'; mediaType: string; data: string }
  | { type: 'url'; url: string }
  | { type: 'text'; mediaType?: string; text: string }

export interface DocumentBlock {
  type: 'document'
  source: DocumentSource
}

export interface RefusalBlock {
  type: 'refusal'
  category?: string
  explanation?: string
}

export interface ProviderBlocksBlock {
  type: 'provider_blocks'
  providerId: string
  blocks: JsonValue[]
}

export type UserBlock = TextBlock | ImageBlock | DocumentBlock

export type AssistantBlock =
  | TextBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ToolCallBlock
  | RefusalBlock
  | ProviderBlocksBlock

export type ToolBlock = ToolResultBlock

export type Block = UserBlock | AssistantBlock | ToolBlock

export interface UserMessage {
  role: 'user'
  content: UserBlock[]
}

export interface AssistantMessage {
  role: 'assistant'
  content: AssistantBlock[]
}

export interface ToolMessage {
  role: 'tool'
  content: [ToolResultBlock, ...ToolResultBlock[]]
}

export type Message = UserMessage | AssistantMessage | ToolMessage

export interface Usage {
  totalInputTokens: number
  outputTokens: number
  reliable: boolean
  cacheReadTokens?: number
  cacheCreationTokens?: number
  reasoningTokens?: number
}
