# WormBrain — a C. elegans connectome running as an on-chain dynamical system

An honest one-paragraph framing first, because the slogans oversell the biology:
this is a **spiking (leaky integrate-and-fire) abstraction** of the *C. elegans*
hermaphrodite connectome (Cook 2019) wired to a small **hand-tuned** sensorimotor
controller, executed as deterministic Q20 fixed-point arithmetic inside one
Solidity contract on BSC mainnet. Every membrane voltage, spike and turn is
on-chain state, reproducible byte-for-byte by anyone who re-runs the spec. It is
an *engineering* artifact — a nervous-system-shaped, chain-resident dynamical
system — **not** an electrophysiological reconstruction of the animal, and not a
brain that emerged from the wiring diagram. See "Limitations" below before
repeating any neuroscience claim.

## On-chain (BNB Chain mainnet, chainId 56)

| Contract        | Address                                                              | Role |
| --------------- | -------------------------------------------------------------------- | ---- |
| `WormBrainV2`   | `0x49E89C58bA3b1f4BEe9a9CFdbC00628cB33fC6A3`                          | the live brain, **corrected synapse direction**, seeded from a fresh deterministic genesis (canonical) |
| `WormBrainV2` (reversed)| `0x18174bb0049d43fA75f468a037dfC32899f01dBB`              | **legacy / superseded**: seeded from the pre-fix direction-reversed genome (`connRoot 0xf12410…`); immutable, left untouched |
| `WormBrain` (v1)| `0xC33B1a8ad0edC91ac7eC7c09326777CF3Dfaf24B`                          | **legacy / retired** at tick 49; its live state was migrated into the (reversed) V2 genesis |
| `WormGenome`    | `0xb11a96464ea974cb34ddfbec862249d8f8bb007f`                          | quantized connectome commitment (companion layer) |
| `WormHeartbeat` | `0x3dEC2612c7603904f6faf1B4D0937A4668a20eC2`                          | a **signed off-chain simulation ledger** (companion layer) — this design posts a stateRoot commitment, it does not run the dynamics on-chain |

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
- `stateHash()` — sha256 over `1 + 4*302 + 5 = 1214` 32-byte big-endian words
  (V / gate / stim / the v2 memory trace M / position / heading / tick),
  byte-identical to the Python reference.

## Limitations, provenance and how to verify

Written to be quoted accurately. What the project does **not** claim matters as
much as what it does.

**It is a model abstraction, not electrophysiology.** Real *C. elegans* chemical
synapses are largely **graded** (continuous, sub-threshold), not all-or-nothing
spikes. This contract uses threshold firing plus post-spike suppression because
that is what runs deterministically in Q20 fixed-point on the EVM — it is a
computational convenience, not a measurement of the animal. It has no
dendritic compartments, no explicit gap-junction conductances, no ion-channel
kinetics, no neuromodulatory diffusion. OpenWorm / c302-class models add exactly
those; this repo does not aim to, and even the off-chain `worm/lif_worm.py` is
kept only as a behavioural reference, not a validated simulation.

**The behaviour is designed, not emergent.** The chemotaxis gains, the food
coordinates and the turning coefficients are **hand-tuned constants** wired onto
classic motor/inter-neuron groups (ASEL/R, AWAL/R, AWCL/R, AVAL/R, AVBL/R). The
Cook connectome supplies only the *sparse wiring topology*; the steering toward
food is a controller a person wrote, not a property that self-organised out of
the connectome. Treat "it does chemotaxis" as "a designed controller runs on a
connectome-shaped substrate" — reproducible, but not a scientific prediction.

**"Fully on-chain" needs one discount.** State, dynamics and *integrity* are
on-chain: every `advance` re-checks `keccak256(connBlob) == connRoot`, and
`stateHash()` commits the whole live state, so the wiring and the trajectory
cannot be silently altered. But *availability and liveness* are off-chain: the
~41 KB blob must be re-supplied by whoever calls `advance`, and continuous
"life" only exists for as long as someone keeps paying gas (~9.4M gas per step,
measured on the corrected deployment). `WormHeartbeat` is by design an off-chain simulation ledger, not a
running brain. Permissionless is not the same as economically autonomous — a
paused keeper means a paused worm (the read-only page then reports HALTED).

