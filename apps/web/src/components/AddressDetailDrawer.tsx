import { useEffect, useState } from "react";
import { api, formatLocalDateTime, formatUtcDateTime, satsToBtc, txUrl } from "../lib/api";
import { ExplorerActions } from "./ExplorerActions";

export interface AddressDetail {
  address: {
    address: string;
    role: string;
    label: string | null;
    source: string;
    hopFromHacker: number | null;
    expandStatus: string;
    lastExpandedAt: string | null;
    totalReceivedSats: number;
    liveBalanceSats: number | null;
    liveBalanceAt: string | null;
  };
  totalSent: number;
  hackOccurredAt: string | null;
  hackBlockHeight: number | null;
  relatedTxs: Array<{
    txid: string;
    blockTime: string | null;
    amountSats: number;
    direction: string;
    counterparty: string;
  }>;
}

export function AddressDetailDrawer({
  address,
  onClose,
}: {
  address: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<AddressDetail | null>(null);

  useEffect(() => {
    setDetail(null);
    api<AddressDetail>(`/api/addresses/${encodeURIComponent(address)}`).then(setDetail).catch(console.error);
  }, [address]);

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="drawer">
        <button type="button" onClick={onClose} style={{ float: "right" }}>
          Close
        </button>
        <h2>{address}</h2>
        <ExplorerActions address={address} />
        {!detail ? (
          <p>Loading…</p>
        ) : (
          <>
            <p>
              Role: {detail.address.role} · source: {detail.address.source}
              {detail.address.hopFromHacker != null && ` · hop ${detail.address.hopFromHacker}`}
            </p>
            <p>
              Expand: {detail.address.expandStatus}
              {detail.address.lastExpandedAt &&
                ` · last ${formatLocalDateTime(detail.address.lastExpandedAt) ?? detail.address.lastExpandedAt}`}
            </p>
            <p>
              Outgoing flows indexed:{" "}
              {detail.relatedTxs.filter((t) => t.direction === "out").length || "none"}
            </p>
            <p>Total received (hack): {satsToBtc(detail.address.totalReceivedSats)} BTC</p>
            {detail.address.liveBalanceSats != null && (
              <p>Current balance: {satsToBtc(detail.address.liveBalanceSats)} BTC</p>
            )}
            <p>Total sent: {satsToBtc(detail.totalSent)} BTC</p>
            {detail.hackOccurredAt ? (
              <>
                <p>Hack date/time (UTC): {formatUtcDateTime(detail.hackOccurredAt) ?? "unknown"}</p>
                <p>Hack date/time (local): {formatLocalDateTime(detail.hackOccurredAt) ?? "unknown"}</p>
              </>
            ) : (
              <p>Hack date/time: unknown</p>
            )}
            <p>
              Block height:{" "}
              {detail.hackBlockHeight != null ? detail.hackBlockHeight.toLocaleString() : "unknown"}
            </p>
            <table>
              <thead>
                <tr>
                  <th>Tx</th>
                  <th>Dir</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {(detail.relatedTxs ?? []).slice(0, 50).map((tx, i) => (
                  <tr key={`${tx.txid}:${tx.direction}:${i}`}>
                    <td>
                      <a href={txUrl(tx.txid)} target="_blank" rel="noreferrer">
                        {tx.txid.slice(0, 8)}…
                      </a>
                    </td>
                    <td>{tx.direction}</td>
                    <td>{satsToBtc(tx.amountSats)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </>
  );
}
