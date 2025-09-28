import * as vscode from 'vscode';
import type { Decorations } from './decorator';
import type { ResolveFn } from '../analyzer/types';
import { computeHighlights } from '../analyzer/compute';
import { isExcludedFileName } from './exclude';

const SUPPORTED = new Set(['typescript', 'typescriptreact']);

/**
 * Build a function that updates decorations for the active editor.
 * - Definitions: highlight whole lines covering the Server Function body.
 * - Call sites: extract candidates → pre-filter (imports/locals) → resolve via LS → if it matches a Server Function, highlight the expression range (with 🚪).
 * - Merge duplicate ranges to avoid double drawing.
 */
export function buildUpdateEditor(getDecorations: () => Decorations, resolveFn: ResolveFn) {
  let seq = 0;
  let currentAbort: AbortController | undefined;
  return async function updateEditor(editor?: vscode.TextEditor): Promise<void> {
    const runId = ++seq;
    // Abort previous run (if any) and create a fresh controller for this run.
    try { currentAbort?.abort(); } catch { /* noop */ }
    currentAbort = new AbortController();
    if (!editor) {return;}
    const { document } = editor;
    const { body, call, icon } = getDecorations();
    if (!SUPPORTED.has(document.languageId)) {
      editor.setDecorations(body, []);
      editor.setDecorations(call, []);
      editor.setDecorations(icon, []);
      return;
    }

    // Skip excluded files (e.g., Storybook/tests)
    if (isExcludedFileName(document.fileName)) {
      editor.setDecorations(body, []);
      editor.setDecorations(call, []);
      editor.setDecorations(icon, []);
      return;
    }

    const text = document.getText();
    const visible = editor.visibleRanges[0];
    const visibleRange = visible ? { start: document.offsetAt(visible.start), end: document.offsetAt(visible.end) } : undefined;
    const cfg = vscode.workspace.getConfiguration('nextjs-server-functions-visualizer');
    // Support both the new key and the previous one for compatibility.
    const ignoreCallees = cfg.get<string[]>('calls.ignoreCallees') ?? [];
    const { bodyRanges, iconRanges, callRanges } = await computeHighlights(
      text,
      document.fileName,
      document.uri.toString(),
      resolveFn,
      visibleRange
        ? { visibleRange, bounds: { maxConcurrent: 6, perPassBudgetMs: 2000, resolveTimeoutMs: 1500, maxResolutions: 30 }, signal: currentAbort.signal, ignoreCallees }
        : { signal: currentAbort.signal, ignoreCallees },
    );
    if (runId !== seq) { return; }
    editor.setDecorations(
      body,
      bodyRanges.map(r => new vscode.Range(document.positionAt(r.start), document.positionAt(r.end)))
    );
    editor.setDecorations(
      icon,
      iconRanges.map(r => new vscode.Range(document.positionAt(r.start), document.positionAt(r.end)))
    );
    editor.setDecorations(
      call,
      callRanges.map(r => new vscode.Range(document.positionAt(r.start), document.positionAt(r.end)))
    );
  };
}
