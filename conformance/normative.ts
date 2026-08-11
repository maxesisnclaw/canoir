import { readFileSync } from 'node:fs'

export type OfficialSchema = 'anthropic' | 'openai-chat' | 'responses'

export interface NormativeSource {
  id: string
  vendor: string
  kind: 'openapi' | 'sdk-types'
  version: string
  commit: string
  versionDate: string
  url: string
  schema: string
  apiVersion?: string
  upstream?: string
}

export type NormativeRule =
  | {
      id: string
      basis: 'official'
      source: string
      anchor: string
      schema?: OfficialSchema
      cases: string[]
    }
  | {
      id: string
      basis: 'deviation'
      condition: string
      testedAt: string
      evidence: string[]
      schema?: OfficialSchema
      cases: string[]
    }
  | {
      // extension：spec 定义域之外的端点自留地（自加字段/参数）。
      // 不是偏差——对外不指控，仅信息记录；要求 note 说明形态。
      id: string
      basis: 'extension'
      note: string
      schema?: OfficialSchema
      cases: string[]
    }
  | {
      id: string
      basis: 'canoir'
      rationale: string
      schema?: OfficialSchema
      cases: string[]
    }

export interface NormativeRegistry {
  sources: NormativeSource[]
  rules: NormativeRule[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function loadNormativeRegistry(path: string): NormativeRegistry {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(value) || !Array.isArray(value.sources) || !Array.isArray(value.rules)) {
    throw new Error(`非法 normative registry: ${path}`)
  }
  return value as unknown as NormativeRegistry
}

export function rulesByCase(registry: NormativeRegistry): Map<string, NormativeRule[]> {
  const result = new Map<string, NormativeRule[]>()
  for (const rule of registry.rules) {
    for (const file of rule.cases) {
      const existing = result.get(file) ?? []
      existing.push(rule)
      result.set(file, existing)
    }
  }
  return result
}
