import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { readMarkdownFile, writeMarkdownFile } from './file-ops.js'
import { createCheckpoint, extractCheckpoints, getAnnotationCounts, getSectionsWithAnnotations, getAllSections } from '../shared/checkpoint.js'
import { buildHandoffDocument, formatHandoffMarkdown, parseHandoffFile } from '../shared/handoff-generator.js'
import { extractMemos } from '../shared/markdown-roundtrip.js'
import { splitDocument, mergeDocument, serializeMemoV2, serializeCursor, generateBodyHash } from '../shared/document-writer.js'
import { evaluateAllGates } from '../shared/gate-evaluator.js'
import type { MemoStatus, ReviewDocument } from '../shared/types.js'

export function registerTools(server: McpServer): void {

  // ─── create_checkpoint ───
  server.tool(
    'create_checkpoint',
    'Create a review checkpoint in an annotated markdown file. Records current annotation counts and reviewed sections.',
    {
      file: z.string().describe('Path to the annotated markdown file'),
      note: z.string().describe('Checkpoint note (e.g., "Phase 1 review done")'),
    },
    async ({ file, note }) => {
      try {
        const markdown = readMarkdownFile(file)
        const { checkpoint, updatedMarkdown } = createCheckpoint(markdown, note)
        writeMarkdownFile(file, updatedMarkdown)
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ checkpoint }, null, 2),
          }],
        }
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          }],
          isError: true,
        }
      }
    },
  )

  // ─── get_checkpoints ───
  server.tool(
    'get_checkpoints',
    'List all checkpoints in an annotated markdown file.',
    {
      file: z.string().describe('Path to the annotated markdown file'),
    },
    async ({ file }) => {
      try {
        const markdown = readMarkdownFile(file)
        const checkpoints = extractCheckpoints(markdown)
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ checkpoints }, null, 2),
          }],
        }
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          }],
          isError: true,
        }
      }
    },
  )

  // ─── generate_handoff ───
  server.tool(
    'generate_handoff',
    'Generate a structured handoff document from an annotated markdown file. Anti-compression format: explicit fields, numbers, lists only.',
    {
      file: z.string().describe('Path to the annotated markdown file'),
      target: z.enum(['standalone', 'claude-md', 'cursor-rules']).optional()
        .describe('Output format target (default: standalone)'),
    },
    async ({ file, target }) => {
      try {
        const markdown = readMarkdownFile(file)
        const doc = buildHandoffDocument(markdown, file)
        const handoff = formatHandoffMarkdown(doc, target || 'standalone')
        return {
          content: [{
            type: 'text' as const,
            text: handoff,
          }],
        }
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          }],
          isError: true,
        }
      }
    },
  )

  // ─── get_review_status ───
  server.tool(
    'get_review_status',
    'Get current review session status: annotation counts, checkpoints, and reviewed sections.',
    {
      file: z.string().describe('Path to the annotated markdown file'),
    },
    async ({ file }) => {
      try {
        const markdown = readMarkdownFile(file)
        const counts = getAnnotationCounts(markdown)
        const checkpoints = extractCheckpoints(markdown)
        const sections = getSectionsWithAnnotations(markdown)
        const status = {
          file,
          annotations: counts,
          checkpointCount: checkpoints.length,
          lastCheckpoint: checkpoints.length > 0 ? checkpoints[checkpoints.length - 1].timestamp : null,
          sectionsReviewed: sections,
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(status, null, 2),
          }],
        }
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          }],
          isError: true,
        }
      }
    },
  )

  // ─── pickup_handoff ───
  server.tool(
    'pickup_handoff',
    'Parse an existing handoff document to resume a review session. Returns structured data for session continuity.',
    {
      file: z.string().describe('Path to the handoff markdown file'),
    },
    async ({ file }) => {
      try {
        const markdown = readMarkdownFile(file)
        const doc = parseHandoffFile(markdown)
        if (!doc) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'Not a valid handoff document' }),
            }],
          }
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(doc, null, 2),
          }],
        }
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          }],
          isError: true,
        }
      }
    },
  )

  // ─── list_annotations ───
  server.tool(
    'list_annotations',
    'List all annotations (USER_MEMO comments) in a markdown file. Returns structured array with id, type, status, owner, text, and color.',
    {
      file: z.string().describe('Path to the annotated markdown file'),
    },
    async ({ file }) => {
      try {
        const markdown = readMarkdownFile(file)
        const parts = splitDocument(markdown)
        const annotations = parts.memos.map(m => ({
          id: m.id,
          type: m.type,
          status: m.status,
          owner: m.owner,
          source: m.source,
          color: m.color,
          text: m.text,
          anchorText: m.anchorText,
          anchor: m.anchor,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
        }))
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ annotations, total: annotations.length }, null, 2),
          }],
        }
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          }],
          isError: true,
        }
      }
    },
  )

  // ─── get_document_structure (v0.4.0 — full ReviewDocument) ───
  server.tool(
    'get_document_structure',
    'Parse an annotated markdown file and return the full v0.4.0 ReviewDocument: { bodyMd, memos[] (with status/owner), checkpoints[], gates[], cursor, sections, summary }. Ideal for AI agents.',
    {
      file: z.string().describe('Path to the annotated markdown file'),
    },
    async ({ file }) => {
      try {
        const markdown = readMarkdownFile(file)
        const parts = splitDocument(markdown)
        const allSections = getAllSections(markdown)
        const reviewedSections = getSectionsWithAnnotations(markdown)

        // Evaluate gates with current memo states
        const gates = evaluateAllGates(parts.gates, parts.memos)

        const open = parts.memos.filter(m => m.status === 'open').length
        const done = parts.memos.filter(m => m.status === 'done' || m.status === 'answered' || m.status === 'wontfix').length
        const blocked = gates.filter(g => g.status === 'blocked').length

        const structure: ReviewDocument = {
          version: '0.4.0',
          file,
          bodyMd: parts.body,
          memos: parts.memos,
          checkpoints: parts.checkpoints,
          gates,
          cursor: parts.cursor,
          sections: {
            all: allSections,
            reviewed: reviewedSections,
            uncovered: allSections.filter(s => !reviewedSections.includes(s)),
          },
          summary: {
            total: parts.memos.length,
            open,
            done,
            blocked,
            fixes: parts.memos.filter(m => m.type === 'fix').length,
            questions: parts.memos.filter(m => m.type === 'question').length,
            highlights: parts.memos.filter(m => m.type === 'highlight').length,
          },
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(structure, null, 2),
          }],
        }
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          }],
          isError: true,
        }
      }
    },
  )

  // ─── update_memo_status (v0.4.0 NEW) ───
  server.tool(
    'update_memo_status',
    'Update the status of a memo annotation. Writes the change back to the markdown file. Returns the updated memo.',
    {
      file: z.string().describe('Path to the annotated markdown file'),
      memoId: z.string().describe('The memo ID to update'),
      status: z.enum(['open', 'answered', 'done', 'wontfix']).describe('New status'),
      owner: z.enum(['human', 'agent', 'tool']).optional().describe('Optionally change the owner'),
    },
    async ({ file, memoId, status, owner }) => {
      try {
        const markdown = readMarkdownFile(file)
        const parts = splitDocument(markdown)

        const memo = parts.memos.find(m => m.id === memoId)
        if (!memo) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: `Memo not found: ${memoId}` }),
            }],
            isError: true,
          }
        }

        memo.status = status as MemoStatus
        if (owner) memo.owner = owner as typeof memo.owner
        memo.updatedAt = new Date().toISOString()

        // Re-evaluate gates after status change
        parts.gates = evaluateAllGates(parts.gates, parts.memos)

        const updated = mergeDocument(parts)
        writeMarkdownFile(file, updated)

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ memo, gatesUpdated: parts.gates.length }, null, 2),
          }],
        }
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          }],
          isError: true,
        }
      }
    },
  )

  // ─── update_cursor (v0.4.0 NEW) ───
  server.tool(
    'update_cursor',
    'Update the plan cursor position in a markdown file. The cursor tracks "where we are" in a plan. Only one cursor per document.',
    {
      file: z.string().describe('Path to the annotated markdown file'),
      taskId: z.string().describe('Current task ID'),
      step: z.string().describe('Current step (e.g., "3/7" or "Phase 2")'),
      nextAction: z.string().describe('Description of the next action to take'),
    },
    async ({ file, taskId, step, nextAction }) => {
      try {
        const markdown = readMarkdownFile(file)
        const parts = splitDocument(markdown)

        parts.cursor = {
          taskId,
          step,
          nextAction,
          lastSeenHash: generateBodyHash(parts.body),
          updatedAt: new Date().toISOString(),
        }

        const updated = mergeDocument(parts)
        writeMarkdownFile(file, updated)

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ cursor: parts.cursor }, null, 2),
          }],
        }
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          }],
          isError: true,
        }
      }
    },
  )

  // ─── evaluate_gates (v0.4.0 NEW) ───
  server.tool(
    'evaluate_gates',
    'Evaluate all gates in a markdown file against current memo statuses. Returns updated gate statuses without modifying the file.',
    {
      file: z.string().describe('Path to the annotated markdown file'),
    },
    async ({ file }) => {
      try {
        const markdown = readMarkdownFile(file)
        const parts = splitDocument(markdown)
        const gates = evaluateAllGates(parts.gates, parts.memos)

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              gates,
              summary: {
                total: gates.length,
                blocked: gates.filter(g => g.status === 'blocked').length,
                proceed: gates.filter(g => g.status === 'proceed').length,
                done: gates.filter(g => g.status === 'done').length,
              },
            }, null, 2),
          }],
        }
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          }],
          isError: true,
        }
      }
    },
  )

  // ─── export_review ───
  server.tool(
    'export_review',
    'Export review feedback in a format optimized for a specific AI coding tool. Targets: claude-code, cursor, codex, copilot, cline, windsurf, roo-code, gemini, generic, handoff. Returns formatted markdown ready to save to the appropriate file.',
    {
      file: z.string().describe('Path to the annotated markdown file'),
      target: z.enum(['claude-code', 'cursor', 'codex', 'copilot', 'cline', 'windsurf', 'roo-code', 'gemini', 'antigravity', 'generic', 'handoff']).describe('Target AI tool format'),
    },
    async ({ file, target }) => {
      try {
        const markdown = readMarkdownFile(file)

        if (target === 'handoff') {
          const doc = buildHandoffDocument(markdown, file)
          const handoff = formatHandoffMarkdown(doc, 'standalone')
          return { content: [{ type: 'text' as const, text: handoff }] }
        }

        // For claude-code, cursor, generic — use context-generator logic
        const { memos } = extractMemos(markdown)
        const counts = getAnnotationCounts(markdown)
        const allSections = getAllSections(markdown)
        const reviewedSections = getSectionsWithAnnotations(markdown)

        // Build feedback items from memos
        const fixes = memos.filter(m => m.color === 'red')
        const questions = memos.filter(m => m.color === 'blue')
        const highlights = memos.filter(m => m.color === 'yellow')

        const L: string[] = []
        const docTitle = allSections[0] || 'Plan Review'

        if (target === 'claude-code' || target === 'codex' || target === 'copilot' || target === 'cline' || target === 'windsurf' || target === 'roo-code' || target === 'gemini' || target === 'antigravity') {
          L.push(`## Active Plan Review: ${file}`)
          L.push(`Follow this plan. Refer to ${file} for details.`)
          L.push('')
          if (fixes.length > 0) {
            L.push('### Must Fix')
            for (const f of fixes) {
              const anchor = f.anchorText ? `"${f.anchorText.slice(0, 60)}" → ` : ''
              L.push(`- ${anchor}${f.text}`)
            }
            L.push('')
          }
          if (questions.length > 0) {
            L.push('### Open Questions (resolve before implementing)')
            for (const q of questions) {
              const anchor = q.anchorText ? `"${q.anchorText.slice(0, 60)}" — ` : ''
              L.push(`- ${anchor}${q.text}`)
            }
            L.push('')
          }
          if (highlights.length > 0) {
            L.push('### Key Points (preserve these)')
            for (const h of highlights) {
              const anchor = h.anchorText ? `"${h.anchorText.slice(0, 80)}"` : h.text
              L.push(`- ${anchor}`)
            }
            L.push('')
          }
          if (allSections.length > 0) {
            L.push('### Checklist')
            for (const s of allSections) {
              const done = reviewedSections.includes(s) ? 'x' : ' '
              L.push(`- [${done}] ${s}`)
            }
            L.push('')
          }
          L.push('When all items are complete, delete this section.')
        } else if (target === 'cursor') {
          L.push('---')
          L.push(`description: Plan review feedback for ${file}`)
          L.push('alwaysApply: true')
          L.push('---')
          L.push('')
          L.push(`Follow the plan at ${file} strictly.`)
          L.push('')
          if (fixes.length > 0) {
            L.push('Required changes:')
            for (const f of fixes) {
              L.push(`- ${f.anchorText ? `"${f.anchorText.slice(0, 50)}" → ` : ''}${f.text}`)
            }
            L.push('')
          }
          if (questions.length > 0) {
            L.push('Open questions (resolve before coding):')
            for (const q of questions) { L.push(`- ${q.text}`) }
            L.push('')
          }
          L.push('Remove this file when all items are complete.')
        } else {
          // generic
          L.push(`# Plan Review Context — ${docTitle}`)
          L.push('')
          L.push(`**Source:** \`${file}\``)
          L.push(`**Reviewed:** ${new Date().toISOString().split('T')[0]}`)
          L.push(`**Summary:** ${counts.fixes} fix, ${counts.questions} question, ${counts.highlights} highlight`)
          L.push('')
          if (fixes.length > 0) {
            L.push('## Must Fix')
            for (const f of fixes) {
              const anchor = f.anchorText ? `"${f.anchorText.slice(0, 60)}" → ` : ''
              L.push(`- ${anchor}${f.text}`)
            }
            L.push('')
          }
          if (questions.length > 0) {
            L.push('## Questions')
            for (const q of questions) {
              const anchor = q.anchorText ? `"${q.anchorText.slice(0, 60)}" — ` : ''
              L.push(`- ${anchor}${q.text}`)
            }
            L.push('')
          }
          if (highlights.length > 0) {
            L.push('## Key Points')
            for (const h of highlights) {
              L.push(`- ${h.anchorText || h.text}`)
            }
            L.push('')
          }
          if (allSections.length > 0) {
            L.push('## Checklist')
            for (const s of allSections) {
              const done = reviewedSections.includes(s) ? 'x' : ' '
              L.push(`- [${done}] ${s}`)
            }
            L.push('')
          }
          L.push('---')
          L.push('*Generated by [md-feedback](https://github.com/yeominux/md-feedback). Delete when done.*')
        }

        return { content: [{ type: 'text' as const, text: L.join('\n') }] }
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          }],
          isError: true,
        }
      }
    },
  )
}
