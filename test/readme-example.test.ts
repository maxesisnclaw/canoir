import { expect, test } from 'bun:test'

import { request } from '../examples/minimal'

test('README 最小示例可运行', () => {
  expect(request.body).toEqual({
    model: 'model-a',
    store: false,
    stream: true,
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
    ],
    include: ['reasoning.encrypted_content'],
  })
})
