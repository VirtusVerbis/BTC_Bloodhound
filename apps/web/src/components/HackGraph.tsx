import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  type Edge,
  type Node,
  useEdgesState,
  useNodesState,
  useReactFlow,
  MarkerType,
} from "@xyflow/react";
import { api, satsToBtc, txUrl } from "../lib/api";
import { layoutGraph, type VictimSortOption } from "../lib/layoutGraph";
import { nodeTypes, type GraphNodeData } from "./nodes/GraphNodes";

interface ApiGraphNode {
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
}

interface ApiGraphEdge {
  id: string;
  source: string;
  target: string;
  txid: string;
  amount: number;
  time: string | null;
}

type GraphMode = "hacker" | "victim-filtered" | "victim-centric";

interface ApiGraphResponse {
  nodes: ApiGraphNode[];
  edges: ApiGraphEdge[];
  mode?: GraphMode;
  matchedHackers?: string[];
}

interface QueuedJob {
  jobId: number;
  parentAddress: string;
  parentId: string;
  estimatedRunAt: string;
  outgoingAtStart: number;
}

const edgeDefaults = {
  type: "smoothstep" as const,
  markerEnd: { type: MarkerType.ArrowClosed, color: "#f7931a" },
  style: { stroke: "#f7931a" },
};

const queuedEdgeDefaults = {
  type: "smoothstep" as const,
  markerEnd: { type: MarkerType.ArrowClosed, color: "#888" },
  style: { stroke: "#888", strokeDasharray: "4 4" },
};

function useMediaQuery(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const fn = () => setMatch(m.matches);
    m.addEventListener("change", fn);
    return () => m.removeEventListener("change", fn);
  }, [query]);
  return match;
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function FitViewAfterLayout({ trigger }: { trigger: number }) {
  const { fitView } = useReactFlow();

  useEffect(() => {
    if (trigger === 0) return;
    requestAnimationFrame(() => {
      fitView({ padding: 0.12, duration: 300 });
    });
  }, [trigger, fitView]);

  return null;
}

function GraphKeyboardShortcuts() {
  const { zoomIn, zoomOut } = useReactFlow();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (e.key === "]") {
        e.preventDefault();
        zoomIn({ duration: 150 });
      }
      if (e.key === "[") {
        e.preventDefault();
        zoomOut({ duration: 150 });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomIn, zoomOut]);

  return null;
}

function minimapNodeColor(node: Node) {
  if (node.type === "hacker") return "#e53935";
  if (node.type === "victim" || node.type === "victimCluster") return "#f7931a";
  return "#555";
}

