import { Handle, Position, type NodeProps } from "@xyflow/react";
import { AddressLine, ExplorerActions } from "../ExplorerActions";
import { useBtcUsdPrice } from "../../context/BtcUsdContext";
import { formatUsd, satsToBtc, satsToUsd } from "../../lib/api";

export type GraphNodeData = {
  type?: string;
  label?: string;
  address?: string;
  childCount?: number;
  totalSats?: number;
  totalReceivedSats?: number;
  liveBalanceSats?: number | null;
  liveBalanceAt?: string | null;
  incomingSats?: number;
  latestTxTime?: string | null;
  earliestTxTime?: string | null;
  hopFromHacker?: number | null;
  onExpand?: () => void;
  countdown?: string;
  failed?: boolean;
  onRetry?: () => void;
};

const handleStyle = { background: "#f7931a", width: 6, height: 6, border: "none" };
const queuedHandleStyle = { background: "#888", width: 6, height: 6, border: "none" };

function balanceAge(at: string | null | undefined) {
  if (!at) return "";
  const mins = Math.floor((Date.now() - new Date(at).getTime()) / 60000);
  return mins < 1 ? "just now" : `${mins}m ago`;
}

function UsdUnderBtc({ sats }: { sats: number }) {
  const btcUsdPrice = useBtcUsdPrice();
  if (btcUsdPrice == null) return null;
  return <div className="usd-value">{formatUsd(satsToUsd(sats, btcUsdPrice))}</div>;
}

export function HackerNode({ data }: NodeProps) {
  const d = data as GraphNodeData;
  return (
    <div className="node-card hacker">
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <Handle type="source" position={Position.Right} style={handleStyle} />
      <div className="node-badge">HACKER</div>
      {d.address && <AddressLine address={d.address} />}
      {d.label && <div>{d.label}</div>}
      {d.totalReceivedSats != null && (
        <div>
          Total received (hack): {satsToBtc(d.totalReceivedSats)} BTC
          <UsdUnderBtc sats={d.totalReceivedSats} />
        </div>
      )}
      {d.liveBalanceSats != null && (
        <div style={{ color: "var(--color-text-muted)" }}>
          Current balance: {satsToBtc(d.liveBalanceSats)} BTC · {balanceAge(d.liveBalanceAt)}
          <UsdUnderBtc sats={d.liveBalanceSats} />
        </div>
      )}
      {d.address && <ExplorerActions address={d.address} />}
    </div>
  );
}

export function DownstreamNode({ data }: NodeProps) {
  const d = data as GraphNodeData;
  return (
    <div className="node-card default">
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <Handle type="source" position={Position.Right} style={handleStyle} />
      <div>Downstream</div>
      {d.address && <AddressLine address={d.address} />}
      {d.incomingSats != null && (
        <div>
          In: {satsToBtc(d.incomingSats)} BTC
          <UsdUnderBtc sats={d.incomingSats} />
        </div>
      )}
      {d.hopFromHacker != null && <div>hop {d.hopFromHacker}</div>}
      <div className="node-actions nodrag">
        <button type="button" className="primary" onClick={d.onExpand}>
          Expand
        </button>
      </div>
      {d.address && <ExplorerActions address={d.address} />}
    </div>
  );
}

export function VictimClusterNode({ data }: NodeProps) {
  const d = data as GraphNodeData;
  return (
    <div className="node-card default">
      <Handle type="source" position={Position.Right} style={handleStyle} />
      <div>Victims</div>
      <div>
        {d.childCount ?? 0} addresses · {satsToBtc(d.totalSats ?? 0)} BTC
        <UsdUnderBtc sats={d.totalSats ?? 0} />
      </div>
      <div className="node-actions nodrag">
        <button type="button" onClick={d.onExpand}>
          Expand
        </button>
      </div>
    </div>
  );
}

export function VictimNode({ data }: NodeProps) {
  const d = data as GraphNodeData;
  return (
    <div className="node-card default">
      <Handle type="source" position={Position.Right} style={handleStyle} />
      <div>Victim</div>
      {d.address && <AddressLine address={d.address} />}
      {d.incomingSats != null && (
        <div>
          {satsToBtc(d.incomingSats)} BTC
          <UsdUnderBtc sats={d.incomingSats} />
        </div>
      )}
      {d.address && <ExplorerActions address={d.address} />}
    </div>
  );
}

export function QueuedPlaceholderNode({ data }: NodeProps) {
  const d = data as GraphNodeData;
  return (
    <div className={`node-card queued${d.failed ? " failed" : ""}`}>
      <Handle type="target" position={Position.Left} style={queuedHandleStyle} />
      {d.failed ? (
        <>
          <div>Failed</div>
          <button type="button" onClick={d.onRetry}>
            Retry
          </button>
        </>
      ) : (
        <>
          <div>⟳ Queued</div>
          <div>{d.countdown ?? "…"}</div>
        </>
      )}
    </div>
  );
}

export const nodeTypes = {
  hacker: HackerNode,
  downstream: DownstreamNode,
  victimCluster: VictimClusterNode,
  victim: VictimNode,
  queued: QueuedPlaceholderNode,
};
