import { useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { useWallet } from "../App";
import { ABI, testnet } from "../clients";
import { BASE_SEPOLIA_FAUCETS, CHAIN, DEP, LEASH, STOCKS, STOCK_NAMES, VIBENET_ID, onChain } from "../config";
import { loadPosition } from "../data";
import { ensureAllowance, errorText, send, type Signer } from "../tx";
import { Card, Spinner, Stat } from "../ui";
import { fmtUsd, useAsync } from "../util";
import { HealthBadge } from "./MarketPage";

const usd6 = (s: string) => {
  try {
    return parseUnits(s || "0", 6);
  } catch {
    return 0n;
  }
};

async function loadWallet(address: `0x${string}`) {
  const [eth, usd, last, cooldown, shares, supplied, ...stocks] = (await Promise.all([
    testnet.getBalance({ address }),
    testnet.readContract({ address: LEASH.usd, abi: ABI.b20, functionName: "balanceOf", args: [address] }),
    testnet.readContract({ address: LEASH.faucet, abi: ABI.faucet, functionName: "lastClaim", args: [address] }),
    testnet.readContract({ address: LEASH.faucet, abi: ABI.faucet, functionName: "cooldown" }),
    testnet.readContract({ address: DEP.market, abi: ABI.market, functionName: "sharesOf", args: [address] }),
    testnet.readContract({ address: DEP.market, abi: ABI.market, functionName: "assetsOf", args: [address] }),
    ...STOCKS.map((s) => testnet.readContract({ address: s.token, abi: ABI.b20, functionName: "balanceOf", args: [address] })),
  ])) as bigint[];
  const position = await loadPosition(address);
  return {
    eth,
    usd,
    nextClaim: last === 0n ? 0 : Number(last + cooldown),
    shares,
    supplied,
    stocks: STOCKS.map((s, i) => ({ stock: s, raw: stocks[i] })),
    position,
  };
}

export function BorrowPage() {
  const { address, wallet, connect } = useWallet();
  const [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [buyTicker, setBuyTicker] = useState("NVDA");
  const [buyUsd, setBuyUsd] = useState("5000");
  const [borrowUsd, setBorrowUsd] = useState("1000");
  const [repayUsd, setRepayUsd] = useState("");
  const [supplyUsd, setSupplyUsd] = useState("1000");
  // Reloaded explicitly after each action (not keyed on the status text) so balances stay on screen while refreshing.
  const w = useAsync(async () => (address ? loadWallet(address) : null), [address], 30_000);
  const buyStock = STOCKS.find((s) => s.ticker === buyTicker)!;
  const quote = useAsync(
    async () => (usd6(buyUsd) > 0n ? ((await testnet.readContract({ address: LEASH.desk, abi: ABI.desk, functionName: "quote", args: [buyStock.token, true, usd6(buyUsd)] })) as bigint) : 0n),
    [buyTicker, buyUsd],
  );

  const run = async (label: string, fn: (s: Signer) => Promise<string | void>) => {
    setBusy(true);
    setStatus(`${label}…`);
    try {
      const s = wallet && address ? { wallet, address } : await connect();
      if (!s) throw new Error("Connect a wallet first.");
      const msg = await fn(s);
      setStatus(msg || `${label}: done.`);
    } catch (e) {
      setStatus(`${label}: ${errorText(e)}`);
    } finally {
      setBusy(false);
      w.reload();
    }
  };

  const dripGas = () =>
    run("Requesting test ETH from the Vibenet faucet", async (s) => {
      const r = await fetch("https://api.vibes.base.org/api/vibenet/faucet/drip", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: s.address }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error ?? body?.message ?? `HTTP ${r.status}`);
      if (body.tx_hash) await testnet.waitForTransactionReceipt({ hash: body.tx_hash });
      return "0.1 test ETH received for gas.";
    });
  const claim = () =>
    run("Claiming test USD", async (s) => {
      await send(s, LEASH.faucet, ABI.faucet, "claim");
      return "10,000 tUSD received.";
    });
  const buy = () =>
    run(`Buying ${buyTicker}`, async (s) => {
      const amount = usd6(buyUsd);
      const out = (await testnet.readContract({ address: LEASH.desk, abi: ABI.desk, functionName: "quote", args: [buyStock.token, true, amount] })) as bigint;
      await ensureAllowance(s, LEASH.usd, LEASH.desk, amount);
      await send(s, LEASH.desk, ABI.desk, "buy", [buyStock.token, amount, (out * 99n) / 100n]);
      return `Bought ${formatUnits(out, 8)} ${buyTicker}. Deposit it below to borrow against it.`;
    });
  const deposit = (token: `0x${string}`, raw: bigint, ticker: string) =>
    run(`Depositing ${ticker}`, async (s) => {
      await ensureAllowance(s, token, DEP.market, raw);
      await send(s, DEP.market, ABI.market, "depositCollateral", [token, raw]);
      return `${ticker} deposited as collateral.`;
    });
  const withdrawCollateral = (token: `0x${string}`, raw: bigint, ticker: string) =>
    run(`Withdrawing ${ticker}`, async (s) => {
      await send(s, DEP.market, ABI.market, "withdrawCollateral", [token, raw]);
      return `${ticker} withdrawn.`;
    });
  const borrow = () =>
    run("Borrowing", async (s) => {
      await send(s, DEP.market, ABI.market, "borrow", [usd6(borrowUsd)]);
      return `Borrowed ${fmtUsd(Number(borrowUsd), 2)}.`;
    });
  const repay = () =>
    run("Repaying", async (s) => {
      const debt = w.data?.position.debtRaw ?? 0n;
      // "Repay all" sends a little more than the debt so interest accrued meanwhile is covered; the market only takes what is owed.
      let amount = repayUsd ? usd6(repayUsd) : debt + debt / 1000n + 1n;
      if (w.data && amount > w.data.usd) amount = w.data.usd;
      await ensureAllowance(s, LEASH.usd, DEP.market, amount);
      await send(s, DEP.market, ABI.market, "repay", [amount, s.address]);
      return "Repaid.";
    });
  const supply = () =>
    run("Supplying", async (s) => {
      const amount = usd6(supplyUsd);
      await ensureAllowance(s, LEASH.usd, DEP.market, amount);
      await send(s, DEP.market, ABI.market, "supply", [amount]);
      return `Supplied ${fmtUsd(Number(supplyUsd), 2)} to the pool.`;
    });
  const withdrawSupply = () =>
    run("Withdrawing your supply", async (s) => {
      await send(s, DEP.market, ABI.market, "withdraw", [w.data?.shares ?? 0n]);
      return "Supply withdrawn.";
    });

  const d = w.data;
  const p = d?.position;
  const available = p ? Math.max(0, p.borrowPower - p.debt) : 0;
  const now = Date.now() / 1000;
  return (
    <div className="page narrow">
      <h1>Borrow &amp; lend</h1>
      <p className="lead">
        Everything runs on {CHAIN.name} with test tokens: get test USD from the app, buy a test stock at its Chainlink price,
        post it as collateral and borrow against it. Or lend test USD to the pool.
      </p>

      <Card title="Your wallet">
        {!address && (
          <button className="btn" onClick={() => connect()}>
            Connect wallet
          </button>
        )}
        {address && !d && <Spinner />}
        {d && (
          <>
            <div className="stats">
              <Stat label="Gas" value={`${Number(formatUnits(d.eth, 18)).toFixed(4)} ETH`} />
              <Stat label="Test USD" value={fmtUsd(Number(formatUnits(d.usd, 6)), 2)} />
              <Stat label="Debt" value={fmtUsd(p!.debt, 2)} />
              <Stat label="Health" value={<HealthBadge hf={p!.healthFactor} />} />
            </div>
            {CHAIN.id !== VIBENET_ID && d.eth === 0n && (
              <p className="note small">
                You need a little {CHAIN.name} ETH for gas:{" "}
                {BASE_SEPOLIA_FAUCETS.map(([n, u], i) => (
                  <span key={u}>
                    {i ? " · " : ""}
                    <a href={u} target="_blank" rel="noreferrer">
                      {n}
                    </a>
                  </span>
                ))}
                . No captcha wanted? <a href={onChain(VIBENET_ID, "#/borrow")}>Use Bell on Base Vibenet</a>, where test gas is one click.
              </p>
            )}
            <div className="row gap wrap">
              {CHAIN.id === VIBENET_ID && (
                <button className="btn small ghost" onClick={dripGas} disabled={busy}>
                  Get test ETH (gas)
                </button>
              )}
              <button className="btn small ghost" onClick={claim} disabled={busy || d.nextClaim > now} title={d.nextClaim > now ? "The faucet has a cooldown" : undefined}>
                Get 10,000 tUSD
              </button>
              <a className="btn small ghost" href={`#/account/${address}`}>
                Open my position
              </a>
            </div>
          </>
        )}
        {status && <p className="note small">{status}</p>}
      </Card>

      <Card title="1 · Buy a test stock" extra={<span className="muted small">Leash desk: fills at the Chainlink price plus a small spread</span>}>
        <div className="row gap wrap">
          <select className="input" value={buyTicker} onChange={(e) => setBuyTicker(e.target.value)}>
            {STOCKS.map((s) => (
              <option key={s.ticker} value={s.ticker}>
                {s.ticker} · {STOCK_NAMES[s.ticker]}
              </option>
            ))}
          </select>
          <input className="input" value={buyUsd} onChange={(e) => setBuyUsd(e.target.value)} inputMode="decimal" aria-label="USD to spend" />
          <span className="muted small">tUSD →</span>
          <span className="small">
            {quote.error ? <span className="err">Desk: {quote.error}</span> : quote.data !== undefined ? `${Number(formatUnits(quote.data, 8)).toFixed(4)} ${buyTicker}` : "…"}
          </span>
          <button className="btn small" onClick={buy} disabled={busy || !address}>
            Buy
          </button>
        </div>
      </Card>

      <Card title="2 · Post collateral">
        {!d && <p className="muted small">Connect a wallet to see your stocks.</p>}
        {d && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Stock</th>
                  <th className="num">In wallet</th>
                  <th className="num">Posted</th>
                  <th className="num">LTV</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {d.stocks
                  .filter((x) => x.raw > 0n || p!.holdings.some((h) => h.stock.token === x.stock.token))
                  .map((x) => {
                    const h = p!.holdings.find((y) => y.stock.token === x.stock.token);
                    return (
                      <tr key={x.stock.token}>
                        <td>
                          <b>{x.stock.ticker}</b>
                        </td>
                        <td className="num">{Number(formatUnits(x.raw, 8)).toFixed(4)}</td>
                        <td className="num">{h ? h.balance.toFixed(4) : "–"}</td>
                        <td className="num">{x.stock.ltvBps / 100}%</td>
                        <td className="num">
                          {x.raw > 0n && (
                            <button className="btn small" onClick={() => deposit(x.stock.token, x.raw, x.stock.ticker)} disabled={busy}>
                              Deposit all
                            </button>
                          )}{" "}
                          {h && (
                            <button className="btn small ghost" onClick={() => withdrawCollateral(h.stock.token, h.raw, h.stock.ticker)} disabled={busy}>
                              Withdraw
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
            {!d.stocks.some((x) => x.raw > 0n) && !p!.holdings.length && <p className="muted small">Buy a test stock first.</p>}
          </div>
        )}
      </Card>

      <Card title="3 · Borrow and repay">
        {p && (
          <p className="small">
            Borrowing power {fmtUsd(p.borrowPower, 2)} (live collateral at its lower print × LTV), debt {fmtUsd(p.debt, 2)}: you can
            borrow up to <b>{fmtUsd(available, 2)}</b> more.
          </p>
        )}
        <div className="row gap wrap">
          <input className="input" value={borrowUsd} onChange={(e) => setBorrowUsd(e.target.value)} inputMode="decimal" aria-label="USD to borrow" />
          <button className="btn small" onClick={borrow} disabled={busy || !address}>
            Borrow
          </button>
          <input className="input" value={repayUsd} placeholder="all" onChange={(e) => setRepayUsd(e.target.value)} inputMode="decimal" aria-label="USD to repay" />
          <button className="btn small ghost" onClick={repay} disabled={busy || !address || !p?.debt}>
            Repay
          </button>
        </div>
      </Card>

      <Card title="Lend" extra={<span className="muted small">Earn the borrow rate × utilization</span>}>
        {d && (
          <p className="small">
            You have supplied <b>{fmtUsd(Number(formatUnits(d.supplied, 6)), 2)}</b>.
          </p>
        )}
        <div className="row gap wrap">
          <input className="input" value={supplyUsd} onChange={(e) => setSupplyUsd(e.target.value)} inputMode="decimal" aria-label="USD to supply" />
          <button className="btn small" onClick={supply} disabled={busy || !address}>
            Supply
          </button>
          <button className="btn small ghost" onClick={withdrawSupply} disabled={busy || !d?.shares}>
            Withdraw all
          </button>
        </div>
      </Card>
    </div>
  );
}
