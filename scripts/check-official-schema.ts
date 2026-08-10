import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  loadConformanceCases,
  runConformanceCase,
  type ConformanceCase,
} from '../conformance/runner'
import {
  loadNormativeRegistry,
  rulesByCase,
  type OfficialSchema,
} from '../conformance/normative'
import type { JsonValue } from '../src/types'

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requestBody(item: ConformanceCase, actual: JsonValue): JsonValue {
  if (!item.operation.endsWith('-encode')) {
    throw new Error(`${item.file} 不是 encode case，不能做 request schema 校验`)
  }
  return isRecord(actual) && actual.body !== undefined ? actual.body : actual
}

function identifier(file: string): string {
  return file.replace(/\.json$/, '').replace(/[^a-zA-Z0-9]+/g, '_')
}

const imports: Record<OfficialSchema, string> = {
  anthropic:
    "import type { MessageCreateParams } from '@anthropic-ai/sdk/resources/messages/messages'",
  'openai-chat':
    "import type { ChatCompletionCreateParams } from 'openai/resources/chat/completions/completions'",
  responses:
    "import type { ResponseCreateParams } from 'openai/resources/responses/responses'",
}

const typeNames: Record<OfficialSchema, string> = {
  anthropic: 'MessageCreateParams',
  'openai-chat': 'ChatCompletionCreateParams',
  responses: 'ResponseCreateParams',
}

const root = join(import.meta.dir, '..')
const corpusDirectory = join(root, 'conformance', 'corpus')
const registry = loadNormativeRegistry(join(root, 'normative', 'registry.json'))
const indexedRules = rulesByCase(registry)
const cases = loadConformanceCases(corpusDirectory)
const declarations: string[] = []
const usedSchemas = new Set<OfficialSchema>()

for (const item of cases) {
  const rule = indexedRules.get(item.file)?.[0]
  if (rule?.schema === undefined) continue
  const result = await runConformanceCase(item)
  const body = requestBody(item, result.actual)
  usedSchemas.add(rule.schema)
  const name = identifier(item.file)
  declarations.push(
    `const ${name} = ${JSON.stringify(body, null, 2)} satisfies ${typeNames[rule.schema]}`,
    `void ${name}`,
  )
}

if (declarations.length === 0) {
  throw new Error('normative registry 没有可执行的官方 request schema case')
}

const cacheDirectory = join(root, 'node_modules', '.cache', 'canoir-official-schema')
const generatedPath = join(cacheDirectory, 'requests.ts')
mkdirSync(cacheDirectory, { recursive: true })
writeFileSync(
  generatedPath,
  `${[...usedSchemas].map((schema) => imports[schema]).join('\n')}\n\n${declarations.join('\n\n')}\n`,
)

try {
  const result = Bun.spawnSync([
    'bun',
    'x',
    'tsc',
    '--noEmit',
    '--ignoreConfig',
    '--strict',
    '--skipLibCheck',
    '--target',
    'ES2022',
    '--module',
    'ESNext',
    '--moduleResolution',
    'Bundler',
    '--verbatimModuleSyntax',
    generatedPath,
  ])
  if (result.exitCode !== 0) {
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    throw new Error(`官方 request schema 校验失败：\n${output}`)
  }
  console.log(`官方 request schema 校验通过：${declarations.length / 2} 个 encode case`)
} finally {
  rmSync(cacheDirectory, { recursive: true, force: true })
}
