import * as vscode from 'vscode';

function compilePatterns(patterns: string[]): RegExp[] {
  const regs: RegExp[] = [];
  for (const p of patterns) {
    try {
      regs.push(new RegExp(p));
    } catch {
      // ignore invalid regex
    }
  }
  return regs;
}

export function getExcludeRegexes(): RegExp[] {
  const cfg = vscode.workspace.getConfiguration('nextjs-server-functions-visualizer');
  const arr = cfg.get<string[]>('files.exclude', [
    '\\.(stories|story)\\.[tj]sx?$',
    '\\.(test|spec)\\.[tj]sx?$',
    '/__tests__/',
    '/\\.storybook/',
  ]);
  return compilePatterns(Array.isArray(arr) ? arr : []);
}

export function isExcludedFileName(fileName: string, regs?: RegExp[]): boolean {
  const patterns = regs ?? getExcludeRegexes();
  const path = fileName.replace(/\\/g, '/');
  for (const r of patterns) {
    if (r.test(path)) { return true; }
  }
  return false;
}

export function isExcludedUri(uri: vscode.Uri, regs?: RegExp[]): boolean {
  return isExcludedFileName(uri.fsPath || uri.toString(), regs);
}
