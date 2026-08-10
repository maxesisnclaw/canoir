export function cleanWireModelId(model: string): string {
  let visible = ''
  for (let index = 0; index < model.length; index += 1) {
    if (model.charCodeAt(index) === 27 && model[index + 1] === '[') {
      index += 2
      while (index < model.length) {
        const code = model.charCodeAt(index)
        if (code >= 0x40 && code <= 0x7e) break
        index += 1
      }
      continue
    }
    visible += model[index]
  }

  const cleaned = visible.replace(/\s*\[1m\]\s*$/i, '').trim()

  if (cleaned.length === 0) {
    throw new Error('model 清理显示标记后不能为空')
  }
  return cleaned
}
