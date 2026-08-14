import type { Store } from "@cointrace/db";
import type { ChainRouter } from "../chain/router.js";
import type { AppConfig } from "../config.js";
import { txInvolvesSpend } from "../chain/esplora.js";
import { processTxForHackTrace } from "../graph/builder.js";
import type { HackTraceOptions } from "../graph/builder.js";
import { applySpendFanoutSummary, spendFanoutTxFromPage } from "./spendFanout.js";
import {
  hasPageVinVout,
  isSpendFanout,
  pageEntryToChainTxDetail,
  shouldSkipGetTx,
  uniqueOutputAddresses,
  type PendingTxRuntime,
} from "./txPage.js";

export interface TraceProcessState {
  traceTxid?: string;
  traceEdgeIndex?: number;
  traceEdgesPending?: boolean;
}

export interface ProcessClassifiedTxResult {
  traceState: TraceProcessState;
  continued: boolean;
  chainCallsUsed: number;
}

function traceOptions(
  config: AppConfig,
  state: TraceProcessState,
  txid: string,
  extra?: HackTraceOptions,
): HackTraceOptions & { maxGraphEdgesPerTx?: number; maxEdgesPerJob?: number; traceEdgeIndex?: number } {
  return {
    ...extra,
    traceEdgeIndex:
      state.traceEdgesPending && state.traceTxid === txid ? (state.traceEdgeIndex ?? 0) : 0,
    maxGraphEdgesPerTx: config.maxGraphEdgesPerTx > 0 ? config.maxGraphEdgesPerTx : undefined,
    maxEdgesPerJob: config.maxEdgesPerJob > 0 ? config.maxEdgesPerJob : undefined,
  };
}

export async function processClassifiedPendingTx(
  store: Store,
  router: ChainRouter,
  config: AppConfig,
  address: string,
  hop: number,
  entry: PendingTxRuntime,
  hackers: Set<string>,
  state: TraceProcessState,
  opts?: { expandProfile?: string | null; skipIfIndexed?: boolean },
): Promise<ProcessClassifiedTxResult> {
  const txid = entry.txid;
  const traceActive = state.traceEdgesPending && state.traceTxid === txid;
  const nextState: TraceProcessState = {
    traceTxid: undefined,
    traceEdgeIndex: undefined,
    traceEdgesPending: undefined,
  };

  if (!traceActive && opts?.skipIfIndexed !== false && (await store.getTransaction(txid))) {
    return { traceState: nextState, continued: false, chainCallsUsed: 0 };
  }

  if (
    shouldSkipGetTx(entry, address, config, {
      expandProfile: opts?.expandProfile,
      pageEntry: entry.pageEntry,
    })
  ) {
    return { traceState: nextState, continued: false, chainCallsUsed: 0 };
  }

  if (isSpendFanout(entry, address, config, entry.pageEntry)) {
    const pageTx = spendFanoutTxFromPage(entry);
    if (pageTx) {
      await applySpendFanoutSummary(store, pageTx, address, hop, config);
      return { traceState: nextState, continued: false, chainCallsUsed: 0 };
    }
  }

  let chainCallsUsed = 0;
  let tx = entry.pageEntry && hasPageVinVout(entry.pageEntry)
    ? pageEntryToChainTxDetail(entry.pageEntry)
    : undefined;

  if (!tx) {
    tx = await router.withProvider((p) => p.getTx(txid));
    chainCallsUsed++;
    const fanoutEntry = {
      ...entry,
      isSpend: txInvolvesSpend(tx, address),
      voutCount: tx.vout?.length ?? 0,
      outputAddressCount: uniqueOutputAddresses(tx),
    };
    if (isSpendFanout(fanoutEntry, address, config, tx)) {
      await applySpendFanoutSummary(store, tx, address, hop, config);
      return { traceState: nextState, continued: false, chainCallsUsed };
    }
  }

  if (!traceActive && !txInvolvesSpend(tx, address)) {
    return { traceState: nextState, continued: false, chainCallsUsed };
  }

  const traceResult = await processTxForHackTrace(
    store,
    router,
    txid,
    hackers,
    traceOptions(config, state, txid, {
      tx,
      spendingAddress: address,
      spendingHop: hop,
    }),
  );

  if (!traceResult.traceComplete) {
    return {
      traceState: {
        traceTxid: txid,
        traceEdgeIndex: traceResult.nextEdgeIndex,
        traceEdgesPending: true,
      },
      continued: true,
      chainCallsUsed,
    };
  }

  return { traceState: nextState, continued: false, chainCallsUsed };
}
