import type { Store } from "@cointrace/db";

type AddressFields = Parameters<Store["upsertAddress"]>[0];

export async function insertAddressIfMissing(
  store: Store,
  address: string,
  fields: Omit<AddressFields, "address">,
): Promise<boolean> {
  if (await store.getAddress(address)) return false;
  await store.upsertAddress({ address, ...fields });
  return true;
}
