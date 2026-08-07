import { addressUrl, truncateAddress } from "../lib/api";

export function ExplorerActions({ address }: { address: string }) {
  const copy = async () => {
    await navigator.clipboard.writeText(address);
    window.dispatchEvent(new CustomEvent("cointrace-toast", { detail: "Copied" }));
  };
  return (
    <div className="node-actions nodrag">
      <button type="button" onClick={copy}>
        Copy
      </button>
      <button type="button" onClick={() => window.open(addressUrl(address), "_blank")}>
        mempool.space
      </button>
    </div>
  );
}

export function AddressLine({ address }: { address: string }) {
  return <div title={address}>{truncateAddress(address)}</div>;
}
