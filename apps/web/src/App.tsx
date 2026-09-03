import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AboutPage } from "./components/AboutPage";
import { HackElapsedLabel } from "./components/HackElapsedLabel";
import { HackGraph } from "./components/HackGraph";
import { AddressDetailDrawer } from "./components/AddressDetailDrawer";
import {
  formatHoursMinutesCountdown,
  MonitoringIndicator,
  type MonitoringSyncStatus,
} from "./components/MonitoringIndicator";
import { BtcUsdProvider } from "./context/BtcUsdContext";
import { api, formatBtcSpotUsd, formatUsd, satsToBtc, satsToUsd, ApiError, secondsUntilIso } from "./lib/api";
import {
  extractMonitoringSnapshot,
  hasMeaningfulMonitoring,
  saveMonitoringCache,
  saveMonitoringCacheFromD1Quota,
} from "./lib/monitoringCache";
import { formatQuotaUsageLine, type QuotaUsageDisplay } from "./lib/quotaFormat";
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
import {
  groupHackersForDropdown,
  formatHackerOptionLabel,
  isHackerRecent,
  type Hacker,
  type RecentHackerEntry,
} from "./lib/hackerGroups";

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
  d1Quota?: {
    blocked: boolean;
    readRetryAfterAt: string | null;
    writeRetryAfterAt: string | null;
    rowsRead: number;
    rowsWritten: number;
    workersRequests: number;
    rowsReadLimit: number;
    rowsWrittenLimit: number;
    workersRequestsLimit: number;
  };
}

interface AppConfig {
  minEdgeSats: number;
  statsPollMs?: number;
  maxGraphVictims?: number;
  maxGraphDownstream?: number;
  graphPageSizeDefault?: number;
  graphPageSizeMax?: number;
  recentHackersLimit?: number;
  hackersPollMs?: number;
  cronIndexerPaused?: boolean;
}

const DEFAULT_STATS_POLL_MS = 900_000;
const DEFAULT_HACKERS_POLL_MS = 3_600_000;
const MIN_HACKERS_POLL_MS = 60_000;
const DEFAULT_GRAPH_PAGE_SIZE = 500;
const SYNC_POLL_MS = 15_000;
const DEFER_SECONDARY_POLLS_MS = 3_000;

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

