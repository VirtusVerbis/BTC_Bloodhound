export interface ChainTxSummary {
  txid: string;
  status?: { block_height?: number; block_time?: number };
  fee?: number;
}

export interface ChainTxDetail extends ChainTxSummary {
  vin: Array<{
    txid?: string;
    vout?: number;
    prevout?: { scriptpubkey_address?: string; value?: number };
    is_coinbase?: boolean;
  }>;
  vout: Array<{
    scriptpubkey_address?: string;
    value?: number;
  }>;
}

export interface ChainAddressStats {
  chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
  mempool_stats?: { funded_txo_sum: number; spent_txo_sum: number };
}

export interface ChainProvider {
  name: string;
  getAddressTxs(address: string, lastSeenTxid?: string): Promise<ChainTxSummary[]>;
  getAddressTxsChainPage(address: string, lastTxid: string): Promise<ChainTxSummary[]>;
  getTx(txid: string): Promise<ChainTxDetail>;
  getAddressStats(address: string): Promise<ChainAddressStats>;
}
