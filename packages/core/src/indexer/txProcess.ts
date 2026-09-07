import type { Store } from "@cointrace/db";
import type { ChainRouter } from "../chain/router.js";
import type { AppConfig } from "../config.js";
import { txInvolvesSpend } from "../chain/esplora.js";
import { processTxForHackTrace } from "../graph/builder.js";
import type { HackTraceEdgeDraft, HackTraceOptions } from "../graph/builder.js";
import { applySpendFanoutSummary, spendFanoutTxFromPage } from "./spendFanout.js";
import { captureOpReturnForTx, type CaptureOpReturnOpts } from "./opReturnCapture.js";
import type { CpuGuard } from "./cpuGuard.js";
import {
  hasPageVinVout,
  isSpendFanout,
  pageEntryHasOpReturnAsm,
  pageEntryToChainTxDetail,
  shouldSkipGetTx,
  shouldTraceHackerReceive,
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

function skipGetTxOpts(
  hop: number,
  config: AppConfig,
  opts?: { expandProfile?: string | null; skipIfIndexed?: boolean; cpuGuard?: CpuGuard },
) {
  return {
    expandProfile: opts?.expandProfile,
    hop,
    traceHackerReceives: config.traceFlaggedHackerReceives,
  };
}

async function patchOpReturnFromPageIfNeeded(
  store: Store,
  router: ChainRouter,
  txid: string,
  entry: PendingTxRuntime,
  opts?: { captureOpReturn?: CaptureOpReturnOpts },
): Promise<void> {
  if (!entry.pageEntry || !pageEntryHasOpReturnAsm(entry.pageEntry)) return;

  const indexed = await store.getTransaction(txid);
  if (indexed?.opReturnDisplay != null) return;

  await captureOpReturnForTx(store, router, txid, {
    tx: pageEntryToChainTxDetail(entry.pageEntry),
    allowGetTx: false,
    ...opts?.captureOpReturn,
  });
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
  opts?: { expandProfile?: string | null; skipIfIndexed?: boolean; cpuGuard?: CpuGuard; captureOpReturn?: CaptureOpReturnOpts },
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
  const skipOpts = {
    ...skipGetTxOpts(hop, config, opts),
    pageEntry: entry.pageEntry,
  };

  if (!traceActive && entry.isSpend === false) {
    await patchOpReturnFromPageIfNeeded(store, router, txid, entry, opts);
    if (shouldSkipGetTx(entry, address, config, skipOpts)) {
      return { traceState: nextState, continued: false, chainCallsUsed: 0 };
    }
  }

  if (!traceActive && opts?.skipIfIndexed !== false) {
    const indexed = await store.getTransaction(txid);
    if (indexed) {
      if (
        entry.pageEntry &&
        pageEntryHasOpReturnAsm(entry.pageEntry) &&
        indexed.opReturnDisplay == null
      ) {
        await captureOpReturnForTx(store, router, txid, {
          tx: pageEntryToChainTxDetail(entry.pageEntry),
          allowGetTx: false,
          ...opts?.captureOpReturn,
        });
      }
      return { traceState: nextState, continued: false, chainCallsUsed: 0 };
    }
  }

  if (shouldSkipGetTx(entry, address, config, skipOpts)) {
    return { traceState: nextState, continued: false, chainCallsUsed: 0 };
  }

  if (isSpendFanout(entry, address, config, entry.pageEntry)) {
    const pageTx = spendFanoutTxFromPage(entry);
    if (pageTx) {
      await applySpendFanoutSummary(store, pageTx, address, hop, config);
      await captureOpReturnForTx(store, router, txid, {
        tx: pageTx,
        allowGetTx: opts?.captureOpReturn?.allowGetTx ?? false,
        budget: opts?.captureOpReturn?.budget,
        jobSubreq: opts?.captureOpReturn?.jobSubreq,
        cpuGuard: opts?.cpuGuard,
      });
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

  const isDepositTrace = shouldTraceHackerReceive(entry, config, skipOpts);
  if (!traceActive && !isDepositTrace && !txInvolvesSpend(tx, address)) {
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
        captureOpReturn: {
          allowGetTx: opts?.captureOpReturn?.allowGetTx,
          budget: opts?.captureOpReturn?.budget,
          jobSubreq: opts?.captureOpReturn?.jobSubreq,
          cpuGuard: opts?.cpuGuard,
        },
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
    chainCallsUsed: chainCallsUsed + (traceResult.captureChainCalls ?? 0),
    cpuGuardTripped: traceResult.cpuGuardTripped,
  };
}
