/** True when sync poll reports a new job completion and the Queue tab should refetch. */
export function shouldRefetchQueueOnCompletion(
  prevCompletedAt: string | null | undefined,
  nextCompletedAt: string | null | undefined,
): boolean {
  if (!nextCompletedAt) return false;
  if (!prevCompletedAt) return true;
  return nextCompletedAt !== prevCompletedAt;
}
