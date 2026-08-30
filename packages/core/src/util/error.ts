function flattenOneLine(message: string): string {
  return message.replace(/\r?\n/g, " ").trim();
}

export function formatErrorMessage(err: unknown, depth = 0): string {
  const base = err instanceof Error ? err.message : String(err);
  const flattened = flattenOneLine(base);
  if (depth >= 1) return flattened;

  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  if (cause == null) return flattened;

  return `${flattened}; cause: ${formatErrorMessage(cause, depth + 1)}`;
}
