import { api } from "./api";

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
  edgeKind?: "default" | "peel_relay" | "spend_fanout";
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

function throwIfAborted(signal?: LoadHackerGraphOptions["signal"]) {
  if (signal && signal.generation !== signal.current()) {
    throw new Error("aborted");
  }
}

async function fetchGraphPage(params: URLSearchParams): Promise<ApiGraphResponse> {
  return api<ApiGraphResponse>(`/api/graph?${params}`);
}

export async function loadHackerGraphPaginated(
  params: LoadHackerGraphParams,
  opts?: LoadHackerGraphOptions,
): Promise<ApiGraphResponse> {
  const pages: ApiGraphResponse[] = [];
  const l2Tokens: string[] = [];
  let loadId: string | undefined;
  let totalL1: number | null = null;
  let loadedL1 = 0;
  let cursor: string | null = null;
  let l1Done = false;

  const report = (progress: GraphLoadProgress) => {
    opts?.onProgress?.(progress);
  };

  do {
    throwIfAborted(opts?.signal);
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
        completedL2Tokens: 0,
        totalL2Tokens: 0,
        l2TokenProgress: 0,
      }),
      message: "Loading downstream",
    });

    l1Done = page.page?.done ?? true;
    cursor = page.page?.nextCursor ?? null;
  } while (!l1Done && cursor);

  const totalL2Tokens = l2Tokens.length;
  let completedL2Tokens = 0;

  for (const l2Token of l2Tokens) {
    let l2Cursor: string | null = null;
    let l2Done = false;
    let loadedL2 = 0;

    do {
      throwIfAborted(opts?.signal);
      const search = new URLSearchParams({
        paginated: "1",
        phase: "l2",
        hacker: params.hacker,
        l2_token: l2Token,
        limit: String(params.pageSize),
        loaded_l2: String(loadedL2),
      });
      if (loadId) search.set("load_id", loadId);

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
          loadedL1,
          totalL1,
          maxDownstream: params.maxDownstream,
          completedL2Tokens,
          totalL2Tokens,
          l2TokenProgress: l2Done ? 1 : 0.5,
        }),
        message: "Loading hop 2",
      });
    } while (!l2Done && l2Cursor);

    completedL2Tokens++;
  }

  report({
    phase: "l2",
    loaded: loadedL1,
    total: totalL1,
    percent: 100,
    message: "Complete",
  });

  return mergeGraphPages(pages);
}
