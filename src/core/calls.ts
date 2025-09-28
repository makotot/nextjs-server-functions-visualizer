import ts from 'typescript';

/**
 * Text range and kind of a call site (entry candidate).
 * - kind: jsxAction/formAction/directCall/startTransition/useActionState
 * - start/end: character offset range of the expression (for directCall: from callee identifier start to the closing parenthesis)
 * - calleeName: identifier name (when obtainable)
 */
export interface CallSiteSpan {
  kind: 'jsxAction' | 'jsxFormAction' | 'directCall' | 'startTransition' | 'useActionState';
  start: number;
  end: number;
  calleeName?: string;
  /** Qualifier/base identifier name for property access calls, e.g., ns in ns.fn() */
  qualifierName?: string;
}

/**
 * Extract Server Function call-site candidates from the current file.
 * Syntax covered:
 * - JSX: <form action={...}>, formAction={...}
 * - Direct calls: id(...), obj.id(...), including optional chaining variants
 * - Calls inside startTransition(() => id(...))
 * - The first argument of useActionState(id, ...)
 * Ranges are defined per kind, and duplicates are suppressed using kind+start+end.
 */
export function scanCallSiteCandidates(sourceText: string, fileName = 'file.tsx'): CallSiteSpan[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, kind);
  const calls: CallSiteSpan[] = [];

  const spanOf = (n: ts.Node) => ({ start: n.getStart(sf), end: n.getEnd() });
  const seen = new Set<string>();
  const push = (c: CallSiteSpan) => {
    // Deduplicate by span only to avoid double-counting the same call
    // discovered via multiple paths (e.g., directCall vs startTransition).
    const key = `${c.start}:${c.end}`;
    if (seen.has(key)) {return;}
    seen.add(key);
    calls.push(c);
  };

  /** Strip parentheses, non-null assertions, TS casts/assertions, and satisfies to reach the underlying expression. */
  const unwrap = (e: ts.Expression): ts.Expression => {
    let cur: ts.Expression = e;
    // Unwrap repeatedly up to a safe bound to avoid pathological nesting
    for (let i = 0; i < 8; i++) {
      if (ts.isParenthesizedExpression(cur)) { cur = cur.expression; continue; }
      if (ts.isNonNullExpression(cur)) { cur = cur.expression; continue; }
      if (ts.isAsExpression(cur)) { cur = cur.expression; continue; }
      if (ts.isTypeAssertionExpression(cur)) { cur = cur.expression; continue; }
      // satisfies operator (TS 4.9+)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((ts as any).isSatisfiesExpression && (ts as any).isSatisfiesExpression(cur)) { cur = (cur as any).expression; continue; }
      break;
    }
    return cur;
  };

  /** Get the callee identifier of a call expression (id / obj.id / tail name of a chain). */
  const getCalleeIdent = (expr: ts.Expression): ts.Identifier | undefined => {
    const e = unwrap(expr);
    if (ts.isIdentifier(e)) { return e; }
    if (ts.isPropertyAccessExpression(e)) {
      const n = e.name;
      return ts.isIdentifier(n) ? n : undefined;
    }
    // Fallback for optional chaining or older TS where chain guards aren't available
    const anyE: any = e as any;
    if (anyE && anyE.name && ts.isIdentifier(anyE.name)) {
      return anyE.name as ts.Identifier;
    }
    return undefined;
  };

  /** Get the base/qualifier identifier for a property access call (e.g., ns in ns.fn()). */
  const getQualifierIdent = (expr: ts.Expression): ts.Identifier | undefined => {
    const e = unwrap(expr);
    if (ts.isPropertyAccessExpression(e)) {
      const base = e.expression;
      return ts.isIdentifier(base) ? base : undefined;
    }
    // Optional chaining property access (older TS fallback via duck typing)
    const anyE: any = e as any;
    if (anyE && anyE.expression && ts.isIdentifier(anyE.expression)) {
      return anyE.expression as ts.Identifier;
    }
    return undefined;
  };

  sf.forEachChild(function walk(node) {
    // JSX attributes: action / formAction
    if (ts.isJsxAttribute(node)) {
      const attrName = node.name.getText(sf);
      if (attrName === 'action' || attrName === 'formAction') {
        const init = node.initializer;
        if (init && ts.isJsxExpression(init) && init.expression) {
          const expr = init.expression;
          const { start, end } = spanOf(expr);
          push({ kind: attrName === 'action' ? 'jsxAction' : 'jsxFormAction', start, end });
        }
      }
    }

    // Direct call: id(...), obj.id(...), optional chaining variants
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const id = getCalleeIdent(callee);
      const calleeText = id?.text ?? '';
      if (id) {
        const { start } = spanOf(id);
        // Highlight from identifier through the end of the call (includes parentheses and args)
        const end = node.getEnd();
        const qualifier = getQualifierIdent(callee);
        push({ kind: 'directCall', start, end, calleeName: calleeText, qualifierName: qualifier?.text });
      }

      // startTransition(() => id(...))
      if (calleeText === 'startTransition' && node.arguments.length > 0) {
        const arg = node.arguments[0];
        if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
          const visit = (n: ts.Node) => {
            if (ts.isCallExpression(n)) {
              const ident = getCalleeIdent(n.expression);
              if (ident) {
                const { start } = spanOf(ident);
                const end = n.getEnd();
                const qualifier = getQualifierIdent(n.expression);
                push({ kind: 'startTransition', start, end, calleeName: ident.text, qualifierName: qualifier?.text });
              }
            }
            ts.forEachChild(n, visit);
          };
          visit(arg.body);
        }
      }

      // useActionState(id, ...)
      if (calleeText === 'useActionState' && node.arguments.length > 0) {
        const first = node.arguments[0];
        if (ts.isIdentifier(first)) {
          const { start, end } = spanOf(first);
          push({ kind: 'useActionState', start, end, calleeName: first.text });
        }
      }
    }

    ts.forEachChild(node, walk);
  });

  return calls;
}

