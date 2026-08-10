export interface ValidAddressVector {
  label: string;
  source: string;
  input: string;
  expected: string;
}

export interface InvalidAddressVector {
  label: string;
  input: string;
}

/** Known-valid mainnet addresses — cross-check against BIP vectors, on-chain examples, and prod shapes. */
export const VALID_MAINNET_VECTORS: ValidAddressVector[] = [
  {
    label: "P2PKH genesis",
    source: "genesis coinbase",
    input: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    expected: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
  },
  {
    label: "P2SH legacy",
    source: "well-known mainnet P2SH",
    input: "3QJmV3qfvL9SuYo34YihAf3sRCW3qSinyC",
    expected: "3QJmV3qfvL9SuYo34YihAf3sRCW3qSinyC",
  },
  {
    label: "P2WPKH bc1q",
    source: "BIP173 test vector",
    input: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    expected: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
  },
  {
    label: "P2WSH bc1q",
    source: "BIP173 test vector",
    input: "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3",
    expected: "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3",
  },
  {
    label: "P2TR bc1p",
    source: "bitcoinjs-lib taproot example",
    input: "bc1pxe5uh7cst3p3qzsuzng0r94uv0tn4wfzum2jflph0km6sjjjp5cqc4906u",
    expected: "bc1pxe5uh7cst3p3qzsuzng0r94uv0tn4wfzum2jflph0km6sjjjp5cqc4906u",
  },
  {
    label: "P2TR bc1p prod downstream",
    source: "prod dry-run on-chain taproot",
    input: "bc1pugaqpaqvynrj78ucpv29swhyrhw7u7e293g0su75vg5zyst8yccqd27f9f",
    expected: "bc1pugaqpaqvynrj78ucpv29swhyrhw7u7e293g0su75vg5zyst8yccqd27f9f",
  },
  {
    label: "P2WPKH uppercase bc1q",
    source: "case normalization",
    input: "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4",
    expected: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
  },
];

/** Known-invalid inputs — must never be accepted or pruned as valid. */
export const INVALID_VECTORS: InvalidAddressVector[] = [
  { label: "prod junk legacy 1", input: "1n8knqcfjquejqwjkzzavbboxxl6wvqfdo" },
  { label: "prod junk legacy 3", input: "35dhfzkhn4wcnr3xjj1yerxj44xpx4wnxh" },
  { label: "prod junk legacy 3b", input: "342l6n3b61n1cgoh8wczuzyxuvyztsjztz" },
  {
    label: "bc1p bad checksum",
    input: "bc1pufdpuz5c5wrjpzmvqpc652afukt0wnj4ct3z5nmd2kdc72wf6p3s7therz",
  },
  { label: "testnet bech32", input: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4" },
  { label: "SQL injection", input: "'; DROP TABLE addresses;--" },
  { label: "bc1 SQL fragment", input: "bc1';evil" },
  { label: "empty string", input: "" },
  { label: "whitespace only", input: "   " },
];

export function validVectorByLabel(label: string): ValidAddressVector {
  const v = VALID_MAINNET_VECTORS.find((row) => row.label === label);
  if (!v) throw new Error(`Missing valid address vector: ${label}`);
  return v;
}

export function invalidVectorByLabel(label: string): InvalidAddressVector {
  const v = INVALID_VECTORS.find((row) => row.label === label);
  if (!v) throw new Error(`Missing invalid address vector: ${label}`);
  return v;
}
