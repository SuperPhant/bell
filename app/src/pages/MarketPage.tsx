import { DEP, STOCK_NAMES } from "../config";
import { loadBorrowers, loadMarket, loadStatus, tradingWeek, type CollateralRow, type MarketData, type Position } from "../data";
import { Badge, Card, Spinner, Stat, TxLink } from "../ui";
import { ago, fmtPct, fmtUsd, short, useAsync } from "../util";

export function hfTone(hf: number | null): "ok" | "warn" | "bad" | "neutral" {
  if (hf === null) return "neutral";
  if (hf < 1) return "bad";
  if (hf < 1.3) return "warn";
  return "ok";
}

export function HealthBadge({ hf }: { hf: number | null }) {
  return (
    <Badge tone={hfTone(hf)} title="Collateral at its higher print times the liquidation threshold, divided by debt. Below 1.00 the position can be liquidated through stocks whose price is live.">
      {hf === null ? "no debt" : hf.toFixed(2)}
    </Badge>
  );
}

export function StatusBadge({ row }: { row: CollateralRow }) {
  if (row.status === "paused")
    return (
      <Badge tone="bad" title="Coinbase's oracle registry flags a corporate action: zero borrowing power, cannot be seized.">
        corporate action
      </Badge>
    );
  if (row.status === "stale")
    return (
      <Badge tone="warn" title={`Last print older than ${Math.round(row.maxAge / 3600)} hours: zero borrowing power, cannot be seized.`}>
        closed · {ago(row.price.updatedAt)}
      </Badge>
    );
  if (row.status === "unconfirmed")
    return (
      <Badge tone="blue" title="Only one print seen so far: liquidations wait for the next one.">
        first print
      </Badge>
    );
  return (
    <Badge tone="ok" title="Two prints seen and the price is fresh.">
      live · {ago(row.price.updatedAt)}
    </Badge>
  );
}

function HeroArt() {
  return (
    <div className="hero-art" aria-hidden>
      <svg viewBox="0 0 360 240">
        <rect x="8" y="16" width="344" height="208" rx="16" fill="#EEF3FF" stroke="#0052FF" strokeWidth="2" />
        <rect x="128" y="30" width="78" height="180" fill="#dfe3ea" opacity="0.7" />
        <text x="167" y="52" textAnchor="middle" className="art-s">
          weekend
        </text>
        <path d="M24 92 L48 86 L72 95 L96 84 L120 90" stroke="#0052FF" strokeWidth="3" fill="none" strokeLinecap="round" />
        <path d="M120 90 L232 162" stroke="#cf202f" strokeWidth="2" strokeDasharray="5 5" fill="none" />
        <circle cx="120" cy="90" r="6" fill="#0052FF" />
        <circle cx="232" cy="162" r="9" fill="#cf202f" />
        <circle cx="300" cy="166" r="9" fill="#0052FF" />
        <path d="M232 162 L300 166" stroke="#0052FF" strokeWidth="3" fill="none" />
        <text x="232" y="190" textAnchor="middle" className="art-s">
          1st print: wait
        </text>
        <text x="300" y="206" textAnchor="middle" className="art-s">
          2nd confirms
        </text>
        <text x="58" y="122" textAnchor="middle" className="art-s">
          Friday close
        </text>
      </svg>
    </div>
  );
}

function Pool({ m }: { m: MarketData }) {
  return (
    <div className="stats">
      <Stat label="Supplied" value={fmtUsd(m.totalAssets, 0)} hint={`${fmtUsd(m.cash, 0)} available to borrow`} />
      <Stat label="Borrowed" value={fmtUsd(m.totalDebt, 0)} hint={`${fmtPct(m.utilization)} utilization`} />
      <Stat label="Borrow APR" value={fmtPct(m.borrowApr, 2)} hint="2% + 20% × utilization" />
      <Stat label="Supply APR" value={fmtPct(m.supplyApr, 2)} hint="borrow APR × utilization" />
    </div>
  );
}