/**
 * Return the set of local identifier names introduced via imports.
 * - Collects default imports and named imports (including aliases).
 * - Excludes namespace imports (import * as ns) since calleeName becomes a property name.
 */
export function collectImportedNames(sourceText: string, fileName = 'file.tsx'): Set<string> {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, kind);
  const names = new Set<string>();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !s.importClause) {continue;}
    const ic = s.importClause;
    // Skip entirely if this is a type-only import clause: import type { X } from '...'
    if (ic.isTypeOnly) { continue; }
    if (ic.name) {names.add(ic.name.text);} // default import local name
    if (ic.namedBindings) {
      if (ts.isNamedImports(ic.namedBindings)) {
        for (const el of ic.namedBindings.elements) {
          // Skip type-only specifiers: import { type X as Y }
          // `isTypeOnly` is available on ImportSpecifier in TS 4.5+
          if ((el as ts.ImportSpecifier).isTypeOnly) { continue; }
          names.add(el.name.text); // local binding name (alias or original)
        }
      }
      // Note: namespace import (import * as ns) is not included because calleeName is property name
    }
  }
  return names;
}

/**
 * Collect "callable local names" within the same file.
 * - Function declarations
 * - ArrowFunction / FunctionExpression assigned to variable declarations
 */
export function collectLocalCallableNames(sourceText: string, fileName = 'file.tsx'): Set<string> {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, kind);
  const names = new Set<string>();

  sf.forEachChild(function walk(node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      names.add(node.name.text);
    }
  if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const init = decl.initializer;
          if (init) {
            // Directly assigned function expression / arrow function
            if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
              names.add(decl.name.text);
            } else {
              // Consider it callable if the initializer contains any function literal (builder/factory style)
              let found = false;
              const visit = (n: ts.Node) => {
                if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
                  found = true;
                  return; // Found; no further search needed along this branch
                }
                ts.forEachChild(n, visit);
              };
              ts.forEachChild(init, visit);
              if (found) {
                names.add(decl.name.text);
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  });

  return names;
}

/**
 * Collect namespace import local identifiers: import * as ns from '...'; => add 'ns'.
 */
export function collectNamespaceImportNames(sourceText: string, fileName = 'file.tsx'): Set<string> {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, kind);
  const names = new Set<string>();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !s.importClause) { continue; }
    const ic = s.importClause;
    if (ic.isTypeOnly) { continue; }
    if (ic.namedBindings && ts.isNamespaceImport(ic.namedBindings)) {
      names.add(ic.namedBindings.name.text);
    }
  }
  return names;
}
