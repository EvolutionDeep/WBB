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
`worm/data` is reproducible from the spec, plus two offline worker tests (the event
decoder's hex words, and the browser read proxy's refuse-every-write policy, with fetch
stubbed out so nothing is billed) and a frontend read-only smoke test; `requirements.txt`
pins the Python
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

`frontend/` is a **read-only** page by default: it only issues `eth_call` /
`eth_getLogs`, leading with the project's own read-only worker proxy (`POST /api/rpc`,
which prefers the metered gateway and fails over to the free BSC nodes) and falling back
to the free nodes directly if that proxy is unreachable. Every number on screen still
comes from the chain; the proxy only carries the read, and no gateway key ever ships in
the bundle. Nothing it loads on its own ever signs,
connects a wallet, sends a transaction or calls `advance` / `stimulate` / `seed`, and
no second copy of the brain runs in the browser. Two modules are the documented
exception, and both sit behind an explicit click of their own: `src/poke.js` (see
*Poke the worm*) and `src/engrave.js` (see *The inscription wall on the dashboard*).
Every other file in `src/` — including the wall's read side `src/wall.js` — is held to
the absolute ban by the smoke test.

The read runs on **two cadences**, because only three reads can change inside ten seconds:
the fast beat takes the head, the tick and the three body quantities, and the slow beat
(60 s) takes everything that cannot go wrong answered once a minute - the pairing and
`connRoot` (both fixed at deploy), the `Advanced` log scan, the stimulus accumulations,
the sampled reserve ratio and the two event feeds. The justification is measured, not
assumed: the heartbeat this page learns from real tick changes was about **73 s** on the
live chain, and a measured run of the deployed page after the split issued about **37 proxy
reads per 100 s** from one open tab (~32,000 a day, all of them answered by the metered
gateway through the proxy - zero reads fell to another host). Before the split the same tab
walked its twenty-odd reads every ten seconds, on the order of 180,000 reads a day against a
free Workers allowance of 100,000 that the site's own asset requests also draw on. The page
prints both intervals inside its own liveness note and says how long ago the advance log was
scanned, and the tick witness never waits for the log witness: whichever is fresher decides
LIVE.

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

The dashboard also carries an **autoplaying 3D connectome viewer** (`src/worm3d.js`,
Three.js, still its own chunk but imported by the page itself, so the canvas fills in
without anyone having to press anything). It renders the whole animal from the
corrected connectome — 302 neurons and 5144 directed synapses from
`public/data/graph.json`, regenerated from the authoritative
`worm/data/brain_weights.json` by `scripts/gen_frontend_data.py` so the picture
cannot drift from the deployed `connRoot` — each cell placed by
`public/data/layout.json` and coloured by its anatomical group (nerve ring, head
sensory, motor, cord interneuron, postdeirid, tail).

Nothing gates it and nothing has to be gated: there is no START control and no STOP
control. The only pause left is the one that spares the visitor's battery — drawing
stops while the tab is in the background and resumes by itself, which is a cost guard,
not a control anyone operates.

It is a **demo, and it says so**: the module holds no chain access at all. It
opens no provider and names no endpoint, requesting nothing beyond those two
local anatomy files, so it cannot stall on a rate limit, be fooled by a bad
endpoint, or go blank when an RPC misbehaves. What is real is the anatomy — the
identity of every cell, its position along the body, and the direction of every
synapse it lights up: the signal pulses travel strictly pre → post along
`graph.json`'s own edges, so a pulse that reaches a cell continues down that
cell's axon. What is invented is everything moving: the peristaltic wave, a
seeded schedule of crawl / pause / reversal / turn episodes, each cell's
brightness, the pulse traffic. The HUD prints `DEMO — nothing here is read from
the chain` on every frame and ends with the animal's live state being on card 01,
and the hover readout calls the number `demo drive` rather than a voltage.
The smoke test now fences the weaker half of that promise mechanically: it fails
if `worm3d.js` gains an ethereum client, a provider, an `eth_call`, a hard-coded
endpoint, or a state-changing encoding.

