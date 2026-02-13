import { readFileSync, writeFileSync, existsSync } from 'fs'

export function readMarkdownFile(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }
  try {
    return readFileSync(filePath, 'utf-8')
  } catch (err) {
    throw new Error(`Cannot read file ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function writeMarkdownFile(filePath: string, content: string): void {
  try {
    writeFileSync(filePath, content, 'utf-8')
  } catch (err) {
    throw new Error(`Cannot write file ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Extract highlight text from <mark> tags */
export function extractHighlightTexts(markdown: string): string[] {
  const texts: string[] = []
  const re = /<mark[^>]*>(.*?)<\/mark>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown)) !== null) {
    texts.push(m[1])
  }
  return texts
}
