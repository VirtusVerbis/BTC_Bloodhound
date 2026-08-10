import type { Store } from "@cointrace/db";
import { normalizeBitcoinAddress } from "../util/address.js";

type AddressFields = Parameters<Store["upsertAddress"]>[0];

export async function insertAddressIfMissing(
  store: Store,
  rawAddress: string,
  fields: Omit<AddressFields, "address">,
): Promise<boolean> {
  const address = normalizeBitcoinAddress(rawAddress);
  if (!address) return false;
  if (await store.getAddress(address)) return false;
  await store.upsertAddress({ address, ...fields });
  return true;
}
