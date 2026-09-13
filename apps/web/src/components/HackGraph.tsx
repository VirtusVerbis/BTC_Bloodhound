import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { api, txUrl, ApiError } from "../lib/api";
import {
  fetchGraphDeduped,
  findRelatedGraphLoadState,
  getCachedGraphLoadState,
  graphCacheKey,
  setCachedGraphLoadState,
} from "../lib/graphCache";
import {
  canResumeDownstream,
  canTrimLocally,
  filterGraphByLimits,
  type GraphLoadParams,
} from "../lib/graphFilter";
import {
  loadHackerGraphPaginated,
  loadHackerGraphPaginatedResume,
  type ApiGraphEdge,
  type ApiGraphNode,
  type ApiGraphResponse,
  type GraphLoadProgress,
} from "../lib/graphLoader";
import { layoutGraph, type VictimSortOption } from "../lib/layoutGraph";
import { RefundEdge } from "./edges/RefundEdge";
import { nodeTypes, type GraphNodeData } from "./nodes/GraphNodes";
import {
  DEFAULT_EDGE_COLOR,
  DEFAULT_SOURCE_HANDLE,
  DEFAULT_TARGET_HANDLE,
  graphEdgeColor,
  graphEdgeHandles,
  graphEdgeLabel,
  graphEdgeType,
} from "../lib/graphEdgeRender";

type GraphMode = "hacker" | "victim-filtered" | "victim-centric";

const edgeTypes = { refund: RefundEdge };

const defaultEdgeOptions = {
  type: "smoothstep" as const,
  sourceHandle: DEFAULT_SOURCE_HANDLE,
  targetHandle: DEFAULT_TARGET_HANDLE,
  markerEnd: { type: MarkerType.ArrowClosed, color: DEFAULT_EDGE_COLOR },
  style: { stroke: DEFAULT_EDGE_COLOR, strokeWidth: 2 },
};

function edgeStrokeWidth(e: ApiGraphEdge): number {
  if (e.edgeKind === "peel_relay") return 2 + Math.min((e.edgeCount ?? 1) / 20, 4);
  if (e.edgeKind === "spend_fanout") return 2 + Math.min((e.outputCount ?? 1) / 20, 4);
  return 2;
}

function mapApiEdges(apiEdges: ApiGraphEdge[], showEdgeLabels: boolean): Edge[] {
  return apiEdges.map((e) => {
    const color = graphEdgeColor(e);
    const handles = graphEdgeHandles(e);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: handles.sourceHandle,
      targetHandle: handles.targetHandle,
      type: graphEdgeType(e),
      markerEnd: { type: MarkerType.ArrowClosed, color },
      style: { stroke: color, strokeWidth: edgeStrokeWidth(e) },
      label: graphEdgeLabel(e, showEdgeLabels),
      data: {
        txid: e.txid,
        time: e.time,
        edgeKind: e.edgeKind,
        outputCount: e.outputCount,
        topOutputs: e.topOutputs,
      },
    };
  });
}

