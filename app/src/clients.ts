import { createPublicClient, createWalletClient, custom, http, type Abi, type WalletClient } from "viem";
import { CHAIN, DEP, MAINNET, MAINNET_RPC } from "./config";
import BellMarket from "./abi/BellMarket.json";
import LeashDesk from "./abi/LeashDesk.json";
import UsdFaucet from "./abi/UsdFaucet.json";
import MirrorFeedHub from "./abi/MirrorFeedHub.json";
import MirrorOracleRegistry from "./abi/MirrorOracleRegistry.json";
import IB20 from "./abi/IB20.json";
import Aggregator from "./abi/AggregatorV3Interface.json";

export const ABI = {
  market: BellMarket.abi as Abi,
  desk: LeashDesk.abi as Abi,
  faucet: UsdFaucet.abi as Abi,
  hub: MirrorFeedHub.abi as Abi,
  registry: MirrorOracleRegistry.abi as Abi,
  b20: IB20.abi as Abi,
  feed: Aggregator.abi as Abi,
};

// The public Vibenet RPC rate-limits by request count (JSON-RPC error -32016 inside an HTTP 200, which viem does not
// retry), so reads are folded into Multicall3 calls and rate-limited requests are retried with backoff.
let rpcId = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const patientRpc = (url: string) =>
  custom({
    async request({ method, params }) {
      for (let attempt = 0; ; attempt++) {
        let j: any;
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
          });
          j = await res.json();
        } catch (e) {
          if (attempt < 4) {
            await sleep(500 * (attempt + 1));
            continue;
          }
          throw e;
        }
        if (j.error) {
          if (j.error.code === -32016 && attempt < 8) {
            await sleep(700 * (attempt + 1));
            continue;
          }
          throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
        }
        return j.result;
      }
    },
  });

export const testnet = createPublicClient({
  chain: CHAIN,
  batch: { multicall: { wait: 20 } },
  transport: patientRpc(CHAIN.rpcUrls.default.http[0]),
});
export const mainnet = createPublicClient({ chain: MAINNET, transport: http(MAINNET_RPC, { batch: true, retryCount: 3 }) });

type Eip1193 = { request: (args: { method: string; params?: unknown }) => Promise<unknown>; on?: (e: string, f: (...a: any[]) => void) => void };

export function injected(): Eip1193 | null {
  return ((window as any).ethereum as Eip1193) ?? null;
}

/** Connects the browser wallet, switching (or adding) the Bell testnet. Every transaction carries the Builder Code. */
export async function connectWallet(): Promise<{ wallet: WalletClient; address: `0x${string}` }> {
  const eth = injected();
  if (!eth) throw new Error("No browser wallet found. Install Coinbase Wallet or MetaMask to continue.");
  const wallet = createWalletClient({ chain: CHAIN, transport: custom(eth), dataSuffix: DEP.dataSuffix } as any);
  const [address] = await wallet.requestAddresses();
  const current = await wallet.getChainId();
  if (current !== CHAIN.id) {
    try {
      await wallet.switchChain({ id: CHAIN.id });
    } catch {
      await wallet.addChain({ chain: CHAIN });
      await wallet.switchChain({ id: CHAIN.id });
    }
  }
  return { wallet, address };
}
