import type {
  CapabilityTransformOptions,
  DegradationRecord,
  ProviderCapability,
} from './capability'
import type { Message } from './types'

export type RuntimeCapability = 'document' | 'image' | 'thinking-param'

export type RecoveryAction =
  | 'degrade-document'
  | 'strip-image'
  | 'remove-thinking-param'

export interface RejectionSignature {
  id: string
  capability: RuntimeCapability
  rejection: {
    status: number
    bodyMatch?: string
    errorCode?: string
  }
  recovery: RecoveryAction
  observedAt: string
  evidence: string[]
}

export interface CapabilityRejectionMemoryOptions {
  ttlMs?: number
  now?: () => number
}

export interface AdaptiveAttemptResult<T> {
  value: T
  degradations?: readonly DegradationRecord[]
}

export interface RuntimeCapabilityExecution<T> {
  endpoint: string
  model: string
  usedCapabilities: (
    rejectedCapabilities: ReadonlySet<RuntimeCapability>,
  ) => readonly RuntimeCapability[]
  attempt: (
    rejectedCapabilities: ReadonlySet<RuntimeCapability>,
  ) => Promise<AdaptiveAttemptResult<T>>
}

export interface AdaptiveCallResult<T> {
  result: T
  degradations: DegradationRecord[]
  retried: boolean
}

interface HttpRejection {
  status: number
  responseBody: string
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000
const IMAGE_FALLBACK_TEXT = '[图片已因目标端点拒绝而移除]'

const RECOVERY_BY_CAPABILITY: Record<RuntimeCapability, RecoveryAction> = {
  document: 'degrade-document',
  image: 'strip-image',
  'thinking-param': 'remove-thinking-param',
}

function memoryKey(
  endpoint: string,
  model: string,
  capability: RuntimeCapability,
): string {
  return JSON.stringify([endpoint, model, capability])
}

function isHttpRejection(error: unknown): error is HttpRejection {
  if (typeof error !== 'object' || error === null) return false
  const value = error as Record<string, unknown>
  return (
    typeof value.status === 'number' &&
    Number.isInteger(value.status) &&
    typeof value.responseBody === 'string'
  )
}

function rejectionErrorCode(body: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined
  }
  const value = parsed as Record<string, unknown>
  if (typeof value.code === 'string') return value.code
  if (
    typeof value.error === 'object' &&
    value.error !== null &&
    !Array.isArray(value.error) &&
    typeof (value.error as Record<string, unknown>).code === 'string'
  ) {
    return (value.error as Record<string, unknown>).code as string
  }
  return undefined
}

