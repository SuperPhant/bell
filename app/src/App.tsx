import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { WalletClient } from "viem";
import { connectWallet, injected } from "./clients";
import { CHAIN, DEP, REPO } from "./config";
import { short } from "./util";
import { MarketPage } from "./pages/MarketPage";
import { AccountPage } from "./pages/AccountPage";
import { BorrowPage } from "./pages/BorrowPage";
import { AboutPage } from "./pages/AboutPage";

interface WalletState {
  address?: `0x${string}`;
  wallet?: WalletClient;
  connect: () => Promise<{ wallet: WalletClient; address: `0x${string}` } | undefined>;
  error?: string;
}

const WalletCtx = createContext<WalletState>({ connect: async () => undefined });
export const useWallet = () => useContext(WalletCtx);

function useHashRoute() {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const on = () => {
      setHash(location.hash || "#/");
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash.replace(/^#/, "");
}

function WalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ address?: `0x${string}`; wallet?: WalletClient; error?: string }>({});
  const connect = async () => {
    try {
      const r = await connectWallet();
      setState({ address: r.address, wallet: r.wallet });
      return r;
    } catch (e: any) {
      setState((s) => ({ ...s, error: e?.shortMessage ?? e?.message ?? String(e) }));
      return undefined;
    }
  };
  useEffect(() => {
    const eth = injected();
    eth?.on?.("accountsChanged", (accts: string[]) => setState((s) => ({ ...s, address: accts[0] as `0x${string}` | undefined })));
  }, []);
  return <WalletCtx.Provider value={{ ...state, connect }}>{children}</WalletCtx.Provider>;
}

export function BellLogo({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden>
      <rect width="32" height="32" rx="8" fill="#0052FF" />
      <path d="M16 6.5c-3.6 0-6.2 2.8-6.2 6.4v4.6L8 20.6h16l-1.8-3.1v-4.6c0-3.6-2.6-6.4-6.2-6.4z" fill="white" />
      <circle cx="16" cy="23.6" r="2.3" fill="white" />
    </svg>
  );
}

function Header() {
  const { address, connect, error } = useWallet();
  return (
    <header className="topbar">
      <a className="brand" href="#/">
        <span className="logo">
          <BellLogo />
        </span>
        Bell
      </a>
      <nav>
        <a href="#/">Market</a>
        <a href="#/borrow">Borrow &amp; lend</a>
        <a href="#/about">How it works</a>
        <a href={REPO} target="_blank" rel="noreferrer">
          GitHub
        </a>
      </nav>
      <div className="wallet">
        <span className="chip net">{CHAIN.name}</span>
        {address ? (
          <a className="chip addr" href={`#/account/${address}`}>
            {short(address)}
          </a>
        ) : (
          <button className="btn small" onClick={connect} title={error}>
            Connect wallet
          </button>
        )}
      </div>
    </header>
  );
}

export function App() {
  const route = useHashRoute();
  let page: ReactNode;
  if (!DEP) page = <div className="page"><p>No deployment found.</p></div>;
  else if (route.startsWith("/account/")) page = <AccountPage account={route.split("/")[2] as `0x${string}`} />;
  else if (route.startsWith("/borrow")) page = <BorrowPage />;
  else if (route.startsWith("/about")) page = <AboutPage />;
  else page = <MarketPage />;
  return (
    <WalletProvider>
      <Header />
      <main>{page}</main>
      <footer className="footer">
        <p>
          Bell is a testnet demonstration built for the Base Stocks Maxxing builder quest. Test tokens mirror Coinbase
          tokenized stocks on Base mainnet; they have no value, are not securities and are not issued by Coinbase. Nothing
          here is an offer to lend or borrow, or investment advice. Coinbase tokenized stocks are not available to US
          persons, and neither is Bell.
        </p>
        <p>
          Built by Phant Studio with AI-assisted development tools · <a href={REPO}>source (MIT)</a> · Builder Code{" "}
          <code>{DEP?.builderCode}</code>
        </p>
      </footer>
    </WalletProvider>
  );
}
