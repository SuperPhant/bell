import { COINBASE_REGISTRY, DEP, LEASH, LEASH_REPO, REPO, STOCKS } from "../config";
import { AddrLink, Card } from "../ui";

export function AboutPage() {
  const tiers = [
    { names: "AAPL, AMZN, GOOGL, META, MSFT", s: STOCKS.find((s) => s.ticker === "AAPL") },
    { names: "NVDA, TSLA", s: STOCKS.find((s) => s.ticker === "NVDA") },
    { names: "MSTR, SNDK, SPCX", s: STOCKS.find((s) => s.ticker === "MSTR") },
  ];
  return (
    <div className="page narrow">
      <h1>How Bell works</h1>
      <p className="lead">
        Crypto lending markets assume prices that move every second of every day. Stocks don't: their Chainlink feeds follow
        the 24/5 trading week, stop over weekends and holidays, freeze during corporate actions, and print thin overnight
        sessions. Bell is a lending market for Coinbase tokenized stocks on Base built around that.
      </p>

      <Card title="The rules, enforced by the BellMarket contract">
        <ul className="rules stacked">
          <li>
            <b>Two-print pricing.</b>
            <span>
              The market remembers the last two feed rounds it has seen for every stock. Borrowing power uses the lower one,
              liquidations the higher one. A single print, such as the first print after a weekend or a bad tick, can never
              liquidate anyone: the next print has to confirm the move.
            </span>
          </li>
          <li>
            <b>Frozen means frozen.</b>
            <span>
              If a stock's last print is older than its maximum age (26 hours: the feeds' 24-hour heartbeat plus two hours of
              grace), or Coinbase's oracle registry flags it as paused for a corporate action, it gives zero borrowing power and
              cannot be seized. It still counts toward the borrower's health at its higher print, so a freeze cannot trigger a
              liquidation either. Repaying and adding collateral always work.
            </span>
          </li>
          <li>
            <b>Total-return prices.</b>
            <span>
              Feeds report price × B20 multiplier, so positions are valued on raw token balances and splits or reinvested
              dividends never move a position's value.
            </span>
          </li>
          <li>
            <b>Bounded liquidations.</b>
            <span>At most half the debt per liquidation (close factor 50%), with a bonus that grows with the stock's risk tier.</span>
          </li>
        </ul>
      </Card>

      <Card title="Why wait for a second print?">
        <p className="small">
          Liquidations are irreversible, and one print is only a claim about the price. Waiting for one more print costs little,
          because borrowing power already uses the lower print and the liquidation threshold sits 15 percentage points above
          the maximum LTV. A position opened at the maximum LTV survives a confirmed fall of about 23% (megacaps), 27% (NVDA,
          TSLA) or 33% (MSTR, SNDK, SPCX) before it can be liquidated.
        </p>
        <p className="small">
          The Base documentation is explicit about the feeds: off-hours "it stops updating and holds the last value", and
          "never settle or liquidate against a frozen feed". During a corporate action "the feed freezes (the registry pause
          flag is set)". Bell reads that flag directly instead of waiting for the price to go stale.
        </p>
      </Card>

      <Card title="Risk parameters">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Stocks</th>
                <th className="num">Max LTV</th>
                <th className="num">Liquidation threshold</th>
                <th className="num">Liquidation bonus</th>
                <th className="num">Max price age</th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((t) => (
                <tr key={t.names}>
                  <td>{t.names}</td>
                  <td className="num">{(t.s?.ltvBps ?? 0) / 100}%</td>
                  <td className="num">{(t.s?.thresholdBps ?? 0) / 100}%</td>
                  <td className="num">{(t.s?.bonusBps ?? 0) / 100}%</td>
                  <td className="num">26 h</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">Interest: 2% APR + 20% APR × utilization, paid to lenders pro rata.</p>
      </Card>

      <Card title="What runs where">
        <ul className="bullets small">
          <li>
            <b>BellMarket</b> (<AddrLink address={DEP.market} />): lenders supply test USD; borrowers post B20 test stocks and
            borrow. <code>priceOf</code> returns each stock's latest, low and high print and whether it is confirmed, stale or
            paused; <code>positionOf</code> returns debt, borrowing power, health and every collateral's value in one call.
          </li>
          <li>
            <b>Oracle registry</b> (<AddrLink address={DEP.registry} />): a testnet copy of Coinbase's tokenized-stock oracle
            registry (<AddrLink address={COINBASE_REGISTRY} mainnet label="mainnet" />, <code>getOracleParams</code> → multiplier,
            paused), kept in sync by the keeper.
          </li>
          <li>
            <b>Prices</b> (<AddrLink address={LEASH.hub} />): Base mainnet Chainlink tokenized-equity rounds (same round ids,
            answers and timestamps), mirrored to the testnet every two hours around US market hours (and once a day otherwise)
            by the{" "}
            <a href={LEASH_REPO}>Leash</a> agent, our Agentic Stock Finance entry. Bell shares its test stocks, test USD and
            swap desk; Bell's contracts, keeper and app are separate.
          </li>
          <li>
            <b>Keeper</b> (<AddrLink address={DEP.keeper} />): a GitHub Actions job, hourly in the trading week. It mirrors the
            pause flags, records new prints with <code>pokeAll()</code>, scans for borrowers, liquidates positions that are
            underwater on live, confirmed prices, sells what it seized back through the desk, and publishes its status to the{" "}
            <a href={`${REPO}/tree/notes`}>notes branch</a>. Anyone may call <code>poke</code> or <code>liquidate</code>; the
            keeper is not privileged.
          </li>
          <li>
            <b>Builder Code</b> <code>{DEP.builderCode}</code> (ERC-8021) on every keeper transaction and every transaction sent
            from this app.
          </li>
        </ul>
      </Card>

      <Card title="Testnet">
        <p className="small">
          The demo runs on Base Vibenet (chain id {DEP.chainId}), Base's preview testnet, whose faucet needs no captcha, so
          anyone can try the full flow. Test tokens have no value, are not securities and are not issued by Coinbase. Nothing
          here is an offer to lend or borrow. Coinbase tokenized stocks are not available to US persons, and neither is Bell.
        </p>
        <p className="small">
          Source, tests and deployment scripts: <a href={REPO}>{REPO.replace("https://", "")}</a> (MIT).
        </p>
      </Card>
    </div>
  );
}
