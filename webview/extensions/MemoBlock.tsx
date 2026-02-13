import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react'
import { useState, useRef, useEffect, useCallback } from 'react'
import { MEMO_ACCENT, HIGHLIGHT_COLORS, type MemoColor, type MemoStatus, type HighlightColor } from '../../shared/types'

const STATUS_LABELS: Record<MemoStatus, { label: string; color: string; bg: string }> = {
  open:     { label: 'Open',     color: 'text-amber-700',  bg: 'bg-amber-50' },
  answered: { label: 'Answered', color: 'text-sky-700',    bg: 'bg-sky-50' },
  done:     { label: 'Done',     color: 'text-emerald-700', bg: 'bg-emerald-50' },
  wontfix:  { label: "Won't fix", color: 'text-stone-500',  bg: 'bg-stone-100' },
}

export const MemoBlock = Node.create({
  name: 'memoBlock',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      memoId:     { default: '' },
      text:       { default: '' },
      color:      { default: 'red' as MemoColor },
      anchorText: { default: '' },
      status:     { default: 'open' as MemoStatus },
    }
  },

  parseHTML() {
    return [{
      tag: 'div[data-memo-block]',
      getAttrs: (el) => {
        const element = el as HTMLElement
        return {
          memoId: element.getAttribute('data-memo-id') || '',
          text:   element.getAttribute('data-memo-text') || '',
          color:  element.getAttribute('data-memo-color') || 'red',
          status: element.getAttribute('data-memo-status') || 'open',
          anchorText: element.getAttribute('data-memo-anchor') || '',
        }
      },
    }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, {
      'data-memo-block': '',
      'data-memo-id':    HTMLAttributes.memoId,
      'data-memo-text':  HTMLAttributes.text,
      'data-memo-color': HTMLAttributes.color,
      'data-memo-status': HTMLAttributes.status || 'open',
    }), `memo: ${HTMLAttributes.text || ''}`]
  },

  addNodeView() {
    return ReactNodeViewRenderer(MemoBlockView)
  },
})

