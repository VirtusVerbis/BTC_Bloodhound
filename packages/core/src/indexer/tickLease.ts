import { formatErrorMessage } from "../util/error.js";

export async function clearTickLeaseSafe(
  store: { clearTickLease(): Promise<void> },
  onError?: (message: string) => void,
): Promise<void> {
  try {
    await store.clearTickLease();
  } catch (err) {
    onError?.(formatErrorMessage(err));
  }
}