function latestD1QuotaRetryAfterAt(d1Quota: SyncStatus["d1Quota"]): string | null {
  if (!d1Quota?.blocked) return null;
  const candidates = [d1Quota.readRetryAfterAt, d1Quota.writeRetryAfterAt].filter(
    (iso): iso is string => iso != null && iso !== "",
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, iso) =>
    new Date(iso).getTime() > new Date(latest).getTime() ? iso : latest,
  );
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
  const [d1QuotaSecondsLeft, setD1QuotaSecondsLeft] = useState<number | null>(null);
  const [d1QuotaUsage, setD1QuotaUsage] = useState<QuotaUsageDisplay | null>(null);
  const [apiThresholdSecondsLeft, setApiThresholdSecondsLeft] = useState<number | null>(null);
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
  const [graphPageSize, setGraphPageSize] = useState(DEFAULT_GRAPH_PAGE_SIZE);
  const [victimSearchInput, setVictimSearchInput] = useState("");
  const [activeVictimSearch, setActiveVictimSearch] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>("tracker");
  const [recentHackers, setRecentHackers] = useState<RecentHackerEntry[]>([]);
  const [hackersPollMs, setHackersPollMs] = useState(DEFAULT_HACKERS_POLL_MS);
  const [hackersLoading, setHackersLoading] = useState(false);
  const prevApiThresholdRef = useRef(false);
  const minAmountFocusedRef = useRef(false);

  const loadHackers = useCallback(async (q?: string) => {
    setHackersLoading(true);
    try {
      const params = q ? `?q=${encodeURIComponent(q)}` : "";
      const res = await api<{ hackers: Hacker[]; recentHackers: RecentHackerEntry[] }>(
        `/api/hackers${params}`,
      );
      setRecentHackers(res.recentHackers ?? []);
      setHackers(res.hackers);
      const visible = groupHackersForDropdown(res.hackers, res.recentHackers ?? []).flatMap(
        (g) => g.items,
      );
      if (!selected || !visible.some((h) => h.address === selected)) {
        setSelected(visible[0]?.address ?? "");
      }
    } catch (e) {
      const isD1Quota = e instanceof ApiError && e.code === "d1_quota_exceeded";
      if (!isD1Quota) {
        window.dispatchEvent(
          new CustomEvent("cointrace-toast", { detail: "Failed to load hackers. Try again." }),
        );
      }
    } finally {
      setHackersLoading(false);
    }
  }, [selected]);

  const recentHackerAddresses = useMemo(
    () => new Set(recentHackers.map((entry) => entry.address)),
    [recentHackers],
  );

  const hackerDropdownGroups = useMemo(
    () => groupHackersForDropdown(hackers, recentHackers),
    [hackers, recentHackers],
  );
  const sortedHackers = useMemo(
    () => hackerDropdownGroups.flatMap((g) => g.items),
    [hackerDropdownGroups],
  );

  useEffect(() => {
    loadHackers(filter).catch(console.error);
  }, [filter, loadHackers]);

  useEffect(() => {
    const pollMs = Math.max(MIN_HACKERS_POLL_MS, hackersPollMs);
    const iv = setInterval(() => {
      loadHackers(filter).catch(console.error);
    }, pollMs);
    return () => clearInterval(iv);
  }, [filter, loadHackers, hackersPollMs]);

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
        if (
          cfg.hackersPollMs != null &&
          Number.isFinite(cfg.hackersPollMs) &&
          cfg.hackersPollMs >= MIN_HACKERS_POLL_MS
        ) {
          setHackersPollMs(Math.floor(cfg.hackersPollMs));
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
        if (
          cfg.graphPageSizeDefault != null &&
          Number.isFinite(cfg.graphPageSizeDefault) &&
          cfg.graphPageSizeDefault >= 1
        ) {
          setGraphPageSize(Math.floor(cfg.graphPageSizeDefault));
        }
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
    const initial = setTimeout(loadStats, DEFER_SECONDARY_POLLS_MS);
    const iv = setInterval(loadStats, statsPollMs);
    return () => {
      clearTimeout(initial);
      clearInterval(iv);
    };
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
          const thresholdLeft = status.apiThresholdSecondsLeft;
          setApiThresholdSecondsLeft(
            thresholdLeft != null && thresholdLeft > 0 ? Math.ceil(thresholdLeft) : null,
          );
          const d1RetryAt = latestD1QuotaRetryAfterAt(status.d1Quota);
          if (d1RetryAt) {
            setD1QuotaSecondsLeft(secondsUntilIso(d1RetryAt));
          }
          if (status.d1Quota?.blocked) {
            setD1QuotaUsage({
              rowsRead: status.d1Quota.rowsRead,
              rowsWritten: status.d1Quota.rowsWritten,
              workersRequests: status.d1Quota.workersRequests,
              rowsReadLimit: status.d1Quota.rowsReadLimit,
              rowsWrittenLimit: status.d1Quota.rowsWrittenLimit,
              workersRequestsLimit: status.d1Quota.workersRequestsLimit,
            });
          }
          if (hasMeaningfulMonitoring(status)) {
            saveMonitoringCache(extractMonitoringSnapshot(status));
          }
          setSync(status);
        })
        .catch(console.error);
    };
    const initial = setTimeout(loadSync, DEFER_SECONDARY_POLLS_MS);
    const iv = setInterval(loadSync, SYNC_POLL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(iv);
    };
  }, []);

  useEffect(() => {
    const onToast = (e: Event) => setToast((e as CustomEvent).detail as string);
    const onExpandVictims = () => setExpandVictims(true);
    const onRateLimit = (e: Event) => {
      const sec = (e as CustomEvent<{ retryAfterSec?: number }>).detail?.retryAfterSec;
      setRateLimitSecondsLeft(Math.max(1, Number(sec) || 60));
    };
    const onD1Quota = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          retryAfterSec?: number;
          retryAfterAt?: string | null;
          rowsRead?: number;
          rowsWritten?: number;
          workersRequests?: number;
          rowsReadLimit?: number;
          rowsWrittenLimit?: number;
          workersRequestsLimit?: number;
        }>
      ).detail;
      const retryAfterAt = detail?.retryAfterAt;
      const sec =
        retryAfterAt != null
          ? secondsUntilIso(retryAfterAt)
          : Math.max(1, Number(detail?.retryAfterSec) || 60);
      setD1QuotaSecondsLeft(sec);
      if (
        detail?.rowsReadLimit != null &&
        detail?.rowsWrittenLimit != null &&
        detail?.workersRequestsLimit != null
      ) {
        setD1QuotaUsage({
          rowsRead: detail.rowsRead ?? 0,
          rowsWritten: detail.rowsWritten ?? 0,
          workersRequests: detail.workersRequests ?? 0,
          rowsReadLimit: detail.rowsReadLimit,
          rowsWrittenLimit: detail.rowsWrittenLimit,
          workersRequestsLimit: detail.workersRequestsLimit,
        });
        saveMonitoringCacheFromD1Quota({
          rowsRead: detail.rowsRead ?? 0,
          rowsWritten: detail.rowsWritten ?? 0,
          workersRequests: detail.workersRequests ?? 0,
          rowsReadLimit: detail.rowsReadLimit,
          rowsWrittenLimit: detail.rowsWrittenLimit,
          workersRequestsLimit: detail.workersRequestsLimit,
          blocked: true,
        });
      }
    };
    window.addEventListener("cointrace-toast", onToast);
    window.addEventListener("cointrace-expand-victims", onExpandVictims);
    window.addEventListener("cointrace-rate-limit", onRateLimit);
    window.addEventListener("cointrace-d1-quota", onD1Quota);
    return () => {
      window.removeEventListener("cointrace-toast", onToast);
      window.removeEventListener("cointrace-expand-victims", onExpandVictims);
      window.removeEventListener("cointrace-rate-limit", onRateLimit);
      window.removeEventListener("cointrace-d1-quota", onD1Quota);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(t);
  }, [toast]);

  const rateLimitActive = rateLimitSecondsLeft != null && rateLimitSecondsLeft > 0;
  const d1QuotaActive = d1QuotaSecondsLeft != null && d1QuotaSecondsLeft > 0;
  const thresholdCountdownActive = apiThresholdSecondsLeft != null && apiThresholdSecondsLeft > 0;
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
    if (!d1QuotaActive) return;
    const t = setInterval(() => {
      setD1QuotaSecondsLeft((prev) => {
        if (prev == null || prev <= 1) return null;
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [d1QuotaActive]);

  useEffect(() => {
    if (!thresholdCountdownActive) return;
    const t = setInterval(() => {
      setApiThresholdSecondsLeft((prev) => {
        if (prev == null || prev <= 1) return null;
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [thresholdCountdownActive]);

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
          apiThresholdSecondsLeft={apiThresholdSecondsLeft}
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
              <span title="Victim wallet addresses stored in the database, from public trackers and on-chain tracing. Does not include downstream addresses.">
                {stats.victimCount} victims indexed
              </span>
              <span
                className="stats-hacker-count"
                title="Flagged consolidation addresses that received stolen funds from victims."
              >
                {stats.hackerCount} hacker addresses
              </span>
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
          {rateLimitActive && (
            <div className="rate-limit-banner" role="status">
              Rate limit active — too many requests. Try again in {rateLimitSecondsLeft}s.
            </div>
          )}
          {d1QuotaActive && (
            <div className="rate-limit-banner" role="status">
              Database temporarily unavailable — try again in{" "}
              {formatHoursMinutesCountdown(d1QuotaSecondsLeft)} (resets midnight UTC).
              {d1QuotaUsage && (
                <>
                  <br />
                  {formatQuotaUsageLine(d1QuotaUsage)}
                </>
              )}
            </div>
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
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={hackersLoading && hackers.length === 0}
            >
              {hackerDropdownGroups.map((group) => (
                <optgroup
                  key={group.source}
                  label={group.label}
                  className={group.source === "__recent__" ? "hacker-optgroup-recent" : undefined}
                >
                  {group.items.map((h) => (
                    <option key={h.address} value={h.address}>
                      {formatHackerOptionLabel(h, isHackerRecent(h.address, recentHackerAddresses))}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          {hackersLoading && hackers.length === 0 && (
            <span className="inline-status" role="status">
              Loading hackers…
            </span>
          )}
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
            graphPageSize={graphPageSize}
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
