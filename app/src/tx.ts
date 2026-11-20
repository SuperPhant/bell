import { BaseError, decodeErrorResult, maxUint256, type Abi, type WalletClient } from "viem";
import { ABI, testnet } from "./clients";
import { CHAIN } from "./config";

export interface Signer {
  wallet: WalletClient;
  address: `0x${string}`;
}

/** Simulates first (so reverts are explained before the wallet pops up), then sends and waits for the receipt. */
export async function send(s: Signer, address: `0x${string}`, abi: Abi, functionName: string, args: readonly unknown[] = []) {
  await testnet.simulateContract({ address, abi, functionName, args, account: s.address } as any);
  const hash = await s.wallet.writeContract({ address, abi, functionName, args, account: s.address, chain: CHAIN } as any);
  const r = await testnet.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return hash;
}

/** Approves `spender` once for an unlimited amount if the current allowance is too small. */
export async function ensureAllowance(s: Signer, token: `0x${string}`, spender: `0x${string}`, amount: bigint) {
  const current = (await testnet.readContract({ address: token, abi: ABI.b20, functionName: "allowance", args: [s.address, spender] })) as bigint;
  if (current >= amount) return;
  await send(s, token, ABI.b20, "approve", [spender, maxUint256]);
}

export function errorText(e: unknown): string {
  if (e instanceof BaseError) {
    const raw = (e.walk((x: any) => typeof x?.data === "string" && x.data.startsWith("0x")) as any)?.data;
    for (const abi of [ABI.market, ABI.b20, ABI.desk, ABI.faucet]) {
      if (!raw) break;
      try {
        const d = decodeErrorResult({ abi, data: raw });
        const args = (d.args ?? []).map((a: any) => (typeof a === "bigint" ? a.toString() : String(a))).join(", ");
        return `${d.errorName}(${args})`;
      } catch {}
    }
    const details = (e as any).details as string | undefined;
    return details && !e.shortMessage.includes(details) ? `${e.shortMessage} ${details}` : e.shortMessage;
  }
  return (e as any)?.message ?? String(e);
}
