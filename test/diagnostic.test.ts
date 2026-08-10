import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  OpenAIResponsesHttpError,
  OpenAIResponsesCodec,
  type JsonValue,
  type RequestDiagnostic,
} from '../src/index'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('I11 请求诊断', () => {
  test('显式 writer 保存完整出站请求，默认模式不落盘', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'canoir-diagnostic-'))
    temporaryDirectories.push(directory)
    const enabledPath = join(directory, 'request.json')
    const disabledPath = join(directory, 'disabled.json')
    let sentBody: unknown

    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as unknown
      return new Response('{"error":{"message":"invalid request"}}', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch

    const codec = new OpenAIResponsesCodec({
      providerId: 'provider-x',
      model: 'model-a',
      endpoint: 'https://endpoint-a.example/v1/responses',
      apiKey: 'test-key',
      fetch: fetchImpl,
    })
    const messages = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] },
    ]
    const capability = {
      vision: false,
      document: 'unsupported' as const,
      toolCalls: true,
      thinking: 'native' as const,
      streaming: true,
    }
    const encoded = codec.encode(messages, capability)

    await expect(
      codec.call(messages, capability, {
        diagnosticWriter: (diagnostic: RequestDiagnostic) => {
          writeFileSync(enabledPath, JSON.stringify(diagnostic))
        },
      }),
    ).rejects.toBeInstanceOf(OpenAIResponsesHttpError)

    const saved = JSON.parse(readFileSync(enabledPath, 'utf8')) as RequestDiagnostic
    expect(saved.body).toEqual(encoded.body as unknown as JsonValue)
    expect(saved.body).toEqual(sentBody as JsonValue)
    expect(saved.headers.authorization).toBe('Bearer test-key')

    await expect(codec.call(messages, capability)).rejects.toBeInstanceOf(
      OpenAIResponsesHttpError,
    )
    expect(existsSync(disabledPath)).toBe(false)
  })
})
