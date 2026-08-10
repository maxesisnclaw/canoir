import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { applyCapability } from '../src/capability'

describe('capability document converters', () => {
  test('真实 PDF fixture 经注入转换器降级为页面图片', () => {
    const pdf = readFileSync(join(import.meta.dir, 'fixtures', 'minimal.pdf'))
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.toString().trimEnd().endsWith('%%EOF')).toBeTrue()

    const result = applyCapability(
      [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                mediaType: 'application/pdf',
                data: pdf.toString('base64'),
              },
            },
          ],
        },
      ],
      {
        vision: true,
        document: 'degrade',
        toolCalls: true,
        thinking: 'unsupported',
        streaming: false,
      },
      {
        preferDocumentImages: true,
        documentConverters: {
          toImages: (document) => {
            expect(document.source.type).toBe('base64')
            return [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  mediaType: 'image/png',
                  data: 'cGFnZQ==',
                },
              },
            ]
          },
        },
      },
    )

    expect(result.messages[0]?.content[0]?.type).toBe('image')
    expect(result.degradations[0]?.action).toBe('document-to-images')
  })
})