This replaced an earlier viewer that drove each frame from batched `eth_call`
reads of `V(i)`, `spikeCount(i)`, the motor gates, `tick` and `connRoot`, freezing
the body and printing **HALTED** whenever `tick` stopped moving. That is no longer
this card's job; the honest liveness readouts are the identity card (verdict,
last-advance age and observed heartbeat on one screen), the life badge and the
recording.

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

`https://bscworm.com/badge.html?lang=zh` renders the same widget in Chinese. The badge
imports nothing at all -- not even the dashboard's language catalogue -- so it carries
its own two languages inline and stays English unless the URL or the visitor's stored
choice asks for Chinese.

### Two languages, English by default

Every user-visible string on the page lives in `frontend/src/i18n.js` as one key with two
values, `{ en, zh }`, side by side so the two cannot drift apart. The dashboard boots in
English and switches to Chinese from the button in the header; the choice is stored in
`localStorage.wbb_lang`, and `?lang=zh` / `?lang=en` pins one link without overwriting
what the visitor chose for the rest of the site.

Switching language costs no network read. Each card keeps the numbers it already read and
re-words them in place, so a live reading -- a head block, a stimulus feed, a wall
progress line, a wallet's own refusal -- never falls back to a placeholder, and numbers
and clock times are formatted for the active locale rather than inherited from the
machine. Contract names, addresses, transaction hashes, on-chain event names and neuron
names are identifiers and are never translated. The Chinese exists only inside the two
dictionaries; every comment, every document, every commit message in this repository
stays English.

`npm test` asserts all of that, and it asserts the two halves that a translation project
usually forgets: no key may be missing a language, no Chinese entry may be an English
string copied twice, both languages must accept the same `{parameters}`, every key named
by a module or by a `data-i18n` attribute must resolve in the catalogue (an unresolved
key would print its own name on the page), and no shipped module may contain a Han
character at all.

### Poke the worm (opt-in write path)

`inject(int256)` on the deployed `SenseAdapter` was always permissionless —
anyone could write to it from BscScan or a script. The dashboard now exposes
that door honestly, as one of the site's two sanctioned write paths
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

## Token endowments

The token has no claim on the project and the tax vault is not project income, so
neither can a holder be paid from cash flow. What is real and sellable is therefore
scarcity of two specific things: a permanent place in the animal's record, and
information about its next beat that nobody can buy before it happens.

**`WormLedger.sol` — the inscription wall.** Life is chopped into slots of
`TICKS_PER_SLOT` ticks and a slot can be engraved exactly once, forever, only after
the ticks inside it have actually occurred. The text is 1–64 printable ASCII bytes
(so a browser can render it without an XSS question), the slot can never be edited,
removed, paused or upgraded — there is no owner, no setter, no withdrawal — and what
you pay is burnt to the zero address in the same transaction that takes it.

**`WormGuess.sol` — the per-beat wager.** A round asks one factual question about one
specific upcoming tick: will more than N of the 302 neurons fire in that single step?
Staking is refused as soon as `brain.tick()` has reached the target, so nobody can bet
on a beat they have already watched, and settling is only legal exactly on that tick,
so the answer comes from `totalSpikes` differences and nothing else. If the beat passes
unsettled the round refunds — the stake is never re-dealt to whichever side calls first.
Winners claim from the contract; it never holds a balance it can be run off.

Both are read-only with respect to the organism: neither can `advance` or `stimulate`,
and the test suite asserts that from the ABI rather than from my word for it.
Prices are defined as what **arrives**, measured as a `balanceOf` difference, because
the token charges 3% on transfer: asking for 1.0 is not the same as receiving 1.0, and
a contract that pretended otherwise would be short-changing itself.

Why there is no paid influence over the worm. An earlier design sold a quota on
`stimulate`, on the assumption that stimulus capacity is a contested resource. It is
not: `stimulate(index, amp)` is permissionless and one transaction at the cap drives
that neuron's stimulus to its ceiling (+/-8.0) *and* its memory to +/-2.0 at the same
time (`K_MEM` writes memory inline, and only the neuron's own spikes erode it, ~0.5%
each). Anyone — paying or not — can saturate the memory of any of the 302 neurons in
one gas-fee transaction, permanently shaping this animal. That is a property of an
unpermissioned on-chain life form, not a flaw in a payment scheme, so no paid tier could
have made it exclusive and I withdrew the idea rather than sell something counterfeit.
The 302 memory slots currently read 0.000: the first person to write one is not buying
a privilege, they are writing on the animal, and that is now documented here.

