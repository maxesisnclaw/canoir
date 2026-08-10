import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import {
  loadConformanceCases,
  runConformanceCase,
} from '../conformance/runner'

const corpusDirectory = join(import.meta.dir, '..', 'conformance', 'corpus')
const cases = loadConformanceCases(corpusDirectory)

describe('conformance runner', () => {
  test('M2 Anthropic 语料不少于 12 条且录制流不少于 3 条', () => {
    const anthropicCases = cases.filter((item) =>
      item.operation.startsWith('anthropic-'),
    )
    expect(anthropicCases.length).toBeGreaterThanOrEqual(12)
    expect(
      anthropicCases.filter((item) => item.recorded).length,
    ).toBeGreaterThanOrEqual(3)
  })

  for (const item of cases) {
    test(item.name, async () => {
      const result = await runConformanceCase(item)
      expect(result.actual).toEqual(result.expected)
    })
  }
})