function filterEdgesToNodes(nodes: ApiGraphNode[], edges: ApiGraphEdge[]): ApiGraphEdge[] {
  const nodeIds = new Set(nodes.map((n) => n.id));
  return edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
}

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
  maxVictimNodes,
  maxDownstreamNodes,
  graphPageSize,
  victimSearch,
  onNodeClick,
  onCollapseVictims,
  onHackerChange,
}: {
  hacker: string;
  expandVictims: boolean;
  minEdgeSats: number;
  maxVictimNodes: number;
  maxDownstreamNodes: number;
  graphPageSize: number;
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
  const lastGraphKeyRef = useRef<string | null>(null);
  const lastLoadedParamsRef = useRef<GraphLoadParams | null>(null);
  const prevExpandRef = useRef(expandVictims);
  const pendingFitRef = useRef(false);
  const graphDataRef = useRef<{
    rfNodes: Node[];
    rfEdges: Edge[];
    mode: GraphMode;
    apiEdges: ApiGraphEdge[];
  } | null>(null);
  const victimSortRef = useRef<VictimSortOption>("btc-desc");
  const [fitViewTrigger, setFitViewTrigger] = useState(0);
  const [victimSort, setVictimSort] = useState<VictimSortOption>("btc-desc");
  const [showLabels, setShowLabels] = useState(false);
  const [nodesInteractive, setNodesInteractive] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphLoadProgress, setGraphLoadProgress] = useState<GraphLoadProgress | null>(null);

  const flowKey = useMemo(
    () =>
      graphCacheKey({
        hacker,
        victimSearch,
        minEdgeSats,
        maxVictimNodes,
        maxDownstreamNodes,
        expandVictims,
      }),
    [hacker, victimSearch, minEdgeSats, maxVictimNodes, maxDownstreamNodes, expandVictims],
  );

  useLayoutEffect(() => {
    setNodes([]);
    setEdges([]);
    setGraphError(null);
    setGraphLoading(false);
    setGraphLoadProgress(null);
  }, [flowKey, setNodes, setEdges]);

  useEffect(() => {
    victimSortRef.current = victimSort;
  }, [victimSort]);

  useEffect(() => {
    positionsRef.current = {};
    graphDataRef.current = null;
    lastLoadedParamsRef.current = null;
    setVictimSort("btc-desc");
    victimSortRef.current = "btc-desc";
    pendingFitRef.current = true;
  }, [hacker, victimSearch, expandVictims]);

  useEffect(() => {
    if (expandVictims && !prevExpandRef.current) {
      pendingFitRef.current = true;
    }
    prevExpandRef.current = expandVictims;
  }, [expandVictims]);

  const applyLayout = useCallback(
    (rfNodes: Node[], rfEdges: Edge[], mode: GraphMode, sort: VictimSortOption) => {
      const laid = layoutGraph(rfNodes, rfEdges, "LR", mode, sort);
      for (const n of laid) {
        if (n.type !== "victim") delete positionsRef.current[n.id];
      }
      const merged = laid.map((n) => ({
        ...n,
        position: positionsRef.current[n.id] ?? n.position,
      }));
      setNodes(merged);
      setEdges(rfEdges);
    },
    [setNodes, setEdges],
  );

  const applyApiGraph = useCallback(
    (graph: ApiGraphResponse) => {
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
          expandProfile: n.expandProfile,
          relayMeta: n.relayMeta,
          fanoutMeta: n.fanoutMeta,
          opReturn: n.opReturn,
          opReturnLabel: n.opReturnLabel,
          showOpReturnLabel: showLabels,
          onExpandVictims:
            n.type === "victimCluster"
              ? () => window.dispatchEvent(new CustomEvent("cointrace-expand-victims"))
              : undefined,
        } satisfies GraphNodeData,
        position: positionsRef.current[n.id] ?? { x: 0, y: 0 },
      }));

      const validApiEdges = filterEdgesToNodes(graph.nodes, graph.edges);
      const rfEdges = mapApiEdges(validApiEdges, showLabels);

      graphDataRef.current = { rfNodes, rfEdges, mode, apiEdges: validApiEdges };
      applyLayout(rfNodes, rfEdges, mode, victimSortRef.current);

      if (pendingFitRef.current) {
        pendingFitRef.current = false;
        setFitViewTrigger((t) => t + 1);
      }
    },
    [victimSearch, onHackerChange, showLabels, applyLayout],
  );

  const loadGraph = useCallback(
    async (opts?: { expandVictims?: boolean; skipCache?: boolean }) => {
      const expanded = opts?.expandVictims ?? expandVictims;
      const key = graphCacheKey({
        hacker,
        victimSearch,
        minEdgeSats,
        maxVictimNodes,
        maxDownstreamNodes,
        expandVictims: expanded,
      });
      const generation = ++loadGenerationRef.current;
      setGraphError(null);

      const loadParams: GraphLoadParams = {
        hacker,
        minEdgeSats,
        maxVictims: maxVictimNodes,
        maxDownstream: maxDownstreamNodes,
        expandVictims: expanded,
      };

      const keyChanged = key !== lastGraphKeyRef.current;
      const needsClear = keyChanged || opts?.skipCache === true;

      const searchParams = new URLSearchParams({
        min_edge_sats: String(minEdgeSats),
        max_victims: String(maxVictimNodes),
        max_downstream: String(maxDownstreamNodes),
      });

      if (victimSearch) {
        searchParams.set("victim", victimSearch);
        searchParams.set("depth", "2");
      } else {
        searchParams.set("hacker", hacker);
        if (expanded) searchParams.set("expand_victims", "1");
      }

      if (!opts?.skipCache) {
        const cachedState = getCachedGraphLoadState(key);
        if (cachedState && generation === loadGenerationRef.current) {
          if (needsClear || graphDataRef.current === null) {
            applyApiGraph(cachedState.response);
            lastGraphKeyRef.current = key;
            lastLoadedParamsRef.current = cachedState.params;
          }
          setGraphLoading(false);
          setGraphLoadProgress(null);
          return;
        }

        if (!victimSearch) {
          const related = findRelatedGraphLoadState(loadParams, victimSearch);
          if (related && canTrimLocally(related.params, loadParams)) {
            const filtered = filterGraphByLimits(related.response, loadParams);
            const trimmedState = { ...related, response: filtered, params: loadParams };
            setCachedGraphLoadState(key, trimmedState);
            applyApiGraph(filtered);
            lastGraphKeyRef.current = key;
            lastLoadedParamsRef.current = loadParams;
            setGraphLoading(false);
            setGraphLoadProgress(null);
            return;
          }
        }
      }

      setGraphLoading(true);
      setGraphLoadProgress({ phase: "l1", loaded: 0, total: null, percent: 0, message: "Loading" });

      const loaderOpts = {
        onProgress: (progress: GraphLoadProgress) => {
          if (generation === loadGenerationRef.current) {
            setGraphLoadProgress(progress);
          }
        },
        signal: {
          generation,
          current: () => loadGenerationRef.current,
        },
      };

      const paginatedParams = {
        hacker,
        minEdgeSats,
        maxDownstream: maxDownstreamNodes,
        maxVictims: maxVictimNodes,
        expandVictims: expanded,
        pageSize: graphPageSize,
      };

      let graph: ApiGraphResponse;
      try {
        if (victimSearch) {
          graph = await fetchGraphDeduped(
            key,
            () => api<ApiGraphResponse>(`/api/graph?${searchParams}`),
            { force: opts?.skipCache === true },
          );
        } else if (!opts?.skipCache) {
          const related = findRelatedGraphLoadState(loadParams, victimSearch);
          if (related && canResumeDownstream(related.params, loadParams)) {
            const result = await loadHackerGraphPaginatedResume(related, paginatedParams, loaderOpts);
            graph = result.graph;
            setCachedGraphLoadState(key, result.state);
            lastLoadedParamsRef.current = result.state.params;
          } else {
            const result = await loadHackerGraphPaginated(paginatedParams, loaderOpts);
            graph = result.graph;
            setCachedGraphLoadState(key, result.state);
            lastLoadedParamsRef.current = result.state.params;
          }
        } else {
          const result = await loadHackerGraphPaginated(paginatedParams, loaderOpts);
          graph = result.graph;
          setCachedGraphLoadState(key, result.state);
          lastLoadedParamsRef.current = result.state.params;
        }
      } catch (e) {
        if (generation !== loadGenerationRef.current) return;
        if (e instanceof Error && e.message === "aborted") return;
        if (victimSearch) {
          window.dispatchEvent(
            new CustomEvent("cointrace-toast", { detail: "Address not found in hack data" }),
          );
        } else {
          const message =
            e instanceof ApiError && e.message ? e.message : "Graph failed to load. Try again.";
          setGraphError(message);
          window.dispatchEvent(
            new CustomEvent("cointrace-toast", { detail: "Graph failed to load. Try again." }),
          );
        }
        setGraphLoading(false);
        setGraphLoadProgress(null);
        return;
      }

      if (generation !== loadGenerationRef.current) return;

      if (victimSearch) {
        setCachedGraphLoadState(key, {
          response: graph,
          params: loadParams,
          l1: { loadedL1: 0, nextCursor: null, done: true },
          l2Sessions: [],
        });
      }
      applyApiGraph(graph);
      lastGraphKeyRef.current = key;
      setGraphLoading(false);
      setGraphLoadProgress(null);
    },
    [
      hacker,
      expandVictims,
      minEdgeSats,
      maxVictimNodes,
      maxDownstreamNodes,
      graphPageSize,
      victimSearch,
      applyApiGraph,
    ],
  );

  useEffect(() => {
    const cached = graphDataRef.current;
    if (!cached?.apiEdges) return;
    const rfEdges = mapApiEdges(cached.apiEdges, showLabels);
    graphDataRef.current = { ...cached, rfEdges };
    setEdges(rfEdges);
  }, [showLabels, setEdges]);

  useEffect(() => {
    if (!graphDataRef.current) return;
    setNodes((current) =>
      current.map((n) => ({
        ...n,
        data: { ...(n.data as GraphNodeData), showOpReturnLabel: showLabels },
      })),
    );
  }, [showLabels, setNodes]);

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
  }, [loadGraph]);

  const onNodeDragStop = useCallback((_: unknown, node: Node) => {
    positionsRef.current[node.id] = node.position;
  }, []);

  const onNodeClickHandler = useCallback(
    (_: unknown, node: Node) => {
      const data = node.data as GraphNodeData;
      if (data.address && node.type !== "victimCluster") {
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
      {graphLoading && nodes.length === 0 && !graphError && (
        <div className="graph-status-overlay" role="status">
          <p>Loading graph…{graphLoadProgress ? ` ${graphLoadProgress.percent}%` : ""}</p>
        </div>
      )}
      {graphError && nodes.length === 0 && (
        <div className="graph-error-overlay" role="alert">
          <p>{graphError}</p>
          <button
            type="button"
            onClick={() => loadGraph({ skipCache: true }).catch(console.error)}
          >
            Retry
          </button>
        </div>
      )}
      <div style={{ width: "100%", height: "100%" }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={onNodeClickHandler}
          onEdgeClick={onEdgeClick}
          onNodeDragStop={onNodeDragStop}
          nodesDraggable={nodesInteractive}
          nodesConnectable={nodesInteractive}
          elementsSelectable={nodesInteractive}
          zoomOnScroll
          zoomOnPinch
          panOnScroll={false}
          panOnDrag
          minZoom={0.1}
          maxZoom={2}
          fitView
          defaultEdgeOptions={defaultEdgeOptions}
          style={{ background: "#000" }}
        >
          <Background color="#222" gap={20} />
          {graphLoading && graphLoadProgress && (
            <Panel position="top-right">
              <div className="graph-load-progress" role="status" aria-live="polite">
                Loading… {graphLoadProgress.percent}%
              </div>
            </Panel>
          )}
          <Panel position="top-left">
            <div className="graph-panel-controls">
              <div className="graph-panel-controls-stack">
                <button type="button" onClick={resetLayout}>
                  Reset layout
                </button>
                <label className="graph-panel-switch">
                  <input
                    type="checkbox"
                    checked={showLabels}
                    onChange={(e) => setShowLabels(e.target.checked)}
                  />
                  Show labels
                </label>
              </div>
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
          <Controls onInteractiveChange={setNodesInteractive} />
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
