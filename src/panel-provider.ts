import * as vscode from 'vscode'
import { convertMemosToHtml, normalizeHighlights, extractCheckpoints } from '../shared/markdown-roundtrip'
import { createCheckpoint } from '../shared/checkpoint'
import { buildHandoffDocument, formatHandoffMarkdown } from '../shared/handoff-generator'
import { generateContext, TARGET_LABELS, type TargetFormat } from '../shared/context-generator'
import { splitDocument, serializeGate, serializeCheckpoint, serializeCursor } from '../shared/document-writer'
import { evaluateAllGates } from '../shared/gate-evaluator'
import type { ReviewHighlight, ReviewMemo, Gate, Checkpoint, PlanCursor } from '../shared/types'

export class MdFeedbackPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'md-feedback.panel'
  public static activePanel: MdFeedbackPanelProvider | null = null

  private _view: vscode.WebviewView | undefined
  private currentDocument: vscode.TextDocument | undefined
  private editVersion = 0
  private lastWebviewEditVersion = 0
  private preservedFrontmatter = ''
  private preservedGates: Gate[] = []
  private preservedCheckpoints: Checkpoint[] = []
  private preservedCursor: PlanCursor | null = null

  constructor(private readonly context: vscode.ExtensionContext) {}

  private wrapWithPrompt(content: string, documentUri: vscode.Uri): string {
    const relativePath = vscode.workspace.asRelativePath(documentUri)
    return `I reviewed ${relativePath} and annotated it with MD Feedback. Here are the changes and questions. Implement the fixes and answer the questions:\n\n${content}`
  }

  get view(): vscode.WebviewView | undefined {
    return this._view
  }

  public postMessage(msg: Record<string, unknown>): void {
    if (!this._view) return
    const documentUri = this.currentDocument?.uri.toString() ?? ''
    void this._view.webview.postMessage({ ...msg, documentUri })
  }

  public handleDocumentUpdate(document: vscode.TextDocument): void {
    this.currentDocument = document
    if (!this._view) return
    this.sendDocumentToWebview(document)
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    if (this._view !== webviewView) {
      this._view = webviewView
    }

    MdFeedbackPanelProvider.activePanel = this

    const distUri = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [distUri],
    }

    ;(webviewView as vscode.WebviewView & { retainContextWhenHidden?: boolean }).retainContextWhenHidden = true
    webviewView.webview.html = this.getHtml(webviewView.webview)

    const disposables: vscode.Disposable[] = []

    const messageHandler = webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'webview.ready': {
          const document = this.getActiveMarkdownDocument()
          if (document) {
            this.currentDocument = document
            this.sendDocumentToWebview(document)
            const onboardingDone = this.context.globalState.get('md-feedback.onboardingDone', false)
            this.postMessage({ type: 'onboarding.state', done: onboardingDone })
          } else {
            vscode.window.showWarningMessage('Open a markdown file to review.')
          }
          break
        }

        case 'document.edit': {
          const document = this.currentDocument ?? this.getActiveMarkdownDocument()
          if (!document) {
            vscode.window.showWarningMessage('Open a markdown file to review.')
            break
          }
          this.currentDocument = document

          const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === document.uri.toString())
          const selection = editor?.selection
          const visibleRange = editor?.visibleRanges[0]

          this.editVersion += 1
          const myVersion = this.editVersion
          this.lastWebviewEditVersion = myVersion

          // Restore preserved metadata around webview content
          let fullContent = msg.content || ''

          // Frontmatter restoration
          if (this.preservedFrontmatter) {
            fullContent = this.preservedFrontmatter.trimEnd() + '\n\n' + fullContent
          }

          // Gates, Checkpoints, Cursor restoration (append at end)
          const metadataSections: string[] = []
          for (const gate of this.preservedGates) {
            metadataSections.push(serializeGate(gate))
          }
          for (const cp of this.preservedCheckpoints) {
            metadataSections.push(serializeCheckpoint(cp))
          }
          if (this.preservedCursor) {
            metadataSections.push(serializeCursor(this.preservedCursor))
          }
          if (metadataSections.length > 0) {
            fullContent = fullContent.trimEnd() + '\n\n' + metadataSections.join('\n\n') + '\n'
          }

          const edit = new vscode.WorkspaceEdit()
          edit.replace(
            document.uri,
            new vscode.Range(0, 0, document.lineCount, 0),
            fullContent,
          )

          try {
            const success = await vscode.workspace.applyEdit(edit)
            if (!success) {
              vscode.window.showErrorMessage('Failed to apply edits from MD Feedback.')
            }
          } catch (error) {
            vscode.window.showErrorMessage('Failed to apply edits from MD Feedback.')
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
          break
        }

        case 'clipboard.copy': {
          await vscode.env.clipboard.writeText(msg.text || '')
          vscode.window.showInformationMessage('Copied to clipboard!')
          break
        }

        case 'checkpoint.create': {
          const document = this.currentDocument ?? this.getActiveMarkdownDocument()
          if (!document) {
            vscode.window.showWarningMessage('Open a markdown file to review.')
            break
          }
          this.currentDocument = document

          const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === document.uri.toString())
          const selection = editor?.selection
          const visibleRange = editor?.visibleRanges[0]

          const raw = document.getText()
          const { checkpoint, updatedMarkdown } = createCheckpoint(raw, msg.note || '')

          this.editVersion += 1
          const myVersion = this.editVersion
          this.lastWebviewEditVersion = myVersion

          const cpEdit = new vscode.WorkspaceEdit()
          cpEdit.replace(
            document.uri,
            new vscode.Range(0, 0, document.lineCount, 0),
            updatedMarkdown,
          )

          try {
            const success = await vscode.workspace.applyEdit(cpEdit)
            if (!success) {
              vscode.window.showErrorMessage('Failed to create checkpoint.')
              break
            }
          } catch (error) {
            vscode.window.showErrorMessage('Failed to create checkpoint.')
            break
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

          this.postMessage({
            type: 'checkpoint.created',
            checkpoint,
            checkpoints: extractCheckpoints(updatedMarkdown),
          })
          vscode.window.showInformationMessage(`Checkpoint created: ${checkpoint.note || checkpoint.id}`)
          break
        }

        case 'checkpoint.list': {
          const document = this.currentDocument ?? this.getActiveMarkdownDocument()
          if (!document) break
          const checkpoints = extractCheckpoints(document.getText())
          this.postMessage({ type: 'checkpoint.list', checkpoints })
          break
        }

        case 'handoff.generate': {
          const document = this.currentDocument ?? this.getActiveMarkdownDocument()
          if (!document) {
            vscode.window.showWarningMessage('Open a markdown file to review.')
            break
          }
          const raw = document.getText()
          const fp = vscode.workspace.asRelativePath(document.uri)
          const doc = buildHandoffDocument(raw, fp)
          const target = msg.target || 'standalone'
          const handoff = formatHandoffMarkdown(doc, target)
          this.postMessage({ type: 'handoff.result', handoff })
          break
        }

        case 'export.generic': {
          await this.handleGenericExport(msg)
          break
        }

        case 'export.context.generate': {
          const document2 = this.currentDocument ?? this.getActiveMarkdownDocument()
          if (!document2) {
            vscode.window.showWarningMessage('Open a markdown file to review.')
            break
          }
          const target2 = msg.target as TargetFormat
          const title2 = typeof msg.title === 'string' ? msg.title : ''
          const filePath2 = typeof msg.filePath === 'string' ? msg.filePath : vscode.workspace.asRelativePath(document2.uri)
          const sections2 = Array.isArray(msg.sections) ? msg.sections.filter((s: unknown) => typeof s === 'string') : []
          const highlights2 = Array.isArray(msg.highlights) ? msg.highlights as ReviewHighlight[] : []
          const docMemos2 = Array.isArray(msg.docMemos) ? msg.docMemos as ReviewMemo[] : []

          const content2 = generateContext(title2, filePath2, sections2, highlights2, docMemos2, target2)
          await this.autoSaveExport(document2, target2, content2)
          break
        }

        case 'export.all': {
          const document3 = this.currentDocument ?? this.getActiveMarkdownDocument()
          if (!document3) {
            vscode.window.showWarningMessage('Open a markdown file to review.')
            break
          }
          const title3 = typeof msg.title === 'string' ? msg.title : ''
          const filePath3 = typeof msg.filePath === 'string' ? msg.filePath : vscode.workspace.asRelativePath(document3.uri)
          const sections3 = Array.isArray(msg.sections) ? msg.sections.filter((s: unknown) => typeof s === 'string') : []
          const highlights3 = Array.isArray(msg.highlights) ? msg.highlights as ReviewHighlight[] : []
          const docMemos3 = Array.isArray(msg.docMemos) ? msg.docMemos as ReviewMemo[] : []

          const allTargets: TargetFormat[] = ['claude-code', 'cursor', 'codex', 'copilot', 'cline', 'windsurf', 'roo-code', 'gemini', 'antigravity']
          const saved: string[] = []

          for (const t of allTargets) {
            const content3 = generateContext(title3, filePath3, sections3, highlights3, docMemos3, t)
            const ok = await this.autoSaveExport(document3, t, content3, true)
            if (ok) saved.push(TARGET_LABELS[t].file)
          }

          if (saved.length > 0) {
            const message = `Exported ${saved.length} files: ${saved.join(', ')}`
            vscode.window.showInformationMessage(message)
            this.postMessage({ type: 'export.saved', message })
          }
          break
        }

        case 'export.context': {
          const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(msg.suggestedPath || 'review-context.md'),
            filters: { 'Markdown': ['md', 'mdc'] },
          })
          if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.content || '', 'utf-8'))
            const savedName = vscode.workspace.asRelativePath(uri)
            vscode.window.showInformationMessage(`Saved to ${savedName}`)
            this.postMessage({ type: 'export.saved', message: `Saved: ${savedName}` })
          }
          break
        }

        case 'export.pickTarget': {
          const document4 = this.currentDocument ?? this.getActiveMarkdownDocument()
          if (!document4) {
            vscode.window.showWarningMessage('Open a markdown file to review.')
            break
          }

          // Capture editor data sent from webview
          const pickTitle = typeof msg.title === 'string' ? msg.title : ''
          const pickFilePath = typeof msg.filePath === 'string' ? msg.filePath : vscode.workspace.asRelativePath(document4.uri)
          const pickSections = Array.isArray(msg.sections) ? msg.sections.filter((s: unknown) => typeof s === 'string') : []
          const pickHighlights = Array.isArray(msg.highlights) ? msg.highlights as ReviewHighlight[] : []
          const pickMemos = Array.isArray(msg.docMemos) ? msg.docMemos as ReviewMemo[] : []

          type PickItem = vscode.QuickPickItem & { target?: string }
          const pickItems: PickItem[] = [
            { label: '$(checklist) Export All Tools', description: 'Write all 9 context files at once', target: 'all' },
            { label: '', kind: vscode.QuickPickItemKind.Separator },
            { label: 'Claude Code', description: 'CLAUDE.md', target: 'claude-code' },
            { label: 'Cursor', description: '.cursor/rules/plan-review.mdc', target: 'cursor' },
            { label: 'Codex', description: 'AGENTS.md', target: 'codex' },
            { label: 'GitHub Copilot', description: '.github/copilot-instructions.md', target: 'copilot' },
            { label: 'Cline', description: '.clinerules', target: 'cline' },
            { label: 'Windsurf', description: '.windsurfrules', target: 'windsurf' },
            { label: 'Roo Code', description: '.roo/rules/plan-review.md', target: 'roo-code' },
            { label: 'Gemini', description: '.gemini/styleguide.md', target: 'gemini' },
            { label: 'Antigravity', description: '.agent/rules/plan-review.md', target: 'antigravity' },
            { label: '', kind: vscode.QuickPickItemKind.Separator },
            { label: 'Generic Markdown', description: 'Clipboard + file (for any tool)', target: 'generic' },
            { label: 'Handoff Document', description: 'HANDOFF.md', target: 'handoff' },
          ]

          const picked = await vscode.window.showQuickPick(pickItems, {
            placeHolder: 'Select export target (or Export All)',
            title: 'MD Feedback — Export',
          })

          if (!picked?.target) break

          if (picked.target === 'all') {
            const allTargets: TargetFormat[] = ['claude-code', 'cursor', 'codex', 'copilot', 'cline', 'windsurf', 'roo-code', 'gemini', 'antigravity']
            const saved: string[] = []
            for (const t of allTargets) {
              const c = generateContext(pickTitle, pickFilePath, pickSections, pickHighlights, pickMemos, t)
              const ok = await this.autoSaveExport(document4, t, c, true)
              if (ok) saved.push(TARGET_LABELS[t].file)
            }
            if (saved.length > 0) {
              const message = `Exported ${saved.length} files: ${saved.join(', ')}`
              vscode.window.showInformationMessage(message)
              this.postMessage({ type: 'export.saved', message })
            }
          } else if (picked.target === 'generic') {
            const c = generateContext(pickTitle, pickFilePath, pickSections, pickHighlights, pickMemos, 'generic')
            await this.handleGenericExport({ title: pickTitle, filePath: pickFilePath, sections: pickSections, highlights: pickHighlights, docMemos: pickMemos, content: c })
          } else if (picked.target === 'handoff') {
            const raw = document4.getText()
            const fp = vscode.workspace.asRelativePath(document4.uri)
            const doc = buildHandoffDocument(raw, fp)
            const handoff = formatHandoffMarkdown(doc, 'standalone')
            const uri = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.file('HANDOFF.md'),
              filters: { 'Markdown': ['md'] },
            })
            if (uri) {
              await vscode.workspace.fs.writeFile(uri, Buffer.from(handoff, 'utf-8'))
              const savedName = vscode.workspace.asRelativePath(uri)
              try {
                const wrapped = this.wrapWithPrompt(handoff, document4.uri)
                await vscode.env.clipboard.writeText(wrapped)
                vscode.window.showInformationMessage(`Saved to ${savedName} + copied to clipboard`)
                this.postMessage({ type: 'export.saved', message: `Saved: ${savedName} + copied to clipboard` })
              } catch {
                vscode.window.showInformationMessage(`Saved to ${savedName}`)
                this.postMessage({ type: 'export.saved', message: `Saved: ${savedName}` })
              }
            }
          } else {
            const t = picked.target as TargetFormat
            const c = generateContext(pickTitle, pickFilePath, pickSections, pickHighlights, pickMemos, t)
            await this.autoSaveExport(document4, t, c)
          }
          break
        }

        case 'onboarding.dismiss': {
          await this.context.globalState.update('md-feedback.onboardingDone', true)
          break
        }

        case 'annotation.first': {
          const done = this.context.globalState.get('md-feedback.onboardingDone', false)
          if (!done) {
            await this.context.globalState.update('md-feedback.onboardingDone', true)
            this.postMessage({ type: 'onboarding.state', done: true })
          }
          break
        }
      }
    })
    disposables.push(messageHandler)

    const changeHandler = vscode.workspace.onDidChangeTextDocument((e) => {
      const document = this.currentDocument
      if (!document) return
      if (e.document.uri.toString() !== document.uri.toString()) return
      if (this.lastWebviewEditVersion === this.editVersion) {
        this.lastWebviewEditVersion = 0
        return
      }
      this.sendDocumentToWebview(document)
    })
    disposables.push(changeHandler)

    const disposeHandler = webviewView.onDidDispose(() => {
      if (MdFeedbackPanelProvider.activePanel === this) {
        MdFeedbackPanelProvider.activePanel = null
      }
      while (disposables.length) {
        const item = disposables.pop()
        if (item) item.dispose()
      }
    })
    disposables.push(disposeHandler)
  }

  private sendDocumentToWebview(document: vscode.TextDocument): void {
    const raw = document.getText()

    try {
      const parts = splitDocument(raw)

      // Preserve metadata for restoration on save
      this.preservedFrontmatter = parts.frontmatter
      this.preservedGates = parts.gates
      this.preservedCheckpoints = parts.checkpoints
      this.preservedCursor = parts.cursor

      // Strip frontmatter before processing (keep memos for convertMemosToHtml)
      let processed = raw
      if (parts.frontmatter) {
        processed = raw.slice(parts.frontmatter.length)
      }

      const normalized = normalizeHighlights(processed)
      const withMemoHtml = convertMemosToHtml(normalized)

      this.postMessage({
        type: 'document.load',
        content: raw,
        cleanContent: withMemoHtml,
        filePath: vscode.workspace.asRelativePath(document.uri),
      })

      // Send v0.4.0 status info (cursor + summary)
      this.sendStatusInfo(raw)
    } catch (error) {
      // Fallback: send raw content without processing
      this.postMessage({
        type: 'document.load',
        content: raw,
        cleanContent: raw,
        filePath: vscode.workspace.asRelativePath(document.uri),
      })
    }
  }

  /** Extract and send cursor + status summary to webview */
  private sendStatusInfo(raw: string): void {
    try {
      const parts = splitDocument(raw)
      const gates = evaluateAllGates(parts.gates, parts.memos)

      // Send cursor
      this.postMessage({ type: 'cursor.update', cursor: parts.cursor })

      // Send status summary
      const openFixes = parts.memos.filter(m => m.type === 'fix' && m.status === 'open').length
      const openQuestions = parts.memos.filter(m => m.type === 'question' && m.status === 'open').length
      const blockedGate = gates.find(g => g.status === 'blocked')
      const allGatesDone = gates.length > 0 && gates.every(g => g.status === 'done')

      const gateStatus = gates.length === 0 ? null
        : blockedGate ? 'blocked'
        : allGatesDone ? 'done'
        : 'proceed'

      if (parts.memos.length > 0 || gates.length > 0) {
        this.postMessage({
          type: 'status.summary',
          summary: { openFixes, openQuestions, gateStatus },
        })
      }
    } catch {
      // best-effort — don't break document loading
    }
  }

  private getActiveMarkdownDocument(): vscode.TextDocument | undefined {
    const editor = vscode.window.activeTextEditor
    if (!editor) return undefined
    if (editor.document.languageId !== 'markdown') return undefined
    return editor.document
  }

  private async autoSaveExport(document: vscode.TextDocument, target: TargetFormat, content: string, silent = false): Promise<boolean> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)
    const targetFile = TARGET_LABELS[target]?.file

    if (workspaceFolder && targetFile && targetFile !== '(clipboard + file)') {
      try {
        const uri = vscode.Uri.joinPath(workspaceFolder.uri, targetFile)
        // Ensure parent directories exist (for .cursor/rules/, .github/, .roo/rules/, .gemini/)
        const parentDir = vscode.Uri.joinPath(uri, '..')
        try { await vscode.workspace.fs.createDirectory(parentDir) } catch { /* exists */ }

        // Check if file already exists — protect user content
        let fileExists = false
        try {
          await vscode.workspace.fs.stat(uri)
          fileExists = true
        } catch { /* not found */ }

        if (fileExists && !silent) {
          const choice = await vscode.window.showWarningMessage(
            `${targetFile} already exists. How to proceed?`,
            'Overwrite', 'Append', 'Cancel',
          )
          if (choice === 'Cancel' || !choice) return false
          if (choice === 'Append') {
            const existing = await vscode.workspace.fs.readFile(uri)
            content = Buffer.from(existing).toString('utf-8') + '\n\n---\n\n' + content
          }
        }

        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'))
        if (!silent) {
          try {
            const wrapped = this.wrapWithPrompt(content, document.uri)
            await vscode.env.clipboard.writeText(wrapped)
            vscode.window.showInformationMessage(`Saved: ${targetFile} + copied to clipboard`)
            this.postMessage({ type: 'export.saved', message: `Saved: ${targetFile} + copied to clipboard` })
          } catch {
            vscode.window.showInformationMessage(`Saved: ${targetFile}`)
            this.postMessage({ type: 'export.saved', message: `Saved: ${targetFile}` })
          }
        }
        return true
      } catch (error) {
        if (!silent) {
          vscode.window.showErrorMessage(`Failed to save ${targetFile}: ${error instanceof Error ? error.message : String(error)}`)
        }
        return false
      }
    }

    // Fallback: save dialog
    if (!silent) {
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(targetFile || 'review-context.md'),
        filters: { 'Markdown': ['md', 'mdc'] },
      })
      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'))
        const savedName = vscode.workspace.asRelativePath(uri)
        try {
          const wrapped = this.wrapWithPrompt(content, document.uri)
          await vscode.env.clipboard.writeText(wrapped)
          vscode.window.showInformationMessage(`Saved to ${savedName} + copied to clipboard`)
          this.postMessage({ type: 'export.saved', message: `Saved: ${savedName} + copied to clipboard` })
        } catch {
          vscode.window.showInformationMessage(`Saved to ${savedName}`)
          this.postMessage({ type: 'export.saved', message: `Saved: ${savedName}` })
        }
        return true
      }
    }
    return false
  }

  private async handleGenericExport(msg: Record<string, unknown>): Promise<void> {
    const document = this.currentDocument ?? this.getActiveMarkdownDocument()
    if (!document) {
      vscode.window.showWarningMessage('Open a markdown file to review.')
      return
    }

    const title = typeof msg.title === 'string' ? msg.title : ''
    const filePath = typeof msg.filePath === 'string' ? msg.filePath : vscode.workspace.asRelativePath(document.uri)
    const sections = Array.isArray(msg.sections) ? msg.sections.filter(s => typeof s === 'string') : []
    const highlights = Array.isArray(msg.highlights) ? msg.highlights as ReviewHighlight[] : []
    const docMemos = Array.isArray(msg.docMemos) ? msg.docMemos as ReviewMemo[] : []

    const content = typeof msg.content === 'string'
      ? msg.content
      : generateContext(title, filePath, sections, highlights, docMemos, 'generic' as TargetFormat)

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const filename = `generic-review-${timestamp}.md`
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)
    let fileSaved = false
    let clipboardSaved = false
    let lastError: unknown

    if (workspaceFolder) {
      try {
        const uri = vscode.Uri.joinPath(workspaceFolder.uri, filename)
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'))
        fileSaved = true
      } catch (error) {
        lastError = error
      }
    }

    try {
      const wrapped = this.wrapWithPrompt(content, document.uri)
      await vscode.env.clipboard.writeText(wrapped)
      clipboardSaved = true
    } catch (error) {
      lastError = error
    }

    if (workspaceFolder && fileSaved && clipboardSaved) {
      const message = `${filename} saved + clipboard copied`
      vscode.window.showInformationMessage(message)
      this.postMessage({ type: 'export.saved', message })
      return
    }

    if (workspaceFolder && fileSaved && !clipboardSaved) {
      const message = `${filename} saved (clipboard copy failed)`
      vscode.window.showInformationMessage(message)
      this.postMessage({ type: 'export.saved', message })
      return
    }

    if (!workspaceFolder && clipboardSaved) {
      const message = 'Clipboard copied (no workspace for file save)'
      vscode.window.showInformationMessage(message)
      this.postMessage({ type: 'export.saved', message })
      return
    }

    const errMsg = lastError instanceof Error ? lastError.message : String(lastError || 'Unknown error')
    vscode.window.showErrorMessage(`Export failed: ${errMsg}`)
  }

  private getHtml(webview: vscode.Webview): string {
    const distUri = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'main.js'))
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'style.css'))
    const nonce = getNonce()

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <title>MD Feedback</title>
</head>
<body style="background:#fafaf9!important;color:#1a1a1a!important;margin:0;padding:0">
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let nonce = ''
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return nonce
}
