import * as vscode from 'vscode';
import { scanServerFunctions } from '../core/definitions';
import type { ResolveFn } from '../analyzer/types';
import { isExcludedUri } from './exclude';

/**
 * Create a ResolveFn backed by VS Code's TypeScript Language Service.
 * Keeps the VS Code dependency isolated here; upper layers (highlight/updater) receive it via DI.
 */
export function makeVsCodeResolveFn(): ResolveFn {
  return async (uri: string, offset: number): Promise<boolean> => {
    type QueueItem = { uri: string; offset: number };
    const visited = new Set<string>();
    const queue: QueueItem[] = [{ uri, offset }];
    let hops = 0;
    while (queue.length && hops < 3) {
      hops++;
      const { uri: curUri, offset: curOffset } = queue.shift()!;
      const key = `${curUri}@${curOffset}`;
      if (visited.has(key)) { continue; }
      visited.add(key);

      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(curUri));
      const position = doc.positionAt(curOffset);

      const defs = await vscode.commands.executeCommand<vscode.Location[] | undefined>('vscode.executeDefinitionProvider', doc.uri, position);
      const impls = await vscode.commands.executeCommand<vscode.Location[] | undefined>('vscode.executeImplementationProvider', doc.uri, position);
      const all: vscode.Location[] = [];
      if (defs?.length) {all.push(...defs);}
      if (impls?.length) {all.push(...impls);}
      if (!all.length) {continue;}

      for (const loc of all) {
        try {
          // Skip excluded targets early
          if (isExcludedUri(loc.uri)) { continue; }
          const targetDoc = await vscode.workspace.openTextDocument(loc.uri);
          const targetText = targetDoc.getText();
          const serverFunctions = scanServerFunctions(targetText, targetDoc.fileName);
          const defOffset = targetDoc.offsetAt(loc.range.start);
          for (const sf of serverFunctions) {
            const inName = sf.nameStart !== undefined && sf.nameEnd !== undefined && defOffset >= sf.nameStart && defOffset <= sf.nameEnd;
            const inBody = defOffset >= sf.bodyStart && defOffset <= sf.bodyEnd;
            if (inName || inBody) {
              return true;
            }
          }
          queue.push({ uri: loc.uri.toString(), offset: defOffset });
        } catch {
          // ignore
        }
      }
    }
    return false;
  };
}
