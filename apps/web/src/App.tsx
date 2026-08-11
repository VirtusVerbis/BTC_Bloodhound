import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AboutPage } from "./components/AboutPage";
import { HackElapsedLabel } from "./components/HackElapsedLabel";
import { HackGraph } from "./components/HackGraph";
import { AddressDetailDrawer } from "./components/AddressDetailDrawer";
import { MonitoringIndicator, type MonitoringSyncStatus } from "./components/MonitoringIndicator";
import { BtcUsdProvider } from "./context/BtcUsdContext";
import { api, formatBtcSpotUsd, formatUsd, satsToBtc, satsToUsd } from "./lib/api";
import {
  clampGraphNodeCount,
  commitGraphNodeDraft,
  commitMinAmountDraft,
  DEFAULT_MAX_DOWNSTREAM_NODES,
  DEFAULT_MAX_GRAPH_NODE_CAP,
  DEFAULT_MAX_VICTIM_NODES,
  DEFAULT_MIN_EDGE_SATS,
  formatMinAmountDraft,
  graphNodeInputMaxLength,
  MIN_BTC_INPUT_MAX_LENGTH,
  MIN_SATS_INPUT_MAX_LENGTH,
} from "./lib/graphInputLimits";
import { groupHackersBySource, type Hacker } from "./lib/hackerGroups";

type AppTab = "tracker" | "about";

interface Stats {
  victimCount: number;
  hackerCount: number;
  totalInSats: number;
  totalOutSats: number;
  lastJobAt: string | null;
  btcUsdPrice: number | null;
  btcUsdPriceAt: string | null;
}

interface SyncStatus extends MonitoringSyncStatus {
  queueDepth: number;
  crawlPendingCount: number;
  treeNodeCount?: number;
  downstreamPollDueCount?: number;
}

interface AppConfig {
  minEdgeSats: number;
  statsPollMs?: number;
  maxGraphVictims?: number;
  maxGraphDownstream?: number;
}

const DEFAULT_STATS_POLL_MS = 3_600_000;
const SYNC_POLL_MS = 15_000;

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

function commitOnEnter(e: KeyboardEvent<HTMLInputElement>, commit: () => void) {
  if (e.key === "Enter") {
    e.preventDefault();
    commit();
    e.currentTarget.blur();
  }
}

