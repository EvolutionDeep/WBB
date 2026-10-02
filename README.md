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

## Calling the organism (integration layers)

The brain is raw, on-chain life that other contracts can use — not a token, an
NFT, a chatbot, or an off-chain "it decided to buy". The organism itself is
already deployed and is **not** redeployed, upgraded, paused or owned by these
layers; they only bind to it. There are exactly **two** sanctioned external
actions: queue current into a sensory neuron, and read three fresh movement
quantities. No external contract may run a full brain step inside its own
swap/mint transaction (a cold step is ~8.7M gas), so `advance()` is for the
resident keepalive node only.

| Layer | File | Role |
| ----- | ---- | ---- |
| Interface | `contracts/contracts/IWormBrain.sol` | mirrors the deployed selectors (uint256 index, since the live getters are `uint256`); freezing the interface means matching the deployment, not renaming it |
| Index table | `contracts/contracts/WormNeurons.sol` | FROZEN named indices (Cook 2019 hermaphrodite, sorted order): `ASEL=39 ASER=40 AVAL=53 AVAR=54 AVBL=55 AVBR=56 AWAL=72 AWAR=73 AWCL=76 AWCR=77 PVCL=172 PVCR=173` |
| Readout | `contracts/contracts/WormReadout.sol` | `read()` returns `{approach,turn,speed,tick,blockNumber,stateHash}`; each is a pure on-chain function of named-neuron gates, clamped to ±10000 |
| Sense adapter | `contracts/contracts/SenseAdapter.sol` | the single stimulation entry: `inject(int256)` and permissionless `sample()` (frozen PancakeV2 WBNB/USDT pool) |
| Effector demo | `contracts/contracts/WormEffectorDemo.sol` | a separate consumer that reads `WormReadout` from its own address and records an action — brain and business are different contracts |

Readout is a small agreed interface, not the worm's full motor circuit:

- `approach = gate(ASEL) - gate(ASER)`
- `turn     = gate(AWCL) + gate(AWCR) - gate(AWAL) - gate(AWAR)`
- `speed    = gate(AVBL) + gate(AVBR) - gate(AVAL) - gate(AVAR)`

Freshness is part of the contract: a consumer must discard a `Readout` when
`block.number - blockNumber > 20` (the `stateHash` ties the reading to the exact
on-chain state it came from).

Stimulation is limited to three sources, and only the first two are live: (1)
`inject(signedIntensity)` — clamp, then positive → ASEL, negative → ASER; (2)
`sample()` — read the frozen pool's reserve ratio, difference it against the
previous sample, charge the signed change into ASEL/ASER and its absolute
magnitude into AWCL/AWCR; it interprets nothing. (3) body feedback is deferred
until an effector exists. Forbidden as stimuli: transaction hashes, randomness,
owner signatures, off-chain opinions. `stimulate` is permissionless but
amplitude-capped and decays every `advance`; two opposite stimuli in one block
**accumulate**, they never overwrite.

Deploy the layers on top of the live brain (never touches it):

```powershell
cd contracts; node scripts\deploy_readout_adapter.js
```

## Mainnet integration record

Only `WormReadout` and `SenseAdapter` were deployed and bound to the existing
brain; the constructor transactions seeded, advanced and stimulated nothing, and
the pair was taken from the factory exactly once and frozen as immutable.

| Item | Value |
| ---- | ----- |
| Brain (untouched) | `0x18174bb0049d43fA75f468a037dfC32899f01dBB` |
| connRoot | `0xf12410a5de0073148d04c237c2da534d96d997f6812a3d896a6e4cbed9b4a177` |
| WormReadout | `0xe47f67b2e38AFA8a02e27A1D6F3694f33034aB18` |
| SenseAdapter | `0xb7b4C58E58f8496EA7f861c977c4c19698317b87` |
| pair (WBNB/USDT, one-shot) | `0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE` |

Three on-chain verifications (BscScan, chainId 56):

1. **A non-deployer injects, no brain step happens in that tx.** A funded
   throwaway address (not the deployer) called `SenseAdapter.inject(200000)`.
   `tick` before/after the transaction: **6 → 6** — an external caller can only
   queue current; it never advances the worm inside its own transaction.
   tx `0xe41ea3b5af30f816e7221c3301c4b5e046bbfbf4298f938db0d7492a975ebb8c`
   (funding tx `0x0f8b1da2a47ea8cb2910a1b34accd6f7348b2602f3f4affd5d8f939bea1c5aa1`).

2. **Two stimulations in one block accumulate; the later one does not overwrite.**
   (a) permissionless primitive — same block, `stimulate(ASEL, +300000)` then
   `stimulate(ASEL, -120000)`; `stim(ASEL)` **200000 → 380000** (a sum of both,
   not the trailing `-120000`). block `125298241`, txs
   `0x351c1dfab71eca9ca8561674e79bd3e2e177bc4d45b9fabcf4da61e850b39e19` /
   `0xfe601929a04a8269502034a0fab86870947914dfe1558c48c4caf35c13f1ad1f`.
   (b) through the single entry — same block, `inject(250000)` then
   `inject(150000)` (both positive, both route to ASEL); `stim(ASEL)`
   **380000 → 780000** (a sum, not the trailing `150000`). block `125298253`,
   txs `0x341adf0fa71b5aaffe2bdcc9f9dc82b20f37f25e15368ed5933c569c9e1a7795` /
   `0xe444dbb48acf5edd955203a65e36c09a81cdeab4c6da05bdc3d69177885c7216`.