```bash
cd contracts
node scripts/deploy_endowments.js                       # plan only, sends nothing
node scripts/deploy_endowments.js --on testnet          # 97 rehearsal, mock 3% token
node scripts/deploy_endowments.js --on mainnet --i-authorize-mainnet
```

Mainnet deployment is a separate deliberate act behind an explicit flag; the script
reads `tick()`/`stateHash()` before and after and aborts if its own deployment moved
the animal.

**Both are live on BSC mainnet**, wired to the running worm and to the `0xa18f…`
token, with the parameters frozen as deployed — one inscription per 100 ticks at 10,000
token arriving net of tax, and a 1.0 token minimum stake:

| contract | address | deployed block |
| --- | --- | --- |
| `WormLedger` | `0x16a4d26C90fE7613f22Da41150E4847e1fE47495` | 125412554 |
| `WormGuess` | `0x8d3c1e2fED66aAB5293d0FC8983988Df15e6353b` | 125402137 |

`ticksPerSlot` and `price` are `immutable`, so repricing the wall meant a second
deployment rather than a setting. The first wall,
`0xb305bDcf97C26B1312E3C3b3158BAAc7cD5f6966` (10 ticks per slot, 1.0 token per
inscription), is **superseded, not retired**: it carries zero inscriptions and nothing
in this repo points at it any more, but it is unowned and immutable, so it stays
buyable at one token per slot for as long as BSC runs, and anyone who finds that
address may engrave there. The wall this project advertises is the 10,000-token one
above; `contracts/deployed_addresses.json` keeps both records, under `WormLedger` and
`WormLedgerSuperseded`.

The two transactions cost 1,004,455 and 1,219,279 gas (0.00011 BNB together), the
replacement ledger 1,004,479, and
`tick()`/`stateHash()` were identical before and after: the deployments did not touch
the animal. `npx hardhat test` covers both suites (23 cases, all local).

One honest gap: explorer source verification did not work from this network. The
legacy `api.bscscan.com` endpoint now answers `301 -> docs.etherscan.io/v2-migration`,
and the Etherscan v2 multichain host that replaced it is unreachable from Node here
(`UND_ERR_CONNECT_TIMEOUT`, while a keyless probe through another client is refused
with "Free API access is not supported for this chain"). So `npx hardhat verify`
could not publish from this machine — it may from elsewhere. The closest check
available from here is made offline instead —
`node scripts/verify_bytecode.cjs WormLedger 0xb305… WormGuess 0x8d3c…` compares the
deployed runtime code with a fresh local compile of this source: identical metadata
fingerprint, identical size, and zero divergences outside the slots where the
constructor inlines `brain`/`token`/`price`/`minStake`. This is a weaker claim than an
explorer verification: it convinces anyone who runs it themselves, and it is offered
as such rather than as a substitute for the published source.

### The inscription wall on the dashboard

Card **05** of `bscworm.com` renders the deployed `WormLedger`, and it is split into
two modules on purpose — a stricter arrangement than the poke card, which keeps its
read feed and its single write in one fenced file:

- `frontend/src/wall.js` — **read-only, and still inside the global ban.** One batched
  `eth_call` for the seven getters, one 24-call batch for the visible slots, and an
  `Inscribed` event walk that starts at the pinned deployment block
  (`125412554`) and advances in 2,000-block spans cached in `localStorage` under a key
  derived from the ledger address itself, so re-pointing the page at a different wall
  can never inherit the old wall's cached scan floor and quietly skip the earliest
  inscriptions. A visitor who keeps the tab open keeps syncing instead of re-reading
  from genesis.
  The cached event rows are capped at the newest 2,000 — an unbounded cache would
  eventually exceed the storage quota, fail its `setItem` into a silent catch, and
  send every visit back to genesis with no way to reach the head inside its budget.
  A span an endpoint refuses is counted and reported as refusal, never drawn as "no
  one has engraved anything"; a slot this page cannot read is drawn as *unreadable*,
  not as *open*. If `token()` on the ledger is not the token this page pins, the card
  refuses to quote a price at all. Engraved text is HTML-escaped before it is drawn —
  the contract's printable-ASCII rule is the first line of defence, not the only one.
