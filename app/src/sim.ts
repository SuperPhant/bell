// What-if simulations against the live contracts. Each scenario is a plain eth_call to BellMarket with state overrides
// on the testnet price mirror (new feed rounds), on the market's record of prints it has seen, or on the oracle
// registry's corporate-action flag, optionally at a later block time. Nothing is sent and no wallet is needed: the
// verdicts come from the deployed contract code.
import { BaseError, decodeErrorResult, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, pad, toHex } from "viem";
import { ABI, testnet } from "./clients";
import { DEP, LEASH, type Stock } from "./config";
import type { MarketData, Position } from "./data";
import { fmtUsd } from "./util";

type Hex = `0x${string}`;
type StateDiff = Array<{ slot: Hex; value: Hex }>;
type Override = Array<{ address: Hex; stateDiff: StateDiff }>;

const u = (x: bigint): Hex => pad(toHex(x), { size: 32 });
const signed = (x: bigint): Hex => u(x < 0n ? (1n << 256n) + x : x);
const slotOf = (types: string[], values: unknown[]): Hex => keccak256(encodeAbiParameters(types.map((type) => ({ type })), values as any));
const plus = (slot: Hex, n: bigint): Hex => u(BigInt(slot) + n);

// Storage layouts (see contracts/src): MirrorFeedHub.latestRound @3, MirrorFeedHub._rounds @4,
// BellMarket.observationOf @11, MirrorOracleRegistry.params @2.
const latestRoundSlot = (feedId: number) => slotOf(["uint256", "uint256"], [BigInt(feedId), 3n]);
const roundSlot = (feedId: number, rid: bigint) => slotOf(["uint256", "bytes32"], [rid, slotOf(["uint256", "uint256"], [BigInt(feedId), 4n])]);
const observationSlot = (token: Hex) => slotOf(["address", "uint256"], [token, 11n]);
const registrySlot = (token: Hex) => slotOf(["address", "uint256"], [token, 2n]);
const timestamps = (t: bigint) => u(t | (t << 64n) | (t << 128n));

/** Round `rid` of a mirrored feed with `answer` (8 decimals), stamped at time `t`. */
const round = (feedId: number, rid: bigint, answer: bigint, t: bigint): StateDiff => [
  { slot: roundSlot(feedId, rid), value: signed(answer) },
  { slot: plus(roundSlot(feedId, rid), 1n), value: timestamps(t) },
];

function merge(parts: Override): Override {
  const by = new Map<string, StateDiff>();
  for (const p of parts) by.set(p.address.toLowerCase(), [...(by.get(p.address.toLowerCase()) ?? []), ...p.stateDiff]);
  return [...by.entries()].map(([address, stateDiff]) => ({ address: address as Hex, stateDiff }));
}

export interface Verdict {
  allowed: boolean;
  name?: string;
  args?: readonly unknown[];
  seized?: bigint;
  detail?: string;
  at: number;
}

async function call(data: Hex, from: Hex, stateOverride: Override, at: number, shifted: boolean): Promise<{ ok: true; data: Hex } | { ok: false; name: string; args: readonly unknown[] }> {
  try {
    const r = await testnet.call({
      to: DEP.market,
      data,
      account: from,
      stateOverride: stateOverride.length ? stateOverride : undefined,
      ...(shifted ? { blockOverrides: { time: BigInt(at) } } : {}),
    } as any);
    return { ok: true, data: (r.data ?? "0x") as Hex };
  } catch (e) {
    const raw = e instanceof BaseError ? ((e.walk((x: any) => typeof x?.data === "string" && x.data.startsWith("0x")) as any)?.data as Hex | undefined) : undefined;
    for (const abi of [ABI.market, ABI.b20]) {
      if (!raw) break;
      try {
        const d = decodeErrorResult({ abi, data: raw });
        return { ok: false, name: d.errorName, args: d.args ?? [] };
      } catch {}
    }
    return { ok: false, name: (e as any)?.shortMessage ?? String(e), args: [] };
  }
}

export interface Scenario {
  id: string;
  title: string;
  story: string;
  expect: "blocked" | "allowed";
  run: () => Promise<Verdict>;
}

