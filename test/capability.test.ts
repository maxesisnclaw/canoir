import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { applyCapability } from '../src/capability'
import { OpenAIResponsesCodec } from '../src/codecs/openai-responses'

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

describe('codec capability 生命周期', () => {
  test('constructor 固定能力，updateCapability 显式替换后续请求能力', () => {
    const codec = new OpenAIResponsesCodec({
      providerId: 'provider-x',
      model: 'model-a',
      endpoint: 'https://endpoint-a.example/v1/responses',
      apiKey: 'test-key',
      capability: {
        vision: true,
        document: 'unsupported',
        toolCalls: true,
        thinking: 'native',
        streaming: true,
      },
    })
    const messages = [
      {
        role: 'user' as const,
        content: [
          {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              mediaType: 'image/png',
              data: 'aW1hZ2U=',
            },
          },
        ],
      },
    ]

    expect(codec.encode(messages).body.input).toEqual([
      {
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' }],
      },
    ])

    codec.updateCapability({
      vision: false,
      document: 'unsupported',
      toolCalls: true,
      thinking: 'native',
      streaming: true,
    })
    const updated = codec.encode(messages)
    expect(updated.body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: '' }] },
    ])
    expect(updated.degradations).toEqual([
      {
        blockType: 'image',
        action: 'filtered',
        reason: '目标 provider 的 vision capability 为 false',
      },
    ])
  })
})
