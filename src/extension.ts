import * as vscode from 'vscode';
import { registerVisualizer } from './extension/controller';

export function activate(context: vscode.ExtensionContext) {
  console.log('nextjs-server-functions-visualizer activated');
  registerVisualizer(context);
}

export function deactivate() {}