export default function App() {
  const [hackers, setHackers] = useState<Hacker[]>([]);
  const [selected, setSelected] = useState("");
  const [filter, setFilter] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [drawerAddr, setDrawerAddr] = useState<string | null>(null);
  const [expandVictims, setExpandVictims] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [rateLimitSecondsLeft, setRateLimitSecondsLeft] = useState<number | null>(null);
  const [minEdgeSats, setMinEdgeSats] = useState(DEFAULT_MIN_EDGE_SATS);
  const [statsPollMs, setStatsPollMs] = useState(DEFAULT_STATS_POLL_MS);
  const [minAmountUnit, setMinAmountUnit] = useState<"sats" | "btc">("sats");
  const [maxVictimNodes, setMaxVictimNodes] = useState(DEFAULT_MAX_VICTIM_NODES);
  const [maxDownstreamNodes, setMaxDownstreamNodes] = useState(DEFAULT_MAX_DOWNSTREAM_NODES);
  const [minAmountDraft, setMinAmountDraft] = useState(String(DEFAULT_MIN_EDGE_SATS));
  const [maxVictimDraft, setMaxVictimDraft] = useState(String(DEFAULT_MAX_VICTIM_NODES));
  const [maxDownstreamDraft, setMaxDownstreamDraft] = useState(String(DEFAULT_MAX_DOWNSTREAM_NODES));
  const [configMinEdgeSats, setConfigMinEdgeSats] = useState(DEFAULT_MIN_EDGE_SATS);
  const [graphMaxVictims, setGraphMaxVictims] = useState(DEFAULT_MAX_GRAPH_NODE_CAP);
  const [graphMaxDownstream, setGraphMaxDownstream] = useState(DEFAULT_MAX_GRAPH_NODE_CAP);
  const [victimSearchInput, setVictimSearchInput] = useState("");
  const [activeVictimSearch, setActiveVictimSearch] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>("tracker");
  const prevApiThresholdRef = useRef(false);
  const minAmountFocusedRef = useRef(false);

  const loadHackers = useCallback(async (q?: string) => {
    const params = q ? `?q=${encodeURIComponent(q)}` : "";
    const res = await api<{ hackers: Hacker[] }>(`/api/hackers${params}`);
    setHackers(res.hackers);
    const visible = groupHackersBySource(res.hackers).flatMap((g) => g.items);
    if (!selected || !visible.some((h) => h.address === selected)) {
      setSelected(visible[0]?.address ?? "");
    }
  }, [selected]);

  const hackerGroups = useMemo(() => groupHackersBySource(hackers), [hackers]);
  const sortedHackers = useMemo(
    () => hackerGroups.flatMap((g) => g.items),
    [hackerGroups],
  );

  useEffect(() => {
    loadHackers(filter).catch(console.error);
  }, [filter, loadHackers]);

  useEffect(() => {
    api<AppConfig>("/api/config")
      .then((cfg) => {
        setConfigMinEdgeSats(cfg.minEdgeSats);
        setMinEdgeSats(cfg.minEdgeSats);
        if (!minAmountFocusedRef.current) {
          setMinAmountDraft(String(cfg.minEdgeSats));
        }
        if (cfg.statsPollMs != null && Number.isFinite(cfg.statsPollMs) && cfg.statsPollMs >= 1000) {
          setStatsPollMs(Math.floor(cfg.statsPollMs));
        }
        const victimsCap =
          cfg.maxGraphVictims != null && Number.isFinite(cfg.maxGraphVictims) && cfg.maxGraphVictims >= 1
            ? Math.floor(cfg.maxGraphVictims)
            : DEFAULT_MAX_GRAPH_NODE_CAP;
        const downstreamCap =
          cfg.maxGraphDownstream != null &&
          Number.isFinite(cfg.maxGraphDownstream) &&
          cfg.maxGraphDownstream >= 1
            ? Math.floor(cfg.maxGraphDownstream)
            : DEFAULT_MAX_GRAPH_NODE_CAP;
        setGraphMaxVictims(victimsCap);
        setGraphMaxDownstream(downstreamCap);
        setMaxVictimNodes((n) => clampGraphNodeCount(n, victimsCap));
        setMaxVictimDraft((d) => String(clampGraphNodeCount(Number(d) || DEFAULT_MAX_VICTIM_NODES, victimsCap)));
        setMaxDownstreamNodes((n) => clampGraphNodeCount(n, downstreamCap));
        setMaxDownstreamDraft((d) =>
          String(clampGraphNodeCount(Number(d) || DEFAULT_MAX_DOWNSTREAM_NODES, downstreamCap)),
        );
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    const loadStats = () => api<Stats>("/api/stats").then(setStats).catch(console.error);
    loadStats();
    const iv = setInterval(loadStats, statsPollMs);
    return () => clearInterval(iv);
  }, [statsPollMs]);

  useEffect(() => {
    const loadSync = () => {
      api<SyncStatus>("/api/sync/status")
        .then((status) => {
          if (status.apiThresholdExceeded && !prevApiThresholdRef.current) {
            window.dispatchEvent(
              new CustomEvent("cointrace-toast", {
                detail: "API rate limit hit — indexing slowed",
              }),
            );
          }
          prevApiThresholdRef.current = status.apiThresholdExceeded === true;
          setSync(status);
        })
        .catch(console.error);
    };
    loadSync();
    const iv = setInterval(loadSync, SYNC_POLL_MS);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    const onToast = (e: Event) => setToast((e as CustomEvent).detail as string);
    const onExpandVictims = () => setExpandVictims(true);
    const onRateLimit = (e: Event) => {
      const sec = (e as CustomEvent<{ retryAfterSec?: number }>).detail?.retryAfterSec;
      setRateLimitSecondsLeft(Math.max(1, Number(sec) || 60));
    };
    window.addEventListener("cointrace-toast", onToast);
    window.addEventListener("cointrace-expand-victims", onExpandVictims);
    window.addEventListener("cointrace-rate-limit", onRateLimit);
    return () => {
      window.removeEventListener("cointrace-toast", onToast);
      window.removeEventListener("cointrace-expand-victims", onExpandVictims);
      window.removeEventListener("cointrace-rate-limit", onRateLimit);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(t);
  }, [toast]);

  const rateLimitActive = rateLimitSecondsLeft != null && rateLimitSecondsLeft > 0;
  useEffect(() => {
    if (!rateLimitActive) return;
    const t = setInterval(() => {
      setRateLimitSecondsLeft((prev) => {
        if (prev == null || prev <= 1) return null;
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [rateLimitActive]);

  useEffect(() => {
    if (activeTab !== "tracker" || sortedHackers.length === 0) return;

    const onKey = (e: globalThis.KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.key !== "PageUp" && e.key !== "PageDown") return;

      e.preventDefault();
      const idx = sortedHackers.findIndex((h) => h.address === selected);
      const current = idx >= 0 ? idx : 0;
      const next =
        e.key === "PageDown"
          ? Math.min(current + 1, sortedHackers.length - 1)
          : Math.max(current - 1, 0);
      if (next !== current) setSelected(sortedHackers[next].address);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTab, sortedHackers, selected]);

  const findVictim = () => {
    const addr = victimSearchInput.trim().toLowerCase();
    if (!addr) return;
    setActiveVictimSearch(addr);
    setExpandVictims(false);
    // minEdgeSats / maxVictimNodes stay as the user set them; API ignores them while searching.
  };

  const clearVictimSearch = () => {
    setVictimSearchInput("");
    setActiveVictimSearch(null);
    setExpandVictims(false);
    // Resume user min sats / max victims on the next hacker graph load (state unchanged).
  };

  const navigateToMonitoring = () => {
    setActiveTab("about");
    requestAnimationFrame(() => {
      document.getElementById("monitoring")?.scrollIntoView({ behavior: "smooth" });
    });
  };

  const commitMinAmount = useCallback(() => {
    commitMinAmountDraft(minAmountDraft, minAmountUnit, configMinEdgeSats, setMinEdgeSats, setMinAmountDraft);
  }, [minAmountDraft, minAmountUnit, configMinEdgeSats]);

  const commitMaxVictim = useCallback(() => {
    commitGraphNodeDraft(
      maxVictimDraft,
      DEFAULT_MAX_VICTIM_NODES,
      setMaxVictimNodes,
      setMaxVictimDraft,
      graphMaxVictims,
    );
  }, [maxVictimDraft, graphMaxVictims]);

  const commitMaxDownstream = useCallback(() => {
    commitGraphNodeDraft(
      maxDownstreamDraft,
      DEFAULT_MAX_DOWNSTREAM_NODES,
      setMaxDownstreamNodes,
      setMaxDownstreamDraft,
      graphMaxDownstream,
    );
  }, [maxDownstreamDraft, graphMaxDownstream]);

  const victimInputMaxLen = graphNodeInputMaxLength(graphMaxVictims);
  const downstreamInputMaxLen = graphNodeInputMaxLength(graphMaxDownstream);

  return (
    <BtcUsdProvider price={stats?.btcUsdPrice ?? null}>
    <div>
      <header className="app-header">
        <MonitoringIndicator
          sync={sync}
          onNavigateMonitoring={navigateToMonitoring}
          rateLimitSecondsLeft={rateLimitSecondsLeft}
        />
        <div className="app-header-title-row">
          <h1>Bitcoin Bloodhound — Coldcard Hack Tracker</h1>
          <HackElapsedLabel />
        </div>
        <nav className="app-tabs" role="tablist" aria-label="Main navigation">
          <button
            type="button"
            role="tab"
            className={`app-tab${activeTab === "tracker" ? " active" : ""}`}
            aria-selected={activeTab === "tracker"}
            onClick={() => setActiveTab("tracker")}
          >
            Tracker
          </button>
          <button
            type="button"
            role="tab"
            className={`app-tab${activeTab === "about" ? " active" : ""}`}
            aria-selected={activeTab === "about"}
            onClick={() => setActiveTab("about")}
          >
            About
          </button>
        </nav>
        <div className="stats-row">
          {stats && (
            <>
              <span>{stats.victimCount} victims indexed</span>
              <span className="stats-hacker-count">{stats.hackerCount} hacker addresses</span>
              <span className="stats-hack-btc">
                {satsToBtc(stats.totalInSats)} BTC stolen =
                {stats.btcUsdPrice != null && (
                  <>
                    <span className="usd-value">
                      {" "}
                      {formatUsd(satsToUsd(stats.totalInSats, stats.btcUsdPrice))}
                    </span>
                    <span className="btc-spot-price">
                      {" @ "}
                      {formatBtcSpotUsd(stats.btcUsdPrice)} USD/BTC
                    </span>
                  </>
                )}
              </span>
            </>
          )}
          {sync && (
            <span className="sync-stats">
              <span title="Background indexer jobs waiting to run (polls, expansions, and sync tasks).">
                Queue: {sync.queueDepth}
              </span>
              {" · "}
              <span title="Downstream addresses discovered but not yet expanded to trace further outgoing flows.">
                Crawl pending: {sync.crawlPendingCount}
              </span>
              {sync.treeNodeCount != null && (
                <>
                  {" · "}
                  <span title="Downstream addresses currently indexed within the crawl depth limit.">
                    Tree: {sync.treeNodeCount}
                  </span>
                  {" · "}
                  <span title="Downstream addresses due for a re-poll to check for new outgoing activity.">
                    Poll due: {sync.downstreamPollDueCount ?? 0}
                  </span>
                </>
              )}
            </span>
          )}
        </div>
      </header>

      {activeTab === "tracker" ? (
        <>
      <div className="controls-panel">
        <div className="controls-row">
          <label>
            Hacker address{" "}
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              {hackerGroups.map((group) => (
                <optgroup key={group.source} label={group.label}>
                  {group.items.map((h) => (
                    <option key={h.address} value={h.address}>
                      {(h.label ?? h.address.slice(0, 12)) + "…"} ({satsToBtc(h.totalReceivedSats)} BTC)
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <input
            placeholder="Search hackers…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <label>
            Minimum{" "}
            <input
              type="text"
              inputMode={minAmountUnit === "btc" ? "decimal" : "numeric"}
              maxLength={minAmountUnit === "btc" ? MIN_BTC_INPUT_MAX_LENGTH : MIN_SATS_INPUT_MAX_LENGTH}
              value={minAmountDraft}
              onChange={(e) => setMinAmountDraft(e.target.value)}
              onFocus={() => {
                minAmountFocusedRef.current = true;
              }}
              onBlur={() => {
                minAmountFocusedRef.current = false;
                commitMinAmount();
              }}
              onKeyDown={(e) => commitOnEnter(e, commitMinAmount)}
            />
            <select
              value={minAmountUnit}
              onChange={(e) => {
                const unit = e.target.value as "sats" | "btc";
                setMinAmountUnit(unit);
                setMinAmountDraft(formatMinAmountDraft(minEdgeSats, unit));
              }}
              aria-label="Minimum amount unit"
            >
              <option value="sats">sats</option>
              <option value="btc">BTC</option>
            </select>
          </label>
          <label>
            Max victim nodes{" "}
            <input
              type="text"
              inputMode="numeric"
              maxLength={victimInputMaxLen}
              value={maxVictimDraft}
              onChange={(e) => setMaxVictimDraft(e.target.value.slice(0, victimInputMaxLen))}
              onBlur={commitMaxVictim}
              onKeyDown={(e) => commitOnEnter(e, commitMaxVictim)}
            />
          </label>
          <label>
            Max downstream nodes{" "}
            <input
              type="text"
              inputMode="numeric"
              maxLength={downstreamInputMaxLen}
              value={maxDownstreamDraft}
              onChange={(e) =>
                setMaxDownstreamDraft(e.target.value.slice(0, downstreamInputMaxLen))
              }
              onBlur={commitMaxDownstream}
              onKeyDown={(e) => commitOnEnter(e, commitMaxDownstream)}
            />
          </label>
        </div>

        <div className="controls-row">
          <label>
            Victim address{" "}
            <input
              placeholder="bc1q…"
              value={victimSearchInput}
              onChange={(e) => setVictimSearchInput(e.target.value)}
            />
          </label>
          <button type="button" onClick={findVictim}>
            Find
          </button>
          <button type="button" onClick={clearVictimSearch} disabled={!activeVictimSearch && !victimSearchInput}>
            Clear
          </button>
        </div>
      </div>

      {selected && (
        <div style={{ padding: "0 1.5rem 1rem" }}>
          <HackGraph
            hacker={selected}
            expandVictims={expandVictims}
            minEdgeSats={minEdgeSats}
            maxVictimNodes={maxVictimNodes}
            maxDownstreamNodes={maxDownstreamNodes}
            victimSearch={activeVictimSearch}
            onNodeClick={setDrawerAddr}
            onCollapseVictims={() => setExpandVictims(false)}
            onHackerChange={setSelected}
          />
        </div>
      )}
        </>
      ) : (
        <AboutPage sync={sync} />
      )}

      {drawerAddr && <AddressDetailDrawer address={drawerAddr} onClose={() => setDrawerAddr(null)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
    </BtcUsdProvider>
  );
}
