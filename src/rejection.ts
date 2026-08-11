import type {
  CapabilityTransformOptions,
  ProviderCapability,
} from './capability'
import type { Message } from './types'

export type RuntimeCapability = 'document' | 'image' | 'thinking-param'

export type RecoveryHint =
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
  recoveryHint: RecoveryHint
  observedAt: string
  evidence: string[]
}

export interface CapabilityRejectionEvidence {
  signatureId: string
  recoveryHint: RecoveryHint
  observedAt: string
  references: string[]
  rejection: {
    status: number
    responseBody: string
  }
}

export class CapabilityRejectionError extends Error {
  readonly capability: RuntimeCapability
  readonly evidence: CapabilityRejectionEvidence

  constructor(
    capability: RuntimeCapability,
    evidence: CapabilityRejectionEvidence,
  ) {
    super(`目标端点拒绝 capability: ${capability}`)
    this.name = 'CapabilityRejectionError'
    this.capability = capability
    this.evidence = evidence
  }
}

interface HttpRejection {
  status: number
  responseBody: string
}

const RECOVERY_BY_CAPABILITY: Record<RuntimeCapability, RecoveryHint> = {
  document: 'degrade-document',
  image: 'strip-image',
  'thinking-param': 'remove-thinking-param',
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
  if (signature.id.length === 0) throw new Error('拒绝签名 id 不得为空')
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
  if (signature.recoveryHint !== RECOVERY_BY_CAPABILITY[signature.capability]) {
    throw new Error(`拒绝签名 ${signature.id} 的 capability 与 recoveryHint 不匹配`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(signature.observedAt)) {
    throw new Error(`拒绝签名 ${signature.id} 的 observedAt 必须是 YYYY-MM-DD`)
  }
  if (signature.evidence.length === 0) {
    throw new Error(`拒绝签名 ${signature.id} 必须包含 evidence`)
  }
}

export function normalizeRejectionSignatures(
  signatures: readonly RejectionSignature[] = [],
): RejectionSignature[] {
  const ids = new Set<string>()
  return signatures.map((signature) => {
    validateSignature(signature)
    if (ids.has(signature.id)) throw new Error(`拒绝签名 id 重复: ${signature.id}`)
    ids.add(signature.id)
    return {
      ...signature,
      rejection: { ...signature.rejection },
      evidence: [...signature.evidence],
    }
  })
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

export function classifyCapabilityRejection(
  rejection: HttpRejection,
  usedCapabilities: readonly RuntimeCapability[],
  signatures: readonly RejectionSignature[],
): CapabilityRejectionError | undefined {
  const used = new Set(usedCapabilities)
  const signature = signatures.find(
    (item) => used.has(item.capability) && signatureMatches(item, rejection),
  )
  if (signature === undefined) return undefined
  return new CapabilityRejectionError(signature.capability, {
    signatureId: signature.id,
    recoveryHint: signature.recoveryHint,
    observedAt: signature.observedAt,
    references: [...signature.evidence],
    rejection: {
      status: rejection.status,
      responseBody: rejection.responseBody,
    },
  })
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

export function usedRequestCapabilities(
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