export interface ScenarioContext {
  position: Position;
  market: MarketData;
  liquidator: Hex;
  liquidatorFloat: bigint;
  multipliers: Map<string, bigint>;
}

/** The crash used in the what-ifs: deep enough that the position is underwater once the move is confirmed. */
export function crashFor(p: Position): number {
  const hf = p.healthFactor ?? 1;
  const needed = 1 - 1 / hf;
  return Math.min(0.9, Math.max(0.15, Math.ceil((needed + 0.08) * 100) / 100));
}

export function buildScenarios(ctx: ScenarioContext): Scenario[] {
  const { position: p, market } = ctx;
  if (!p.debtRaw || !p.holdings.length) return [];
  const now = Math.floor(Date.now() / 1000);
  const t = BigInt(now);
  const crash = crashFor(p);
  const held = p.holdings.map((h) => market.rows.find((r) => r.stock.token.toLowerCase() === h.stock.token.toLowerCase())!).filter(Boolean);
  const target = [...p.holdings].sort((a, b) => b.valueHigh - a.valueHigh)[0];
  const targetRow = held.find((r) => r.stock.token === target.stock.token)!;
  const crashed = (r: (typeof held)[number]) => BigInt(Math.round(r.price.latest * (1 - crash) * 1e8));
  const tickers = held.map((r) => r.stock.ticker).join(" and ");
  const hfOnCrash = (p.healthFactor ?? 0) * (1 - crash);
  let repay = p.debtRaw / 2n;
  if (repay > ctx.liquidatorFloat) repay = ctx.liquidatorFloat;
  const liquidateData = encodeFunctionData({ abi: ABI.market, functionName: "liquidate", args: [p.account, target.stock.token, repay] });

  // One new print per stock, not yet confirmed. The market still remembers the previous print.
  const onePrint: Override = held.map((r) => ({
    address: LEASH.hub,
    stateDiff: [{ slot: latestRoundSlot(r.stock.feedId), value: u(r.feedRound + 1n) }, ...round(r.stock.feedId, r.feedRound + 1n, crashed(r), t)],
  }));
  // Two crash prints: the market has already recorded the first one, the feed now shows the second.
  const twoPrints: Override = held.flatMap((r) => [
    {
      address: LEASH.hub,
      stateDiff: [
        { slot: latestRoundSlot(r.stock.feedId), value: u(r.feedRound + 2n) },
        ...round(r.stock.feedId, r.feedRound + 1n, crashed(r), t),
        ...round(r.stock.feedId, r.feedRound + 2n, crashed(r), t),
      ],
    },
    {
      address: DEP.market,
      stateDiff: [
        { slot: observationSlot(r.stock.token), value: u((r.feedRound + 1n) | (r.feedRound << 80n)) },
        { slot: plus(observationSlot(r.stock.token), 1n), value: signed(crashed(r)) },
        { slot: plus(observationSlot(r.stock.token), 2n), value: signed(BigInt(Math.round(r.price.latest * 1e8))) },
      ],
    },
  ]);
  const paused: Override = held.map((r) => ({
    address: DEP.registry,
    stateDiff: [
      { slot: registrySlot(r.stock.token), value: u(ctx.multipliers.get(r.stock.token.toLowerCase()) ?? 10n ** 18n) },
      { slot: plus(registrySlot(r.stock.token), 1n), value: u(1n | (t << 8n)) },
    ],
  }));
  const weekend = now + 60 * 3600;

  const liquidation = async (o: Override, at = now, shifted = false): Promise<Verdict> => {
    const r = await call(liquidateData, ctx.liquidator, merge(o), at, shifted);
    if (!r.ok) return { allowed: false, name: r.name, args: r.args, at };
    const seized = decodeFunctionResult({ abi: ABI.market, functionName: "liquidate", data: r.data }) as bigint;
    const units = Number(seized) / 1e8;
    const px = Number(crashed(targetRow)) / 1e8;
    const value = units * px;
    const repaid = value / (1 + target.stock.bonusBps / 10_000);
    return {
      allowed: true,
      seized,
      at,
      detail: `the liquidator repays ${fmtUsd(repaid, 0)} of the ${fmtUsd(p.debt, 0)} debt and receives ${units.toFixed(4)} ${target.stock.ticker}, worth ${fmtUsd(value, 0)} at the confirmed ${fmtUsd(px)} (the ${target.stock.bonusBps / 100}% liquidation bonus included).`,
    };
  };

  const pct = `${Math.round(crash * 100)}%`;
  const pricesText = held.map((r) => `${r.stock.ticker} ${fmtUsd(r.price.latest)} → ${fmtUsd(r.price.latest * (1 - crash))}`).join(", ");
  const list: Scenario[] = [
    {
      id: "now",
      title: "Liquidate this position right now",
      story: `A liquidator tries to repay ${fmtUsd(Number(repay) / 1e6, 0)} of the debt and seize ${target.stock.ticker} at today's prices.`,
      expect: "blocked",
      run: () => liquidation([]),
    },
    {
      id: "gap",
      title: `One crash print: ${tickers} −${pct}`,
      story: `The next print says ${pricesText}, like the first print after a weekend or a bad tick in thin overnight trading. On that print alone the health factor would be ${hfOnCrash.toFixed(2)}, so a crypto-style market would liquidate now.`,
      expect: "blocked",
      run: () => liquidation(onePrint),
    },
    {
      id: "confirmed",
      title: "The next print confirms the crash",
      story: `A second print at the same level arrives. Both prints are now ${pct} lower, so the move is real and the position is underwater.`,
      expect: "allowed",
      run: () => liquidation(twoPrints),
    },
    {
      id: "paused",
      title: "Confirmed crash during a corporate action",
      story: `Same two prints, but Coinbase's oracle registry has flagged ${tickers} as paused for a corporate action (a split, say), so the feed is frozen.`,
      expect: "blocked",
      run: () => liquidation([...twoPrints, ...paused]),
    },
    {
      id: "weekend",
      title: "Confirmed crash, then the weekend",
      story: `Same two prints, but the liquidator only shows up 60 hours later, when the feeds have stopped for the weekend and the last print is far older than ${Math.round(targetRow.maxAge / 3600)} hours.`,
      expect: "blocked",
      run: () => liquidation(twoPrints, weekend, true),
    },
  ];
  const headroom = p.borrowPower - p.debt;
  const ask = BigInt(headroom < 200 ? 100 : Math.min(1000, Math.floor(headroom / 2))) * 1_000_000n;
  const borrowData = encodeFunctionData({ abi: ABI.market, functionName: "borrow", args: [ask] });
  list.push({
    id: "borrow-weekend",
    title: "Borrow more against a weekend-old price",
    story: `The borrower asks for ${fmtUsd(Number(ask) / 1e6, 0)} more on Sunday, 60 hours from now, while the feeds still show Friday's prices.`,
    expect: "blocked",
    run: async () => {
      const r = await call(borrowData, p.account, [], weekend, true);
      return r.ok ? { allowed: true, at: weekend } : { allowed: false, name: r.name, args: r.args, at: weekend };
    },
  });
  return list;
}

