import * as vscode from 'vscode';

/**
 * A bundle of decorations applied to the editor.
 * - body: whole-line highlight for Server Function definitions
 * - call: expression-range highlight for call sites (shows 🚪 at the end)
 */
export type Decorations = {
  body: vscode.TextEditorDecorationType;
  call: vscode.TextEditorDecorationType;
  icon: vscode.TextEditorDecorationType; // For 🌐 at the end of the definition line
};

/**
 * Pick a color based on the current color theme.
 */
function pickByTheme(light: string, dark: string, hc: string): string {
  const kind = vscode.window.activeColorTheme.kind;
  if (kind === vscode.ColorThemeKind.Dark) { return dark; }
  // HighContrastLight is not in all versions; compare by value if present
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (kind === vscode.ColorThemeKind.HighContrast || (vscode.ColorThemeKind as any).HighContrastLight === kind) {
    return hc;
  }
  return light;
}

/**
 * Create and return TextEditorDecorationTypes for definition/call decorations.
 * Colors are selected from settings (light/dark/high-contrast) and the current theme.
 */
export function createDecorations(): Decorations {
  const cfg = vscode.workspace.getConfiguration('nextjs-server-functions-visualizer');
  const defLight = cfg.get<string>('highlight.definition.tintLight', 'rgba(138, 99, 255, 0.14)');
  const defDark = cfg.get<string>('highlight.definition.tintDark', 'rgba(138, 99, 255, 0.18)');
  const defHC = cfg.get<string>('highlight.definition.tintHighContrast', 'rgba(138, 99, 255, 0.22)');
  const callLight = cfg.get<string>('highlight.call.tintLight', 'rgba(118, 129, 255, 0.14)');
  const callDark = cfg.get<string>('highlight.call.tintDark', 'rgba(118, 129, 255, 0.18)');
  const callHC = cfg.get<string>('highlight.call.tintHighContrast', 'rgba(118, 129, 255, 0.22)');
  const underlineLight = cfg.get<string>('highlight.call.underlineColorLight', 'rgba(118, 129, 255, 0.85)');
  const underlineDark = cfg.get<string>('highlight.call.underlineColorDark', 'rgba(118, 129, 255, 0.85)');
  const underlineHC = cfg.get<string>('highlight.call.underlineColorHighContrast', 'rgba(118, 129, 255, 0.9)');

  const defTint = pickByTheme(defLight, defDark, defHC);
  const callTint = pickByTheme(callLight, callDark, callHC);
  const underline = pickByTheme(underlineLight, underlineDark, underlineHC);

  const body = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: defTint,
  });
  const call = vscode.window.createTextEditorDecorationType({
    isWholeLine: false,
    backgroundColor: callTint,
    // Call sites get an underline over the same range as the background
    textDecoration: `underline solid ${underline}`,
    after: {
      contentText: '🚪',
      margin: '0 0 0 0.25rem',
    },
  });
  const icon = vscode.window.createTextEditorDecorationType({
    isWholeLine: false,
    after: {
      contentText: '🌐',
      margin: '0 0 0 0.25rem',
    },
  });

  return { body, call, icon };
}

/** Dispose decorations and release resources. */
export function disposeDecorations(decos: Decorations): void {
  decos.body.dispose();
  decos.call.dispose();
  decos.icon.dispose();
}
