import * as vscode from 'vscode'
import { MdFeedbackPanelProvider } from './panel-provider'
import { createCheckpoint } from '../shared/checkpoint'
import { extractCheckpoints } from '../shared/markdown-roundtrip'

type DocumentState = {
  lastActivity: number
  hasChanges: boolean
}

type PanelEditVersionAccess = {
  editVersion: number
  lastWebviewEditVersion: number
}

export class SyncController implements vscode.Disposable {
  private switchToken = 0
  private debounceTimer: ReturnType<typeof setTimeout> | undefined
  private checkpointTimer: ReturnType<typeof setInterval> | undefined
  private webviewPollTimer: ReturnType<typeof setInterval> | undefined
  private webviewMessageDisposable: vscode.Disposable | undefined
  private currentDocumentUri: vscode.Uri | undefined
  private readonly disposables: vscode.Disposable[] = []
  private readonly docStates = new Map<string, DocumentState>()

  constructor(
    private readonly panelProvider: MdFeedbackPanelProvider,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.context.subscriptions.push(this)

    const activeEditorHandler = vscode.window.onDidChangeActiveTextEditor((editor) => {
      this.handleActiveEditorChange(editor)
    })
    this.disposables.push(activeEditorHandler)
    this.handleActiveEditorChange(vscode.window.activeTextEditor)

    const changeHandler = vscode.workspace.onDidChangeTextDocument((e) => {
      const currentUri = this.currentUri
      if (!currentUri) return
      if (e.document.uri.toString() !== currentUri.toString()) return

      this.markActivity(e.document.uri)

      const edits = this.panelProvider as unknown as PanelEditVersionAccess
      const isWebviewEdit = edits.lastWebviewEditVersion === edits.editVersion
      if (isWebviewEdit) return

      this.panelProvider.handleDocumentUpdate(e.document)
    })
    this.disposables.push(changeHandler)

    this.checkpointTimer = setInterval(() => {
      void this.handleTimerCheckpoint()
    }, 600_000)

    this.webviewPollTimer = setInterval(() => {
      this.attachWebviewListener()
    }, 500)
    this.attachWebviewListener()
  }

  get currentUri(): vscode.Uri | undefined {
    return this.currentDocumentUri
  }

