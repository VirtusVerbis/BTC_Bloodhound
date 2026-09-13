import { api } from "./api";
import type { GraphL1State, GraphL2Session, GraphLoadState } from "./graphCache";
import type { GraphLoadParams } from "./graphFilter";

export interface ApiGraphNode {
  id: string;
  type: string;
  label: string;
  role: string;
  address?: string;
  childCount?: number;
  totalSats?: number;
  totalReceivedSats?: number;
  liveBalanceSats?: number | null;
  liveBalanceAt?: string | null;
  hopFromHacker?: number | null;
  incomingSats?: number;
  latestTxTime?: string | null;
  earliestTxTime?: string | null;
  expandProfile?: "sweep_relay" | "spend_fanout" | null;
  relayMeta?: {
    receiveTxCount: number;
    spendTxCount: number;
    primarySweepTarget?: string;
    totalReceivedSats?: number;
  };
  fanoutMeta?: {
    outputCount: number;
    totalOutSats: number;
    txid: string;
    topOutputs?: Array<{ address: string; sats: number }>;
  };
  opReturn?: string;
  opReturnLabel?: string;
}

export interface ApiGraphEdge {
  id: string;
  source: string;
  target: string;
  txid: string;
  amount: number;
  time: string | null;
  edgeKind?: "default" | "peel_relay" | "spend_fanout" | "victim_refund" | "victim_dust";
  bundled?: boolean;
  edgeCount?: number;
  txids?: string[];
  totalAmount?: number;
  outputCount?: number;
  topOutputs?: Array<{ address: string; sats: number }>;
}

type GraphMode = "hacker" | "victim-filtered" | "victim-centric";

export interface ApiGraphResponse {
  nodes: ApiGraphNode[];
  edges: ApiGraphEdge[];
  mode?: GraphMode;
  matchedHackers?: string[];
  page?: {
    phase: "l1" | "l2";
    done: boolean;
    nextCursor: string | null;
    pageSize?: number;
    totalL1?: number | null;
    loadedL1?: number;
    loadedL2?: number;
    loadId?: string;
  };
  l2Token?: string | null;
}

export interface GraphLoadProgress {
  phase: "l1" | "l2";
  loaded: number;
  total: number | null;
  percent: number;
  message: string;
}

export interface LoadHackerGraphParams {
  hacker: string;
  minEdgeSats: number;
  maxDownstream: number;
  maxVictims: number;
  expandVictims: boolean;
  pageSize: number;
}

export interface LoadHackerGraphOptions {
  onProgress?: (progress: GraphLoadProgress) => void;
  signal?: { generation: number; current: () => number };
}

export interface LoadHackerGraphResult {
  graph: ApiGraphResponse;
  state: GraphLoadState;
}

export function mergeGraphPages(
  pages: Array<Pick<ApiGraphResponse, "nodes" | "edges">>,
): ApiGraphResponse {
  const nodeById = new Map<string, ApiGraphNode>();
  const edgeById = new Map<string, ApiGraphEdge>();
  for (const page of pages) {
    for (const node of page.nodes) nodeById.set(node.id, node);
    for (const edge of page.edges) edgeById.set(edge.id, edge);
  }
  return {
    nodes: [...nodeById.values()],
    edges: [...edgeById.values()],
    mode: "hacker",
  };
}

export function computeLoadPercent(opts: {
  phase: "l1" | "l2";
  loadedL1: number;
  totalL1: number | null;
  maxDownstream: number;
  completedL2Tokens: number;
  totalL2Tokens: number;
  l2TokenProgress: number;
}): number {
  let l1Percent = 0;
  if (opts.totalL1 != null && opts.totalL1 > 0) {
    l1Percent = Math.min(1, opts.loadedL1 / opts.totalL1);
  } else if (opts.maxDownstream > 0) {
    l1Percent = Math.min(1, opts.loadedL1 / opts.maxDownstream);
  }

  let l2Percent = 0;
  if (opts.totalL2Tokens > 0) {
    l2Percent = (opts.completedL2Tokens + opts.l2TokenProgress) / opts.totalL2Tokens;
  }

  const raw = opts.phase === "l1" ? l1Percent * 60 : 60 + l2Percent * 40;
  return Math.min(99, Math.round(raw));
}

export function shouldResumeL1(l1: GraphL1State, newMaxDownstream: number): boolean {
  if (!l1.done) return true;
  if (l1.nextCursor != null && l1.loadedL1 < newMaxDownstream) return true;
  return false;
}

export function shouldReexpandL2(session: GraphL2Session, oldMaxDownstream: number, newMaxDownstream: number): boolean {
  return newMaxDownstream > oldMaxDownstream && session.done && session.nextCursor == null;
}

