export type SubrequestSink = { consumeSubrequests(n?: number): void };

export function instrumentedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  sink?: SubrequestSink,
): Promise<Response> {
  sink?.consumeSubrequests?.(1);
  return fetch(input, init);
}