- `frontend/src/engrave.js` — **the write path, reached only by a click inside the
  wall card.** It can encode exactly two calls, `ERC20.approve(ledger, amount)` and
  `WormLedger.inscribe(slot, text, nominal)`, against exactly two addresses, the
  pinned ledger and its pinned token. It never names the brain, so nothing on the
  wall can move or stimulate the animal; it never sees a key, since signing happens
  in the visitor's own wallet. Because the price is defined as what *arrives* and the
  token keeps 3%, the form prefills `price / 0.97` plus a 2% margin: on the live wall
  that is a contract floor of 10,309.28 against a 10,000 price, and a prefilled
  10,515.46. The extra exists because I cannot know how the deployed token rounds its
  own fee and a reverted inscription still costs gas. The module also refuses to mount
  at all unless the addresses the read side hands it equal the two it pins itself, so a
  one-sided address change cannot produce a spending form. Text policy, slot window and
  nominal are all checked client-side first so a mistake costs a keystroke instead of a
  fee.

`frontend/test/smoke.mjs` fences both halves: `wall.js` stays under the site-wide ban
on `getSigner` / `sendTransaction` / `window.ethereum` / key material, while
`engrave.js` is exempted from that blanket rule only to be held to a narrower one —
the ledger and its token are the only two address literals in the file, `approve` and
`inscribe` the only two calls it can make, every `Contract(...)` is built on one of
the two pinned identifiers, and no module may reach it through a static import.

What I verified after deploying, rather than assuming:

- **Live page, real browser.** A fresh load of card 05, pressed READ THE WALL: `wall read ·
  11:44:51`, price `10000.0000 WormBrain (must arrive)`, contract floor `10309.2783`, slot
  span "100 ticks of beating (about 100 minutes at the observed ~1 tick/min cadence)",
  newest slot `9 (brain tick 970)`, `0 engraved`, log coverage "all history, through block
  125414581". Ten tiles rendered (slot 9 down to slot 0 — the wall is young, so fewer than
  24 exist yet), all of them `open`. Zero console messages of any kind, and every RPC
  response returned 2xx.
- **The form, armed but not fired.** ENABLE ENGRAVING mounted it and prefilled slot `9`
  (min 0, max 9) with nominal `10515.463917525773195877`. I had computed that exact number
  independently, straight from the on-chain `price()` with the same ceiling arithmetic, and
  it agrees to the last wei. Nothing was signed: no wallet prompt appeared and no
  transaction left the page.