function throwIfAborted(signal?: LoadHackerGraphOptions["signal"]) {
  if (signal && signal.generation !== signal.current()) {
    throw new Error("aborted");
  }
}

async function fetchGraphPage(params: URLSearchParams): Promise<ApiGraphResponse> {
  return api<ApiGraphResponse>(`/api/graph?${params}`);
}

function toGraphLoadParams(params: LoadHackerGraphParams): GraphLoadParams {
  return {
    hacker: params.hacker,
    minEdgeSats: params.minEdgeSats,
    maxVictims: params.maxVictims,
    maxDownstream: params.maxDownstream,
    expandVictims: params.expandVictims,
  };
}

async function fetchL1Pages(
  params: LoadHackerGraphParams,
  opts: {
    start?: GraphL1State;
    onProgress?: (progress: GraphLoadProgress) => void;
    signal?: LoadHackerGraphOptions["signal"];
    totalL1?: number | null;
    completedL2Tokens?: number;
    totalL2Tokens?: number;
  },
): Promise<{ pages: ApiGraphResponse[]; l1: GraphL1State; l2Tokens: string[]; totalL1: number | null }> {
  const pages: ApiGraphResponse[] = [];
  const l2Tokens: string[] = [];
  let loadId = opts.start?.loadId;
  let totalL1 = opts.totalL1 ?? null;
  let loadedL1 = opts.start?.loadedL1 ?? 0;
  let cursor: string | null = opts.start?.nextCursor ?? null;
  let l1Done = opts.start?.done ?? false;

  if (l1Done && !shouldResumeL1(opts.start ?? { loadedL1: 0, nextCursor: null, done: true }, params.maxDownstream)) {
    return { pages, l1: opts.start!, l2Tokens, totalL1 };
  }

  if (opts.start && shouldResumeL1(opts.start, params.maxDownstream)) {
    l1Done = false;
  }

  const report = (progress: GraphLoadProgress) => opts.onProgress?.(progress);

  do {
    throwIfAborted(opts.signal);
    const search = new URLSearchParams({
      paginated: "1",
      phase: "l1",
      hacker: params.hacker,
      min_edge_sats: String(params.minEdgeSats),
      max_downstream: String(params.maxDownstream),
      max_victims: String(params.maxVictims),
      limit: String(params.pageSize),
      loaded_l1: String(loadedL1),
    });
    if (params.expandVictims) search.set("expand_victims", "1");
    if (loadId) search.set("load_id", loadId);
    if (cursor) search.set("cursor", cursor);

    const page = await fetchGraphPage(search);
    pages.push(page);
    if (page.page?.loadId) loadId = page.page.loadId;
    if (page.page?.totalL1 != null) totalL1 = page.page.totalL1;
    loadedL1 = page.page?.loadedL1 ?? loadedL1;
    if (page.l2Token) l2Tokens.push(page.l2Token);

    report({
      phase: "l1",
      loaded: loadedL1,
      total: totalL1,
      percent: computeLoadPercent({
        phase: "l1",
        loadedL1,
        totalL1,
        maxDownstream: params.maxDownstream,
        completedL2Tokens: opts.completedL2Tokens ?? 0,
        totalL2Tokens: opts.totalL2Tokens ?? 0,
        l2TokenProgress: 0,
      }),
      message: "Loading downstream",
    });

    l1Done = page.page?.done ?? true;
    cursor = page.page?.nextCursor ?? null;
  } while (!l1Done && cursor);

  return {
    pages,
    l1: { loadId, loadedL1, nextCursor: cursor, done: l1Done },
    l2Tokens,
    totalL1,
  };
}

