/**
 * Incremental parser for live-streaming display.
 * Extracts only the explanation text and file status from the raw stream —
 * file content is replaced with just the filename indicator.
 */
export function extractStreamDisplay(rawText) {
  let display = ''
  const files = []
  let pos = 0

  while (pos < rawText.length) {
    const startTag = rawText.indexOf('<<<FREEZR_START', pos)
    if (startTag < 0) {
      const tail = rawText.slice(pos).trim()
      if (tail) display += (display ? '\n\n' : '') + tail
      break
    }

    const textBefore = rawText.slice(pos, startTag).trim()
    if (textBefore) display += (display ? '\n\n' : '') + textBefore

    const tagEnd = rawText.indexOf('>>>', startTag + 15)
    if (tagEnd < 0) break

    const tagContent = rawText.slice(startTag + 15, tagEnd).trim()
    const typeMatch = tagContent.match(/type="([^"]*)"/)
    const pathMatch = tagContent.match(/path="([^"]*)"/)
    const type = typeMatch?.[1]
    const contentStart = tagEnd + 3
    const endTag = rawText.indexOf('<<<FREEZR_END>>>', contentStart)

    if (type === 'explanation') {
      if (endTag >= 0) {
        const sectionText = rawText.slice(contentStart, endTag).trim()
        if (sectionText) display += (display ? '\n\n' : '') + sectionText
        pos = endTag + 16
      } else {
        const partial = rawText.slice(contentStart).trim()
        if (partial) display += (display ? '\n\n' : '') + partial
        break
      }
    } else if (type === 'file') {
      const filePath = pathMatch?.[1] || 'file'
      const done = endTag >= 0
      const content = done ? rawText.slice(contentStart, endTag).trim() : rawText.slice(contentStart).trim()
      // For the streaming preview box we want a "tail -f" effect: show the
      // LAST few lines of what the model has written so far, so the preview
      // visibly changes as new content streams in. (Previously this took the
      // first 2 lines, which froze the preview as soon as line 2 was written.)
      const lines = content.split('\n')
      const snippet = lines.slice(Math.max(0, lines.length - 3)).join('\n')
      files.push({ path: filePath, done, snippet })
      if (done) { pos = endTag + 16 } else { break }
    } else if (type === 'image') {
      const filePath = pathMatch?.[1] || 'image.png'
      files.push({ path: filePath, done: endTag >= 0, snippet: null, isImage: true })
      if (endTag >= 0) { pos = endTag + 16 } else { break }
    } else if (type === 'meta' || type === 'summary' || type === 'request_file') {
      if (endTag >= 0) { pos = endTag + 16 } else { break }
    } else {
      pos = tagEnd + 3
    }
  }

  return { displayText: display.trim(), files }
}

/** Minimal parser for <<<FREEZR_START ...>>> sections (same idea as Creator). */
export function parseFreezrResponse(responseText) {
  const result = {
    explanation: '',
    files: [],
    images: [],
    meta: null,
    requestFiles: [],
    summary: null,
    parseErrors: [],
    hasSections: false
  }
  const sectionRegex = /<<<FREEZR_START\s([^>]*)>>>([\s\S]*?)<<<FREEZR_END>>>/g
  const explanationParts = []
  let lastIndex = 0
  let match

  while ((match = sectionRegex.exec(responseText)) !== null) {
    result.hasSections = true

    const textBefore = responseText.slice(lastIndex, match.index).trim()
    if (textBefore) explanationParts.push(textBefore)
    lastIndex = match.index + match[0].length

    const attributeStr = match[1].trim()
    const content = match[2].trim()
    const attrs = {}
    const attrRegex = /(\w+)="([^"]*)"/g
    let attrMatch
    while ((attrMatch = attrRegex.exec(attributeStr)) !== null) {
      attrs[attrMatch[1]] = attrMatch[2]
    }

    switch (attrs.type) {
      case 'explanation':
        explanationParts.push(content)
        break
      case 'file':
        if (!attrs.path) {
          result.parseErrors.push('File section missing path attribute: ' + attributeStr)
          break
        }
        result.files.push({ path: attrs.path, action: attrs.action || 'upsert', content })
        break
      case 'meta':
        try {
          result.meta = JSON.parse(content)
        } catch (e) {
          result.parseErrors.push('Failed to parse meta JSON: ' + e.message)
        }
        break
      case 'request_file':
        if (content) {
          content.split('\n').forEach((line) => {
            const p = line.trim()
            if (p) result.requestFiles.push(p)
          })
        }
        break
      case 'image':
        if (!attrs.path) {
          result.parseErrors.push('Image section missing path attribute: ' + attributeStr)
          break
        }
        result.images.push({ path: attrs.path, prompt: content })
        break
      case 'summary':
        try {
          result.summary = JSON.parse(content)
        } catch (e) {
          result.parseErrors.push('Failed to parse summary JSON: ' + e.message)
        }
        break
      default:
        result.parseErrors.push('Unknown section type: "' + attrs.type + '"')
    }
  }

  const trailing = responseText.slice(lastIndex).trim()
  if (trailing) explanationParts.push(trailing)

  result.explanation = explanationParts.join('\n\n')
  return result
}
