// One keeper cycle for Bell:
//   1. mirror Coinbase's mainnet oracle-registry flags (multiplier, corporate-action pause) onto the testnet registry
//   2. pokeAll() when any stock has a new feed round, so the market sees every print
//   3. discover borrowers from events, read their health
//   4. liquidate positions that are unhealthy on confirmed, live prices; sell the seized stock back through the desk
//   5. publish market, prices, accounts and liquidations to the notes branch for the app
import { encodeEventTopics, parseAbiItem, maxUint256 } from "viem";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAINNET_ORACLE_REGISTRY, NOTES_DIR, abi, bellDeployment, clients, loadKey, mainnet, targetChain } from "./config.js";

const chain = targetChain();
const dep = bellDeployment(chain.id);
const { pub, wallet, account } = clients(chain, loadKey("KEEPER_KEY", "testnet-bell-keeper"), true, dep.builderCode);
const bell = abi("BellMarket");
const b20 = abi("IB20");
const feedAbi = abi("AggregatorV3Interface");
const regAbi = abi("MirrorOracleRegistry");
const deskAbi = abi("LeashDesk");
const dryRun = process.env.BELL_DRY_RUN === "1";
const now = Math.floor(Date.now() / 1000);
const log: string[] = [];
const say = (s: string) => {
  console.log(s);
  log.push(s);
};

