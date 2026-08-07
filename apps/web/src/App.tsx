import { useCallback, useEffect, useState } from "react";
import { AboutPage } from "./components/AboutPage";
import { HackGraph } from "./components/HackGraph";
import { AddressDetailDrawer } from "./components/AddressDetailDrawer";
import { MonitoringIndicator, type MonitoringSyncStatus } from "./components/MonitoringIndicator";
import { api, btcToSats, satsToBtc, satsToBtcNumber } from "./lib/api";

type AppTab = "tracker" | "about";

interface Hacker {
  address: string;
  label: string | null;
  totalReceivedSats: number;
}

interface Stats {
  victimCount: number;
  hackerCount: number;
  totalInSats: number;
  totalOutSats: number;
  lastJobAt: string | null;
}

interface SyncStatus extends MonitoringSyncStatus {
  queueDepth: number;
  crawlPendingCount: number;
  treeNodeCount?: number;
  downstreamPollDueCount?: number;
}

interface AppConfig {
  minEdgeSats: number;
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
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
  const [defaultMinEdgeSats, setDefaultMinEdgeSats] = useState(1000);
  const [minEdgeSats, setMinEdgeSats] = useState(1000);
  const [minAmountUnit, setMinAmountUnit] = useState<"sats" | "btc">("sats");
  const [victimSearchInput, setVictimSearchInput] = useState("");
  const [activeVictimSearch, setActiveVictimSearch] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>("tracker");

  const loadHackers = useCallback(async (q?: string) => {
    const params = q ? `?q=${encodeURIComponent(q)}` : "";
    const res = await api<{ hackers: Hacker[] }>(`/api/hackers${params}`);
    setHackers(res.hackers);
    if (!selected && res.hackers[0]) setSelected(res.hackers[0].address);
  }, [selected]);

  useEffect(() => {
    loadHackers(filter).catch(console.error);
  }, [filter, loadHackers]);

  useEffect(() => {
    api<AppConfig>("/api/config")
      .then((cfg) => {
        setDefaultMinEdgeSats(cfg.minEdgeSats);
        setMinEdgeSats(cfg.minEdgeSats);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    const load = () => {
      api<Stats>("/api/stats").then(setStats).catch(console.error);
      api<SyncStatus>("/api/sync/status").then(setSync).catch(console.error);
    };
    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    const onToast = (e: Event) => setToast((e as CustomEvent).detail as string);
    const onExpandVictims = () => setExpandVictims(true);
    window.addEventListener("cointrace-toast", onToast);
    window.addEventListener("cointrace-expand-victims", onExpandVictims);
    return () => {
      window.removeEventListener("cointrace-toast", onToast);
      window.removeEventListener("cointrace-expand-victims", onExpandVictims);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (activeTab !== "tracker" || hackers.length === 0) return;

    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.key !== "PageUp" && e.key !== "PageDown") return;

      e.preventDefault();
      const idx = hackers.findIndex((h) => h.address === selected);
      const current = idx >= 0 ? idx : 0;
      const next =
        e.key === "PageDown"
          ? Math.min(current + 1, hackers.length - 1)
          : Math.max(current - 1, 0);
      if (next !== current) setSelected(hackers[next].address);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTab, hackers, selected]);

  const findVictim = () => {
    const addr = victimSearchInput.trim().toLowerCase();
    if (!addr) return;
    setActiveVictimSearch(addr);
    setExpandVictims(false);
  };

  const clearVictimSearch = () => {
    setVictimSearchInput("");
    setActiveVictimSearch(null);
    setExpandVictims(false);
  };

  const navigateToMonitoring = () => {
    setActiveTab("about");
    requestAnimationFrame(() => {
      document.getElementById("monitoring")?.scrollIntoView({ behavior: "smooth" });
    });
  };

  return (
    <div>
      <header className="app-header">
        <MonitoringIndicator sync={sync} onNavigateMonitoring={navigateToMonitoring} />
        <h1>Bitcoin Bloodhound — Coldcard Hack Tracker</h1>
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
              <span className="stats-hack-btc">{satsToBtc(stats.totalInSats)} BTC received (hack)</span>
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
              {hackers.map((h) => (
                <option key={h.address} value={h.address}>
                  {(h.label ?? h.address.slice(0, 12)) + "…"} ({satsToBtc(h.totalReceivedSats)} BTC)
                </option>
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
              type="number"
              min={0}
              step={minAmountUnit === "btc" ? "0.00000001" : "1"}
              value={minAmountUnit === "sats" ? minEdgeSats : satsToBtcNumber(minEdgeSats)}
              onChange={(e) => {
                const n = Number(e.target.value) || 0;
                setMinEdgeSats(
                  minAmountUnit === "sats" ? Math.max(0, Math.floor(n)) : btcToSats(n),
                );
              }}
            />
            <select
              value={minAmountUnit}
              onChange={(e) => setMinAmountUnit(e.target.value as "sats" | "btc")}
              aria-label="Minimum amount unit"
            >
              <option value="sats">sats</option>
              <option value="btc">BTC</option>
            </select>
          </label>
          <span className="controls-hint">
            Default: {defaultMinEdgeSats.toLocaleString()} sats ({satsToBtc(defaultMinEdgeSats)} BTC)
          </span>
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
  );
}
