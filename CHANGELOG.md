# Changelog

## [0.6.0] — 2026-02-13

Official launch release.

### Fixed
- **Memo persistence**: Memos now correctly persist across VS Code restarts (fixed serialization regex in Editor)
- **Dark theme code blocks**: Code blocks no longer render as black boxes in dark theme (fixed CSS layer ordering)
- **Export quality**: Export output now matches README format examples (downstream of memo persistence fix)

### Added
- **Clipboard + prompt**: All exports now copy a ready-to-paste prompt to clipboard (save file + Ctrl+V to any AI chat)
- **README**: Full rewrite for marketplace polish — every feature documented accurately

## [0.5.1] - 2026-02-13

### Fixed
- **Memo save bug (P0)**: `onUpdate` path now includes fallback to append memos that tiptap-markdown silently drops — memos no longer disappear on save
- **Highlight text fragmentation (P0)**: `getHighlights()` now merges consecutive text nodes split by format boundaries — exports show full text instead of `"pacted/truncat"` fragments
- **Export quality (P0)**: Section matching uses `trim()`, truncation limit raised from 60→120 chars, empty exports show a warning instead of blank output
- **Dark theme black box (P1)**: Nuclear CSS override forces paper-white background on `html`, `body`, `.vscode-dark`, `.vscode-high-contrast`
- **Handoff highlight regex (P1)**: Now matches `<mark data-color="...">`, `<mark style="...">`, and `==text==` formats instead of only `style="background-color:..."`
- **BubbleMenu z-index (P1)**: `appendTo` option set to `.md-feedback-root` to prevent menu rendering outside webview container

### Changed
- MCP server version synced to 0.5.1
- QuickPick "Export All" description corrected from "8" to "9" context files

## [0.5.0] - 2026-02-13

### Fixed
- **Frontmatter preservation**: YAML frontmatter no longer stripped on save — preserved across annotation edits
- **Metadata preservation**: GATE, CHECKPOINT, and PLAN_CURSOR blocks no longer lost when editing annotations
- **Code block dark theme**: Fixed background color bleeding from VS Code dark theme into the review panel

### Changed
- Repository moved to `seonyeomin-rgb/md-feedback`

## [0.4.5] - 2026-02-13

### Fixed
- Memo cards (Fix/Question) now persist when reopening the panel or restarting VS Code
- Panel state preserved when hiding/showing sidebar (`retainContextWhenHidden`)

### Changed
- `sendDocumentToWebview` converts memo comments to TipTap-parseable HTML instead of stripping them

## [0.4.4] - 2026-02-13

### Added
- Screenshot in README showing Fix/Question annotations with memo cards

### Changed
- README restructured: Why section, Quick Start, collapsible details for Commands/Shortcuts/State Model

## [0.4.3] - 2026-02-13

### Changed
- README: added MCP workflow explanation — why MCP matters, before/after comparison, setup guide
- README: reordered MCP tools by usage frequency

## [0.4.2] - 2026-02-13

### Fixed
- MCP server: duplicate shebang causing `SyntaxError` on `node dist/mcp-server.js`
- MCP server: ESM→CJS build format for broader Node.js compatibility

### Changed
- Package: reduced .vsix from 446KB to 426KB by excluding dev-only files

## [0.4.0] - 2026-02-12

### Added
- **State Model**: MemoV2 with status/owner/source, 4-state workflow (open → answered → done → wontfix)
- **Gates**: Define merge/release/implement conditions, auto-evaluate against memo states
- **Plan Cursor**: Track current task/step/nextAction for agent-driven workflows
- **6 new MCP tools**: `update_memo_status`, `update_cursor`, `evaluate_gates`, `list_annotations`, `get_document_structure`, `export_review`
- **Status summary bar**: Live display of open fixes/questions and gate status
- **Status dropdown** in memo cards with persistence through serialization

## [0.3.0] - 2026-02-12

