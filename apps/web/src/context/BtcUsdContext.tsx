import { createContext, useContext, type ReactNode } from "react";

const BtcUsdContext = createContext<number | null>(null);

export function BtcUsdProvider({ price, children }: { price: number | null; children: ReactNode }) {
  return <BtcUsdContext.Provider value={price}>{children}</BtcUsdContext.Provider>;
}

export function useBtcUsdPrice() {
  return useContext(BtcUsdContext);
}