  currentDocument(): vscode.TextDocument | undefined {
    const uri = this.currentDocumentUri ?? this.getActiveMarkdownDocument()?.uri
    if (!uri) return undefined
    const openDoc = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString())
    return openDoc ?? this.getActiveMarkdownDocument()
  }

  async createManualCheckpoint(): Promise<void> {
    const document = this.currentDocument() ?? this.getActiveMarkdownDocument()
    if (!document) {
      vscode.window.showWarningMessage('Open a markdown file to review.')
      return
    }

    const note = await vscode.window.showInputBox({
      prompt: 'Checkpoint note (optional)',
      placeHolder: 'e.g. Architecture section reviewed',
    })

    if (note === undefined) return

    const raw = document.getText()
    const { checkpoint, updatedMarkdown } = createCheckpoint(raw, note || '')
    const success = await this.applyCheckpointEdit(document, updatedMarkdown, 'Failed to create checkpoint.')
    if (!success) return

    this.clearChanges(document.uri)
    this.panelProvider.postMessage({
      type: 'checkpoint.created',
      checkpoint,
      checkpoints: extractCheckpoints(updatedMarkdown),
    })
    vscode.window.showInformationMessage(`Checkpoint created: ${checkpoint.note || checkpoint.id}`)
  }

  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.checkpointTimer) clearInterval(this.checkpointTimer)
    if (this.webviewPollTimer) clearInterval(this.webviewPollTimer)
    if (this.webviewMessageDisposable) this.webviewMessageDisposable.dispose()
    while (this.disposables.length) {
      const item = this.disposables.pop()
      if (item) item.dispose()
    }
    this.docStates.clear()
  }

  private handleActiveEditorChange(editor: vscode.TextEditor | undefined): void {
    const myToken = ++this.switchToken
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      if (this.switchToken !== myToken) return

      if (!editor || editor.document.languageId !== 'markdown') {
        this.currentDocumentUri = undefined
        this.panelProvider.postMessage({ type: 'document.empty' })
        return
      }

      this.currentDocumentUri = editor.document.uri
      this.ensureState(editor.document.uri)
      this.panelProvider.handleDocumentUpdate(editor.document)
    }, 150)
  }

  private attachWebviewListener(): void {
    if (this.webviewMessageDisposable) return
    const view = this.panelProvider.view
    if (!view) return

    this.webviewMessageDisposable = view.webview.onDidReceiveMessage((msg) => {
      if (!msg || typeof msg !== 'object') return
      const type = (msg as { type?: string }).type
      if (type !== 'annotation.first') return
      void this.handleFirstAnnotationCheckpoint()
    })
    this.disposables.push(this.webviewMessageDisposable)

    if (this.webviewPollTimer) {
      clearInterval(this.webviewPollTimer)
      this.webviewPollTimer = undefined
    }
  }

  private async handleFirstAnnotationCheckpoint(): Promise<void> {
    const document = this.currentDocument() ?? this.getActiveMarkdownDocument()
    if (!document) return
    await this.createAutoCheckpoint(document, 'first-annotation')
  }

  private async handleTimerCheckpoint(): Promise<void> {
    const document = this.currentDocument() ?? this.getActiveMarkdownDocument()
    if (!document) return

    const key = document.uri.toString()
    const state = this.docStates.get(key)
    if (!state || !state.hasChanges) return

    await this.createAutoCheckpoint(document, 'timer')
  }

  private async createAutoCheckpoint(
    document: vscode.TextDocument,
    reason: 'first-annotation' | 'timer',
  ): Promise<void> {
    const raw = document.getText()
    const { checkpoint, updatedMarkdown } = createCheckpoint(raw, 'auto')
    const success = await this.applyCheckpointEdit(document, updatedMarkdown, 'Failed to create auto checkpoint.')
    if (!success) return

    this.clearChanges(document.uri)
    this.panelProvider.postMessage({
      type: 'checkpoint.auto',
      reason,
      checkpoint,
      checkpoints: extractCheckpoints(updatedMarkdown),
    })
  }

  private async applyCheckpointEdit(
    document: vscode.TextDocument,
    updatedMarkdown: string,
    errorMessage: string,
  ): Promise<boolean> {
    const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === document.uri.toString())
    const selection = editor?.selection
    const visibleRange = editor?.visibleRanges[0]

    const edit = new vscode.WorkspaceEdit()
    edit.replace(
      document.uri,
      new vscode.Range(0, 0, document.lineCount, 0),
      updatedMarkdown,
    )

    try {
      const success = await vscode.workspace.applyEdit(edit)
      if (!success) {
        vscode.window.showErrorMessage(errorMessage)
        return false
      }
    } catch {
      vscode.window.showErrorMessage(errorMessage)
      return false
    }

    if (editor) {
      try {
        if (selection) editor.selection = selection
        if (visibleRange) {
          editor.revealRange(visibleRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
        }
      } catch {
        // best-effort restore
      }
    }

    return true
  }

  private ensureState(uri: vscode.Uri): DocumentState {
    const key = uri.toString()
    const existing = this.docStates.get(key)
    if (existing) return existing
    const state: DocumentState = { lastActivity: Date.now(), hasChanges: false }
    this.docStates.set(key, state)
    return state
  }

  private markActivity(uri: vscode.Uri): void {
    const state = this.ensureState(uri)
    state.lastActivity = Date.now()
    state.hasChanges = true
  }

  private clearChanges(uri: vscode.Uri): void {
    const state = this.ensureState(uri)
    state.lastActivity = Date.now()
    state.hasChanges = false
  }

  private getActiveMarkdownDocument(): vscode.TextDocument | undefined {
    const editor = vscode.window.activeTextEditor
    if (!editor) return undefined
    if (editor.document.languageId !== 'markdown') return undefined
    return editor.document
  }
}