- **The write encoding, without spending.** `inscribe` carries selector `0x9b882837`. A
  static `eth_call` from a wallet holding no token passed every check the ledger makes on
  its own — slot window, `nominal >= price`, text policy — and failed only inside the
  token, at `"ERC20: insufficient allowance"`, at four different nominals (price, floor −
  1 wei, floor, and the form's value); one slot ahead it answered `"slot is in the
  future"`. What that cannot prove is the arrival check: the ledger inspects the balance
  delta *after* the transfer, so an unapproved wallet never reaches it. That limit is the
  reason the form prefills above the floor rather than at it — a shortfall reverts on
  chain and still costs gas.
- **Bundle shape.** The deployed entry chunk contains neither the ledger address nor
  `window.ethereum` nor `inscribe(`; those live only in the lazily fetched
  `wall-*.js` and `engrave-*.js` chunks, so the default page genuinely cannot spend.

No inscription has been made yet: the wall is empty, and the first one costs its
author ~10,515.46 token plus two transactions of gas. I have not spent any of your
token on this — arming the form and pressing ENSCRIBE is yours to do.

```powershell
cd frontend; npm test; npm run build      # fence + Vite build into frontend/dist
cd ../site; npx wrangler deploy           # serves dist on bscworm.com + www
```

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
the deployed `WormReadout` / `SenseAdapter` / brain over JSON-RPC, leading with the
project's own read-only worker proxy and falling back to the free public BSC nodes —
the worker forwards reads only, it holds no state of its own and no second brain runs
in the browser. By default
nothing is signed or sent; the two exceptions are both explicitly opt-in and each
pins one contract and one function — the poke module (`### Poke the worm`) and the
engraving form behind the wall card (`### The inscription wall on the dashboard`),
which relay their calls to the visitor's own wallet. The Three.js 3D viewer autoplays
and is a self-running demo of the connectome's shape, issuing no chain read at all; and
the time-lapse card (`### Time-lapse`) plays a static
recording of replayed on-chain state. `npm test` runs a static read-only guardrail
covering every module except those two, each of which gets a narrower dedicated
fence, plus an integrity check on the replay recording and an existence check for
every element id the wall touches, and a completeness check on the two language
catalogues (`### Two languages, English by default`); `npm run build` emits `dist/` including the
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
                      wormreadout.test.js, senseadapter.test.js, wormeffector.test.js,
                      advance_guards.test.js, wormledger.test.js, wormguess.test.js
  scripts/            deploy / seed / verify / readout+adapter deployment / inspection
worm/                 off-chain companion code
  brain_spec.py       authoritative integer spec -> brain_weights.json + brain_golden.json
  lif_worm.py         floating-point LIF prototype (behavioral reference)
  export_connectome.py  Cook 2019 -> 302x302 matrices + edge list (via ConnectomeToolbox)
  data/               connectome npz, edge list, golden trajectory, layout, weights
  node/               resident daemon (advance only, keeps the animal alive)
scripts/              analysis + layout generation helpers
frontend/             Vite + ethers read-only dashboard (worker proxy first, free BSC
                      nodes behind it), an autoplaying Three.js 3D viewer (a pure demo,
                      no chain read), opt-in poke, and the inscription wall
                      (src/wall.js reads, src/engrave.js writes)
worker/               Cloudflare Worker: read-only chain API + the browser's read proxy
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

A read-only Cloudflare Worker that aggregates chain state into a JSON API and carries
the dashboard's reads. The worker never signs or sends anything and holds no private
key; the one secret it carries is a metered RPC URL, kept as a wrangler secret so the
key never appears in a public bundle:

- `GET /api/snapshot` — tick, all 302 V/gate/stim/spikeCount, body pose, stateHash
- `GET /api/events?blocks=N` — recent `Advanced` / `Stimulated` logs (on-chain history)
- `POST /api/rpc` — read-only JSON-RPC proxy for the browser: `eth_call`, `eth_getLogs`,
  `eth_blockNumber`, `eth_chainId`, `eth_getBlockByNumber`, single or batched (up to 100
  members, ids echoed). Anything else — every write, signing or filter method — is
  refused with `-32601` before a request leaves the worker, a `getLogs` range over
  20,000 blocks is refused, other sites' origins get 403, and each client address gets a
  per-minute read budget (per isolate, so a rough guard rather than an exact ledger)
- `POST /api/push-snapshot`, `POST /api/push-events` — daemon feeds (shared-secret guarded)

Gateway order, everywhere in the worker: `BSC_RPC` (the metered gateway) leads and the
free dataseeds are the failover, tried only once the preferred endpoint actually failed —
so running out of compute units degrades a read instead of stopping the heart or blinding
the page. A gateway that just failed is cooled down for 30 s per isolate, and any error
text leaving the worker has the gateway URL stripped from it first.

Deploy: `cd worker; npx wrangler deploy` (vars: `BRAIN_ADDRESS`; secrets: `BSC_RPC`,
`DAEMON_KEY`; KV `WBB_STORE` for the shared snapshot/event cache). Offline tests:
`node worker/test_events.mjs`, `node worker/test_rpc_gate.mjs` (the proxy's policy with
fetch stubbed out, so no gateway is billed to check it).

## Security model

- Private keys live only in `contracts/.env`, which is git-ignored; nothing
  signs in the browser or the worker.
- The connectome is content-addressed (`connRoot`); any viewer can verify the
  blob served to `advance()` against the on-chain anchor.
- The daemon's spend guardrails (`--reserve-bnb`, `--max-spend-bnb`, failure
  backoff) bound the cost of running a resident node.

## License

MIT
