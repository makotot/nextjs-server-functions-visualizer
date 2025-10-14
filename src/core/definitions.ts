import ts from "typescript";

/**
 * Information representing a detected Server Function.
 * - name: Action name (anonymous/default is 'default' or '(inline)')
 * - bodyStart/bodyEnd: Character offset range for the function body (converted to VS Code positions by the caller)
 * - nameStart/nameEnd: Offset range of the definition identifier (undefined if absent)
 */
export type ServerFunctionSpan = {
  name: string;
  bodyStart: number;
  bodyEnd: number;
  nameStart?: number;
  nameEnd?: number;
};

/**
 * Detect Server Function candidates from the given source.
 * Criteria:
 * - Either the module starts with 'use server' or the function body starts with 'use server'
 * - And the function is async
 * Targets:
 * - export async function / export default async function
 * - export const x = async () => {} / async function() {}
 * - Async function literals inside initializers (builder/factory arguments)
 * - Inline async () => { 'use server' } in JSX
 */
export function scanServerFunctions(
  sourceText: string,
  fileName = "file.tsx"
): ServerFunctionSpan[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    kind
  );
  const moduleHasUseServer = isUseServerPrologue(sf.statements);

  const serverFunctions: ServerFunctionSpan[] = [];
  const seen = new Set<string>();

  const pushFunction = ({
    name,
    span: { start, end },
    nameStart,
    nameEnd,
  }: {
    name: string;
    span: { start: number; end: number };
    nameStart?: number;
    nameEnd?: number;
  }) => {
    const key = `${start}:${end}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    serverFunctions.push({
      name,
      bodyStart: start,
      bodyEnd: end,
      nameStart,
      nameEnd,
    });
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: temporary ignore
  sf.forEachChild(function walk(node) {
    // function declarations (exported or local)
    if (ts.isFunctionDeclaration(node)) {
      const fn = node;
      const exported = isExported(node.modifiers);
      const eligible =
        isAsync(fn) &&
        ((exported && (moduleHasUseServer || hasUseServerInFunctionBody(fn))) ||
          (!exported && hasUseServerInFunctionBody(fn)));
      if (eligible) {
        const span = getBodySpan(sf, fn);
        if (span) {
          const nameId = node.name;
          const name =
            nameId?.text ??
            (exported && isDefault(node.modifiers) ? "default" : "(anonymous)");
          const nameStart = nameId ? nameId.getStart(sf) : undefined;
          const nameEnd = nameId ? nameId.getEnd() : undefined;
          pushFunction({
            name,
            span: { start: span.start, end: span.end },
            nameStart,
            nameEnd,
          });
        }
      }
    }

    // variable statements (exported or local)
    if (ts.isVariableStatement(node)) {
      const exported = isExported(node.modifiers);
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          const exportName = decl.name.text;
          const exportNameStart = decl.name.getStart(sf);
          const exportNameEnd = decl.name.getEnd();
          const init = decl.initializer;
          // direct function/arrow assignment
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
            const eligible =
              isAsync(init) &&
              ((exported &&
                (moduleHasUseServer || hasUseServerInFunctionBody(init))) ||
                (!exported && hasUseServerInFunctionBody(init)));
            if (eligible) {
              const span = getBodySpan(sf, init);
              if (span) {
                pushFunction({
                  name: exportName,
                  span: { start: span.start, end: span.end },
                  nameStart: exportNameStart,
                  nameEnd: exportNameEnd,
                });
              }
            }
          }

          // nested: walk any expression tree and pick async function literals (builder/factory)
          // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: temporary ignore
          const visit = (n: ts.Node) => {
            if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
              const fn = n;
              const eligible =
                isAsync(fn) &&
                ((exported &&
                  (moduleHasUseServer || hasUseServerInFunctionBody(fn))) ||
                  (!exported && hasUseServerInFunctionBody(fn)));
              if (eligible) {
                const span = getBodySpan(sf, fn);
                if (span) {
                  pushFunction({
                    name: exportName,
                    span: { start: span.start, end: span.end },
                    nameStart: exportNameStart,
                    nameEnd: exportNameEnd,
                  });
                }
              }
            }
            ts.forEachChild(n, visit);
          };
          visit(init);
        }
      }
    }

    // Generic: any inline async function/arrow with 'use server' in its body (e.g., JSX inline)
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const fn = node;
      if (isAsync(fn) && hasUseServerInFunctionBody(fn)) {
        const span = getBodySpan(sf, fn);
        if (span) {
          pushFunction({
            name: "(inline)",
            span: { start: span.start, end: span.end },
          });
        }
      }
    }

    ts.forEachChild(node, walk);
  });

  return serverFunctions;
}

/**
 * Determine whether the directives at the start of a module or block include 'use server'.
 */
function isUseServerPrologue(statements: ts.NodeArray<ts.Statement>): boolean {
  for (const s of statements) {
    if (ts.isExpressionStatement(s) && ts.isStringLiteralLike(s.expression)) {
      if (s.expression.text === "use server") {
        return true;
      }
      continue;
    }
    break;
  }
  return false;
}

/**
 * Check if the function body starts with a 'use server' directive.
 * Arrow functions with expression bodies cannot have directives, so this returns false in that case.
 */
function hasUseServerInFunctionBody(
  fn: ts.FunctionLikeDeclarationBase
): boolean {
  if (!fn.body) {
    return false;
  }
  if (ts.isBlock(fn.body)) {
    return isUseServerPrologue(fn.body.statements);
  }
  return false;
}

/** Whether the export modifier is present. */
function isExported(mods?: readonly ts.ModifierLike[]): boolean {
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** Whether the default modifier is present. */
function isDefault(mods?: readonly ts.ModifierLike[]): boolean {
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
}

/** Whether the async modifier is present. */
function isAsync(node: ts.Node): boolean {
  return (
    // biome-ignore lint/suspicious/noBitwiseOperators: temporary ignore
    (ts.getCombinedModifierFlags(node as ts.Declaration) &
      ts.ModifierFlags.Async) !==
    0
  );
}

/**
 * Return the text range of the function body (entire block including braces).
 */
function getBodySpan(
  sf: ts.SourceFile,
  fn: ts.FunctionLikeDeclarationBase
): { start: number; end: number } | undefined {
  const body = fn.body;
  if (!body) {
    return;
  }
  const start = body.getStart(sf);
  const end = body.getEnd();
  return { start, end };
}