async function fetchL2ForToken(
  params: LoadHackerGraphParams,
  l2Token: string,
  opts: {
    loadId?: string;
    start?: GraphL2Session;
    oldMaxDownstream: number;
    onProgress?: (progress: GraphLoadProgress) => void;
    signal?: LoadHackerGraphOptions["signal"];
    loadedL1: number;
    totalL1: number | null;
    completedL2Tokens: number;
    totalL2Tokens: number;
  },
): Promise<{ pages: ApiGraphResponse[]; session: GraphL2Session }> {
  const pages: ApiGraphResponse[] = [];
  const reexpand = opts.start
    ? shouldReexpandL2(opts.start, opts.oldMaxDownstream, params.maxDownstream)
    : false;
  let l2Cursor: string | null = opts.start && !reexpand ? opts.start.nextCursor : null;
  let loadedL2 = opts.start && !reexpand ? opts.start.loadedL2 : 0;
  let l2Done = false;

  const report = (progress: GraphLoadProgress) => opts.onProgress?.(progress);

  do {
    throwIfAborted(opts.signal);
    const search = new URLSearchParams({
      paginated: "1",
      phase: "l2",
      hacker: params.hacker,
      l2_token: l2Token,
      limit: String(params.pageSize),
      loaded_l2: String(loadedL2),
      max_downstream: String(params.maxDownstream),
    });
    if (opts.loadId) search.set("load_id", opts.loadId);
    if (l2Cursor) search.set("cursor", l2Cursor);

    const page = await fetchGraphPage(search);
    pages.push(page);
    loadedL2 = page.page?.loadedL2 ?? loadedL2;
    l2Done = page.page?.done ?? true;
    l2Cursor = page.page?.nextCursor ?? null;

    report({
      phase: "l2",
      loaded: loadedL2,
      total: null,
      percent: computeLoadPercent({
        phase: "l2",
        loadedL1: opts.loadedL1,
        totalL1: opts.totalL1,
        maxDownstream: params.maxDownstream,
        completedL2Tokens: opts.completedL2Tokens,
        totalL2Tokens: opts.totalL2Tokens,
        l2TokenProgress: l2Done ? 1 : 0.5,
      }),
      message: "Loading hop 2",
    });
  } while (!l2Done && l2Cursor);

  return {
    pages,
    session: { l2Token, loadedL2, nextCursor: l2Cursor, done: l2Done },
  };
}

async function loadHackerGraphInternal(
  params: LoadHackerGraphParams,
  opts?: LoadHackerGraphOptions & {
    prevState?: GraphLoadState;
  },
): Promise<LoadHackerGraphResult> {
  const report = (progress: GraphLoadProgress) => opts?.onProgress?.(progress);
  const prevPages: ApiGraphResponse[] = opts?.prevState ? [opts.prevState.response] : [];

  const l1Start =
    opts?.prevState && shouldResumeL1(opts.prevState.l1, params.maxDownstream)
      ? opts.prevState.l1
      : undefined;

  const { pages: l1Pages, l1, l2Tokens: newL2Tokens, totalL1 } = await fetchL1Pages(params, {
    start: l1Start,
    onProgress: report,
    signal: opts?.signal,
  });

  const prevSessions = opts?.prevState?.l2Sessions ?? [];
  const prevTokenSet = new Set(prevSessions.map((s) => s.l2Token));
  for (const t of newL2Tokens) {
    if (!prevTokenSet.has(t)) prevTokenSet.add(t);
  }

  const l2SessionsToRun: Array<{ token: string; start?: GraphL2Session }> = [];
  for (const session of prevSessions) {
    const reexpand = shouldReexpandL2(
      session,
      opts?.prevState?.params.maxDownstream ?? params.maxDownstream,
      params.maxDownstream,
    );
    if (reexpand || !session.done || session.nextCursor) {
      l2SessionsToRun.push({ token: session.l2Token, start: reexpand ? undefined : session });
    }
  }
  for (const token of newL2Tokens) {
    if (!prevSessions.some((s) => s.l2Token === token)) {
      l2SessionsToRun.push({ token });
    }
  }

  const totalL2Tokens = l2SessionsToRun.length;
  let completedL2Tokens = 0;
  const l2Pages: ApiGraphResponse[] = [];
  const l2Sessions: GraphL2Session[] = [];

  for (const { token, start } of l2SessionsToRun) {
    const { pages, session } = await fetchL2ForToken(params, token, {
      loadId: l1.loadId,
      start,
      oldMaxDownstream: opts?.prevState?.params.maxDownstream ?? params.maxDownstream,
      onProgress: report,
      signal: opts?.signal,
      loadedL1: l1.loadedL1,
      totalL1,
      completedL2Tokens,
      totalL2Tokens,
    });
    l2Pages.push(...pages);
    l2Sessions.push(session);
    completedL2Tokens++;
  }

  for (const session of prevSessions) {
    if (!l2Sessions.some((s) => s.l2Token === session.l2Token)) {
      l2Sessions.push(session);
    }
  }

  report({
    phase: "l2",
    loaded: l1.loadedL1,
    total: totalL1,
    percent: 100,
    message: "Complete",
  });

  const graph = mergeGraphPages([...prevPages, ...l1Pages, ...l2Pages]);
  return {
    graph,
    state: {
      response: graph,
      params: toGraphLoadParams(params),
      l1,
      l2Sessions,
    },
  };
}

export async function loadHackerGraphPaginated(
  params: LoadHackerGraphParams,
  opts?: LoadHackerGraphOptions,
): Promise<LoadHackerGraphResult> {
  return loadHackerGraphInternal(params, opts);
}

export async function loadHackerGraphPaginatedResume(
  prevState: GraphLoadState,
  params: LoadHackerGraphParams,
  opts?: LoadHackerGraphOptions,
): Promise<LoadHackerGraphResult> {
  return loadHackerGraphInternal(params, { ...opts, prevState });
}
