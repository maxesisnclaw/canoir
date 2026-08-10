import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  loadNormativeRegistry,
  rulesByCase,
} from '../conformance/normative'

const root = join(import.meta.dir, '..')
const registry = loadNormativeRegistry(join(root, 'normative', 'registry.json'))
const corpusFiles = readdirSync(join(root, 'conformance', 'corpus'))
  .filter((file) => file.endsWith('.json'))
  .sort()

describe('M6 normative registry', () => {
  test('官方来源固定到不可变版本', () => {
    expect(registry.sources.length).toBeGreaterThanOrEqual(3)
    expect(new Set(registry.sources.map((source) => source.id)).size).toBe(
      registry.sources.length,
    )
    for (const source of registry.sources) {
      expect(source.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(source.versionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(source.url).toStartWith('https://')
      expect(source.schema.length).toBeGreaterThan(0)
      if (source.upstream !== undefined) {
        expect(registry.sources.some((item) => item.id === source.upstream)).toBe(
          true,
        )
      }
    }
  })

  test('每条语料恰好登记一次，新增语料不能隐式继承规则', () => {
    const indexed = rulesByCase(registry)
    expect([...indexed.keys()].sort()).toEqual(corpusFiles)
    for (const file of corpusFiles) {
      expect(indexed.get(file)).toHaveLength(1)
    }
  })

  test('官方、偏差与 CanoIR 规则分别具备必要证据', () => {
    const sourceIds = new Set(registry.sources.map((source) => source.id))
    expect(new Set(registry.rules.map((rule) => rule.id)).size).toBe(
      registry.rules.length,
    )
    for (const rule of registry.rules) {
      expect(rule.cases.length).toBeGreaterThan(0)
      if (rule.basis === 'official') {
        expect(sourceIds.has(rule.source)).toBe(true)
        expect(rule.anchor.length).toBeGreaterThan(0)
      } else if (rule.basis === 'deviation') {
        expect(rule.condition.length).toBeGreaterThan(0)
        expect(rule.testedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(rule.evidence.length).toBeGreaterThan(0)
      } else {
        expect(rule.rationale.length).toBeGreaterThan(0)
      }
    }
  })

  test('每个成功 encode case 必须通过官方 schema 或显式登记偏差', async () => {
    const indexed = rulesByCase(registry)
    const { loadConformanceCases } = await import('../conformance/runner')
    const cases = loadConformanceCases(join(root, 'conformance', 'corpus'))
    for (const item of cases) {
      if (!item.operation.endsWith('-encode')) continue
      const expected = item.expected
      const isError =
        typeof expected === 'object' &&
        expected !== null &&
        !Array.isArray(expected) &&
        expected.error !== undefined
      if (isError) continue
      const rule = indexed.get(item.file)?.[0]
      expect(rule?.schema !== undefined || rule?.basis === 'deviation').toBe(true)
    }
  })
})
