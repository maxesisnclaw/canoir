import { describe, expect, test } from 'bun:test'

import {
  isRuleDefinitionFile,
  scanContent,
} from '../scripts/check-public-content'

describe('公开内容扫描', () => {
  test('豁免范围固定为规则定义文件', () => {
    expect(isRuleDefinitionFile('AGENTS.md')).toBe(true)
    expect(isRuleDefinitionFile('.githooks/pre-push')).toBe(true)
    expect(isRuleDefinitionFile('scripts/check-public-content.ts')).toBe(true)
    expect(isRuleDefinitionFile('README.md')).toBe(false)
  })

  test('普通跟踪文件命中本机 denylist 时失败', () => {
    const internalDomain = ['maxng', 'cc'].join('.')
    const findings = scanContent('fixture', 'README.md', internalDomain, [
      internalDomain,
    ])

    expect(findings).toHaveLength(1)
    expect(findings[0]?.rule).toContain('内部标识')
  })

  test('普通跟踪文件命中通用内网地址规则时失败', () => {
    const privateAddress = [10, 0, 0, 1].join('.')
    const findings = scanContent('fixture', 'README.md', privateAddress, [])

    expect(findings.some((finding) => finding.rule === '10.x 内网地址')).toBe(
      true,
    )
  })

  test('规则定义文件可书写被拦截模式', () => {
    const protectedName = ['keys', 'env'].join('.')
    const findings = scanContent(
      'fixture',
      'scripts/check-public-content.ts',
      protectedName,
      [protectedName],
    )

    expect(findings).toEqual([])
  })
})
