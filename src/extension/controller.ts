import * as vscode from 'vscode';
import { createDecorations, disposeDecorations, type Decorations } from './decorator';
import { buildUpdateEditor } from './updater';
import { makeVsCodeResolveFn } from './resolver';

/**
 * Register highlighting and wire the decoration lifecycle and events.
 * - Reacts to initial render, active editor changes, text edits, document open, theme changes, and configuration changes.
 * - Recreates decorations on theme/config changes to reflect updates immediately.
 */
export function registerVisualizer(context: vscode.ExtensionContext) {
  let decorations: Decorations = createDecorations();
  context.subscriptions.push(decorations.body, decorations.call, decorations.icon);

  const getDecorations = () => decorations;
  const resolveFn = makeVsCodeResolveFn();
  const updateEditor = buildUpdateEditor(getDecorations, resolveFn);

  let timer: NodeJS.Timeout | undefined;
  const scheduleUpdate = () => {
    if (timer) { clearTimeout(timer); }
    timer = setTimeout(() => { void updateEditor(vscode.window.activeTextEditor); }, 200);
  };

  // Initial render
  scheduleUpdate();

  // Wire events
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => scheduleUpdate()),
    vscode.workspace.onDidChangeTextDocument(e => {
      const active = vscode.window.activeTextEditor;
      if (active && e.document === active.document) {scheduleUpdate();}
    }),
    vscode.workspace.onDidOpenTextDocument(doc => {
      const active = vscode.window.activeTextEditor;
      if (active && doc === active.document) {scheduleUpdate();}
    }),
    vscode.window.onDidChangeActiveColorTheme(() => {
      disposeDecorations(decorations);
      decorations = createDecorations();
      context.subscriptions.push(decorations.body, decorations.call, decorations.icon);
      scheduleUpdate();
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (
        e.affectsConfiguration('nextjs-server-functions-visualizer.highlight.definition') ||
        e.affectsConfiguration('nextjs-server-functions-visualizer.highlight.call') ||
        e.affectsConfiguration('nextjs-server-functions-visualizer.calls.ignoreCallees')
      ) {
        disposeDecorations(decorations);
        decorations = createDecorations();
        context.subscriptions.push(decorations.body, decorations.call, decorations.icon);
        scheduleUpdate();
      }
    })
  );
}