function validateSignature(signature: RejectionSignature): void {
  if (signature.id.length === 0) {
    throw new Error('拒绝签名 id 不得为空')
  }
  if (
    !Number.isInteger(signature.rejection.status) ||
    signature.rejection.status < 400 ||
    signature.rejection.status > 599
  ) {
    throw new Error(`拒绝签名 ${signature.id} 的 status 必须是 400–599 整数`)
  }
  if (
    signature.rejection.bodyMatch === undefined &&
    signature.rejection.errorCode === undefined
  ) {
    throw new Error(`拒绝签名 ${signature.id} 必须声明 bodyMatch 或 errorCode`)
  }
  if (signature.rejection.bodyMatch === '') {
    throw new Error(`拒绝签名 ${signature.id} 的 bodyMatch 不得为空`)
  }
  if (signature.rejection.errorCode === '') {
    throw new Error(`拒绝签名 ${signature.id} 的 errorCode 不得为空`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(signature.observedAt)) {
    throw new Error(`拒绝签名 ${signature.id} 的 observedAt 必须是 YYYY-MM-DD`)
  }
  if (signature.evidence.length === 0) {
    throw new Error(`拒绝签名 ${signature.id} 必须包含 evidence`)
  }
  if (signature.recovery !== RECOVERY_BY_CAPABILITY[signature.capability]) {
    throw new Error(`拒绝签名 ${signature.id} 的 capability 与 recovery 不匹配`)
  }
}

export function capabilityAfterRuntimeRejections(
  capability: ProviderCapability,
  rejected: ReadonlySet<RuntimeCapability>,
): ProviderCapability {
  return {
    ...capability,
    document:
      rejected.has('document') && capability.document === 'native'
        ? 'degrade'
        : capability.document,
    vision: rejected.has('image') ? false : capability.vision,
    thinking: rejected.has('thinking-param')
      ? 'unsupported'
      : capability.thinking,
  }
}

export function optionsAfterRuntimeRejections<
  T extends CapabilityTransformOptions,
>(options: T, rejected: ReadonlySet<RuntimeCapability>): T {
  return {
    ...options,
    ...(rejected.has('document') ? { preferDocumentImages: true } : {}),
    ...(rejected.has('image')
      ? { imageFallbackText: options.imageFallbackText ?? IMAGE_FALLBACK_TEXT }
      : {}),
  }
}

function hasDocument(messages: readonly Message[]): boolean {
  return messages.some(
    (message) =>
      message.role === 'user' &&
      message.content.some((block) => block.type === 'document'),
  )
}

function hasImage(messages: readonly Message[]): boolean {
  return messages.some((message) => {
    if (message.role === 'user') {
      return message.content.some((block) => block.type === 'image')
    }
    if (message.role === 'tool') {
      return message.content.some((block) => (block.images?.length ?? 0) > 0)
    }
    return false
  })
}

export function usedRuntimeCapabilities(
  messages: readonly Message[],
  capability: ProviderCapability,
  options: CapabilityTransformOptions,
  thinkingParamUsed: boolean,
): RuntimeCapability[] {
  const used: RuntimeCapability[] = []
  const documentUsed = hasDocument(messages)
  if (documentUsed && capability.document === 'native') used.push('document')

  const documentBecomesImages =
    documentUsed &&
    capability.document === 'degrade' &&
    options.preferDocumentImages === true &&
    capability.vision &&
    options.documentConverters?.toImages !== undefined
  if (capability.vision && (hasImage(messages) || documentBecomesImages)) {
    used.push('image')
  }
  if (thinkingParamUsed && capability.thinking !== 'unsupported') {
    used.push('thinking-param')
  }
  return used
}

export function thinkingParamRemovedDegradation(): DegradationRecord {
  return {
    blockType: 'thinking',
    action: 'thinking-param-removed',
    reason: '目标端点已被运行时确认拒绝 thinking 参数，移除该参数',
  }
}

function signatureMatches(
  signature: RejectionSignature,
  rejection: HttpRejection,
): boolean {
  if (signature.rejection.status !== rejection.status) return false
  if (
    signature.rejection.bodyMatch !== undefined &&
    !rejection.responseBody.includes(signature.rejection.bodyMatch)
  ) {
    return false
  }
  if (
    signature.rejection.errorCode !== undefined &&
    rejectionErrorCode(rejection.responseBody) !== signature.rejection.errorCode
  ) {
    return false
  }
  return true
}

export class CapabilityRejectionMemory {
  private readonly rejectedAt = new Map<string, number>()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(options: CapabilityRejectionMemoryOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.now = options.now ?? Date.now
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error('capability rejection memory 的 ttlMs 必须是正数')
    }
  }

  remember(
    endpoint: string,
    model: string,
    capability: RuntimeCapability,
  ): void {
    this.rejectedAt.set(memoryKey(endpoint, model, capability), this.now())
  }

  isRejected(
    endpoint: string,
    model: string,
    capability: RuntimeCapability,
  ): boolean {
    const key = memoryKey(endpoint, model, capability)
    const timestamp = this.rejectedAt.get(key)
    if (timestamp === undefined) return false
    if (this.now() - timestamp < this.ttlMs) return true
    this.rejectedAt.delete(key)
    return false
  }

  rejectedCapabilities(
    endpoint: string,
    model: string,
  ): Set<RuntimeCapability> {
    const result = new Set<RuntimeCapability>()
    for (const capability of [
      'document',
      'image',
      'thinking-param',
    ] as const) {
      if (this.isRejected(endpoint, model, capability)) {
        result.add(capability)
      }
    }
    return result
  }
}

export class RuntimeCapabilityAdapter {
  readonly memory: CapabilityRejectionMemory
  private readonly signatures: RejectionSignature[]

  constructor(
    signatures: readonly RejectionSignature[],
    memory = new CapabilityRejectionMemory(),
  ) {
    const ids = new Set<string>()
    this.signatures = signatures.map((signature) => {
      validateSignature(signature)
      if (ids.has(signature.id)) {
        throw new Error(`拒绝签名 id 重复: ${signature.id}`)
      }
      ids.add(signature.id)
      return {
        ...signature,
        rejection: { ...signature.rejection },
        evidence: [...signature.evidence],
      }
    })
    this.memory = memory
  }

  private rememberMatches(
    endpoint: string,
    model: string,
    usedCapabilities: readonly RuntimeCapability[],
    error: unknown,
  ): RuntimeCapability[] {
    if (!isHttpRejection(error)) return []
    const used = new Set(usedCapabilities)
    const matched = new Set<RuntimeCapability>()
    for (const signature of this.signatures) {
      if (
        used.has(signature.capability) &&
        signatureMatches(signature, error)
      ) {
        matched.add(signature.capability)
      }
    }
    for (const capability of matched) {
      this.memory.remember(endpoint, model, capability)
    }
    return [...matched]
  }

  async execute<T>(
    execution: RuntimeCapabilityExecution<T>,
  ): Promise<AdaptiveCallResult<T>> {
    const rejected = this.memory.rejectedCapabilities(
      execution.endpoint,
      execution.model,
    )
    const firstUsed = execution.usedCapabilities(rejected)
    try {
      const firstAttempt = await execution.attempt(rejected)
      return {
        result: firstAttempt.value,
        degradations: [...(firstAttempt.degradations ?? [])],
        retried: false,
      }
    } catch (originalError) {
      const matched = this.rememberMatches(
        execution.endpoint,
        execution.model,
        firstUsed,
        originalError,
      )
      if (matched.length === 0) throw originalError
      for (const capability of matched) rejected.add(capability)

      const retryUsed = execution.usedCapabilities(rejected)
      try {
        const retryAttempt = await execution.attempt(rejected)
        return {
          result: retryAttempt.value,
          degradations: [...(retryAttempt.degradations ?? [])],
          retried: true,
        }
      } catch (retryError) {
        this.rememberMatches(
          execution.endpoint,
          execution.model,
          retryUsed,
          retryError,
        )
        throw originalError
      }
    }
  }
}
