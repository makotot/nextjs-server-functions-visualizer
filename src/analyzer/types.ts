export type ResolveFn = (uri: string, offset: number) => Promise<boolean>;

export type RuntimeControls = {
  // Resolve only within this visible range first, then optionally a few outside.
  visibleRange?: { start: number; end: number };
  // Internal safety bounds (applied if provided by caller). If omitted, behaves like legacy (no limits).
  bounds?: {
    maxConcurrent?: number; // default 6
    perPassBudgetMs?: number; // default 2000
    resolveTimeoutMs?: number; // default 1500
    maxResolutions?: number; // default 30
  };
  // Standard cancellation signal for cooperative cancellation across layers.
  // When aborted, compute avoids starting new work and returns promptly.
  signal?: AbortSignal;
  // Additional callee names to ignore for call-site highlighting.
  // Provided by the VS Code layer via configuration.
  ignoreCallees?: string[];
};