function MemoBlockView({ node, updateAttributes, deleteNode, selected, editor }: any) {
  const [editing, setEditing] = useState(!node.attrs.text)
  const [text, setText] = useState(node.attrs.text || '')
  const [showStatusMenu, setShowStatusMenu] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const statusMenuRef = useRef<HTMLDivElement>(null)
  const color = (node.attrs.color || 'red') as MemoColor
  const status = (node.attrs.status || 'open') as MemoStatus
  const accent = MEMO_ACCENT[color]
  const statusInfo = STATUS_LABELS[status]

  // Close status menu on click outside
  useEffect(() => {
    if (!showStatusMenu) return
    const handleClick = (e: MouseEvent) => {
      if (statusMenuRef.current && !statusMenuRef.current.contains(e.target as Node)) {
        setShowStatusMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showStatusMenu])

  useEffect(() => {
    if (editing) {
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [editing])

  const handleSave = () => {
    if (!text.trim()) {
      handleDelete()
      return
    }
    updateAttributes({ text })
    setEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSave()
    }
    if (e.key === 'Escape') {
      if (!node.attrs.text) {
        handleDelete()
        return
      }
      setText(node.attrs.text || '')
      setEditing(false)
    }
  }

  // Cascade delete: remove memo AND its associated highlight mark
  const handleDelete = useCallback(() => {
    if (!editor) { deleteNode(); return }

    const { anchorText, color: memoColor } = node.attrs

    // Find this memo's position in the document
    let memoPos = -1
    editor.state.doc.descendants((n: any, pos: number) => {
      if (memoPos >= 0) return false
      if (n.type.name === 'memoBlock' && n.attrs.memoId === node.attrs.memoId) {
        memoPos = pos
        return false
      }
    })

    if (memoPos < 0) { deleteNode(); return }

    let tr = editor.state.tr

    // Remove associated highlight mark (fix / question only)
    if (memoColor !== 'yellow') {
      const highlightColor = HIGHLIGHT_COLORS[memoColor as HighlightColor]
      if (highlightColor) {
        const markType = editor.schema.marks.highlight

        // Strategy: walk backwards from memo position to find the nearest
        // highlight of matching color in the preceding block
        let bestFrom = -1
        let bestTo = -1

        editor.state.doc.descendants((textNode: any, nodePos: number) => {
          // Only look at nodes before the memo
          if (nodePos >= memoPos) return false
          if (!textNode.isText || !textNode.text) return
          const hasMark = textNode.marks.some((m: any) =>
            m.type === markType && m.attrs.color === highlightColor,
          )
          if (hasMark) {
            // Track the range of consecutive highlighted text
            if (bestTo === nodePos) {
              // Extend existing range
              bestTo = nodePos + textNode.nodeSize
            } else {
              // Start new range (closer to memo = better)
              bestFrom = nodePos
              bestTo = nodePos + textNode.nodeSize
            }
          }
        })

        // Validate match: if anchorText exists, verify overlap
        if (bestFrom >= 0) {
          let shouldRemove = true
          if (anchorText) {
            try {
              const markedText = editor.state.doc.textBetween(bestFrom, bestTo, ' ')
              // Check bidirectional: either contains the other
              const anchor20 = anchorText.slice(0, 20)
              shouldRemove = markedText.includes(anchor20) || anchor20.includes(markedText.slice(0, 20))
            } catch {
              shouldRemove = true // best-effort
            }
          }
          if (shouldRemove) {
            tr = tr.removeMark(bestFrom, bestTo, markType)
          }
        }
      }
    }

    // Delete the memo node (position may have shifted from mark removal — use mapping)
    const mappedPos = tr.mapping.map(memoPos)
    tr = tr.delete(mappedPos, mappedPos + node.nodeSize)
    editor.view.dispatch(tr)
  }, [node.attrs, node.nodeSize, editor, deleteNode])

  return (
    <NodeViewWrapper className="my-2.5" data-drag-handle>
      <div
        className={`memo-card group ${selected ? 'ring-1 ring-indigo-300 ring-offset-1' : ''}`}
        style={{ '--memo-accent': accent.bar } as React.CSSProperties}
      >
        {/* Header */}
        <div className="flex items-center gap-1.5 px-3 py-2">
          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wider ${accent.labelColor}`}
            style={{ backgroundColor: `${accent.bar}0a` }}
          >
            {accent.label}
          </span>

          {/* Status badge with dropdown */}
          <div className="relative" ref={statusMenuRef}>
            <button
              onClick={() => setShowStatusMenu(!showStatusMenu)}
              className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium cursor-pointer hover:opacity-80 transition-opacity ${statusInfo.color} ${statusInfo.bg}`}
              title="Change status"
            >
              {statusInfo.label}
              <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 3l2 2 2-2z"/></svg>
            </button>
            {showStatusMenu && (
              <div className="absolute top-full left-0 mt-1 z-50 bg-white border border-stone-200 rounded-md shadow-lg py-0.5 min-w-[100px]">
                {(Object.keys(STATUS_LABELS) as MemoStatus[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => { updateAttributes({ status: s }); setShowStatusMenu(false) }}
                    className={`block w-full text-left px-3 py-1 text-[11px] hover:bg-stone-50 ${s === status ? 'font-bold' : ''} ${STATUS_LABELS[s].color}`}
                  >
                    {STATUS_LABELS[s].label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {node.attrs.anchorText && (
            <span
              className="text-[12px] text-stone-300 truncate max-w-[180px] italic"
              title={node.attrs.anchorText}
            >
              {node.attrs.anchorText.slice(0, 35)}{node.attrs.anchorText.length > 35 ? '...' : ''}
            </span>
          )}
          <div className="flex-1" />
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
            {!editing && (
              <button
                onClick={() => setEditing(true)}
                className="p-1 rounded text-stone-300 hover:text-stone-600 hover:bg-stone-50 transition-colors"
                title="Edit"
              >
                <svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8.5 1.5l2 2M1 8.5V11h2.5L10 4.5l-2-2L1 8.5z" />
                </svg>
              </button>
            )}
            <button
              onClick={handleDelete}
              className="p-1 rounded text-stone-300 hover:text-rose-400 hover:bg-rose-50 transition-colors"
              title="Delete"
            >
              <svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                <path d="M3.5 3.5l5 5M8.5 3.5l-5 5" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-3 pb-2.5">
          {editing ? (
            <div>
              <textarea
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleSave}
                placeholder="Write your feedback..."
                className="w-full text-[14px] leading-relaxed bg-transparent border-none resize-none focus:outline-none min-h-[36px] text-stone-700 placeholder-stone-300"
                rows={2}
              />
              <div className="text-right">
                <span className="text-[11px] text-stone-300">Enter to save · Esc to cancel</span>
              </div>
            </div>
          ) : (
            <p
              className="text-[14px] text-stone-600 leading-relaxed whitespace-pre-wrap cursor-pointer hover:text-stone-800 transition-colors"
              onClick={() => setEditing(true)}
            >
              {node.attrs.text}
            </p>
          )}
        </div>
      </div>
    </NodeViewWrapper>
  )
}

export default MemoBlock
