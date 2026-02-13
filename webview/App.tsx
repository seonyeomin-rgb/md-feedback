import { useState, useRef, useCallback, useEffect } from 'react'
import Editor, { type EditorHandle } from './components/Editor'
import { vscode } from './lib/vscode-api'
import { MEMO_ACCENT, type HighlightColor, type Checkpoint, type PlanCursor } from '../shared/types'

export default function App() {
  const editorRef = useRef<EditorHandle>(null)
  const [docLoaded, setDocLoaded] = useState(false)
  const [filePath, setFilePath] = useState('')
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [onboardingDone, setOnboardingDone] = useState(true)
  const [hasSelection, setHasSelection] = useState(false)
  const [lastCheckpointTime, setLastCheckpointTime] = useState<string | null>(null)
  const [docEmpty, setDocEmpty] = useState(false)
  const [exportStatus, setExportStatus] = useState<string | null>(null)
  const [planCursor, setPlanCursor] = useState<PlanCursor | null>(null)
  const [statusSummary, setStatusSummary] = useState<{ openFixes: number; openQuestions: number; gateStatus: string | null } | null>(null)

  const isLoadingRef = useRef(false)
  const debounceRef = useRef<number | undefined>(undefined)
  const firstAnnotationSentRef = useRef(false)

  // Listen for messages from extension host
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data
      switch (msg.type) {
        case 'document.load':
          isLoadingRef.current = true
          if (editorRef.current) {
            editorRef.current.setMarkdown(msg.cleanContent || msg.content)
            setDocLoaded(true)
            setDocEmpty(false)
            setFilePath(msg.filePath || '')
          }
          setTimeout(() => { isLoadingRef.current = false }, 100)
          // Request checkpoints after load
          vscode.postMessage({ type: 'checkpoint.list' })
          break

        case 'document.empty':
          setDocLoaded(false)
          setDocEmpty(true)
          break

        case 'onboarding.state':
          setOnboardingDone(msg.done)
          break

        case 'export.result':
          setExportStatus('✅ Exported')
          setTimeout(() => setExportStatus(null), 3000)
          break

        case 'checkpoint.auto':
          setLastCheckpointTime(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
          break

        case 'checkpoint.created':
          setCheckpoints(msg.checkpoints || [])
          break

        case 'checkpoint.list':
          setCheckpoints(msg.checkpoints || [])
          break

        case 'checkpoint.request': {
          // Triggered by command palette — prompt for note
          const note = prompt('Checkpoint note:')
          if (note !== null) {
            vscode.postMessage({ type: 'checkpoint.create', note })
          }
          break
        }

        case 'export.request': {
          // Triggered by command palette or floating bar
          const target = msg.target as string
          if (!editorRef.current) break

          const highlights = editorRef.current.getHighlights()
          const docMemos = editorRef.current.getMemos()
          const sections = editorRef.current.getSections()
          const title = editorRef.current.getDocumentTitle()

          if (target === 'handoff') {
            vscode.postMessage({ type: 'handoff.generate', target: 'standalone' })
          } else if (target === 'generic') {
            vscode.postMessage({ type: 'export.generic', title, filePath, sections, highlights, docMemos })
          } else if (target === 'all') {
            vscode.postMessage({ type: 'export.all', title, filePath, sections, highlights, docMemos })
          } else {
            // claude-code, cursor, codex, copilot, cline, windsurf, roo-code, gemini
            vscode.postMessage({ type: 'export.context.generate', target, title, filePath, sections, highlights, docMemos })
          }
          setExportStatus('Exporting...')
          break
        }

        case 'export.saved': {
          setExportStatus(msg.message as string || 'Exported')
          setTimeout(() => setExportStatus(null), 4000)
          break
        }

        case 'handoff.result': {
          // Auto-save handoff result
          vscode.postMessage({
            type: 'export.context',
            content: msg.handoff as string,
            suggestedPath: 'HANDOFF.md',
          })
          setExportStatus('Handoff exported')
          setTimeout(() => setExportStatus(null), 4000)
          break
        }

        case 'cursor.update':
          setPlanCursor(msg.cursor as PlanCursor | null)
          break

        case 'status.summary':
          setStatusSummary(msg.summary as typeof statusSummary)
          break
      }
    }

    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  // Tell extension we're ready
  useEffect(() => {
    vscode.postMessage({ type: 'webview.ready' })
  }, [])

  // Called when editor content changes (annotations)
  const handleUpdate = useCallback((annotatedMarkdown: string) => {
    if (isLoadingRef.current) return
    clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      vscode.postMessage({
        type: 'document.edit',
        content: annotatedMarkdown,
      })

      // First annotation auto-dismiss logic
      if (!firstAnnotationSentRef.current) {
        const hasAnnotations = annotatedMarkdown.includes('<!-- USER_MEMO')
        if (hasAnnotations) {
          vscode.postMessage({ type: 'annotation.first' })
          firstAnnotationSentRef.current = true
        }
      }
    }, 300)
  }, [])

  const handleCopy = useCallback((text: string) => {
    vscode.postMessage({ type: 'clipboard.copy', text })
  }, [])

  const handleApplyAnnotation = (color: HighlightColor) => {
    editorRef.current?.applyAnnotation(color)
  }

  const handleExport = () => {
    if (!editorRef.current) return
    // Send to extension host which shows a quickPick with all export targets
    const highlights = editorRef.current.getHighlights()
    const docMemos = editorRef.current.getMemos()
    const sections = editorRef.current.getSections()
    const title = editorRef.current.getDocumentTitle()
    vscode.postMessage({
      type: 'export.pickTarget',
      title,
      filePath,
      sections,
      highlights,
      docMemos,
    })
  }

  const handleDismissOnboarding = () => {
    vscode.postMessage({ type: 'onboarding.dismiss' })
    setOnboardingDone(true)
  }

  return (
    <div className="md-feedback-root">
      <div className="content-area">
        {/* Onboarding Banner */}
        {docLoaded && !onboardingDone && (
          <div className="onboarding-banner">
            <div className="onboarding-content">
              <span className="onboarding-emoji">👋</span>
              <p>Select text and use the buttons below to review</p>
            </div>
            <button onClick={handleDismissOnboarding} className="onboarding-close">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M1 1l12 12M13 1L1 13" />
              </svg>
            </button>
          </div>
        )}

        {/* Editor */}
        <div className={docLoaded ? '' : 'hidden'}>
          <div className="paper-container">
            <div className="paper">
              <Editor
                ref={editorRef}
                onUpdate={handleUpdate}
                onSelectionChange={setHasSelection}
              />
            </div>
          </div>
        </div>

        {/* Placeholder */}
        {docEmpty && !docLoaded && (
          <div className="flex items-center justify-center min-h-screen">
            <p className="text-[16px] text-stone-400">Open a markdown file to start reviewing</p>
          </div>
        )}

        {/* Loading state */}
        {!docLoaded && !docEmpty && (
          <div className="flex items-center justify-center min-h-screen">
            <p className="text-[14px] opacity-60">Loading document...</p>
          </div>
        )}
      </div>

      {/* Status Summary + Cursor Bar */}
      {docLoaded && (statusSummary || planCursor) && (
        <div className="status-bar">
          {statusSummary && (
            <div className="status-items">
              {statusSummary.openFixes > 0 && (
                <span className="text-red-600 font-medium">{statusSummary.openFixes} Fix</span>
              )}
              {statusSummary.openQuestions > 0 && (
                <span className="text-blue-600 font-medium">{statusSummary.openQuestions} Question</span>
              )}
              {statusSummary.openFixes === 0 && statusSummary.openQuestions === 0 && (
                <span className="text-emerald-600 font-medium">All resolved</span>
              )}
              {statusSummary.gateStatus && (
                <span className={statusSummary.gateStatus === 'blocked' ? 'text-red-500' : statusSummary.gateStatus === 'done' ? 'text-emerald-500' : 'text-amber-500'}>
                  Gate: {statusSummary.gateStatus === 'blocked' ? 'BLOCKED' : statusSummary.gateStatus === 'done' ? 'CLEAR' : 'PROCEED'}
                </span>
              )}
            </div>
          )}
          {planCursor && (
            <div className="cursor-info">
              <span className="text-stone-500">Task {planCursor.taskId}</span>
              <span className="text-stone-400">Step {planCursor.step}</span>
              <span className="text-stone-600 truncate max-w-[200px]">{planCursor.nextAction}</span>
            </div>
          )}
        </div>
      )}

      {/* Floating Bar */}
      {docLoaded && (
        <div className="floating-bar">
          {/* Annotation Buttons */}
          {(['yellow', 'red', 'blue'] as HighlightColor[]).map((color) => (
            <button
              key={color}
              onClick={() => handleApplyAnnotation(color)}
              disabled={!hasSelection}
              className={`floating-btn ${!hasSelection ? 'opacity-50 pointer-events-none' : ''}`}
              style={{ color: MEMO_ACCENT[color].labelColor }}
            >
              <span className="text-lg">{MEMO_ACCENT[color].emoji}</span>
              <span className="text-xs font-medium">{MEMO_ACCENT[color].label}</span>
            </button>
          ))}

          <div className="w-px h-6 bg-stone-200 mx-2" />

          {/* Export Button */}
          <button onClick={handleExport} className="floating-btn">
            <span className="text-lg">📤</span>
            <span className="text-xs font-medium">Export</span>
          </button>

          {/* Status Text */}
          <div className="ml-auto text-[11px] text-stone-400 flex items-center gap-2">
            {exportStatus && <span className="text-emerald-600 font-medium">{exportStatus}</span>}
            {lastCheckpointTime && <span>💾 Auto-saved {lastCheckpointTime}</span>}
          </div>
        </div>
      )}

      {/* Buy Me a Coffee — small corner link */}
      <div className="bmc-corner">
        <a
          href="https://buymeacoffee.com/ymnseon8"
          target="_blank"
          rel="noopener noreferrer"
          className="bmc-link"
        >
          Buy me a coffee
        </a>
      </div>
    </div>
  )
}
