import type { Store } from "@cointrace/db";
import type { ChainRouter } from "../chain/router.js";
import { blockTimeIso } from "../chain/esplora.js";
import { extractOpReturnDisplay, txHasOpReturnScriptFields } from "../chain/opReturn.js";
import type { ChainTxDetail } from "../chain/types.js";
import type { createChainCallBudget } from "./chainCallBudget.js";
import type { CpuGuard } from "./cpuGuard.js";
import type { JobSubrequestBudget } from "./subrequestBudget.js";

type ChainCallBudget = ReturnType<typeof createChainCallBudget>;

export interface CaptureOpReturnOpts {
  allowGetTx?: boolean;
  budget?: ChainCallBudget;
  jobSubreq?: JobSubrequestBudget;
  cpuGuard?: CpuGuard;
  tx?: ChainTxDetail;
}

export async function captureOpReturnForTx(
  store: Store,
  router: ChainRouter,
  txid: string,
  opts?: CaptureOpReturnOpts,
): Promise<{ captured: boolean; chainCallsUsed: number }> {
  const existing = await store.getTransaction(txid);
  if (existing?.opReturnDisplay != null) {
    return { captured: false, chainCallsUsed: 0 };
  }

  let tx = opts?.tx;
  let chainCallsUsed = 0;

  if (!tx || (!txHasOpReturnScriptFields(tx) && opts?.allowGetTx)) {
    const canFetch =
      opts?.allowGetTx === true &&
      (!opts.budget || opts.budget.canCall()) &&
      (!opts.jobSubreq || opts.jobSubreq.canUse()) &&
      !opts.cpuGuard?.exceeded();

    if (canFetch) {
      tx = await router.withProvider((p) => p.getTx(txid));
      chainCallsUsed++;
      opts?.budget?.consume();
    }
  }

  if (!tx) {
    return { captured: false, chainCallsUsed };
  }

  const display = extractOpReturnDisplay(tx);
  await store.upsertTransaction({
    txid,
    blockHeight: tx.status?.block_height ?? existing?.blockHeight ?? null,
    blockTime: existing?.blockTime ?? blockTimeIso(tx),
    feeSats: tx.fee ?? existing?.feeSats ?? null,
    opReturnDisplay: display,
  });

  return { captured: true, chainCallsUsed };
}