function Collaterals({ m }: { m: MarketData }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Stock</th>
            <th className="num">Previous print</th>
            <th className="num">Latest print</th>
            <th className="num" title="Borrowing power uses the lower of the last two prints">
              Borrow at
            </th>
            <th className="num" title="Liquidations use the higher of the last two prints">
              Liquidate at
            </th>
            <th>Price</th>
            <th className="num" title="Max loan-to-value / liquidation threshold / liquidation bonus">
              LTV / threshold / bonus
            </th>
          </tr>
        </thead>
        <tbody>
          {m.rows.map((r) => {
            const prev = r.feedRound === r.lastRound ? r.prevSeen : r.lastSeen;
            const move = prev ? r.price.latest / prev - 1 : 0;
            return (
              <tr key={r.stock.token}>
                <td>
                  <b>{r.stock.ticker}</b> <span className="muted">{STOCK_NAMES[r.stock.ticker]}</span>
                </td>
                <td className="num muted">{prev ? fmtUsd(prev) : "–"}</td>
                <td className="num">
                  {fmtUsd(r.price.latest)}{" "}
                  {prev > 0 && Math.abs(move) >= 0.0005 && (
                    <span className={`small ${move >= 0 ? "pos" : "neg"}`}>
                      {move >= 0 ? "+" : ""}
                      {(move * 100).toFixed(2)}%
                    </span>
                  )}
                </td>
                <td className="num">{fmtUsd(r.price.low)}</td>
                <td className="num">{fmtUsd(r.price.high)}</td>
                <td>
                  <StatusBadge row={r} />
                </td>
                <td className="num small">
                  {r.stock.ltvBps / 100}% / {r.stock.thresholdBps / 100}% / {r.stock.bonusBps / 100}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Borrowers({ list }: { list: Position[] }) {
  if (!list.length) return <div className="muted small">No open positions yet.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Borrower</th>
            <th>Collateral</th>
            <th className="num">Debt</th>
            <th className="num">Borrowing power</th>
            <th className="num">Health</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {list.map((p) => (
            <tr key={p.account}>
              <td>
                <a href={`#/account/${p.account}`}>{p.name ?? short(p.account)}</a>
                {p.name && <div className="muted mono small">{short(p.account)}</div>}
              </td>
              <td className="small">
                {p.holdings.map((h) => (
                  <span key={h.stock.token} className="tick" title={`${h.balance.toFixed(4)} ${h.stock.ticker}`}>
                    {h.stock.ticker} {fmtUsd(h.valueLow, 0)}
                  </span>
                ))}
              </td>
              <td className="num">{fmtUsd(p.debt, 0)}</td>
              <td className="num">{fmtUsd(p.borrowPower, 0)}</td>
              <td className="num">
                <HealthBadge hf={p.healthFactor} />
              </td>
              <td className="num">
                {p.debt > 0 && (
                  <a className="btn small ghost" href={`#/account/${p.account}`}>
                    Try to liquidate
                  </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KeeperLog() {
  const { data: status, error } = useAsync(loadStatus, [], 120_000);
  if (error) return <div className="err small">{error}</div>;
  if (!status) return <Spinner />;
  const runs = [status.latest, ...status.history.filter((h) => h.at !== status.latest.at)].slice(0, 8);
  const describe = (log: string[]) => {
    const lines = log.filter((l) => !l.startsWith("accounts "));
    if (!lines.length) return <>no new prints; nothing to liquidate</>;
    return lines.map((l, i) => {
      const m = l.match(/^(.*?)\s*\((0x[0-9a-fA-F]{64})\)\s*$/);
      return (
        <span key={i}>
          {i > 0 && " · "}
          {m ? (
            <>
              {m[1]} (<TxLink hash={m[2]} />)
            </>
          ) : (
            l
          )}
        </span>
      );
    });
  };
  return (
    <div className="history">
      {runs.map((r) => (
        <div key={r.at} className="hist-row">
          <span className="muted small">{ago(Date.parse(r.at) / 1000)}</span>
          <span className="small">{describe(r.log ?? [])}</span>
        </div>
      ))}
    </div>
  );
}

export function MarketPage() {
  const { data: m, error } = useAsync(loadMarket, [], 60_000);
  const { data: borrowers, error: bErr } = useAsync(() => loadBorrowers(), [], 90_000);
  const week = tradingWeek();
  const live = m?.rows.filter((r) => r.status === "live").length ?? 0;
  const demo = DEP.demoBorrowers[1] ?? DEP.demoBorrowers[0];
  return (
    <div className="page">
      <section className="hero">
        <div className="hero-text">
          <h1>
            Borrow against tokenized stocks.
            <br />
            <span className="blue">Liquidations wait for the bell.</span>
          </h1>
          <p className="lead">
            Bell is a lending market for Coinbase tokenized stocks on Base that keeps stock-market hours. One price print
            can never liquidate you: the next print has to confirm the move. And while a price is frozen, over a weekend
            or during a corporate action, nobody can borrow against it or be liquidated through it.
          </p>
          <div className="hero-cta">
            <a className="btn" href="#/borrow">
              Borrow or lend
            </a>
            {demo && (
              <a className="btn ghost" href={`#/account/${demo.account}`}>
                Try an unfair liquidation
              </a>
            )}
          </div>
        </div>
        <HeroArt />
      </section>

      <section className="steps">
        <div className="step">
          <span className="step-n">1</span>
          <h4>Two prints, not one</h4>
          <p>Borrowing power uses the lower of a stock's last two prints; liquidations use the higher one.</p>
        </div>
        <div className="step">
          <span className="step-n">2</span>
          <h4>Frozen means frozen</h4>
          <p>Stale or corporate-action-paused stocks give zero borrowing power and cannot be seized.</p>
        </div>
        <div className="step">
          <span className="step-n">3</span>
          <h4>Total-return prices</h4>
          <p>Chainlink total-return feeds on raw B20 balances, so splits and dividends never move a position.</p>
        </div>
      </section>

      <div className="status-strip">
        <Badge tone={week.open ? "ok" : "warn"}>{week.open ? "trading week" : "weekend"}</Badge>
        <span className="small">{week.label}.</span>
        {m && (
          <span className="small muted">
            {live} of {m.rows.length} stocks live on the testnet mirror.
          </span>
        )}
      </div>

      <Card title="Pool" extra={<span className="muted small">One pool of test USD (B20 stablecoin), lent against ten tokenized stocks</span>}>
        {error && <div className="err">{error}</div>}
        {!m && !error && <Spinner />}
        {m && <Pool m={m} />}
      </Card>

      <Card
        title="Collateral: the last two prints of every stock"
        extra={<span className="muted small">Mirrored from Base mainnet Chainlink tokenized-equity feeds and Coinbase's oracle registry</span>}
      >
        {!m && !error && <Spinner />}
        {m && <Collaterals m={m} />}
      </Card>

      <Card title="Borrowers" extra={<span className="muted small">Every position the keeper has found, read live from the market</span>}>
        {bErr && <div className="err small">{bErr}</div>}
        {!borrowers && !bErr && <Spinner />}
        {borrowers && <Borrowers list={borrowers} />}
      </Card>

      <Card title="Keeper" extra={<span className="muted small">GitHub Actions, hourly in the trading week: records prints, mirrors pause flags, liquidates what is really underwater</span>}>
        <KeeperLog />
      </Card>
    </div>
  );
}
