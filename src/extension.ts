import type * as vscode from "vscode";
import { registerVisualizer } from "./extension/controller";

export function activate(context: vscode.ExtensionContext) {
  registerVisualizer(context);
}
