import type { Store } from "@cointrace/db";

type AddressFields = Parameters<Store["upsertAddress"]>[0];

export function insertAddressIfMissing(
  store: Store,
  address: string,
  fields: Omit<AddressFields, "address">,
): boolean {
  if (store.getAddress(address)) return false;
  store.upsertAddress({ address, ...fields });
  return true;
}
