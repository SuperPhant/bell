import { defineChain, type Chain } from "viem";
import { base, baseSepolia } from "viem/chains";

export interface LeashData {
  chainId: number;
  usd: `0x${string}`;
  desk: `0x${string}`;
  faucet: `0x${string}`;
  hub: `0x${string}`;
  stocks: Array<{
    ticker: string;
    token: `0x${string}`;
    feed: `0x${string}`;
    feedId: number;
    mainnetToken: `0x${string}`;
    mainnetFeed: `0x${string}`;
  }>;
}

export interface Deployment {
  chainId: number;
  chainName: string;
  deployedAt: string;
  deployer: `0x${string}`;
  keeper: `0x${string}`;
  builderCode: string;
  dataSuffix: `0x${string}`;
  market: `0x${string}`;
  registry: `0x${string}`;
  startBlock: string;
  collaterals: Array<{
    ticker: string;
    token: `0x${string}`;
    feed: `0x${string}`;
    mainnetToken: `0x${string}`;
    ltvBps: number;
    thresholdBps: number;
    bonusBps: number;
  }>;
  demoBorrowers: Array<{ name: string; account: `0x${string}` }>;
  leash?: LeashData;
}

export const vibenet = defineChain({
  id: 84538453,
  name: "Base Vibenet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.vibes.base.org"] } },
  blockExplorers: { default: { name: "Vibenet Explorer", url: "https://chain.base.org/vibenet/explorer" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

const files = import.meta.glob("../../deployments/*.json", { eager: true, import: "default" }) as Record<string, unknown>;
/** Every chain Bell is deployed on, Base Sepolia first. */
export const DEPLOYMENTS = Object.entries(files)
  .filter(([path]) => /\/\d+\.json$/.test(path))
  .map(([, d]) => d as Deployment)
  .sort((a, b) => (a.chainId === 84532 ? -1 : b.chainId === 84532 ? 1 : 0));
const leashFiles = Object.entries(files)
  .filter(([path]) => /\/leash-\d+\.json$/.test(path))
  .map(([, d]) => d as LeashData);

function pick(): Deployment {
  const wanted = Number(new URLSearchParams(location.search).get("chain") ?? import.meta.env.VITE_CHAIN_ID ?? 84532);
  return DEPLOYMENTS.find((d) => d.chainId === wanted) ?? DEPLOYMENTS[0];
}

export const VIBENET_ID = 84538453;
/** Base Sepolia gas comes from captcha faucets; Vibenet's faucet is one click from the app. */
export const BASE_SEPOLIA_FAUCETS: Array<[string, string]> = [
  ["Coinbase Developer Platform faucet", "https://portal.cdp.coinbase.com/products/faucet"],
  ["Superchain faucet", "https://console.optimism.io/faucet"],
  ["thirdweb faucet", "https://thirdweb.com/base-sepolia-testnet"],
];
/** Link to the same page of this app on another chain. */
export const onChain = (chainId: number, hash = "#/") => `${location.pathname}?chain=${chainId}${hash}`;

export const DEP: Deployment = pick();
export const LEASH: LeashData = DEP?.leash ?? leashFiles.find((l) => l.chainId === DEP?.chainId)!;
export const CHAIN: Chain = DEP?.chainId === baseSepolia.id ? baseSepolia : vibenet;
export const MAINNET = base;
export const MAINNET_RPC = "https://mainnet.base.org";

export const EXPLORER =
  CHAIN.id === baseSepolia.id ? "https://sepolia.basescan.org" : "https://chain.base.org/vibenet/explorer";
export const MAINNET_EXPLORER = "https://basescan.org";

export const REPO = "https://github.com/SuperPhant/bell";
export const NOTES = "https://raw.githubusercontent.com/SuperPhant/bell/notes";
export const LEASH_REPO = "https://github.com/SuperPhant/leash";
export const COINBASE_REGISTRY = "0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD";

/** Collateral stocks with their feed ids on the mirror hub (needed for what-if simulations). */
export const STOCKS = (DEP?.collaterals ?? []).map((c) => {
  const s = LEASH?.stocks.find((x) => x.token.toLowerCase() === c.token.toLowerCase());
  return { ...c, feedId: s?.feedId ?? 0, mainnetFeed: s?.mainnetFeed };
});
export type Stock = (typeof STOCKS)[number];

export const STOCK_BY_TOKEN = new Map(STOCKS.map((s) => [s.token.toLowerCase(), s]));

export const STOCK_NAMES: Record<string, string> = {
  AAPL: "Apple",
  AMZN: "Amazon",
  GOOGL: "Alphabet",
  META: "Meta Platforms",
  MSFT: "Microsoft",
  MSTR: "Strategy",
  NVDA: "NVIDIA",
  SNDK: "Sandisk",
  SPCX: "SpaceX",
  TSLA: "Tesla",
};
