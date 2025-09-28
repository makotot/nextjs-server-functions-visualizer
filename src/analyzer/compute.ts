/** Highlight computation logic independent of VS Code. */
import { scanServerFunctions } from '../core/definitions';
import { scanCallSiteCandidates, collectImportedNames, collectLocalCallableNames, collectNamespaceImportNames } from '../core/calls';
import type { ResolveFn, RuntimeControls } from './types';

export type OffsetRange = { start: number; end: number };

/**
 * Given text and file name, compute offset ranges for definition and call-site highlights.
 * - Extraction: use core definitions/calls logic (AST-based).
 * - Filter: consider only imported or locally declared callables.
 * - Matching: keep only those that resolve to a Server Function via resolveFn (LSP-compatible).
 */
export async function computeHighlights(
  text: string,
  fileName: string,
  documentUri: string,
  resolveFn: ResolveFn,
  controls?: RuntimeControls,
): Promise<{ bodyRanges: OffsetRange[]; iconRanges: OffsetRange[]; callRanges: OffsetRange[] }> {
  const spans = scanServerFunctions(text, fileName);
  const bodyRanges: OffsetRange[] = [];
  const iconRanges: OffsetRange[] = [];
  const localFunctionNames = new Set<string>();
  for (const s of spans) {
    const startLine = lineStartOffset(text, s.bodyStart);
    const endLine = lineEndOffset(text, s.bodyEnd);
    bodyRanges.push({ start: startLine, end: endLine });
    if (text[s.bodyStart] === '{') {
      const endOfBraceLine = lineEndOffset(text, s.bodyStart);
      iconRanges.push({ start: endOfBraceLine, end: endOfBraceLine });
    }
    if (s.name && s.name !== '(inline)' && s.name !== 'default') {
      localFunctionNames.add(s.name);
    }
  }

  const calls = scanCallSiteCandidates(text, fileName);
  const imported = collectImportedNames(text, fileName);
  const locals = collectLocalCallableNames(text, fileName);
  const nsImports = collectNamespaceImportNames(text, fileName);
  const callRanges: OffsetRange[] = [];
  const seen = new Set<string>();

  const add = (r: OffsetRange) => {
    const key = `${r.start}:${r.end}`;
    if (!seen.has(key)) { seen.add(key); callRanges.push(r); }
  };

  // Order call candidates: visible range first (if provided)
  const vr = controls?.visibleRange;
  const inView: typeof calls = [];
  const outView: typeof calls = [];
  if (vr) {
    for (const c of calls) {
      if (c.start <= vr.end && c.end >= vr.start) { inView.push(c); } else { outView.push(c); }
    }
  }
  const orderedCalls = vr ? [...inView, ...outView] : calls;

  // Safety bounds applied only when caller passed options
  const {
    maxConcurrent = 6,
    perPassBudgetMs = 2000,
    resolveTimeoutMs = 1500,
    maxResolutions = 30
  } = controls?.bounds ?? {};

  const useBounds = !!controls;
  const signal = controls?.signal;

  const startedAt = Date.now();
  let resolutions = 0;
  let inFlight = 0;
  const queue: Promise<void>[] = [];

  const runWithTimeout = async (uri: string, off: number): Promise<boolean> => {
    if (!useBounds && !signal) { return resolveFn(uri, off); }
    return await Promise.race([
      resolveFn(uri, off),
      new Promise<boolean>(res => setTimeout(() => res(false), resolveTimeoutMs)),
      new Promise<boolean>(res => {
        if (signal) {
          if (signal.aborted) {
            res(false);
          } else {
            signal.addEventListener('abort', () => res(false), { once: true });
          }
        }
      }),
    ]);
  };

  // Admit a task into a small concurrency pool.
  // - Limits concurrent resolve operations to avoid flooding the language server.
  // - When bounds are disabled, runs the task inline for simplicity.
  const schedule = async (task: () => Promise<void>) => {
    // Fast path: no bounds configured → execute immediately.
    if (!useBounds && !signal) { await task(); return; }

    // If aborted, do not admit new tasks.
    if (signal?.aborted) { return; }

    // Backpressure: if the pool is full, wait until any in-flight task finishes.
    while (inFlight >= maxConcurrent) {
      // Wait for whichever promise settles first to free a slot.
      // eslint-disable-next-line no-await-in-loop
      await Promise.race(queue);
      if (signal?.aborted) { return; }
    }

    // Wrap the task to keep pool accounting correct.
    const p = (async () => {
      try {
        inFlight++; // Occupy a slot.
        await task();
      } finally {
        inFlight--; // Free the slot even if the task throws.
      }
    })();

    // Track the promise so Promise.race can observe progress.
    queue.push(p);

    // Remove the settled promise from the queue to avoid unbounded growth.
    p.finally(() => {
      const idx = queue.indexOf(p);
      if (idx >= 0) { queue.splice(idx, 1); }
    });
  };

  // Built-in non-action callees to exclude at the top-level call-site.
  // Keep this conservative: core React hooks and Next.js client navigation only.
  const BUILTIN_IGNORED_CALLEES = new Set<string>([
    // React core hooks
    'useEffect', 'useLayoutEffect', 'useInsertionEffect', 'useMemo', 'useCallback',
    'useState', 'useReducer', 'useRef', 'useId', 'useSyncExternalStore', 'useDeferredValue',
    // Transitions / optimistic UI helpers
    'startTransition', 'useTransition', 'useOptimistic',
    // Next.js navigation (client)
    'useRouter', 'usePathname', 'useSearchParams',
  ]);
  // Merge with user-provided ignores from the extension layer.
  const IGNORED_CALLEES = new Set<string>([
    ...BUILTIN_IGNORED_CALLEES,
    ...(controls?.ignoreCallees ?? []),
  ]);

  for (const orderedCall of orderedCalls) {
    if (signal?.aborted) { break; }
    const site: OffsetRange = { start: orderedCall.start, end: orderedCall.end };
    if (orderedCall.kind === 'jsxAction' || orderedCall.kind === 'jsxFormAction') {
      add(site);
      continue;
    }
    // Skip known non-action callees even if imported/local (e.g., React hooks/wrappers)
    if (orderedCall.calleeName && IGNORED_CALLEES.has(orderedCall.calleeName)) {
      continue;
    }
    // Intra-file short-circuit: local server functions don't need LS
    if (orderedCall.calleeName && localFunctionNames.has(orderedCall.calleeName)) {
      add(site);
      continue;
    }
    if (orderedCall.calleeName && !imported.has(orderedCall.calleeName) && !locals.has(orderedCall.calleeName)) {
      // Allow property access off a namespace import: ns.fn()
      if (!orderedCall.qualifierName || !nsImports.has(orderedCall.qualifierName)) {
        continue;
      }
    }
    const inside = orderedCall.calleeName ? (orderedCall.start + Math.max(1, Math.floor(orderedCall.calleeName.length / 2))) : orderedCall.start;
    // Pre-check bounds before scheduling to avoid enqueuing no-op tasks
    if (useBounds && (resolutions >= maxResolutions || Date.now() - startedAt > perPassBudgetMs || signal?.aborted)) {
      break;
    }
    const resolveCallCandidate = async () => {
      const ok = await runWithTimeout(documentUri, inside);
      if (ok) { add(site); }
      resolutions++;
    };
    // eslint-disable-next-line no-await-in-loop
    await schedule(resolveCallCandidate);
    if (useBounds && (resolutions >= maxResolutions || Date.now() - startedAt > perPassBudgetMs || signal?.aborted)) {
      break;
    }
  }
  // Drain remaining scheduled tasks.
  // If aborted, do not block on outstanding tasks — but attach a catch handler
  // so late rejections don't surface as unhandled promise rejections.
  if (signal?.aborted) {
    for (const p of queue) { void p.catch(() => {}); }
  } else {
    // Take a snapshot: each promise removes itself from `queue` in its `finally`
    // handler above. Iterating the live array can skip entries. A copy ensures
    // we await every scheduled task before returning.
    const pending = [...queue];
    await Promise.all(pending);
  }

  return { bodyRanges, iconRanges, callRanges };
}

function lineStartOffset(text: string, at: number): number {
  let i = at;
  while (i > 0 && text[i - 1] !== '\n') {i--;}
  return i;
}
function lineEndOffset(text: string, at: number): number {
  const idx = text.indexOf('\n', at);
  return idx === -1 ? text.length : idx;
}
