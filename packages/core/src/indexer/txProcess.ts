import type { Store } from "@cointrace/db";
import type { ChainRouter } from "../chain/router.js";
import type { AppConfig } from "../config.js";
import { txInvolvesSpend } from "../chain/esplora.js";
import { processTxForHackTrace } from "../graph/builder.js";
import type { HackTraceEdgeDraft, HackTraceOptions } from "../graph/builder.js";
import { applySpendFanoutSummary, spendFanoutTxFromPage } from "./spendFanout.js";
import type { CpuGuard } from "./cpuGuard.js";
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
  traceEdgeTotal?: number;
  traceEdgesFlat?: HackTraceEdgeDraft[];
}

export interface ProcessClassifiedTxResult {
  traceState: TraceProcessState;
  continued: boolean;
  chainCallsUsed: number;
  cpuGuardTripped?: boolean;
}

function traceOptions(
  config: AppConfig,
  state: TraceProcessState,
  txid: string,
  extra?: HackTraceOptions,
  opts?: { cpuGuard?: CpuGuard },
): HackTraceOptions & {
  maxGraphEdgesPerTx?: number;
  maxEdgesPerJob?: number;
  traceEdgeIndex?: number;
  traceEdgeTotal?: number;
  traceEdgesFlat?: HackTraceEdgeDraft[];
  cpuGuard?: CpuGuard;
} {
  const traceActive = state.traceEdgesPending && state.traceTxid === txid;
  return {
    ...extra,
    traceEdgeIndex: traceActive ? (state.traceEdgeIndex ?? 0) : 0,
    traceEdgeTotal: traceActive ? state.traceEdgeTotal : undefined,
    traceEdgesFlat: traceActive ? state.traceEdgesFlat : undefined,
    maxGraphEdgesPerTx: config.maxGraphEdgesPerTx > 0 ? config.maxGraphEdgesPerTx : undefined,
    maxEdgesPerJob: config.maxEdgesPerJob > 0 ? config.maxEdgesPerJob : undefined,
    cpuGuard: opts?.cpuGuard,
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
  opts?: { expandProfile?: string | null; skipIfIndexed?: boolean; cpuGuard?: CpuGuard },
): Promise<ProcessClassifiedTxResult> {
  const txid = entry.txid;
  const traceActive = state.traceEdgesPending && state.traceTxid === txid;
  const nextState: TraceProcessState = {
    traceTxid: undefined,
    traceEdgeIndex: undefined,
    traceEdgesPending: undefined,
    traceEdgeTotal: undefined,
    traceEdgesFlat: undefined,
  };

  if (
    !traceActive &&
    entry.isSpend === false &&
    shouldSkipGetTx(entry, address, config, {
      expandProfile: opts?.expandProfile,
      pageEntry: entry.pageEntry,
    })
  ) {
    return { traceState: nextState, continued: false, chainCallsUsed: 0 };
  }

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
    traceOptions(
      config,
      state,
      txid,
      {
        tx,
        spendingAddress: address,
        spendingHop: hop,
      },
      { cpuGuard: opts?.cpuGuard },
    ),
  );

  if (!traceResult.traceComplete) {
    return {
      traceState: {
        traceTxid: txid,
        traceEdgeIndex: traceResult.nextEdgeIndex,
        traceEdgesPending: true,
        traceEdgeTotal: traceResult.traceEdgeTotal,
        traceEdgesFlat: traceResult.traceEdgesFlat,
      },
      continued: true,
      chainCallsUsed,
      cpuGuardTripped: traceResult.cpuGuardTripped,
    };
  }

  return {
    traceState: nextState,
    continued: false,
    chainCallsUsed,
    cpuGuardTripped: traceResult.cpuGuardTripped,
  };
}