3. **`Readout.read().stateHash` equals the brain's own `stateHash()`.** At block
   `125298262` both read `0x5b6ba3ae94422f570f7e28f5296eabb9f9ace2e96e8789ecef739b341fe7d5e6`
   (equal). This is a **read-only, current-state check only**: during the wait
   window the existing heartbeat node did **not** fire, so `tick` stayed at `6`
   and no `advance` was performed (none was forced). The equality is therefore a
   structural property — `WormReadout` forwards `brain.stateHash()` directly —
   and is **not** a demonstration that a live beat was observed advancing; the
   post-advance behaviour is covered deterministically by the local test suite,
   not by this on-chain reading.

The repo was not pushed and the brain was not modified.

### Read-only dashboard

`frontend/` is a **read-only** page: it only issues `eth_call` / `eth_getLogs`
against a public BSC RPC. It never signs, never connects a wallet, never sends a
transaction, and never calls `advance` / `stimulate` / `seed`; no second copy of
the brain runs in the browser.

Local preview:

```powershell
cd frontend; npm install; npm run dev   # serves http://127.0.0.1:5173/
```

The page reads these three full addresses (all live on BscScan, chainId 56):

- WormBrain (the animal, bound at construction): `0x18174bb0049d43fA75f468a037dfC32899f01dBB`
- WormReadout (the `read()` lens): `0xe47f67b2e38AFA8a02e27A1D6F3694f33034aB18`
- SenseAdapter (the stimulation entry): `0xb7b4C58E58f8496EA7f861c977c4c19698317b87`

The brain address is taken from `readout.brain()` on-chain, not hardcoded. When
`current block − last advance block > 20` (the on-chain `STALE_WINDOW`), the
Identity panel shows **HALTED** and stops plotting — the page never fakes motion
or fabricates a trajectory between beats.

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

## Frontend (`frontend/`)

A Vite + three.js viewer: 302 instanced neuron points riding a shader-driven
body, wired to the chain through the worker. It is a pure read-only
observation surface — every number and every reaction comes from on-chain
state (`/api/snapshot`) and on-chain logs (`/api/events`); nothing in the
browser signs or sends a transaction.

```powershell
cd frontend; npm install; npm run dev   # needs the worker (or its local dev server) up
```

## Repository layout

```
contracts/            Hardhat + ethers v6 project (solc 0.8.24, viaIR)
  contracts/          WormBrain.sol + companions (WormGenome, WormHeartbeat);
                      integration layers: IWormBrain / WormNeurons / WormReadout /
                      SenseAdapter / WormEffectorDemo (+ mocks/PancakeMocks.sol)
  test/               worm.test.js, wormbrain.test.js (golden trajectory),
                      wormreadout.test.js, senseadapter.test.js, wormeffector.test.js
  scripts/            deploy / seed / verify / readout+adapter deployment / inspection
worm/                 off-chain companion code
  brain_spec.py       authoritative integer spec -> brain_weights.json + brain_golden.json
  lif_worm.py         floating-point LIF prototype (behavioral reference)
  export_connectome.py  Cook 2019 -> 302x302 matrices + edge list (via ConnectomeToolbox)
  data/               connectome npz, edge list, golden trajectory, layout, weights
  node/               resident daemon (advance only, keeps the animal alive)
scripts/              analysis + layout generation helpers
frontend/             Vite + three.js 3D viewer (read-only chain observation)
worker/               Cloudflare Worker: read-only chain aggregation API
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

# 4) keep the organism alive (spend guardrails built in; advance only)
python ..\worm\node\brain_daemon.py --continuous --interval 300
```

`cect-src/` (openworm/ConnectomeToolbox v0.3.5) is needed only to re-export the
raw connectome: `pip install -e ./cect-src`.

## Worker API (`worker/`)

A read-only Cloudflare Worker that turns the contract into a real-time data
source for the frontend (the browser never signs anything; the worker sends no
transaction and holds no private key):

- `GET /api/snapshot` — tick, all 302 V/gate/stim/spikeCount, body pose, stateHash
- `GET /api/events?blocks=N` — recent `Advanced` / `Stimulated` logs (on-chain history)
- `POST /api/push-snapshot`, `POST /api/push-events` — daemon feeds (shared-secret guarded)

Deploy: `cd worker; npx wrangler deploy` (vars: `BRAIN_ADDRESS`, `BSC_RPC`,
`DAEMON_KEY`; KV `WBB_STORE` for the shared snapshot/event cache).

## Security model

- Private keys live only in `contracts/.env`, which is git-ignored; nothing
  signs in the browser or the worker.
- The connectome is content-addressed (`connRoot`); any viewer can verify the
  blob served to `advance()` against the on-chain anchor.
- The daemon's spend guardrails (`--reserve-bnb`, `--max-spend-bnb`, failure
  backoff) bound the cost of running a resident node.

## License

MIT