async function send(address: `0x${string}`, abiX: any, functionName: string, args: readonly unknown[]) {
  const { request } = await pub.simulateContract({ address, abi: abiX, functionName, args, account } as never);
  if (dryRun) return "0xdryrun" as `0x${string}`;
  const hash = await wallet.writeContract(request as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted ${hash}`);
  return hash;
}

const dir = join(NOTES_DIR, String(chain.id));
mkdirSync(dir, { recursive: true });
const indexFile = join(dir, "index.json");
const index: {
  lastScanned: string;
  accounts: string[];
  liquidations: Array<{ at: string; tx: string; account: string; ticker: string; repaid: number; seized: number; price: number; hfBefore: number }>;
  health: Record<string, Array<[string, number]>>;
} = existsSync(indexFile)
  ? JSON.parse(readFileSync(indexFile, "utf8"))
  : { lastScanned: String(BigInt(dep.startBlock) - 1n), accounts: [], liquidations: [], health: {} };

// 1. registry flags
const m = mainnet();
const mainParams = (await Promise.all(
  dep.collaterals.map((c) => m.readContract({ address: MAINNET_ORACLE_REGISTRY, abi: regAbi, functionName: "getOracleParams", args: [c.mainnetToken] })),
)) as Array<readonly [bigint, boolean]>;
const localParams = (await Promise.all(dep.collaterals.map((c) => pub.readContract({ address: dep.registry, abi: regAbi, functionName: "getOracleParams", args: [c.token] })))) as Array<readonly [bigint, boolean]>;
const changed = dep.collaterals.map((c, i) => ({ c, main: mainParams[i], local: localParams[i] })).filter((x) => x.main[0] !== x.local[0] || x.main[1] !== x.local[1]);
if (changed.length) {
  const tx = await send(dep.registry, regAbi, "mirror", [changed.map((x) => x.c.token), changed.map((x) => x.main[0]), changed.map((x) => x.main[1])]);
  say(`registry: mirrored ${changed.map((x) => `${x.c.ticker}${x.main[1] ? " PAUSED" : ""}`).join(", ")} (${tx})`);
}

// 2. record new prints
const rounds = (await Promise.all(dep.collaterals.map((c) => pub.readContract({ address: c.feed, abi: feedAbi, functionName: "latestRoundData" })))) as Array<readonly bigint[]>;
const obs = (await Promise.all(dep.collaterals.map((c) => pub.readContract({ address: dep.market, abi: bell, functionName: "observationOf", args: [c.token] })))) as Array<readonly [bigint, bigint, bigint, bigint]>;
const fresh = dep.collaterals.filter((_, i) => rounds[i][0] !== obs[i][0]);
if (fresh.length) {
  const tx = await send(dep.market, bell, "pokeAll", []);
  say(`prints: new rounds for ${fresh.map((c) => c.ticker).join(", ")} recorded (${tx})`);
}

// 3. discover borrowers
const latest = await pub.getBlockNumber();
const events = [
  parseAbiItem("event CollateralDeposited(address indexed account, address indexed token, uint256 amount)"),
  parseAbiItem("event Borrowed(address indexed account, uint256 amount, uint256 debtAfter)"),
];
let from = BigInt(index.lastScanned) + 1n;
const known = new Set(index.accounts.map((a) => a.toLowerCase()));
const CHUNK = BigInt(process.env.BELL_LOG_CHUNK ?? 9000);
while (from <= latest) {
  const to = from + CHUNK - 1n > latest ? latest : from + CHUNK - 1n;
  for (const ev of events) {
    const logs = await pub.getLogs({ address: dep.market, event: ev, fromBlock: from, toBlock: to });
    for (const l of logs) {
      const a = (l as any).args.account as string;
      if (a && !known.has(a.toLowerCase())) {
        known.add(a.toLowerCase());
        index.accounts.push(a);
      }
    }
  }
  index.lastScanned = to.toString();
  from = to + 1n;
}
void encodeEventTopics;

// 4. health and liquidations
const tickerOf = new Map(dep.collaterals.map((c) => [c.token.toLowerCase(), c.ticker]));
type Pos = readonly [bigint, bigint, bigint, Array<{ token: `0x${string}`; balance: bigint; valueLow: bigint; valueHigh: bigint; live: boolean }>];
const accounts: Array<{ account: string; name?: string; debt: number; borrowPower: number; healthFactor: number | null; collateral: Array<{ ticker: string; balance: number; valueLow: number; valueHigh: number; live: boolean }> }> = [];
for (const a of index.accounts) {
  let pos = (await pub.readContract({ address: dep.market, abi: bell, functionName: "positionOf", args: [a] })) as Pos;
  const hf = pos[2] === maxUint256 ? null : Number(pos[2]) / 1e18;
  if (pos[0] > 0n && pos[2] < 10n ** 18n) {
    const target = [...pos[3]].filter((p) => p.live && p.balance > 0n).sort((x, y) => (y.valueHigh > x.valueHigh ? 1 : -1))[0];
    const float = (await pub.readContract({ address: dep.leash.usd, abi: b20, functionName: "balanceOf", args: [account.address] })) as bigint;
    if (target && float > 0n) {
      let repay = pos[0] / 2n;
      if (repay > float) repay = float;
      try {
        const allowance = (await pub.readContract({ address: dep.leash.usd, abi: b20, functionName: "allowance", args: [account.address, dep.market] })) as bigint;
        if (allowance < repay) await send(dep.leash.usd, b20, "approve", [dep.market, maxUint256]);
        const before = (await pub.readContract({ address: target.token, abi: b20, functionName: "balanceOf", args: [account.address] })) as bigint;
        const tx = await send(dep.market, bell, "liquidate", [a, target.token, repay]);
        const after = (await pub.readContract({ address: target.token, abi: b20, functionName: "balanceOf", args: [account.address] })) as bigint;
        const seized = after - before;
        const p = (await pub.readContract({ address: dep.market, abi: bell, functionName: "priceOf", args: [target.token] })) as any;
        index.liquidations.unshift({
          at: new Date().toISOString(),
          tx,
          account: a,
          ticker: tickerOf.get(target.token.toLowerCase()) ?? "?",
          repaid: Number(repay) / 1e6,
          seized: Number(seized) / 1e8,
          price: Number(p.high) / 1e8,
          hfBefore: hf ?? 0,
        });
        say(`liquidated ${a} on ${tickerOf.get(target.token.toLowerCase())}: repaid ${Number(repay) / 1e6} tUSD (${tx})`);
        if (seized > 0n && !dryRun) {
          const allowanceDesk = (await pub.readContract({ address: target.token, abi: b20, functionName: "allowance", args: [account.address, dep.leash.desk] })) as bigint;
          if (allowanceDesk < seized) await send(target.token, b20, "approve", [dep.leash.desk, maxUint256]);
          await send(dep.leash.desk, deskAbi, "sell", [target.token, seized, 0n]);
          say(`sold seized ${tickerOf.get(target.token.toLowerCase())} back through the desk`);
        }
        pos = (await pub.readContract({ address: dep.market, abi: bell, functionName: "positionOf", args: [a] })) as Pos;
      } catch (e) {
        say(`liquidation of ${a} not possible: ${(e as Error).message.split("\n")[0].slice(0, 200)}`);
      }
    }
  }
  const hfNow = pos[2] === maxUint256 ? null : Number(pos[2]) / 1e18;
  (index.health[a.toLowerCase()] ??= []).push([new Date().toISOString(), hfNow ?? -1]);
  index.health[a.toLowerCase()] = index.health[a.toLowerCase()].slice(-1500);
  accounts.push({
    account: a,
    name: dep.demoBorrowers.find((d) => d.account.toLowerCase() === a.toLowerCase())?.name,
    debt: Number(pos[0]) / 1e6,
    borrowPower: Number(pos[1]) / 1e6,
    healthFactor: hfNow,
    collateral: pos[3]
      .filter((p) => p.balance > 0n)
      .map((p) => ({ ticker: tickerOf.get(p.token.toLowerCase()) ?? "?", balance: Number(p.balance) / 1e8, valueLow: Number(p.valueLow) / 1e6, valueHigh: Number(p.valueHigh) / 1e6, live: p.live })),
  });
}

// 5. publish
const prices = await Promise.all(
  dep.collaterals.map(async (c) => {
    const p = (await pub.readContract({ address: dep.market, abi: bell, functionName: "priceOf", args: [c.token] })) as any;
    return {
      ticker: c.ticker,
      latest: Number(p.latest) / 1e8,
      low: Number(p.low) / 1e8,
      high: Number(p.high) / 1e8,
      updatedAt: Number(p.updatedAt),
      confirmed: p.confirmed,
      stale: p.stale,
      paused: p.paused,
    };
  }),
);
const [totalAssets, totalDebt, util, borrowRate] = (await Promise.all(
  ["totalAssets", "totalDebt", "utilizationBps", "borrowRatePerYearRay"].map((fn) => pub.readContract({ address: dep.market, abi: bell, functionName: fn })),
)) as bigint[];
const run = {
  at: new Date().toISOString(),
  keeper: account.address,
  market: { totalAssets: Number(totalAssets) / 1e6, totalDebt: Number(totalDebt) / 1e6, utilization: Number(util) / 1e4, borrowApr: Number(borrowRate) / 1e27 },
  prices,
  accounts,
  log,
};
writeFileSync(indexFile, JSON.stringify(index));
const statusFile = join(dir, "status.json");
const history = existsSync(statusFile) ? (JSON.parse(readFileSync(statusFile, "utf8")).history ?? []) : [];
writeFileSync(statusFile, JSON.stringify({ latest: run, history: [{ at: run.at, log, market: run.market }, ...history].slice(0, 300) }, null, 1));
say(`accounts ${accounts.length}; utilization ${(Number(util) / 100).toFixed(1)}%; status written`);
void now;
