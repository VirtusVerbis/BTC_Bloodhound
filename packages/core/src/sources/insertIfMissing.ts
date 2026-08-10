import type { Store } from "@cointrace/db";
import { normalizeBitcoinAddress } from "../util/address.js";

type AddressFields = Omit<Parameters<Store["insertAddressIfMissing"]>[0], "address">;

export async function insertAddressIfMissing(
  store: Store,
  rawAddress: string,
  fields: AddressFields,
): Promise<boolean> {
  const address = normalizeBitcoinAddress(rawAddress);
  if (!address) return false;
  return store.insertAddressIfMissing({ address, ...fields });
}
