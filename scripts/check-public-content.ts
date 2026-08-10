import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const LOCAL_DENYLIST_PATH = '.public-scan.local'

// 规则必须能被定义。豁免仅限规则的文字定义与代码定义，禁止通过配置扩展。
const RULE_DEFINITION_FILES = new Set([
  'AGENTS.md',
  '.githooks/pre-push',
  'scripts/check-public-content.ts',
])

interface Finding {
  revision: string
  path: string
  line: number
  rule: string
}

interface PatternRule {
  name: string
  pattern: RegExp
}

const patternRules: PatternRule[] = [
  {
    name: '本机用户目录绝对路径',
    pattern: /(?:\/Users|\/home)\/[A-Za-z0-9._-]+(?:\/|$)/,
  },
  {
    name: '10.x 内网地址',
    pattern: /(^|[^0-9])10(?:\.[0-9]{1,3}){3}([^0-9]|$)/,
  },
  {
    name: '192.168.x 内网地址',
    pattern: /(^|[^0-9])192\.168(?:\.[0-9]{1,3}){2}([^0-9]|$)/,
  },
  {
    name: '环境文件名引用',
    pattern: /(^|[^A-Za-z0-9_])(?:keys\.env|\.env(?:\.[A-Za-z0-9_-]+)?)(?=$|[^A-Za-z0-9_.-])/,
  },
  {
    name: 'OpenAI 风格密钥',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    name: '疑似长 token 或 secret 赋值',
    pattern: /\b(?:api[_-]?key|token|secret)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{20,}/i,
  },
  {
    name: 'JWT',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    name: '私钥头',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
]

function gitText(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' })
}

function readDenylist(): string[] {
  if (!existsSync(LOCAL_DENYLIST_PATH)) {
    throw new Error(`缺少 ${LOCAL_DENYLIST_PATH}，拒绝在没有内部标识清单时扫描`)
  }

  return readFileSync(LOCAL_DENYLIST_PATH, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

function listFiles(revision: string): string[] {
  return gitText(['ls-tree', '-r', '--name-only', '-z', revision])
    .split('\0')
    .filter((path) => path.length > 0)
}

function readCommitMetadata(revision: string): string | undefined {
  const objectType = gitText(['cat-file', '-t', revision]).trim()
  if (objectType !== 'commit') return undefined

  return gitText(['show', '-s', '--format=fuller', revision])
}

function readTrackedFile(revision: string, path: string): Buffer {
  return execFileSync('git', ['show', `${revision}:${path}`])
}

function findLine(content: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset; index += 1) {
    if (content.charCodeAt(index) === 10) line += 1
  }
  return line
}

export function isRuleDefinitionFile(path: string): boolean {
  return RULE_DEFINITION_FILES.has(path)
}

export function scanContent(
  revision: string,
  path: string,
  content: string,
  denylist: string[],
): Finding[] {
  if (RULE_DEFINITION_FILES.has(path)) return []
  const findings: Finding[] = []

  for (const literal of denylist) {
    const offset = content.indexOf(literal)
    if (offset >= 0) {
      findings.push({
        revision,
        path,
        line: findLine(content, offset),
        rule: `内部标识：${literal}`,
      })
    }
  }

  for (const rule of patternRules) {
    const match = rule.pattern.exec(content)
    if (match?.index !== undefined) {
      findings.push({
        revision,
        path,
        line: findLine(content, match.index),
        rule: rule.name,
      })
    }
  }

  return findings
}

function scanFile(revision: string, path: string, denylist: string[]): Finding[] {
  if (isRuleDefinitionFile(path)) return []

  const bytes = readTrackedFile(revision, path)
  if (bytes.includes(0)) return []

  return scanContent(revision, path, bytes.toString('utf8'), denylist)
}

function main(): void {
  const denylist = readDenylist()
  const revisions = process.argv.slice(2)
  const targets = revisions.length > 0 ? revisions : ['HEAD']
  const findings: Finding[] = []

  for (const revision of new Set(targets)) {
    const metadata = readCommitMetadata(revision)
    if (metadata !== undefined) {
      findings.push(
        ...scanContent(revision, '<commit-metadata>', metadata, denylist),
      )
    }

    for (const path of listFiles(revision)) {
      findings.push(...scanFile(revision, path, denylist))
    }
  }

  if (findings.length === 0) {
    console.log(`公开内容扫描通过：${targets.length} 个 revision`)
    return
  }

  console.error('公开内容扫描失败：')
  for (const finding of findings) {
    console.error(`${finding.revision} ${finding.path}:${finding.line} ${finding.rule}`)
  }
  process.exitCode = 1
}

if (import.meta.main) main()