### Added
- **Sidebar Panel**: WebviewViewProvider-based review — no more "Open With...", review directly from the sidebar Activity Bar icon
- **Floating Bar**: 4-button toolbar — 🟡 Highlight, 🔴 Fix, 🔵 Question, 📤 Export — appears contextually on text selection
- **Auto-checkpoint**: Automatic checkpoint on first annotation + every 10 minutes per document
- **Onboarding Banner**: First-use guidance banner, auto-dismisses after first annotation
- **Document Parser**: Split/merge pipeline parser (`document-parser.ts`) — foundation for safe compaction (bodyMd/memos/checkpoints extraction)
- **Editor↔Panel Sync**: Automatic content sync when switching between markdown files, with 150ms debounce and staleness token for flicker prevention

### Changed
- **Architecture**: CustomTextEditorProvider → WebviewViewProvider (sidebar panel)
- **Export UX**: Multi-target Export Panel UI → single "Export" button (Generic export with file + clipboard)
- **Checkpoint UX**: Manual button → automatic background saves (manual still via Command Palette)
- **Theme**: Always paper/light style regardless of IDE dark mode — WCAG AA accessible color pins
- **Edit Sync**: `isUpdatingFromWebview` boolean → `editVersion` counter pattern (prevents race conditions)

### Removed
- "Open With..." based Custom Editor (`editor-provider.ts`)
- Export Panel component (`ExportPanel.tsx`)
- Manual Checkpoint button from toolbar (moved to Command Palette `md-feedback.checkpoint`)
- `md-feedback.openReview` command

## [0.2.0] - 2026-02-12

### Added
- **Session Checkpoints**: Save review progress with `<!-- CHECKPOINT -->` HTML comments in the file
  - Checkpoint button in toolbar (with count badge)
  - `MD Feedback: Create Checkpoint` command
  - Records annotation counts and reviewed sections at checkpoint time
- **Handoff Document Export**: Generate structured handoff documents for AI session continuity
  - Anti-compression format: explicit fields, numbers, lists only — survives context compaction
  - Sections: Decisions Made, Open Questions, Key Points, Progress Checkpoints, Next Steps
  - `MD Feedback: Export: Handoff Document` command
  - Available as 4th target in Export Panel
- **MCP Server**: 5 tools for direct AI agent integration
  - `create_checkpoint` — Create a checkpoint in an annotated file
  - `get_checkpoints` — List all checkpoints
  - `generate_handoff` — Generate structured handoff document
  - `get_review_status` — Get annotation counts and session status
  - `pickup_handoff` — Parse existing handoff for session resumption
- Shared logic layer (`shared/`) consumed by both VS Code extension and MCP server

### Changed
- Export Panel now shows 4 targets: Claude Code, Cursor, Generic, Handoff
- Build pipeline: `npm run build` now includes `build:mcp` step

## [0.1.0] - 2026-02-12

### Added
- Custom Editor for `.md` files ("Open With..." > "MD Feedback: Review")
- Three annotation types: Highlight (yellow), Fix (red strikethrough), Question (blue wavy underline)
- Keyboard shortcuts: `1` = Highlight, `2` = Fix, `3` = Question
- Memo cards for Fix and Question annotations with edit/delete
- Cascade delete (removing a highlight removes its memo, and vice versa)
- Export to 3 formats: Claude Code (CLAUDE.md), Cursor (.cursor/rules), Generic Markdown
- Export Panel with "Save Context" and "Paste to AI" tabs
- Clipboard copy via VS Code API (bypasses webview sandbox)
- File save dialog for export
- Annotations stored as `<!-- USER_MEMO -->` HTML comments (git-compatible, cross-tool)
- Markdown roundtrip: annotations persist across save/reopen
- VS Code theme support (light and dark mode via CSS variables)
- BubbleMenu for quick annotation on text selection
- Click-to-delete popover for removing individual highlights
- Buy Me a Coffee sponsor link
