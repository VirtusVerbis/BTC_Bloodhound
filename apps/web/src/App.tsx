import { useCallback, useEffect, useState } from "react";
import { AboutPage } from "./components/AboutPage";
import { HackGraph } from "./components/HackGraph";
import { AddressDetailDrawer } from "./components/AddressDetailDrawer";
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

interface SyncStatus {
  queueDepth: number;
  crawlPendingCount: number;
}

interface AppConfig {
  minEdgeSats: number;
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

  return (
    <div>
      <header className="app-header">
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
              <span>{stats.hackerCount} hacker addresses</span>
              <span>{satsToBtc(stats.totalInSats)} BTC received (hack)</span>
            </>
          )}
          {sync && (
            <span>
              Queue: {sync.queueDepth} · Crawl pending: {sync.crawlPendingCount}
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
        <AboutPage />
      )}

      {drawerAddr && <AddressDetailDrawer address={drawerAddr} onClose={() => setDrawerAddr(null)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
