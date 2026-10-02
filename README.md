# WormBrain — a living C. elegans on BNB Chain

A digital organism whose brain is not simulated beside the chain — it is
simulated **by** the chain. All 302 neurons of the *C. elegans* hermaphrodite
connectome (Cook 2019), a 2D body and chemotaxis run as deterministic Q20
fixed-point arithmetic inside a single Solidity contract on BSC mainnet. Every
membrane voltage, every spike, every turn is on-chain state, reproducible
byte-for-byte by anyone who re-runs the spec.

## On-chain (BNB Chain mainnet, chainId 56)

| Contract        | Address                                                              | Role |
| --------------- | -------------------------------------------------------------------- | ---- |
| `WormBrain`     | `0xC33B1a8ad0edC91ac7eC7c09326777CF3Dfaf24B`                          | the living brain (fully on-chain dynamics) |
| `WormGenome`    | `0xb11a96464ea974cb34ddfbec862249d8f8bb007f`                          | quantized connectome commitment (companion layer) |
| `WormHeartbeat` | `0x3dEC2612c7603904f6faf1B4D0937A4668a20eC2`                          | signed off-chain simulation ledger (companion layer) |

**Two-phase genesis.** The canonical connectome blob is ~41 KB, and EIP-3860
caps a deploy payload at 49152 bytes, so the genome cannot be injected through
a constructor on mainnet. Deployment is `deploy()` (empty constructor) followed
by a one-shot `seed()` transaction that loads blob + initial state and proves
`connRoot = keccak256(blob)` on-chain. After seeding, the organism is
permissionless:

- `advance(n, connBlob)` — anyone can feed n brain steps (paying their own
  gas); every call re-verifies the blob against `connRoot`, so the wiring can
  never be altered.
- `stimulate(idx, amp)` — inject current into any neuron; it takes effect on
  the next step and decays beat by beat.
- `stateHash()` — sha256 over 912 32-byte big-endian words (V / gate / stim /
  position / heading / tick), byte-identical to the Python reference.

## Determinism

`worm/brain_spec.py` is the authoritative integer spec (MIT license, Q20 fixed
point, splitmix64 noise, truncating division that matches Solidity `/`).
`contracts/contracts/WormBrain.sol` mirrors it line by line and the Hardhat
suite proves the contract reproduces the golden trajectory exactly:
60 steps -> stimulate AVAR -> 90 steps, final `stateHash()` equals
`588d9e25fd87c58798e100deec9c5e3602dd5e17df48c4ce948459c661c23d05`.

Measured: ~8.7M gas per cold step; with 284/302 neurons active the animal
explores an odor field, speeds up toward the food plume and backs off when
repelled.

## Repository layout

```
contracts/            Hardhat + ethers v6 project (solc 0.8.24, viaIR)
  contracts/          WormBrain.sol, WormGenome.sol, WormHeartbeat.sol
  test/               worm.test.js, wormbrain.test.js (golden trajectory)
  scripts/            deploy / seed / verify / inspection scripts
worm/                 off-chain companion code
  brain_spec.py       authoritative integer spec -> brain_weights.json + brain_golden.json
  lif_worm.py         floating-point LIF prototype (behavioral reference)
  export_connectome.py  Cook 2019 -> 302x302 matrices + edge list (via ConnectomeToolbox)
  data/               connectome npz, edge list, golden trajectory, layout, weights
  node/               resident daemons (advance + heartbeat), zero local state
scripts/              analysis + layout generation helpers
worker/               Cloudflare Worker: chain-read aggregator + stimulation API
```

## Quick start

```powershell
# 1) regenerate the genome + golden trajectory
python worm\brain_spec.py

# 2) prove the contract == the spec (10 tests green)
cd contracts; npx hardhat test

# 3) deploy to mainnet (reads contracts/.env; deploy + seed, then read-back check)
node scripts\deploy_brain.js
npx hardhat run scripts\verify_brain.js --network bscMainnet

# 4) keep the organism alive (spend guardrails built in)
python ..\worm\node\brain_daemon.py --continuous --interval 300 --poke-every 24
```

`cect-src/` (openworm/ConnectomeToolbox v0.3.5) is needed only to re-export the
raw connectome: `pip install -e ./cect-src`.

## Worker API (`worker/`)

A Cloudflare Worker that turns the contract into a real-time data source for
visual frontends (the browser never signs anything; the worker holds no key):

- `GET /api/snapshot` — tick, all 302 V/gate/stim/spikeCount, body pose, stateHash
- `GET /api/events?blocks=N` — recent `Advanced` / `Stimulated` logs
- `POST /api/stimulate {idx, amp}` — queues a stimulation request; a resident
  node drains the queue and pays for the on-chain `stimulate()` tx
- `GET /api/pending`, `POST /api/ack` — daemon endpoints (shared-secret guarded)

Deploy: `cd worker; npx wrangler deploy` (vars: `BRAIN_ADDRESS`, `BSC_RPC`,
`DAEMON_KEY`; optional KV `STIM_QUEUE`).

## Security model

- Private keys live only in `contracts/.env`, which is git-ignored; nothing
  signs in the browser or the worker.
- The connectome is content-addressed (`connRoot`); any viewer can verify the
  blob served to `advance()` against the on-chain anchor.
- The daemon's spend guardrails (`--reserve-bnb`, `--max-spend-bnb`, failure
  backoff) bound the cost of running a resident node.

## License

MIT
