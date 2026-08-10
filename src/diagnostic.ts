import type { JsonValue } from './types'

export interface RequestDiagnostic {
  method: 'POST'
  url: string
  headers: Record<string, string>
  body: JsonValue
}

export type RequestDiagnosticWriter = (
  diagnostic: RequestDiagnostic,
) => void | Promise<void>

function jsonClone(value: unknown): JsonValue {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new Error('诊断请求不是可序列化 JSON')
  }
  return JSON.parse(serialized) as JsonValue
}

export async function writeRequestDiagnostic(
  writer: RequestDiagnosticWriter | undefined,
  request: Omit<RequestDiagnostic, 'body'> & { body: unknown },
): Promise<void> {
  if (writer === undefined) return
  await writer({
    method: request.method,
    url: request.url,
    headers: { ...request.headers },
    body: jsonClone(request.body),
  })
}
