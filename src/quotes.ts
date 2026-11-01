/**
 * Quote currencies other than native ETH: symbol and decimals, keyed by lowercase address. These are the
 * currencies Tsunami's factory lets a token launch against (its CurrencyAdded and CurrencyRemoved logs), read
 * from each token contract with symbol() and decimals(), plus the three removed currencies that launched tokens.
 */
export const QUOTE_ASSETS: Record<string, { symbol: string; decimals: number }> = {
  "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18 },
  "0x2d270e6886d130d724215a266106e6832161eaed": { symbol: "USDC", decimals: 6 },
  "0xe343167631d89b6ffc58b88d6b7fb0228795491d": { symbol: "USDG", decimals: 6 },
  "0x0200c29006150606b650577bbe7b6248f58470c1": { symbol: "USD₮0", decimals: 6 },
  "0x73e0c0d45e048d25fc26fa3159b0aa04bfa4db98": { symbol: "kBTC", decimals: 8 },
  "0xae4efbc7736f963982aacb17efa37fcbab924cb3": { symbol: "SolvBTC", decimals: 18 },
  "0xd3c8da379d71a33bfee8875f87ac2748beb1d58d": { symbol: "uniBTC", decimals: 8 },
  "0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f": { symbol: "wAAPLx", decimals: 18 },
  "0x910cabde3eba7fc1ce64fd14bd680b9f60fa0f90": { symbol: "wAMZNx", decimals: 18 },
  "0xe89572bfe500ac7e8ecd8dc8119d274214e06f14": { symbol: "wAVGOx", decimals: 18 },
  "0x44c7ed7ffdf8465c9d27f60aec845eed3d49d56e": { symbol: "wCOINx", decimals: 18 },
  "0xb11134f14d5b94db60d4599dfdc3bf1bba2150e8": { symbol: "wCRCLx", decimals: 18 },
  "0x735f1509bff25e27cd442b9bfb231324648ead9b": { symbol: "wGLDx", decimals: 18 },
  "0xf8c5308f80e459bb53d9ebe689854d9cbb2caa6f": { symbol: "wGOOGLx", decimals: 18 },
  "0x59801175a9b2248f9bf4ba7f82e17045c4672ec8": { symbol: "wHOODx", decimals: 18 },
  "0xe840946ffebcd66b7c4e95095effafadfa0d0e56": { symbol: "wMETAx", decimals: 18 },
  "0x166fbe68274b6a47e025f4ba17388c539f1fa1d0": { symbol: "wMSFTx", decimals: 18 },
  "0x30987adf0b11dc698438a99ba04ec3a1ab2c7eab": { symbol: "wMSTRx", decimals: 18 },
  "0xa8ddb5cd96b5222afe198316e9a57caa642850d5": { symbol: "wNVDAx", decimals: 18 },
  "0x4c1ae29c159838fc1b224636e28e086eb69101f7": { symbol: "wQQQx", decimals: 18 },
  "0x75e82e2884ea10f72fca777449b73377f4646219": { symbol: "wSNDKx", decimals: 18 },
  "0xe7e553cd128f0011777323a0b44a7b96ea1cb540": { symbol: "wSPYx", decimals: 18 },
  "0xc3fdbe3a68ee5de461d30415a8165cf9aefe1171": { symbol: "wTSLAx", decimals: 18 },
  "0x8e2eed8b8b5e13ea7bf38e50d7821d2c57309072": { symbol: "wSPCXx", decimals: 18 },
  "0xc6639026a3a862cd4fcbae3f67cb2d25a2959d37": { symbol: "wMCDx", decimals: 18 },
  "0x4a2df09536f62341c9f946427d16414c04e21342": { symbol: "wPLTRx", decimals: 18 },
  "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a": { symbol: "AAPLx", decimals: 18 },
  "0xe92f673ca36c5e2efd2de7628f815f84807e803f": { symbol: "GOOGLx", decimals: 18 },
  "0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0": { symbol: "TSLAx", decimals: 18 },
}

// shortcut: a quote currency Tsunami enables after this table was written shows 18 decimals and its address.
// Add it here, or carry decimals on the events in the next schema version.
/** Decimals of a quote currency: the table's, else 18 (native ETH and every currency not listed). */
export const quoteDecimals = (quote: string): number =>
  QUOTE_ASSETS[quote.toLowerCase()]?.decimals ?? 18

/** "0x2d27…aeed". */
export const shortAddress = (address: string): string =>
  `${address.slice(0, 6)}…${address.slice(-4)}`