**Provenance of the connectome.** The edge table is generated by
`worm/export_connectome.py` from the Cook 2019 hermaphrodite dataset (via the
`cect` library), quantised to the on-chain fixed-point genome. The **canonical
live brain** (`0x49E89C58…`) is seeded from the corrected genome and anchored to
`connRoot = 0x38dc5c120b55d24182cb3f81738c271c7255de5ffa1507f8aa4cb950494d8cac`.
An earlier, now-superseded deployment (`0x1817…`) was seeded from the pre-fix
packer and holds the reversed root `0xf12410a5…b4a177` (see the direction note
below).
Because `advance` hashes the blob it is given against this on-chain constant, a
cropped or re-scaled table produces a different hash and **reverts** — the table
used at runtime is provably the one that was seeded. The initial seed itself is
one deployer transaction, so its integrity reduces to that single event plus the
reproducible `connRoot`.

**Synapse direction (a real bug, found in review, fixed on-chain).** The first
V2 deployment was seeded from a genome whose **chemical-synapse direction was
transposed**: the exporter stores `W[pre, post]` but the packer read it as
`W[post, pre]`, so about 2,332 of the unidirectional chemical edges pointed the
opposite way from Cook 2019 (it ran `RIH -> ADEL` where the table says
`ADEL -> RIH`). Python and Solidity agreed because they shared the same reversal —
which is exactly why the golden test could not catch it. The spec is corrected
(transpose, and apply the GABAergic sign to the presynaptic column) and guarded by
`check_direction()` in `brain_spec.py` plus a reproducibility step in CI; the
corrected build hashes to
`connRoot = 0x38dc5c120b55d24182cb3f81738c271c7255de5ffa1507f8aa4cb950494d8cac`.
Because `WormBrainV2` is immutable, the reversed animal could not be fixed in
place, so the corrected genome was **seeded into a new deployment**
(`0x49E89C58…`, block 125312465, 2026-10-02) from a fresh deterministic genesis
(`brain_spec.py` `init.V`, not migrated from live state). The reversed deployment
(`0x1817…`, `connRoot 0xf12410…`) is left untouched as immutable legacy; the
canonical live worm now runs the correct `pre -> post` connectome.

**Bytecode ↔ source, and the honest gap.** The bundled Hardhat golden test proves
*"this Solidity matches this Python spec"* — it does **not** prove the on-chain
bytes came from this Solidity. Two things close that:

- A gas-free, key-free local check ships with this repo: after
  `npx hardhat compile`, `node contracts/scripts/verify_bytecode.cjs` recompiles
  `WormBrainV2.sol` with the pinned settings (solc 0.8.24, viaIR, runs=200),
  fetches `eth_getCode` at the live address, and compares. The durable claim is
  **0 real differences in the runtime executable code** (the only deltas are the
  two inlined `deployer` immutable slots, the constructor's `msg.sender`). It
  also reports a byte-identical solc **metadata** fingerprint, but that is the
  weaker of the two: metadata embeds the exact compiler build, so recompiling
  with a different toolchain can make metadata differ while the executable code
  is still identical — a reviewer hit precisely this. Trust the runtime-code
  equality; treat metadata equality as corroboration only under the pinned
  settings.
- That check is self-attesting. The third-party-visible step — **publishing the
  source on BscScan** — is now **done**: the canonical `WormBrainV2`
  (`0x49E89C58…`) is verified on BscScan (`npx hardhat verify --network bscMainnet
  0x49E89C58bA3b1f4BEe9a9CFdbC00628cB33fC6A3`; identical bytecode to the earlier
  `0x1817…`, so the explorer reports it verified), so anyone can compare the
  published source against the deployed bytecode without compiling anything:
  https://bscscan.com/address/0x49E89C58bA3b1f4BEe9a9CFdbC00628cB33fC6A3#code

**How to reproduce, and what is still not covered.** Anyone can rerun
`python worm/brain_spec.py` (golden integer trajectory + the `check_direction()`
synapse-direction guard), `node contracts/scripts/verify_neurons_review.cjs`
(genome well-formed, frozen neuron index table, direction),
`node contracts/scripts/verify_bytecode.cjs` (deployed runtime code == this
source) and `npx hardhat test` (36 passing). A CI workflow
(`.github/workflows/ci.yml`) now runs all of it on every push, including a
byte-for-byte "regenerate then `git diff --exit-code`" step proving the committed
`worm/data` is reproducible from the spec, plus an offline worker event-decode
test and a frontend read-only smoke test; `requirements.txt` pins the Python
deps. The main brain is now **verified on BscScan**, so its source is externally
checkable. Still absent: an independent third-party reproduction report and a
long public commit history — the in-repo evidence is strong, but not yet audited
by someone else.

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

## Mainnet integration record (original reversed binding — historical)

The record below captures the **first** integration, bound to the now-superseded
direction-reversed brain `0x1817…` (`connRoot 0xf12410…`); its on-chain
transactions and proofs are retained as history and are unchanged. The
corrected-direction redeployment that follows lists the canonical live addresses.

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

### Corrected-direction redeployment (2026-10-02)

The `check_direction()` fix was carried **on-chain** by seeding a fresh,
deterministic genesis (option A — initial `V` and body pose taken straight from
`worm/data/brain_weights.json` `init`, **not** migrated from live state; the
reversed worm's accumulated tick was intentionally abandoned). Built with the same
pinned compiler settings, so its bytecode is identical to the already-verified
`0x1817…`.

| Item | Value |
| ---- | ----- |
| Brain (canonical, corrected) | `0x49E89C58bA3b1f4BEe9a9CFdbC00628cB33fC6A3` |
| connRoot (corrected) | `0x38dc5c120b55d24182cb3f81738c271c7255de5ffa1507f8aa4cb950494d8cac` |
| deploy tx | `0xc4f9b07efcc31b51c509e4dd01fecb984e29937b02f4ede5eced8dbbd0d14774` |
| seed tx | `0xfdbc8560346d59a8f063214287fa2791bf869c22d167b2de5c1d43b2a8be1db5` (block 125312465) |
| probe advance(1) tx | `0x341702b01d6e2c5ac326333c830ed831f9bf0940efa0791d689bf2e20230c7af` (9,457,390 gas) |
| WormReadout (rebound) | `0x192004dAe2A55E20CE21A7d05E722B32c9A9b61E` |
| SenseAdapter (rebound) | `0xbe0C5117f740a9333614D806Bd50C3907186C6fD` (pair `0x16b9…0daE` frozen) |

Seed read-back proved `connRoot == keccak256(blob)` and spot `V`/pose equal to the
spec; the `advance(1)` probe succeeded on mainnet, then the resident
`brain_daemon.py` was restarted against the new brain (continuous, ~9.4M gas per
beat). The frontend was rebuilt to the new readout/adapter and redeployed
(`bscworm.com`), and the worker's `BRAIN_ADDRESS` was updated and redeployed
(`api.bscworm.com`). The reversed `0x1817…` and its original readout/adapter
(`0xe47…` / `0xb7b4…`) are left immutable and untouched.

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

- WormBrain (the animal, bound at construction): `0x49E89C58bA3b1f4BEe9a9CFdbC00628cB33fC6A3`
- WormReadout (the `read()` lens): `0x192004dAe2A55E20CE21A7d05E722B32c9A9b61E`
- SenseAdapter (the stimulation entry): `0xbe0C5117f740a9333614D806Bd50C3907186C6fD`

The brain address is taken from `readout.brain()` on-chain, not hardcoded. Liveness
is judged on **elapsed time, not block count**: the seconds since the last real
advance are compared against a window of three heartbeat periods, where the period
is learned from tick changes this page observed itself (floored at 90 s so a fast
keeper never makes the verdict twitchy). Two independent witnesses feed the age — the
block timestamp of the newest `Advanced` event, and the last observed tick change —
and either one proving life is enough to say **LIVE**.

A `getLogs` range an endpoint refuses is reported as *not readable here*, never
read as absence of a beat: on a missing reading the badge says CHECKING instead of
pronouncing the animal dead. Only a genuinely elapsed window shows **HALTED**, and
then the panel stops plotting — the page never fakes motion or fabricates a
trajectory between beats.

The on-chain `STALE_WINDOW` (20 blocks) is still displayed, next to what it is worth
in seconds at the block time measured on the fly. BSC currently seals in well under a
second, which makes that constant worth roughly ten seconds while this keeper beats
about every 45 — which is exactly why the verdict is time-based and the block count
is reference only.

### 3D viewer

The dashboard also offers an opt-in **3D connectome viewer** (`src/worm3d.js`,
Three.js, lazily imported so the base page carries no 3D dependency). Pressing
START renders the whole animal from the corrected connectome — 302 neurons and
5144 directed synapses from `public/data/graph.json`, regenerated from the
authoritative `worm/data/brain_weights.json` by `scripts/gen_frontend_data.py`
so the picture cannot drift from the deployed `connRoot`.

It is read-only in the strictest sense: every frame is driven by batched
`eth_call` reads of the live brain's public view getters — per-neuron membrane
voltage `V(i)`, `spikeCount(i)`, motor `gate(i)`, `tick`, `connRoot` — and the
module encodes no state-changing call at all (the smoke test asserts this).
Node brightness maps `V` through a ±`V_THRESH` display band with gamma 2, a
white flash marks a spike-count increment, and the body's peristaltic wave
amplitude comes from the motor-neuron gates. Any display gains applied to make
small signals visible are stated in the HUD rather than silently inflated. When
`tick` stops changing (nobody paid for an `advance`), the wave freezes and the
HUD shows **HALTED** — the viewer never animates a frozen animal. Liveness is
judged against the node's *learned* heartbeat cadence (an EMA of observed tick
intervals, floored at 90 s): a deliberately slow keeper is not misreported as
dead, while a real stall still freezes within three learned beats. The HUD also
prints the age of the last advance, so the pace is never hidden.

### Keep-alive nodes (anyone can run one)

`advance(n, connBlob)` is permissionless and deterministic: any wallet can pay
for any step, and every honest node computes exactly the same next state. The
resident keeper (`worm/node/brain_daemon.py`) ships with `--adaptive`: as the
funding wallet drains, the beat interval stretches toward spreading the
remaining steps over `--survive-hours` (capped by `--max-interval`) — the heart
slows down instead of stopping dead at the reserve floor.

A community node needs no build toolchain:

```powershell
# bare python (web3 + python-dotenv; the ABI falls back to worm/node/brain_abi.json)
pip install -r worm/node/requirements.txt
set DEPLOYER_PRIVATE_KEY=<your own wallet key>
python worm/node/brain_daemon.py --continuous --interval 300 --adaptive
```

```bash
# or containerised (context = repository root)
docker build -t worm-node -f worm/node/Dockerfile .
docker run -d --name worm-node -e DEPLOYER_PRIVATE_KEY=<your-key> worm-node
```

Multiple nodes are safe: `advance` reverts nothing that belongs to anyone else,
concurrent keepers at worst waste each other's gas on identical steps. The node
only advances — it never stimulates.

`worm/node/archive_life.py` (read-only) exports the animal's whole biography:
it scans every `Advanced` event from the deployment block and writes a
per-heartbeat CSV (tick, block, UTC time, tx hash, fired, cumulative spikes).
Anyone can re-run it and diff the result against the chain.

### Embeddable life badge

`frontend/public/badge.html` is a dependency-free, read-only widget (one
`eth_call` per minute against a public RPC, pinned `tick()` selector) that
shows the live tick and an honest LIVE/HALTED dot sized to three stretched
beats. Other sites embed it with:

```html
<iframe src="https://bscworm.com/badge.html" width="260" height="72"
        style="border:0;border-radius:10px" title="on-chain worm"></iframe>
```

### Poke the worm (opt-in write path)

`inject(int256)` on the deployed `SenseAdapter` was always permissionless —
anyone could write to it from BscScan or a script. The dashboard now exposes
that door honestly, as the site's single sanctioned write path
(`src/poke.js`, dynamically imported only after an explicit opt-in click):
the visitor connects their own wallet, pays their own gas (~0.0000x BNB), and
the module can encode exactly one call against one pinned address. Positive
intensity routes to ASEL, negative to ASER, clamped at the adapter's
`ampCap` (2.0 in Q20). A below-the-fold feed renders recent `Injected` events
straight from chain logs — public facts, including who poked and how hard.
The smoke test fences this module: no `advance`/`stimulate` encodings, the
adapter as the only address in the file, no key material, lazy import only.
Since the brain is passive, a poke queues current and takes effect on the next
`advance` — the UI states this instead of pretending instant motion.

### Time-lapse (recorded on-chain past)

`scripts/gen_replay_data.mjs` rebuilds the worm's entire history as video
material: for every `Advanced` heartbeat in `life_log.csv` it reads the brain's
state **at that event block** (302 membrane voltages + body pose, 306 batched
reads per frame, quantized int8/int16) into `frontend/public/data/replay.json`.
The dashboard's time-lapse card plays that recording through a canvas
(`src/replay.js`, lazily imported on click, zero RPC — it is a static asset,
not a live view). Nothing is simulated or interpolated; the silhouette is a
schematic of the four recorded pose scalars and the HUD names the exact tick,
block and timestamp of every frame. Cost guards are built in: runs are
incremental (existing frames are never refetched) and the metered archive
endpoint requires an explicit `--allow-metered` opt-in that prints the
estimated compute-unit cost up front. The smoke test asserts the recording is
contiguous from tick 1, correctly sized per frame, and that the player never
touches the network beyond its own JSON asset.

## Determinism

`worm/brain_spec.py` is the authoritative integer spec (MIT license, Q20 fixed
point, splitmix64 noise, truncating division that matches Solidity `/`).
`contracts/contracts/WormBrainV2.sol` mirrors it line by line and the Hardhat
suite proves the contract reproduces the golden trajectory exactly:
60 steps -> stimulate AVAR -> 90 steps, final `stateHash()` equals
`3424289a9eb94618edecc580ad45fbc61b01dcc44d660572084ed67c4e59464b`. The canonical
live brain (`0x49E89C58…`) is seeded from this corrected-direction build, so it
starts on the same genome the golden test proves; the live daemon only advances
(no step-60 stimulate), so its running stateHash is not expected to equal the
golden one.

Measured: ~9.4M gas per cold step on V2 (the `advance(1)` probe used 9,457,390).
Over the 90-step golden run 264/302
neurons spike at least once; in this corrected-direction build the animal does
**not** show net approach to the food within the window (mean distance is flat),
which is a further reminder that the steering is a hand-tuned controller, not an
emergent property — the trajectory depends on the tuning and on getting the
synapse direction right.

## Frontend (`frontend/`)

The live page is the **read-only dashboard** described above
(`### Read-only dashboard` and `### 3D viewer`): a Vite + ethers app that reads
the deployed `WormReadout` / `SenseAdapter` / brain directly from a public BSC
RPC — no worker in the data path, no second brain in the browser. By default
nothing is signed or sent; the only exception is the explicitly opt-in poke
module (`### Poke the worm`), which relays a single pinned call to the
visitor's own wallet. The optional Three.js 3D viewer only reads view getters,
and the time-lapse card (`### Time-lapse`) plays a static recording of
replayed on-chain state. `npm test` runs a static read-only guardrail covering
every module plus a dedicated fence around the poke path and an integrity
check on the replay recording; `npm run build` emits `dist/` including the
embeddable badge and `data/replay.json`.

```powershell
cd frontend; npm install; npm run dev; npm test
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
frontend/             Vite + ethers read-only dashboard (direct BSC RPC) +
                      opt-in Three.js 3D connectome viewer (view getters only)
worker/               Cloudflare Worker: read-only chain aggregation API
```

## Quick start

```powershell
# 1) regenerate the genome + golden trajectory
python worm\brain_spec.py

# 2) prove the contract == the spec (36 tests green)
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

A read-only Cloudflare Worker that aggregates chain state into a JSON API. The
read-only dashboard no longer consumes it (it talks to a public RPC directly);
this API is a separate optional surface fed by the daemon (the worker never
signs or sends anything and holds no private key):

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
