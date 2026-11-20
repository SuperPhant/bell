// Copies Bell ABIs (and bytecode for deployable contracts) from the Foundry build into keeper/abi and app/src/abi.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = join(root, "contracts", "out");
const keeperAbi = join(root, "keeper", "abi");
const appAbi = join(root, "app", "src", "abi");
for (const dir of [keeperAbi, appAbi]) mkdirSync(dir, { recursive: true });

function emit(file: string, name: string, withBytecode: boolean) {
  const art = JSON.parse(readFileSync(join(out, file, `${name}.json`), "utf8"));
  writeFileSync(join(keeperAbi, `${name}.json`), JSON.stringify(withBytecode ? { abi: art.abi, bytecode: art.bytecode.object } : { abi: art.abi }));
  writeFileSync(join(appAbi, `${name}.json`), JSON.stringify({ abi: art.abi }));
  console.log(`exported ${name}`);
}

emit("BellMarket.sol", "BellMarket", true);
emit("MirrorOracleRegistry.sol", "MirrorOracleRegistry", true);
emit("MirrorFeedHub.sol", "MirrorFeedHub", false);
emit("IB20.sol", "IB20", false);
emit("AggregatorV3Interface.sol", "AggregatorV3Interface", false);
// The testnet venue and faucet belong to the Leash deployment Bell builds on.
for (const n of ["LeashDesk", "UsdFaucet"]) copyFileSync(join(keeperAbi, `${n}.json`), join(appAbi, `${n}.json`));
