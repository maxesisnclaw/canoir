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

  test('M3 Chat Completions 新增语料不少于 8 条', () => {
    const openAIChatCases = cases.filter((item) =>
      item.operation.startsWith('openai-chat-'),
    )
    expect(openAIChatCases.length).toBeGreaterThanOrEqual(8)
  })

  test('M4 Responses 与 capability 降级语料覆盖最低线', () => {
    const responsesCases = cases.filter((item) =>
      item.operation.startsWith('responses-'),
    )
    const degradationCases = cases.filter(
      (item) => item.category === 'degrade',
    )
    expect(responsesCases.length).toBeGreaterThanOrEqual(7)
    expect(degradationCases.length).toBeGreaterThanOrEqual(4)
  })

  test('M5 五类退化检测与流式录制数量达到发布线', () => {
    const recordedStreams = cases.filter(
      (item) => item.category === 'stream' && item.recorded,
    )
    expect(recordedStreams.length).toBeGreaterThanOrEqual(10)

    const codes = new Set<string>()
    for (const item of cases) {
      const expected = item.expected
      if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) {
        continue
      }
      const error = expected.error
      if (error === null || typeof error !== 'object' || Array.isArray(error)) {
        continue
      }
      if (typeof error.code === 'string') codes.add(error.code)
      if (error.name === 'AnthropicRefusalError') codes.add('refusal')
    }
    for (const code of [
      'max_tokens',
      'refusal',
      'runaway_thinking',
      'empty_response',
      'stream_assembly_loss',
    ]) {
      expect(codes.has(code)).toBe(true)
    }
  })

  test('M7 三家 Usage 分解与 cache hint 路径达到最低线', () => {
    const usageCases = cases.filter((item) => item.category === 'usage')
    expect(
      usageCases.some((item) => item.operation.startsWith('anthropic-')),
    ).toBe(true)
    expect(
      usageCases.some((item) => item.operation.startsWith('openai-chat-')),
    ).toBe(true)
    expect(
      cases.some(
        (item) =>
          item.operation.startsWith('responses-') &&
          JSON.stringify(item.expected).includes('cacheReadTokens'),
      ),
    ).toBe(true)

    const cacheCases = cases.filter((item) => item.category === 'cache')
    expect(cacheCases.length).toBeGreaterThanOrEqual(3)
    expect(
      cacheCases.some((item) =>
        JSON.stringify(item.expected).includes('cache-hint-ignored'),
      ),
    ).toBe(true)
  })

  test('M8 识别、三类降级、自限重试与 TTL 恢复均有语料', () => {
    const adaptationCases = cases.filter(
      (item) => item.category === 'adaptation',
    )
    expect(adaptationCases.length).toBeGreaterThanOrEqual(5)
    const corpus = JSON.stringify(adaptationCases.map((item) => item.expected))
    for (const marker of [
      'document-to-images',
      '图片已因目标端点拒绝而移除',
      'thinking-param-removed',
      'first opaque error',
      'rejectedAfterExpiry',
    ]) {
      expect(corpus).toContain(marker)
    }
  })

  for (const item of cases) {
    test(item.name, async () => {
      const result = await runConformanceCase(item)
      expect(result.actual).toEqual(result.expected)
    })
  }
})
