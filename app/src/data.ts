import { maxUint256 } from "viem";
import { ABI, testnet } from "./clients";
import { CHAIN, DEP, LEASH, NOTES, STOCKS, STOCK_BY_TOKEN, type Stock } from "./config";

const USD = 1e6;
const PX = 1e8;

export interface Price {
  latest: number;
  low: number;
  high: number;
  updatedAt: number;
  confirmed: boolean;
  stale: boolean;
  paused: boolean;
}

export interface CollateralRow {
  stock: Stock;
  price: Price;
  /** Feed round the market saw last, and the print before it. */
  lastRound: bigint;
  prevRound: bigint;
  lastSeen: number;
  prevSeen: number;
  /** Latest round on the feed (may be newer than what the market has recorded). */
  feedRound: bigint;
  maxAge: number;
  multiplier: number;
  status: "live" | "unconfirmed" | "stale" | "paused";
}

export interface MarketData {
  totalAssets: number;
  totalDebt: number;
  cash: number;
  utilization: number;
  borrowApr: number;
  supplyApr: number;
  rows: CollateralRow[];
  blockTime: number;
}

export function toPrice(p: any): Price {
  return {
    latest: Number(p.latest) / PX,
    low: Number(p.low) / PX,
    high: Number(p.high) / PX,
    updatedAt: Number(p.updatedAt),
    confirmed: Boolean(p.confirmed),
    stale: Boolean(p.stale),
    paused: Boolean(p.paused),
  };
}

export async function loadMarket(): Promise<MarketData> {
  const m = { address: DEP.market, abi: ABI.market } as const;
  const [totalAssets, totalDebt, util, borrowRate, supplyRate, cash, block] = (await Promise.all([
    testnet.readContract({ ...m, functionName: "totalAssets" }),
    testnet.readContract({ ...m, functionName: "totalDebt" }),
    testnet.readContract({ ...m, functionName: "utilizationBps" }),
    testnet.readContract({ ...m, functionName: "borrowRatePerYearRay" }),
    testnet.readContract({ ...m, functionName: "supplyRatePerYearRay" }),
    testnet.readContract({ address: LEASH.usd, abi: ABI.b20, functionName: "balanceOf", args: [DEP.market] }),
    testnet.getBlock(),
  ])) as [bigint, bigint, bigint, bigint, bigint, bigint, { timestamp: bigint }];
  const rows = await Promise.all(
    STOCKS.map(async (s): Promise<CollateralRow> => {
      const [p, obs, cfg, reg, round] = (await Promise.all([
        testnet.readContract({ ...m, functionName: "priceOf", args: [s.token] }),
        testnet.readContract({ ...m, functionName: "observationOf", args: [s.token] }),
        testnet.readContract({ ...m, functionName: "configOf", args: [s.token] }),
        testnet.readContract({ address: DEP.registry, abi: ABI.registry, functionName: "params", args: [s.token] }),
        testnet.readContract({ address: s.feed, abi: ABI.feed, functionName: "latestRoundData" }),
      ])) as [any, readonly [bigint, bigint, bigint, bigint], readonly any[], readonly [bigint, boolean, bigint], readonly bigint[]];
      const price = toPrice(p);
      const status = price.paused ? "paused" : price.stale ? "stale" : price.confirmed ? "live" : "unconfirmed";
      return {
        stock: s,
        price,
        lastRound: obs[0],
        prevRound: obs[1],
        lastSeen: Number(obs[2]) / PX,
        prevSeen: Number(obs[3]) / PX,
        feedRound: round[0],
        maxAge: Number(cfg[4]),
        multiplier: Number(reg[0]) / 1e18,
        status,
      };
    }),
  );
  return {
    totalAssets: Number(totalAssets) / USD,
    totalDebt: Number(totalDebt) / USD,
    cash: Number(cash) / USD,
    utilization: Number(util) / 1e4,
    borrowApr: Number(borrowRate) / 1e27,
    supplyApr: Number(supplyRate) / 1e27,
    rows,
    blockTime: Number(block.timestamp),
  };
}

export interface Holding {
  stock: Stock;
  raw: bigint;
  balance: number;
  valueLow: number;
  valueHigh: number;
  live: boolean;
}

export interface Position {
  account: `0x${string}`;
  name?: string;
  debtRaw: bigint;
  debt: number;
  borrowPower: number;
  /** null when the account has no debt */
  healthFactor: number | null;
  holdings: Holding[];
}

export async function loadPosition(account: `0x${string}`): Promise<Position> {
  const r = (await testnet.readContract({ address: DEP.market, abi: ABI.market, functionName: "positionOf", args: [account] })) as readonly [
    bigint,
    bigint,
    bigint,
    ReadonlyArray<{ token: `0x${string}`; balance: bigint; valueLow: bigint; valueHigh: bigint; live: boolean }>,
  ];
  return {
    account,
    name: DEP.demoBorrowers.find((d) => d.account.toLowerCase() === account.toLowerCase())?.name,
    debtRaw: r[0],
    debt: Number(r[0]) / USD,
    borrowPower: Number(r[1]) / USD,
    healthFactor: r[2] === maxUint256 ? null : Number(r[2]) / 1e18,
    holdings: r[3]
      .filter((h) => h.balance > 0n)
      .map((h) => ({
        stock: STOCK_BY_TOKEN.get(h.token.toLowerCase())!,
        raw: h.balance,
        balance: Number(h.balance) / PX,
        valueLow: Number(h.valueLow) / USD,
        valueHigh: Number(h.valueHigh) / USD,
        live: h.live,
      }))
      .filter((h) => h.stock),
  };
}

export interface KeeperRun {
  at: string;
  log: string[];
  market?: { totalAssets: number; totalDebt: number; utilization: number; borrowApr: number };
}

export interface KeeperStatus {
  latest: KeeperRun & { keeper: string; accounts: Array<{ account: string; name?: string; debt: number; healthFactor: number | null }> };
  history: KeeperRun[];
}

export interface KeeperIndex {
  lastScanned: string;
  accounts: string[];
  liquidations: Array<{ at: string; tx: string; account: string; ticker: string; repaid: number; seized: number; price: number; hfBefore: number }>;
  health: Record<string, Array<[string, number]>>;
}

async function json<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(`${url}?t=${Math.floor(Date.now() / 60_000)}`);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export const loadStatus = () => json<KeeperStatus>(`${NOTES}/${CHAIN.id}/status.json`);
export const loadIndex = () => json<KeeperIndex>(`${NOTES}/${CHAIN.id}/index.json`);

/** Every borrower the keeper has discovered, plus the demo borrowers, read live from the market. */
export async function loadBorrowers(extra: string[] = []): Promise<Position[]> {
  const idx = await loadIndex();
  const seen = new Set<string>();
  const list = [...DEP.demoBorrowers.map((d) => d.account), ...(idx?.accounts ?? []), ...extra].filter((a) => {
    const k = a.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }) as `0x${string}`[];
  const positions = await Promise.all(list.map((a) => loadPosition(a)));
  return positions.filter((p) => p.debt > 0 || p.holdings.length > 0);
}

/** New York trading-week state of the 24/5 equity feeds (weekends only; exchange holidays are not modelled). */
export function tradingWeek(now = new Date()): { open: boolean; label: string } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const closed = wd === "Sat" || (wd === "Fri" && hour >= 20) || (wd === "Sun" && hour < 20);
  return closed
    ? { open: false, label: "Weekend: the stock feeds stop until Sunday 8 pm New York time" }
    : { open: true, label: "Trading week: the 24/5 stock feeds are updating" };
}
