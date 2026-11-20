// Deploys Bell on a Base testnet, on top of the Leash testnet market (tUSD, B20 test stocks, mirrored Chainlink feeds,
// oracle-priced desk), seeds lender liquidity and opens three demo borrower positions.
import { parseEther, parseUnits, maxUint256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  BUILDER_CODE,
  MAINNET_ORACLE_REGISTRY,
  VAULT,
  VAULT_PYTHON,
  abi,
  bellPath,
  clients,
  dataSuffix,
  deployContract,
  leashDeployment,
  loadKey,
  mainnet,
  targetChain,
  write,
  type BellDeployment,
} from "./config.js";

const chain = targetChain();
const leash = leashDeployment(chain.id);
const deployerKey = loadKey("DEPLOYER_KEY", "testnet-deployer");
const keeperKey = loadKey("KEEPER_KEY", "testnet-bell-keeper");
const keeperAddress = privateKeyToAccount(keeperKey).address;
const { pub, wallet, account } = clients(chain, deployerKey, false);
const keeper = clients(chain, keeperKey);
const usd = (x: string) => parseUnits(x, 6);

// Risk tiers: megacaps, high-beta megacaps, single-name volatility.
const TIERS: Record<string, [number, number, number]> = {
  AAPL: [5000, 6500, 500],
  MSFT: [5000, 6500, 500],
  GOOGL: [5000, 6500, 500],
  AMZN: [5000, 6500, 500],
  META: [5000, 6500, 500],
  NVDA: [4000, 5500, 750],
  TSLA: [4000, 5500, 750],
  MSTR: [3000, 4500, 1000],
  SNDK: [3000, 4500, 1000],
  SPCX: [3000, 4500, 1000],
};

console.log(`chain ${chain.name}; deployer ${account.address}; keeper ${keeperAddress}; builder code ${BUILDER_CODE || "(none)"}`);
const startBlock = await pub.getBlockNumber();

const registry = await deployContract(pub, wallet, account, "MirrorOracleRegistry", [keeperAddress]);
const market = await deployContract(pub, wallet, account, "BellMarket", [leash.usd, registry, 2n * 10n ** 25n, 2n * 10n ** 26n]);

const collaterals: BellDeployment["collaterals"] = [];
for (const s of leash.stocks) {
  const [ltv, threshold, bonus] = TIERS[s.ticker];
  await write(pub, wallet, account, { address: registry, abi: abi("MirrorOracleRegistry"), functionName: "mapToken", args: [s.token, s.mainnetToken] });
  await write(pub, wallet, account, {
    address: market,
    abi: abi("BellMarket"),
    functionName: "listCollateral",
    args: [s.token, s.feed, ltv, threshold, bonus, 26 * 3600],
  });
  collaterals.push({ ticker: s.ticker, token: s.token, feed: s.feed, mainnetToken: s.mainnetToken, ltvBps: ltv, thresholdBps: threshold, bonusBps: bonus });
  console.log(`listed ${s.ticker} ltv ${ltv} threshold ${threshold} bonus ${bonus}`);
}

// Mirror the corporate-action pause flags from Coinbase's mainnet registry.
const m = mainnet();
const regAbi = [{ type: "function", name: "getOracleParams", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }, { type: "bool" }] }] as const;
const params = await Promise.all(leash.stocks.map((s) => m.readContract({ address: MAINNET_ORACLE_REGISTRY, abi: regAbi, functionName: "getOracleParams", args: [s.mainnetToken] })));
await write(keeper.pub, keeper.wallet, keeper.account, {
  address: registry,
  abi: abi("MirrorOracleRegistry"),
  functionName: "mirror",
  args: [leash.stocks.map((s) => s.token), params.map((p) => p[0]), params.map((p) => p[1])],
});

const b20 = abi("IB20");
const bell = abi("BellMarket");
// Lender liquidity and the keeper's liquidation float.
await write(pub, wallet, account, { address: leash.usd, abi: b20, functionName: "mint", args: [account.address, usd("300000")] });
await write(pub, wallet, account, { address: leash.usd, abi: b20, functionName: "approve", args: [market, maxUint256] });
await write(pub, wallet, account, { address: market, abi: bell, functionName: "supply", args: [usd("300000")] });
await write(pub, wallet, account, { address: leash.usd, abi: b20, functionName: "mint", args: [keeperAddress, usd("50000")] });

