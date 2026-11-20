import { useMemo, useState } from "react";
import { useWallet } from "../App";
import { ABI, testnet } from "../clients";
import { DEP, LEASH, STOCKS, STOCK_BY_TOKEN, STOCK_NAMES } from "../config";
import { loadIndex, loadMarket, loadPosition, type MarketData, type Position } from "../data";
import { buildScenarios, crashFor, explain, type Scenario, type Verdict } from "../sim";
import { AddrLink, Badge, Card, Empty, Spinner, Stat, TxLink } from "../ui";
import { fmtUsd, short, useAsync } from "../util";
import { HealthBadge, StatusBadge } from "./MarketPage";

async function loadContext() {
  const [float, ...params] = (await Promise.all([
    testnet.readContract({ address: LEASH.usd, abi: ABI.b20, functionName: "balanceOf", args: [DEP.keeper] }),
    ...STOCKS.map((s) => testnet.readContract({ address: DEP.registry, abi: ABI.registry, functionName: "params", args: [s.token] })),
  ])) as [bigint, ...Array<readonly [bigint, boolean, bigint]>];
  return { float, multipliers: new Map(STOCKS.map((s, i) => [s.token.toLowerCase(), params[i][0]])) };
}

function Tester({ p, m, ctx }: { p: Position; m: MarketData; ctx: { float: bigint; multipliers: Map<string, bigint> } }) {
  const list = useMemo(
    () => buildScenarios({ position: p, market: m, liquidator: DEP.keeper, liquidatorFloat: ctx.float, multipliers: ctx.multipliers }),
    [p, m, ctx],
  );
  const [results, setResults] = useState<Record<string, Verdict | "running">>({});
  const runOne = async (s: Scenario) => {
    setResults((r) => ({ ...r, [s.id]: "running" }));
    const v = await s.run();
    setResults((r) => ({ ...r, [s.id]: v }));
  };
  const runAll = async () => {
    for (const s of list) await runOne(s);
  };
  const maxAge = Math.round((m.rows[0]?.maxAge ?? 93600) / 3600);
  const tickerOf = (t: string) => STOCK_BY_TOKEN.get(String(t).toLowerCase())?.ticker ?? short(String(t));
  const crash = Math.round(crashFor(p) * 100);
  return (
    <Card
      title="Try an unfair liquidation"
      extra={
        <span className="muted small">
          Each scenario is an eth_call to the live market with what-if prices. No wallet or gas needed; the verdict comes from the
          deployed contract.
        </span>
      }
    >
      <p className="small">
        The what-ifs crash this borrower's collateral by {crash}%, enough to put the position underwater once the move is
        real. The liquidator is the Bell keeper. <button className="btn small" onClick={runAll}>Run all</button>
      </p>
      <div className="tester">
        {list.map((s) => {
          const r = results[s.id];
          return (
            <div key={s.id} className="scenario">
              <div className="scenario-text">
                <b>{s.title}</b>
                <p className="muted small">{s.story}</p>
                {r && r !== "running" && (
                  <div className={`verdict ${r.allowed ? "allowed" : "blocked"}`}>
                    {r.allowed ? (
                      <>
                        <b>Liquidation allowed:</b> {r.detail ?? "the market accepts it."}
                      </>
                    ) : (
                      <>
                        <b>Blocked by the market</b> <code>{r.name}</code>: {explain(r, tickerOf, maxAge)}
                      </>
                    )}
                  </div>
                )}
              </div>
              <button className="btn small ghost" onClick={() => runOne(s)} disabled={r === "running"}>
                {r === "running" ? <Spinner /> : "Try it"}
              </button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function Holdings({ p, m }: { p: Position; m: MarketData }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Stock</th>
            <th className="num">Amount</th>
            <th className="num">Value (lower print)</th>
            <th className="num">Value (higher print)</th>
            <th className="num">Borrowing power</th>
            <th>Price</th>
          </tr>
        </thead>
        <tbody>
          {p.holdings.map((h) => {
            const row = m.rows.find((r) => r.stock.token === h.stock.token);
            return (
              <tr key={h.stock.token}>
                <td>
                  <b>{h.stock.ticker}</b> <span className="muted">{STOCK_NAMES[h.stock.ticker]}</span>
                </td>
                <td className="num">{h.balance.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
                <td className="num">{fmtUsd(h.valueLow, 0)}</td>
                <td className="num">{fmtUsd(h.valueHigh, 0)}</td>
                <td className="num">{h.live ? fmtUsd((h.valueLow * h.stock.ltvBps) / 10_000, 0) : <span className="muted">$0 (frozen)</span>}</td>
                <td>{row && <StatusBadge row={row} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Liquidations({ account }: { account: string }) {
  const { data: idx } = useAsync(loadIndex, [], 120_000);
  const mine = (idx?.liquidations ?? []).filter((l) => l.account.toLowerCase() === account.toLowerCase());
  if (!mine.length) return null;
  return (
    <Card title="Liquidations">
      <div className="history">
        {mine.map((l) => (
          <div key={l.tx} className="hist-row">
            <span className="small">{new Date(l.at).toLocaleString()}</span>
            <span className="small">
              repaid {fmtUsd(l.repaid, 0)}, seized {l.seized.toFixed(4)} {l.ticker} at {fmtUsd(l.price)} (health {l.hfBefore.toFixed(2)}) · <TxLink hash={l.tx} />
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function AccountPage({ account }: { account: `0x${string}` }) {
  const { address } = useWallet();
  const { data: m, error: mErr } = useAsync(loadMarket, [], 60_000);
  const { data: p, error } = useAsync(() => loadPosition(account), [account], 60_000);
  const { data: ctx } = useAsync(loadContext, [], 0);
  const own = address?.toLowerCase() === account.toLowerCase();
  const toLiq = p?.healthFactor ? 1 - 1 / p.healthFactor : null;
  return (
    <div className="page">
      <div className="vault-head">
        <div>
          <h1>{p?.name ?? (own ? "Your position" : "Position")}</h1>
          <div className="muted small">
            <AddrLink address={account} label={account} />
          </div>
        </div>
        {p && <HealthBadge hf={p.healthFactor} />}
      </div>
      {(error || mErr) && <div className="err">{error ?? mErr}</div>}
      {!p && !error && <Spinner />}
      {p && (
        <Card>
          <div className="stats">
            <Stat label="Debt" value={fmtUsd(p.debt, 2)} hint="tUSD, interest included" />
            <Stat label="Borrowing power" value={fmtUsd(p.borrowPower, 0)} hint="live collateral at its lower print × LTV" />
            <Stat label="Health factor" value={p.healthFactor === null ? "–" : p.healthFactor.toFixed(3)} hint="higher print × threshold ÷ debt" />
            <Stat
              label="Liquidatable after"
              value={toLiq === null ? "–" : toLiq <= 0 ? "now" : `−${(toLiq * 100).toFixed(1)}%`}
              hint="a confirmed fall of every collateral price"
            />
          </div>
          {own && (
            <p className="small">
              This is your wallet. <a href="#/borrow">Borrow, repay or manage collateral</a>.
            </p>
          )}
        </Card>
      )}
      {p && m && (
        <Card title="Collateral">
          {p.holdings.length ? <Holdings p={p} m={m} /> : <Empty>No collateral deposited.</Empty>}
        </Card>
      )}
      {p && m && ctx && p.debt > 0 && <Tester p={p} m={m} ctx={ctx} />}
      {p && p.debt === 0 && (
        <Card title="Try an unfair liquidation">
          <p className="small muted">
            This account has no debt, so there is nothing to liquidate. Open a{" "}
            <a href={`#/account/${(DEP.demoBorrowers[1] ?? DEP.demoBorrowers[0])?.account}`}>demo borrower</a> to run the what-ifs.
          </p>
        </Card>
      )}
      <Liquidations account={account} />
      {p && (
        <p className="muted small">
          {p.name ? <Badge tone="blue">demo borrower</Badge> : null} Positions are read live from <AddrLink address={DEP.market} label="BellMarket" />.
        </p>
      )}
    </div>
  );
}
