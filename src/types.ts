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
}
