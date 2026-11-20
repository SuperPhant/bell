import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  type Abi,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { Attribution } from "ox/erc8021";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const vibenet = defineChain({
  id: 84538453,
  name: "Base Vibenet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.vibes.base.org"] } },
  blockExplorers: { default: { name: "Vibenet Explorer", url: "https://chain.base.org/vibenet/explorer" } },
  testnet: true,
});

export function targetChain(): Chain {
  const name = process.env.BELL_CHAIN ?? "vibenet";
  const chains: Record<string, Chain> = { vibenet, baseSepolia };
  if (!chains[name]) throw new Error(`BELL_CHAIN must be one of ${Object.keys(chains).join(", ")}`);
  return chains[name];
}

/** Coinbase's onchain oracle registry on Base mainnet (multiplier + corporate-action pause flag). */
export const MAINNET_ORACLE_REGISTRY = "0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD" as const;
/** RPCs for eth_getLogs scans where the chain's default RPC caps the block range (sepolia.base.org: 200 blocks). */
export const LOGS_RPC: Record<number, string> = { 84532: "https://base-sepolia-rpc.publicnode.com" };
export const BUILDER_CODE = process.env.BELL_BUILDER_CODE ?? "bc_vfg37ypq";
export const NOTES_DIR = process.env.BELL_NOTES_DIR ?? join(ROOT, "notes-out");

export interface LeashDeployment {
  chainId: number;
  usd: `0x${string}`;
  desk: `0x${string}`;
  faucet: `0x${string}`;
  hub: `0x${string}`;
  stocks: Array<{ ticker: string; token: `0x${string}`; feed: `0x${string}`; feedId: number; mainnetToken: `0x${string}`; mainnetFeed: `0x${string}` }>;
}

export interface BellDeployment {
  chainId: number;
  chainName: string;
  deployedAt: string;
  deployer: `0x${string}`;
  keeper: `0x${string}`;
  builderCode: string;
  dataSuffix: `0x${string}` | "";
  market: `0x${string}`;
  registry: `0x${string}`;
  startBlock: string;
  leash: LeashDeployment;
  collaterals: Array<{ ticker: string; token: `0x${string}`; feed: `0x${string}`; mainnetToken: `0x${string}`; ltvBps: number; thresholdBps: number; bonusBps: number }>;
  demoBorrowers: Array<{ name: string; account: `0x${string}` }>;
}

export const leashDeployment = (chainId: number): LeashDeployment =>
  JSON.parse(readFileSync(join(ROOT, "deployments", `leash-${chainId}.json`), "utf8"));
export const bellPath = (chainId: number) => join(ROOT, "deployments", `${chainId}.json`);
export const bellDeployment = (chainId: number): BellDeployment => JSON.parse(readFileSync(bellPath(chainId), "utf8"));

/** Local key vault used on the maintainer's machine; CI passes keys through environment variables instead. */
export const VAULT = process.env.PHANT_VAULT ?? join(homedir(), "AppData", "Local", "PhantWallet", "vault.py");
export const VAULT_PYTHON = process.env.PHANT_PYTHON ?? join(homedir(), ".pyenv", "pyenv-win", "versions", "3.12.10", "python.exe");

export function loadKey(envName: string, vaultEntry: string): Hex {
  const fromEnv = process.env[envName];
  if (fromEnv) return norm(fromEnv);
  if (!existsSync(VAULT)) throw new Error(`${envName} is not set`);
  const r = spawnSync(VAULT_PYTHON, [VAULT, "get", vaultEntry], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error(`could not read ${vaultEntry} from the local vault (output suppressed)`);
  return norm(r.stdout.trim());
}

function norm(raw: string): Hex {
  const k = raw.trim();
  const key = (k.startsWith("0x") ? k : `0x${k}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("malformed private key (value suppressed)");
  return key;
}

export function abi(name: string): Abi {
  return JSON.parse(readFileSync(join(ROOT, "keeper", "abi", `${name}.json`), "utf8")).abi as Abi;
}

export function bytecode(name: string): Hex {
  return JSON.parse(readFileSync(join(ROOT, "keeper", "abi", `${name}.json`), "utf8")).bytecode as Hex;
}

export function dataSuffix(code = BUILDER_CODE): `0x${string}` | "" {
  return code ? (Attribution.toDataSuffix({ codes: [code] }) as `0x${string}`) : "";
}

export function clients(chain: Chain, key: Hex, attribute = true, code = BUILDER_CODE) {
  const account = privateKeyToAccount(key);
  const transport = http(process.env.BELL_RPC ?? chain.rpcUrls.default.http[0], { retryCount: 4 });
  const pub = createPublicClient({ chain, transport });
  const suffix = dataSuffix(code);
  const wallet = createWalletClient({ chain, transport, account, ...(attribute && suffix ? { dataSuffix: suffix } : {}) });
  return { account, pub, wallet };
}

export function mainnet() {
  const urls = (process.env.BASE_MAINNET_RPCS ?? "https://mainnet.base.org,https://base-rpc.publicnode.com,https://base.drpc.org").split(",");
  return createPublicClient({ chain: base, transport: fallback(urls.map((u) => http(u.trim(), { retryCount: 3 }))) });
}

export async function write(
  pub: PublicClient,
  wallet: WalletClient,
  account: Account,
  req: { address: `0x${string}`; abi: Abi; functionName: string; args?: readonly unknown[] },
) {
  const { request, result } = await pub.simulateContract({ ...req, account } as never);
  const hash = await wallet.writeContract(request as never);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${req.functionName} reverted in ${hash}`);
  return { hash, receipt, result: result as unknown };
}

export async function deployContract(pub: PublicClient, wallet: WalletClient, account: Account, name: string, args: readonly unknown[]) {
  const hash = await wallet.deployContract({ abi: abi(name), bytecode: bytecode(name), args, account, chain: wallet.chain } as never);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deploy ${name} failed in ${hash}`);
  console.log(`deployed ${name} at ${receipt.contractAddress}`);
  return receipt.contractAddress;
}