export function explain(v: Verdict, tickerOf: (token: string) => string, maxAgeHours: number): string {
  const a = (v.args ?? []) as any[];
  switch (v.name) {
    case "PositionHealthy":
      return `health factor is ${(Number(a[0]) / 1e18).toFixed(2)} on the higher of the last two prints, so there is nothing to liquidate.`;
    case "CorporateActionPause":
      return `${tickerOf(a[0])} is paused in the oracle registry. A frozen price cannot be used to seize it.`;
    case "PriceStale": {
      const age = (v.at - Number(a[1])) / 3600;
      return `${tickerOf(a[0])}'s last print is ${age.toFixed(0)} hours old, beyond its ${maxAgeHours}-hour limit. Bell is closed until trading resumes.`;
    }
    case "InsufficientBorrowPower":
      return `borrowing would take the debt to ${fmtUsd(Number(a[0]) / 1e6, 0)} but borrowing power is ${fmtUsd(Number(a[1]) / 1e6, 0)}: stale collateral counts for nothing.`;
    case "InsufficientLiquidity":
      return `the pool only has ${fmtUsd(Number(a[0]) / 1e6, 0)} of cash.`;
    case "ExceedsCloseFactor":
      return `at most half the debt can be repaid in one liquidation.`;
    default:
      return v.name ?? "reverted";
  }
}