const dep: BellDeployment = {
  chainId: chain.id,
  chainName: chain.name,
  deployedAt: new Date().toISOString(),
  deployer: account.address,
  keeper: keeperAddress,
  builderCode: BUILDER_CODE,
  dataSuffix: dataSuffix(),
  market,
  registry,
  startBlock: startBlock.toString(),
  leash,
  collaterals,
  demoBorrowers: [],
};
writeFileSync(bellPath(chain.id), JSON.stringify(dep, null, 2));

// Demo borrowers: buy collateral through the Leash desk at the Chainlink price, deposit, borrow. The same three
// borrower keys are used on every chain (created once, kept in the local key vault).
const BORROWERS: Array<{ name: string; buys: Array<[string, string]>; borrow: string }> = [
  { name: "Conservative: AAPL + MSFT at 25% LTV", buys: [["AAPL", "10000"], ["MSFT", "10000"]], borrow: "5000" },
  { name: "Levered on NVDA at 40% LTV", buys: [["NVDA", "20000"]], borrow: "7900" },
  { name: "Levered on MSTR at 30% LTV", buys: [["MSTR", "20000"]], borrow: "5900" },
];
function borrowerKey(i: number, name: string): `0x${string}` {
  const entry = `testnet-bell-b${i + 1}`;
  const existing = spawnSync(VAULT_PYTHON, [VAULT, "get", entry], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (existing.status === 0 && /^(0x)?[0-9a-fA-F]{64}$/.test(existing.stdout.trim())) {
    const k = existing.stdout.trim();
    return (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;
  }
  const pk = generatePrivateKey();
  const r = spawnSync(
    VAULT_PYTHON,
    [VAULT, "set", entry, privateKeyToAccount(pk).address, pk, "--note", `web3_hackathons lane: TESTNET-ONLY Bell demo borrower (${name}). Created ${new Date().toISOString().slice(0, 10)}.`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (r.status !== 0) throw new Error("could not store borrower key (output suppressed)");
  return pk;
}
for (const [i, b] of BORROWERS.entries()) {
  const pk = borrowerKey(i, b.name);
  const acct = privateKeyToAccount(pk);
  if ((await pub.getBalance({ address: acct.address })) === 0n) {
    if (chain.id === 84538453) {
      await fetch("https://api.vibes.base.org/api/vibenet/faucet/drip", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: acct.address }) });
    } else {
      await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: acct.address, value: parseEther("0.002"), account, chain }) });
    }
  }
  for (let k = 0; k < 30 && (await pub.getBalance({ address: acct.address })) === 0n; k++) await new Promise((res) => setTimeout(res, 2000));
  const total = b.buys.reduce((a, [, x]) => a + usd(x), 0n);
  await write(pub, wallet, account, { address: leash.usd, abi: b20, functionName: "mint", args: [acct.address, total] });
  const c = clients(chain, pk);
  await write(c.pub, c.wallet, c.account, { address: leash.usd, abi: b20, functionName: "approve", args: [leash.desk, maxUint256] });
  for (const [ticker, amount] of b.buys) {
    const token = leash.stocks.find((s) => s.ticker === ticker)!.token;
    await write(c.pub, c.wallet, c.account, { address: leash.desk, abi: abi("LeashDesk"), functionName: "buy", args: [token, usd(amount), 0n] });
    const bal = (await c.pub.readContract({ address: token, abi: b20, functionName: "balanceOf", args: [c.account.address] })) as bigint;
    await write(c.pub, c.wallet, c.account, { address: token, abi: b20, functionName: "approve", args: [market, maxUint256] });
    await write(c.pub, c.wallet, c.account, { address: market, abi: bell, functionName: "depositCollateral", args: [token, bal] });
  }
  await write(c.pub, c.wallet, c.account, { address: market, abi: bell, functionName: "borrow", args: [usd(b.borrow)] });
  dep.demoBorrowers.push({ name: b.name, account: acct.address });
  console.log(`borrower ${i + 1} ${acct.address}: ${b.name}`);
}
writeFileSync(bellPath(chain.id), JSON.stringify(dep, null, 2));
console.log(`wrote ${bellPath(chain.id)}`);
