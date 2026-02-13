import { useEditor, EditorContent, BubbleMenu } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Highlight from '@tiptap/extension-highlight'
import Placeholder from '@tiptap/extension-placeholder'
import Link from '@tiptap/extension-link'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Image from '@tiptap/extension-image'
import { Markdown } from 'tiptap-markdown'
import { useCallback, forwardRef, useImperativeHandle, useRef, useState, useEffect } from 'react'
import { nanoid } from 'nanoid'
import { MemoBlock } from '../extensions/MemoBlock'
import {
  HIGHLIGHT_COLORS,
  HEX_TO_COLOR_NAME,
  type HighlightColor,
  type ReviewHighlight,
  type ReviewMemo,
} from '../../shared/types'

export interface EditorHandle {
  getMarkdown: () => string
  getAnnotatedMarkdown: () => string
  setMarkdown: (md: string) => void
  getMemos: () => ReviewMemo[]
  getHighlights: () => ReviewHighlight[]
  getDocumentTitle: () => string
  getSections: () => string[]
  applyAnnotation: (color: HighlightColor) => void
}

/** Append memos that tiptap-markdown failed to serialize (shared fallback) */
function appendMissedMemos(md: string, ed: { state: { doc: { descendants: (cb: (node: any) => void) => void } } }): string {
  const memoCount = (md.match(/<!-- USER_MEMO/g) || []).length
  let actualMemoCount = 0
  ed.state.doc.descendants((node: any) => {
    if (node.type.name === 'memoBlock') actualMemoCount++
  })
  if (memoCount < actualMemoCount) {
    const appendMemos: string[] = []
    ed.state.doc.descendants((node: any) => {
      if (node.type.name === 'memoBlock') {
        const { memoId, text, color, status } = node.attrs
        const escaped = (text || '').replace(/-->/g, '--\u200B>')
        const statusAttr = status && status !== 'open' ? ` status="${status}"` : ''
        const comment = `<!-- USER_MEMO id="${memoId}" color="${color}"${statusAttr} : ${escaped} -->`
        if (!md.includes(`id="${memoId}"`)) {
          appendMemos.push(comment)
        }
      }
    })
    if (appendMemos.length > 0) {
      md = md.trimEnd() + '\n\n' + appendMemos.join('\n') + '\n'
    }
  }
  return md
}

/** Convert tiptap-markdown output to annotated markdown with memo comments */
function serializeWithMemos(markdown: string): string {
  return markdown.replace(
    /<div\s[^>]*data-memo-block[^>]*>[\s\S]*?<\/div>/g,
    (match) => {
      const id = match.match(/data-memo-id="([^"]*)"/)
      const text = match.match(/data-memo-text="([^"]*)"/)
      const color = match.match(/data-memo-color="([^"]*)"/)
      const status = match.match(/data-memo-status="([^"]*)"/)
      if (id && color) {
        const memoText = text ? decodeHtmlEntities(text[1]) : ''
        const statusAttr = status && status[1] !== 'open' ? ` status="${status[1]}"` : ''
        return `<!-- USER_MEMO id="${id[1]}" color="${color[1]}"${statusAttr} : ${memoText} -->`
      }
      return ''
    },
  )
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/** Find the continuous range of a highlight mark at a given position */
function findMarkRange(
  doc: any, pos: number, markTypeName: string, color: string,
): { from: number; to: number } | null {
  try {
    const $pos = doc.resolve(pos)
    const parent = $pos.parent
    const start = pos - $pos.parentOffset

    const ranges: { from: number; to: number }[] = []
    let cur: { from: number; to: number } | null = null

    parent.forEach((child: any, offset: number) => {
      const childStart = start + offset
      const childEnd = childStart + child.nodeSize
      const hasMark = child.isText && child.marks.some((m: any) =>
        m.type.name === markTypeName && m.attrs.color === color,
      )
      if (hasMark) {
        cur = cur ? { from: cur.from, to: childEnd } : { from: childStart, to: childEnd }
      } else if (cur) {
        ranges.push(cur)
        cur = null
      }
    })
    if (cur) ranges.push(cur)

    return ranges.find(r => pos >= r.from && pos <= r.to) || null
  } catch {
    return null
  }
}

