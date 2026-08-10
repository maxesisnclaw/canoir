import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  validateMessages,
  type ValidationOptions,
} from '../src/validate'

interface ValidationCase {
  name: string
  operation: 'validate'
  invariants: M1Invariant[]
  input: {
    messages: unknown
    options?: ValidationOptions
  }
  expected: {
    valid: boolean
    issueCodes: string[]
  }
}

type M1Invariant = 'I1' | 'I2' | 'I4' | 'I5' | 'I6'

const m1Invariants: M1Invariant[] = ['I1', 'I2', 'I4', 'I5', 'I6']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isM1Invariant(value: unknown): value is M1Invariant {
  return typeof value === 'string' && m1Invariants.includes(value as M1Invariant)
}

function parseCase(path: string): ValidationCase | undefined {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(parsed)) {
    throw new Error(`非法 conformance case: ${path}`)
  }
  if (parsed.operation !== 'validate') return undefined

  if (
    typeof parsed.name !== 'string' ||
    !Array.isArray(parsed.invariants) ||
    !parsed.invariants.every(isM1Invariant) ||
    !isRecord(parsed.input) ||
    !isRecord(parsed.expected) ||
    typeof parsed.expected.valid !== 'boolean' ||
    !Array.isArray(parsed.expected.issueCodes) ||
    !parsed.expected.issueCodes.every((code) => typeof code === 'string')
  ) {
    throw new Error(`非法 validation conformance case: ${path}`)
  }

  let options: ValidationOptions | undefined
  if (parsed.input.options !== undefined) {
    if (
      !isRecord(parsed.input.options) ||
      (parsed.input.options.targetProviderId !== undefined &&
        typeof parsed.input.options.targetProviderId !== 'string')
    ) {
      throw new Error(`非法 validation options: ${path}`)
    }
    options =
      parsed.input.options.targetProviderId === undefined
        ? {}
        : { targetProviderId: parsed.input.options.targetProviderId }
  }

  return {
    name: parsed.name,
    operation: 'validate',
    invariants: parsed.invariants,
    input:
      options === undefined
        ? { messages: parsed.input.messages }
        : { messages: parsed.input.messages, options },
    expected: {
      valid: parsed.expected.valid,
      issueCodes: parsed.expected.issueCodes,
    },
  }
}

const corpusDirectory = join(import.meta.dir, '..', 'conformance', 'corpus')
const cases = readdirSync(corpusDirectory)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => parseCase(join(corpusDirectory, file)))
  .filter((item): item is ValidationCase => item !== undefined)

describe('validation conformance corpus', () => {
  test('M1 每条不变量都有至少两个正例与两个反例', () => {
    for (const invariant of m1Invariants) {
      const relevant = cases.filter((item) =>
        item.invariants.includes(invariant),
      )
      expect(relevant.filter((item) => item.expected.valid)).toHaveLength(2)
      expect(
        relevant.filter((item) => !item.expected.valid).length,
      ).toBeGreaterThanOrEqual(2)
    }
  })

  for (const item of cases) {
    test(item.name, () => {
      const result = validateMessages(item.input.messages, item.input.options)
      const issueCodes = result.issues.map((issue) => issue.code).sort()

      expect(result.valid).toBe(item.expected.valid)
      expect(issueCodes).toEqual([...item.expected.issueCodes].sort())
    })
  }
})