export function HackGraph({
  hacker,
  expandVictims,
  minEdgeSats,
  victimSearch,
  onNodeClick,
  onCollapseVictims,
  onHackerChange,
}: {
  hacker: string;
  expandVictims: boolean;
  minEdgeSats: number;
  victimSearch: string | null;
  onNodeClick: (address: string) => void;
  onCollapseVictims?: () => void;
  onHackerChange?: (address: string) => void;
}) {
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const positionsRef = useRef<Record<string, { x: number; y: number }>>({});
  const loadGenerationRef = useRef(0);
  const prevExpandRef = useRef(expandVictims);
  const pendingFitRef = useRef(false);
  const graphDataRef = useRef<{
    rfNodes: Node[];
    rfEdges: Edge[];
    mode: GraphMode;
  } | null>(null);
  const victimSortRef = useRef<VictimSortOption>("btc-desc");
  const [fitViewTrigger, setFitViewTrigger] = useState(0);
  const [victimSort, setVictimSort] = useState<VictimSortOption>("btc-desc");
  const [queued, setQueued] = useState<QueuedJob[]>([]);
  const [countdownTick, setCountdownTick] = useState(0);

  useEffect(() => {
    victimSortRef.current = victimSort;
  }, [victimSort]);

  useEffect(() => {
    positionsRef.current = {};
    graphDataRef.current = null;
    setQueued([]);
    setVictimSort("btc-desc");
    victimSortRef.current = "btc-desc";
    pendingFitRef.current = true;
  }, [hacker, victimSearch, minEdgeSats, expandVictims]);

  useEffect(() => {
    if (expandVictims && !prevExpandRef.current) {
      pendingFitRef.current = true;
    }
    prevExpandRef.current = expandVictims;
  }, [expandVictims]);

  const expandAddress = useCallback(
    async (address: string, parentId: string) => {
      let outgoingAtStart = 0;
      try {
        const detail = await api<{ relatedTxs: Array<{ direction: string }> }>(
          `/api/addresses/${encodeURIComponent(address)}`,
        );
        outgoingAtStart = detail.relatedTxs.filter((t) => t.direction === "out").length;
      } catch {
        /* address detail optional before expand */
      }

      try {
        const res = await api<{
          jobId: number;
          estimatedRunAt: string;
        }>(`/api/expand/${encodeURIComponent(address)}`, { method: "POST" });
        setQueued((q) => [
          ...q,
          {
            jobId: res.jobId,
            parentAddress: address,
            parentId,
            estimatedRunAt: res.estimatedRunAt,
            outgoingAtStart,
          },
        ]);
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        let message = "Expand failed";
        if (raw.includes("409") || raw.toLowerCase().includes("already queued")) {
          message = "Expand already queued for this address";
        } else if (raw.includes("404") || raw.toLowerCase().includes("not in database")) {
          message = "Address not found in indexed data";
        }
        window.dispatchEvent(new CustomEvent("cointrace-toast", { detail: message }));
        console.error(e);
      }
    },
    [],
  );

  const applyLayout = useCallback(
    (rfNodes: Node[], rfEdges: Edge[], mode: GraphMode, sort: VictimSortOption) => {
      const laid = layoutGraph(rfNodes, rfEdges, "LR", mode, sort);
      const merged = laid.map((n) => ({
        ...n,
        position: positionsRef.current[n.id] ?? n.position,
      }));
      setNodes(merged);
      setEdges(rfEdges);
    },
    [setNodes, setEdges],
  );

  const loadGraph = useCallback(
    async (opts?: { expandVictims?: boolean }) => {
      const generation = ++loadGenerationRef.current;
      setNodes([]);
      setEdges([]);

      const params = new URLSearchParams({ depth: "2", min_edge_sats: String(minEdgeSats) });

      if (victimSearch) {
        params.set("victim", victimSearch);
      } else {
        params.set("hacker", hacker);
        const expanded = opts?.expandVictims ?? expandVictims;
        if (expanded) params.set("expand_victims", "1");
      }

      let graph: ApiGraphResponse;
      try {
        graph = await api<ApiGraphResponse>(`/api/graph?${params}`);
      } catch (e) {
        if (victimSearch) {
          window.dispatchEvent(
            new CustomEvent("cointrace-toast", { detail: "Address not found in hack data" }),
          );
        }
        throw e;
      }

      if (generation !== loadGenerationRef.current) return;

      const mode = graph.mode ?? (victimSearch ? "victim-filtered" : "hacker");
      if (mode === "victim-filtered" && graph.matchedHackers?.[0]) {
        onHackerChange?.(graph.matchedHackers[0]);
      }

      const rfNodes: Node[] = graph.nodes.map((n) => ({
        id: n.id,
        type:
          n.type === "victimCluster"
            ? "victimCluster"
            : n.type === "hacker"
              ? "hacker"
              : n.type === "victim"
                ? "victim"
                : "downstream",
        data: {
          type: n.type,
          label: n.label,
          address: n.address,
          childCount: n.childCount,
          totalSats: n.totalSats,
          totalReceivedSats: n.totalReceivedSats,
          liveBalanceSats: n.liveBalanceSats,
          liveBalanceAt: n.liveBalanceAt,
          hopFromHacker: n.hopFromHacker,
          incomingSats: n.incomingSats,
          latestTxTime: n.latestTxTime,
          earliestTxTime: n.earliestTxTime,
          onExpand:
            n.type === "victimCluster"
              ? () => window.dispatchEvent(new CustomEvent("cointrace-expand-victims"))
              : n.address
                ? () => expandAddress(n.address!, n.id)
                : undefined,
        } satisfies GraphNodeData,
        position: positionsRef.current[n.id] ?? { x: 0, y: 0 },
      }));

      const rfEdges: Edge[] = graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        ...edgeDefaults,
        label: e.txid ? `${satsToBtc(e.amount)} BTC` : e.amount > 0 ? `${satsToBtc(e.amount)} BTC` : undefined,
        data: { txid: e.txid, time: e.time },
      }));

      graphDataRef.current = { rfNodes, rfEdges, mode };
      applyLayout(rfNodes, rfEdges, mode, victimSortRef.current);

      if (pendingFitRef.current) {
        pendingFitRef.current = false;
        setFitViewTrigger((t) => t + 1);
      }
    },
    [hacker, expandVictims, minEdgeSats, victimSearch, expandAddress, onHackerChange, setNodes, setEdges, applyLayout],
  );

  useEffect(() => {
    if (!expandVictims || victimSearch || !graphDataRef.current) return;
    const { rfNodes, rfEdges, mode } = graphDataRef.current;
    for (const n of rfNodes) {
      if (n.type === "victim") delete positionsRef.current[n.id];
    }
    applyLayout(rfNodes, rfEdges, mode, victimSort);
    setFitViewTrigger((t) => t + 1);
  }, [victimSort, expandVictims, victimSearch, applyLayout]);

  useEffect(() => {
    loadGraph().catch(console.error);
    const iv = setInterval(() => loadGraph().catch(console.error), 30000);
    return () => clearInterval(iv);
  }, [loadGraph]);

  useEffect(() => {
    const iv = setInterval(() => setCountdownTick((t) => t + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  const checkQueuedJobs = useCallback(async () => {
    if (queued.length === 0) return;
    const done: Array<{ jobId: number; parentAddress: string; outgoingAtStart: number }> = [];
    for (const q of queued) {
      try {
        const job = await api<{ status: string }>(`/api/jobs/${q.jobId}`);
        if (job.status === "done" || job.status === "failed") {
          done.push({
            jobId: q.jobId,
            parentAddress: q.parentAddress,
            outgoingAtStart: q.outgoingAtStart,
          });
        }
      } catch (e) {
        console.error(e);
      }
    }
    if (done.length === 0) return;

    setQueued((prev) => prev.filter((q) => !done.some((d) => d.jobId === q.jobId)));

    for (const item of done) {
      try {
        const detail = await api<{ relatedTxs: Array<{ direction: string }> }>(
          `/api/addresses/${encodeURIComponent(item.parentAddress)}`,
        );
        const outgoingNow = detail.relatedTxs.filter((t) => t.direction === "out").length;
        const message =
          outgoingNow > item.outgoingAtStart
            ? "Expand complete — new downstream flows found"
            : "Expand complete — no downstream flows found";
        window.dispatchEvent(new CustomEvent("cointrace-toast", { detail: message }));
      } catch {
        window.dispatchEvent(new CustomEvent("cointrace-toast", { detail: "Expand complete" }));
      }
    }

    loadGraph().catch(console.error);
  }, [queued, loadGraph]);

  useEffect(() => {
    if (queued.length === 0) return;
    void checkQueuedJobs();
    const iv = setInterval(() => void checkQueuedJobs(), 3000);
    return () => clearInterval(iv);
  }, [queued, checkQueuedJobs]);

  const queuedNodes: Node[] = useMemo(() => {
    void countdownTick;
    return queued.map((q) => {
      const remaining = Math.max(0, Math.ceil((new Date(q.estimatedRunAt).getTime() - Date.now()) / 1000));
      return {
        id: `queued:${q.jobId}`,
        type: "queued",
        data: {
          countdown: remaining > 0 ? `~${remaining}s` : "Processing…",
        } satisfies GraphNodeData,
        position: positionsRef.current[`queued:${q.jobId}`] ?? { x: 400, y: 200 },
      };
    });
  }, [queued, countdownTick]);

  const queuedEdges: Edge[] = queued.map((q) => ({
    id: `qe-${q.jobId}`,
    source: q.parentId,
    target: `queued:${q.jobId}`,
    ...queuedEdgeDefaults,
  }));

  const onNodeDragStop = useCallback((_: unknown, node: Node) => {
    positionsRef.current[node.id] = node.position;
  }, []);

  const onNodeClickHandler = useCallback(
    (_: unknown, node: Node) => {
      const data = node.data as GraphNodeData;
      if (data.address && node.type !== "queued" && node.type !== "victimCluster") {
        onNodeClick(data.address);
      }
    },
    [onNodeClick],
  );

  const onEdgeClick = useCallback((_: unknown, edge: Edge) => {
    const txid = (edge.data as { txid?: string })?.txid;
    if (txid) window.open(txUrl(txid), "_blank");
  }, []);

  const resetLayout = () => {
    positionsRef.current = {};
    if (!victimSearch) {
      onCollapseVictims?.();
      loadGraph({ expandVictims: false }).catch(console.error);
    } else {
      loadGraph().catch(console.error);
    }
  };

  return (
    <div className="graph-canvas">
      <div style={{ width: "100%", height: "100%" }}>
        <ReactFlow
          nodes={[...nodes, ...queuedNodes]}
          edges={[...edges, ...queuedEdges]}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClickHandler}
          onEdgeClick={onEdgeClick}
          onNodeDragStop={onNodeDragStop}
          nodesDraggable
          zoomOnScroll
          zoomOnPinch
          panOnScroll={false}
          panOnDrag
          minZoom={0.1}
          maxZoom={2}
          fitView
          defaultEdgeOptions={edgeDefaults}
          style={{ background: "#000" }}
        >
          <Background color="#222" gap={20} />
          <Panel position="top-left">
            <div className="graph-panel-controls">
              <button type="button" onClick={resetLayout}>
                Reset layout
              </button>
              <label>
                Sort by{" "}
                <select
                  value={victimSort}
                  onChange={(e) => setVictimSort(e.target.value as VictimSortOption)}
                  disabled={!expandVictims || !!victimSearch}
                  aria-label="Sort victims by"
                >
                  <option value="btc-desc">BTC Amount (Large to Small)</option>
                  <option value="btc-asc">BTC Amount (Small to Large)</option>
                  <option value="date-desc">Date Time (New to Old)</option>
                  <option value="date-asc">Date Time (Old to New)</option>
                </select>
              </label>
            </div>
          </Panel>
          <FitViewAfterLayout trigger={fitViewTrigger} />
          <GraphKeyboardShortcuts />
          <Controls />
          {isDesktop && (
            <MiniMap
              style={{ width: 100, height: 75 }}
              nodeColor={minimapNodeColor}
              maskColor="rgba(0,0,0,0.6)"
            />
          )}
        </ReactFlow>
      </div>
    </div>
  );
}