interface DeletePopover {
  x: number
  y: number
  from: number
  to: number
  color: string
}

interface EditorProps {
  onUpdate?: (annotatedMarkdown: string) => void
  onSelectionChange?: (hasSelection: boolean) => void
}

const Editor = forwardRef<EditorHandle, EditorProps>(({ onUpdate: onUpdateProp, onSelectionChange }, ref) => {
  const savedSelectionRef = useRef<{ from: number; to: number } | null>(null)
  const applyAnnotationRef = useRef<(color: HighlightColor) => void>(() => {})
  const [deletePopover, setDeletePopover] = useState<DeletePopover | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
        codeBlock: { HTMLAttributes: { class: 'code-block' } },
      }),
      Highlight.configure({
        multicolor: true,
        HTMLAttributes: { class: 'highlight' },
      }),
      Placeholder.configure({
        placeholder: 'Open a markdown file to start reviewing.',
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: 'editor-link' },
      }),
      Table.configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
      TaskList,
      TaskItem.configure({ nested: true }),
      Image.configure({ inline: true }),
      MemoBlock,
      Markdown.configure({
        html: true,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    editorProps: {
      attributes: {
        class: 'tiptap-editor tiptap-readonly',
      },
      handleKeyDown: (_view, event) => {
        const nav = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Tab']
        if (nav.includes(event.key)) return false
        const mod = event.ctrlKey || event.metaKey
        if (mod && ['a', 'c', 'f', 'z'].includes(event.key.toLowerCase())) return false

        // Annotation shortcuts: 1 = Highlight, 2 = Fix, 3 = Question
        const sel = savedSelectionRef.current
        if (sel && sel.to - sel.from >= 2) {
          const key = event.key
          if (key === '1') {
            setTimeout(() => applyAnnotationRef.current('yellow'), 0)
            event.preventDefault()
            return true
          }
          if (key === '2') {
            setTimeout(() => applyAnnotationRef.current('red'), 0)
            event.preventDefault()
            return true
          }
          if (key === '3') {
            setTimeout(() => applyAnnotationRef.current('blue'), 0)
            event.preventDefault()
            return true
          }
        }

        event.preventDefault()
        return true
      },
      handlePaste: () => true,
      handleDrop: () => true,
      handleTextInput: () => true,
    },
    onSelectionUpdate: ({ editor: ed }) => {
      const { from, to } = ed.state.selection
      const hasSelection = to - from >= 2
      if (hasSelection) {
        savedSelectionRef.current = { from, to }
        setDeletePopover(null)
      } else {
        savedSelectionRef.current = null
      }
      onSelectionChange?.(hasSelection)
    },
    onUpdate: ({ editor: ed }) => {
      if (onUpdateProp) {
        let md = ed.storage.markdown.getMarkdown()
        md = serializeWithMemos(md)
        md = appendMissedMemos(md, ed)
        onUpdateProp(md)
      }
    },
  })

  // Click-to-delete: detect clicks on marked text
  useEffect(() => {
    if (!editor) return
    const el = editor.view.dom

    const handleClick = (e: MouseEvent) => {
      if (popoverRef.current?.contains(e.target as Node)) return

      const pos = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })
      if (!pos) { setDeletePopover(null); return }

      try {
        const resolved = editor.state.doc.resolve(pos.pos)
        const marks = resolved.marks()
        const hlMark = marks.find((m: any) => m.type.name === 'highlight')

        if (hlMark) {
          const range = findMarkRange(editor.state.doc, pos.pos, 'highlight', hlMark.attrs.color)
          if (range) {
            setDeletePopover({
              x: Math.max(80, Math.min(e.clientX, window.innerWidth - 80)),
              y: e.clientY,
              from: range.from,
              to: range.to,
              color: hlMark.attrs.color,
            })
            return
          }
        }
      } catch { /* ignore resolve errors */ }
      setDeletePopover(null)
    }

    el.addEventListener('click', handleClick)
    return () => el.removeEventListener('click', handleClick)
  }, [editor])

  // Dismiss popover on outside click
  useEffect(() => {
    if (!deletePopover) return
    const dismiss = (e: MouseEvent) => {
      if (popoverRef.current?.contains(e.target as Node)) return
      setDeletePopover(null)
    }
    const timer = setTimeout(() => document.addEventListener('click', dismiss), 10)
    return () => { clearTimeout(timer); document.removeEventListener('click', dismiss) }
  }, [deletePopover])

  useImperativeHandle(ref, () => ({
    getMarkdown: () => {
      if (!editor) return ''
      return editor.storage.markdown.getMarkdown()
    },
    getAnnotatedMarkdown: () => {
      if (!editor) return ''
      let md = editor.storage.markdown.getMarkdown()
      md = serializeWithMemos(md)
      md = appendMissedMemos(md, editor)
      return md
    },
    setMarkdown: (md: string) => {
      if (!editor) return
      try {
        editor.commands.setContent(md)
      } catch (error) {
        // Fallback: try setting as plain text wrapped in paragraph
        console.warn('md-feedback: markdown parsing failed, using fallback', error)
        try {
          editor.commands.setContent(`<p>${md.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
        } catch {
          // Last resort: clear editor
          editor.commands.clearContent()
        }
      }
    },
    getDocumentTitle: () => {
      if (!editor) return ''
      let title = ''
      editor.state.doc.descendants((node) => {
        if (!title && node.type.name === 'heading') {
          title = node.textContent
          return false
        }
      })
      return title
    },
    getHighlights: () => {
      if (!editor) return []
      const highlights: ReviewHighlight[] = []
      let currentSection = ''
      let current: { text: string; color: string; section: string; context: string } | null = null

      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading') currentSection = node.textContent
        if (node.isText && node.marks.length > 0) {
          const hlMark = node.marks.find(m => m.type.name === 'highlight')
          if (hlMark && node.text) {
            const color = hlMark.attrs.color || '#fef08a'
            const resolved = editor.state.doc.resolve(pos)
            const context = resolved.parent.textContent

            // Merge consecutive fragments with same color in same section
            if (current && current.color === color && current.section === currentSection) {
              current.text += node.text
              current.context = context
            } else {
              if (current) highlights.push(current)
              current = { text: node.text, color, section: currentSection, context }
            }
            return
          }
        }
        // Non-highlight node: flush current
        if (current) {
          highlights.push(current)
          current = null
        }
      })
      if (current) highlights.push(current)

      return highlights
    },
    getMemos: () => {
      if (!editor) return []
      const memos: ReviewMemo[] = []
      let currentSection = ''
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading') currentSection = node.textContent
        if (node.type.name === 'memoBlock') {
          let context = ''
          const resolved = editor.state.doc.resolve(pos)
          if (resolved.index(0) > 0) {
            context = editor.state.doc.child(resolved.index(0) - 1).textContent
          }
          memos.push({
            id: node.attrs.memoId,
            text: node.attrs.text,
            color: node.attrs.color,
            section: currentSection,
            context,
          })
        }
      })
      return memos
    },
    getSections: () => {
      if (!editor) return []
      const sections: string[] = []
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'heading' && node.attrs.level === 2) {
          const text = node.textContent.trim()
          if (text) sections.push(text)
        }
      })
      return sections
    },
    applyAnnotation: (color: HighlightColor) => {
      applyAnnotationRef.current(color)
    },
  }))

  const applyAnnotation = useCallback((color: HighlightColor) => {
    if (!editor) return

    const sel = savedSelectionRef.current
    if (!sel || sel.from === sel.to) return

    const { from, to } = sel

    editor.chain().focus().setTextSelection({ from, to }).run()

    const highlightMark = editor.schema.marks.highlight
    let hasSameMark = false
    editor.state.doc.nodesBetween(from, to, (node) => {
      if (node.isText && node.marks.some(m =>
        m.type === highlightMark && m.attrs.color === HIGHLIGHT_COLORS[color],
      )) {
        hasSameMark = true
      }
    })

    if (hasSameMark) {
      editor.chain().focus().setTextSelection({ from, to }).unsetHighlight().run()
      return
    }

    editor.chain().focus().setTextSelection({ from, to }).setHighlight({ color: HIGHLIGHT_COLORS[color] }).run()

    // Fix / Question: also insert a memo card
    if (color !== 'yellow') {
      const resolved = editor.state.doc.resolve(to)
      const endOfBlock = resolved.end(resolved.depth)
      const selectedText = editor.state.doc.textBetween(from, to, ' ')

      editor
        .chain()
        .insertContentAt(endOfBlock + 1, {
          type: 'memoBlock',
          attrs: {
            memoId: nanoid(8),
            text: '',
            color,
            anchorText: selectedText.slice(0, 80),
          },
        })
        .run()
    }
  }, [editor])

  // Keep ref in sync for keyboard shortcuts
  useEffect(() => {
    applyAnnotationRef.current = applyAnnotation
  }, [applyAnnotation])

  // Delete a mark (and its associated memo if fix/question)
  const handleDeleteMark = useCallback(() => {
    if (!editor || !deletePopover) return
    const { from, to, color } = deletePopover

    const markedText = editor.state.doc.textBetween(from, to, ' ')
    const colorName = HEX_TO_COLOR_NAME[color]
    const markType = editor.schema.marks.highlight

    let tr = editor.state.tr
    tr = tr.removeMark(from, to, markType)

    // Cascade: remove associated memo for fix/question
    if (colorName && colorName !== 'yellow') {
      let memoPos = -1
      let memoSize = 0
      editor.state.doc.descendants((node: any, pos: number) => {
        if (memoPos >= 0) return false
        if (
          node.type.name === 'memoBlock' &&
          node.attrs.color === colorName &&
          node.attrs.anchorText &&
          markedText.includes(node.attrs.anchorText.slice(0, 20))
        ) {
          memoPos = pos
          memoSize = node.nodeSize
          return false
        }
      })

      if (memoPos >= 0) {
        tr = tr.delete(memoPos, memoPos + memoSize)
      }
    }

    editor.view.dispatch(tr)
    setDeletePopover(null)
  }, [editor, deletePopover])

  if (!editor) return null

  return (
    <div className="relative">
      <BubbleMenu
        editor={editor}
        tippyOptions={{
          duration: [200, 150],
          placement: 'top',
          delay: [150, 0],
          appendTo: () => document.querySelector('.md-feedback-root') || document.body,
        }}
        className="bubble-menu-glass"
      >
        <div className="flex items-center">
          {/* Primary: Highlight */}
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => applyAnnotation('yellow')}
            className="bubble-btn bubble-btn-primary"
          >
            <span className="bubble-icon">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <rect x="1" y="10" width="14" height="3.5" rx="0.5" fill="#facc15" opacity="0.5" />
                <path d="M5 3.5v6M8 2v8M11 4v5" stroke="#d97706" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </span>
            <span className="bubble-label text-amber-700">Highlight</span>
            <kbd className="bubble-kbd">1</kbd>
          </button>

          <div className="bubble-sep" />

          {/* Secondary: Fix */}
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => applyAnnotation('red')}
            className="bubble-btn"
          >
            <span className="bubble-icon">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <line x1="2" y1="8" x2="14" y2="8" stroke="#dc2626" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </span>
            <span className="bubble-label text-red-600">Fix</span>
            <kbd className="bubble-kbd">2</kbd>
          </button>

          <div className="bubble-sep" />

          {/* Secondary: Question */}
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => applyAnnotation('blue')}
            className="bubble-btn"
          >
            <span className="bubble-icon">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M2 12c1.5-1 2.5 1 4 0s2.5 1 4 0s2.5 1 4 0" stroke="#3b82f6" strokeWidth="1.5" strokeLinecap="round" fill="none" />
              </svg>
            </span>
            <span className="bubble-label text-blue-600">Question</span>
            <kbd className="bubble-kbd">3</kbd>
          </button>
        </div>
      </BubbleMenu>

      <EditorContent
        editor={editor}
        className="min-h-[70vh] focus-within:outline-none"
      />

      {/* Delete mark popover */}
      {deletePopover && (
        <div
          ref={popoverRef}
          className="delete-popover"
          style={{
            position: 'fixed',
            left: deletePopover.x,
            top: deletePopover.y - 40,
          }}
        >
          <button className="delete-popover-btn" onClick={handleDeleteMark}>
            Remove
          </button>
        </div>
      )}
    </div>
  )
})

Editor.displayName = 'Editor'
export default Editor
