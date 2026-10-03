"""Resident brain node -- keeps the on-chain worm alive, tick by tick.

Unlike heartbeat_daemon.py (which simulates off-chain and only posts a
stateRoot commitment), WormBrain lives entirely inside the contract: this node
merely calls advance(). All 302 neuron states are already on-chain, so there is
nothing to persist locally -- restart-safe by construction, and anyone could run
the same script. This node only advances the animal; it never stimulates it.

Safety rails (it spends real BNB):
  - The private key is only read from contracts/.env and never printed.
  - Stops immediately if the wallet balance drops below --reserve-bnb.
  - Cumulative spend is capped by --max-spend-bnb for the whole run.
  - After 5 consecutive failures it exits with an alarm (never flails).

Usage:
  python worm/node/brain_daemon.py --beats 3                    # demo a few beats
  python worm/node/brain_daemon.py --continuous --interval 60   # 7x24 resident
  optional: --steps 1 --reserve-bnb 0.01 --max-spend-bnb 0.5
  --adaptive stretches the beat interval as the wallet drains so the remaining
  steps are spread over --survive-hours (the heart slows down, it does not stop
  dead); --max-interval caps how slow a beat may become.
  --api https://wbb-worker.<subdomain>.workers.dev pushes the freshly read
  on-chain state + this node's own event logs to the Cloudflare Worker each
  beat (needs DAEMON_KEY in .env or --api-key), so the frontend poll path costs
  zero extra RPC. Those pushes are read-only feeds; nothing is enqueued here.

Gateway choice: when contracts/.env carries ALCHEMY_BSC_RPC, every write and
scalar read goes through it first -- it answers eth_call reliably where the free
dataseeds silently drop batch members and refuse eth_getLogs outright -- with the
free gateways kept as the retry pool, so a metered hiccup degrades a read rather
than stopping the heart.

The one deliberate carve-out is the per-beat full-state sweep, 1,217 getters. They
are sent as three JSON-RPC batches, which is what a heartbeat needs: ~2 s and no
threads instead of 1,217 TLS requests that pinned several cores and stretched the
beat past a minute. Batching does not make it cheaper on a metered gateway, though
-- compute units are billed per inner eth_call, so 121,700 CU per beat, ~7.3M CU an
hour at 60 s, a month of allowance inside four hours. The sweep therefore runs on
the free gateways unless --metered-state opts it in; --free-only ignores the metered
gateway at all.
"""
import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

try:
    import requests  # comes with web3's dependency tree
except ImportError:
    requests = None

from dotenv import load_dotenv
from web3 import Web3

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
CONTRACTS_ENV = ROOT / "contracts" / ".env"
ADDRESSES = ROOT / "contracts" / "deployed_addresses.json"
BRAIN_ABI = ROOT / "contracts" / "artifacts" / "contracts" / "WormBrainV2.sol" / "WormBrainV2.json"
# minimal public ABI shipped with the repo, so a fresh clone (no hardhat build)
# can still run a community node
BRAIN_ABI_MIN = HERE / "brain_abi.json"
WEIGHTS = ROOT / "worm" / "data" / "brain_weights.json"

N_NEURONS = 302
Q = 1 << 20  # SCALE, matches brain_spec
# BSC rejects any tx whose gas limit exceeds 2**24; a V2 advance(1) costs ~14.2M
# so the estimate*1.3 headroom must be clamped under this ceiling (and steps>1
# would need ~28M, over the cap -- V2 must run one brain step per tx).
TX_GAS_CAP = 16_777_216

# The workers.dev edge can 403 bare python UAs; present as a browser instead.
BROWSER_UA = {"User-Agent": "Mozilla/5.0 (compatible; wbb-brain-node)"}


def _sint(hexstr):
    """Decode a 32-byte hex word as signed int256 (two's complement)."""
    v = int(hexstr, 16)
    return v - (1 << 256) if v >= (1 << 255) else v


# Public BSC endpoints refuse eth_getLogs, so the worker cannot scan logs on its
# own. The daemon decodes the logs of ITS OWN advance() receipts (zero extra RPC)
# and pushes them, so the read-only frontend can show on-chain history.
TOPIC_ADVANCED = "0xb7496a18e89474c0d4762a4afb060c98a0dc0928ba8e47dad1cba99b601209b9"
TOPIC_STIMULATED = "0x779d0d855bbe3d2772c871993b5828da906f38a7309ad2a7e596ac6730740bd6"
EVBUF = []


def harvest_events(rcpt):
    """Decode this tx's own Advanced/Stimulated logs straight from the receipt."""
    txh = rcpt["transactionHash"].hex()
    if not txh.startswith("0x"):
        txh = "0x" + txh
    for lg in rcpt["logs"]:
        topic = "0x" + lg["topics"][0].hex()
        data = lg["data"].hex() if isinstance(lg["data"], (bytes, bytearray)) else lg["data"][2:]
        block = int(lg["blockNumber"])
        if topic == TOPIC_ADVANCED:
            EVBUF.append({"kind": "Advanced", "block": block, "tx": txh,
                          "tick": int(lg["topics"][1].hex(), 16),
                          "fired": _sint(data[:64]), "totalSpikes": _sint(data[64:128])})
        elif topic == TOPIC_STIMULATED:
            EVBUF.append({"kind": "Stimulated", "block": block, "tx": txh,
                          "idx": int(lg["topics"][1].hex(), 16), "amp": _sint(data[:64])})


def push_events(args, tag):
    """Flush harvested on-chain events to the worker (key-guarded)."""
    if not args.api or requests is None or not EVBUF:
        return
    evs = EVBUF[:]
    EVBUF.clear()
    try:
        r = requests.post(args.api.rstrip("/") + "/api/push-events",
                          headers={**BROWSER_UA, "x-daemon-key": args.api_key or ""},
                          json={"events": evs}, timeout=15)
        print(f"[push] events {tag} n={len(evs)} -> HTTP {r.status_code}")
    except Exception as e:
        EVBUF[:0] = evs  # keep them for the next beat's retry
        print(f"[push] events {tag} failed: {scrub(e)}", file=sys.stderr)


# public dataseeds rate-limit eth_call inside big batches: rotate endpoints
# per chunk, throttle between chunks, back off and retry on limit errors
FREE_RPCS = [
    "https://bsc-rpc.publicnode.com",
    "https://bsc-dataseed1.bnbchain.org",
    "https://bsc-dataseed.binance.org",
    "https://bsc-dataseed1.defibit.io",
]
# One JSON-RPC array per chunk: a batch-capable gateway serves 1,519 eth_calls in a
# handful of requests instead of 1,519 TLS requests, which needed 24 threads, pinned
# several cores and took 200 s -- longer than the beat itself. 500 members was tried
# first and a publicnode chunk came back with a single error object instead of an
# array, so the chunk stays small and every chunk is verified member by member.
BATCH_CHUNK = 200
# Gateway order for the two read loops, rebuilt in main() once .env is loaded so
# a metered key in the environment takes priority without editing any code.
GW = list(FREE_RPCS)          # writes, balance, tick: a handful of calls per beat
GW_STATE = list(FREE_RPCS)    # the full-state sweep: the expensive loop
SECRETS = []                  # URL substrings that must never reach stdout/stderr


def endpoint(pool, i, attempt):
    """Preferred gateway first, the rest of the pool rotated across retries."""
    if attempt == 0 or len(pool) == 1:
        return pool[0]
    return pool[1 + (i + attempt) % (len(pool) - 1)]


def scrub(text):
    """Strip a metered URL from any message.

    HTTP/RPC exceptions quote the endpoint they used, and a metered BSC URL carries
    its key in the path -- so every failure print goes through here first.
    """
    out = str(text)
    for secret in SECRETS:
        out = out.replace(secret, "***")
    return out


def select_gateways(metered, free_only=False, metered_state=False):
    """Gateway order for the two read loops.

    The metered endpoint leads for writes and cheap scalar reads, where its
    reliability is worth far more than its compute units. The full-state sweep is
    the loop that would eat a monthly allowance (1,217 calls per beat), so it only
    joins the metered pool when the operator opts in explicitly.
    """
    gw, gw_state = list(FREE_RPCS), list(FREE_RPCS)
    if metered and not free_only:
        gw.insert(0, metered)
        if metered_state:
            gw_state.insert(0, metered)
    return gw, gw_state


def batch_call(url, address, datas, block_tag="latest"):
    """One JSON-RPC batch of eth_calls -> a list of hex results, order preserved.

    A returned array is NOT proof of success: public gateways have answered HTTP
    200 with members missing their result field, and one measured refusal came back
    as a bare error object instead of an array at all. So every member is checked for
    an absent error and a present result, and the id ordering is re-verified, or the
    whole chunk is refused and the caller falls back to singles.
    """
    payload = [{"jsonrpc": "2.0", "id": n, "method": "eth_call",
                "params": [{"to": address, "data": d}, block_tag]} for n, d in enumerate(datas)]
    j = requests.post(url, json=payload, timeout=30).json()
    if not isinstance(j, list) or len(j) != len(datas):
        got = len(j) if isinstance(j, list) else scrub(j)
        raise RuntimeError(f"batch answered {got} items for {len(datas)} calls")
    by_id = {}
    for item in j:
        if not isinstance(item, dict) or "error" in item or "result" not in item:
            raise RuntimeError(f"batch member unusable: {scrub(item)}")
        by_id[item["id"]] = item["result"]
    if len(by_id) != len(datas):
        raise RuntimeError(f"batch ids collided: {len(by_id)} distinct of {len(datas)}")
    return [by_id[n] for n in range(len(datas))]


def _sweep_once(brain):
    """One pass over the 1,519 getters, batched. Not yet checked for coherence.

    Everything is read at "latest" because that is all a public gateway will serve:
    asking it for a block number even seconds behind the head answers
    -32000 "missing trie node" (measured on publicnode), so pinning is a luxury of
    archive endpoints. Coherence is the caller's job -- see read_full_state.

    Returned shape mirrors the WBB worker snapshot so the worker can serve it
    verbatim (the poll path then costs zero RPC calls of its own).
    """
    scalars = [("tick", False), ("totalSpikes", False), ("px", True), ("py", True),
               ("hx", True), ("hy", True), ("connRoot", None), ("edgeCount", False),
               ("stateHash", None)]
    fns = [getattr(brain.functions, name)() for name, _ in scalars]
    for arr in ("V", "gate", "stim", "M"):
        fns += [getattr(brain.functions, arr)(i) for i in range(N_NEURONS)]
    fns += [brain.functions.spikeCount(i) for i in range(N_NEURONS)]

    datas = [fn._encode_transaction_data() for fn in fns]

    def one(i):
        # fallback for whatever a batch could not deliver: concurrent singles
        # rotated over endpoints stay under every per-method limit
        for attempt in range(4):
            url = endpoint(GW_STATE, i, attempt)
            try:
                r = requests.post(url, json={"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                                             "params": [{"to": brain.address, "data": datas[i]}, "latest"]},
                                  timeout=15)
                j = r.json()
                if "error" in j:
                    raise RuntimeError(f"eth_call: {j['error']}")
                return i, j["result"]
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(0.8 * (attempt + 1))
        raise RuntimeError("unreachable")

    results = [None] * len(datas)
    served, complaints = 0, []
    for off in range(0, len(datas), BATCH_CHUNK):
        chunk = datas[off:off + BATCH_CHUNK]
        # A public gateway happily serves seven 200-member batches and then refuses
        # the eighth for a few seconds (measured: "batch answered 1 items for N
        # calls"). Backing off and walking the pool twice is far cheaper than the
        # 200 singles that refusal would otherwise cost, and those singles are what
        # pinned the cores before.
        attempt = 0
        while attempt < 2 * len(GW_STATE):
            url = GW_STATE[attempt % len(GW_STATE)]
            try:
                results[off:off + len(chunk)] = batch_call(url, brain.address, chunk)
                served += 1
                break
            except Exception as e:
                complaints.append(f"{off}: {scrub(e)}")
                attempt += 1
                time.sleep(0.7 * attempt)
        time.sleep(0.15)  # one polite pause between chunks, never a burst

    holes = [i for i, v in enumerate(results) if v is None]
    if holes:
        with ThreadPoolExecutor(8) as ex:
            for i, res in ex.map(one, holes):
                results[i] = res
    print(f"[sweep] {len(datas)} reads in {served} batch chunks"
          + (f" + {len(holes)} singles (last refusal {complaints[-1]})" if holes else ""))

    out = {}
    for (name, signed), hexres in zip(scalars, results[:len(scalars)]):
        if signed is None:
            out[name] = hexres
        else:
            v = int(hexres, 16)
            out[name] = v - (1 << 256) if (signed and v >= (1 << 255)) else v
    p = len(scalars)
    for name in ("V", "gate", "stim", "M"):
        out[name] = [_sint(x) for x in results[p:p + N_NEURONS]]
        p += N_NEURONS
    out["spikes"] = [int(x, 16) for x in results[p:p + N_NEURONS]]
    out["q"] = Q
    out["address"] = brain.address
    return out


def read_full_state(brain, tries=3):
    """A sweep whose snapshot provably describes one state of the animal.

    stateHash() digests V, gate, stim, M, the pose and the tick -- every byte the
    sweep reads -- so bracketing the sweep with two hash reads proves whether a beat
    landed while it was running. If it did, the mixed half-and-half frame is thrown
    away rather than pushed: the viewer would otherwise animate a worm that never
    existed, and a stale-but-consistent frame beats a fresh-but-impossible one. The
    last attempt is still returned, because an animal that is being advanced
    constantly should not be hidden behind a perfect-frame demand.

    The bracket reads go over the free pool on purpose: two reads a beat is nothing
    for a public gateway, and a metered one would be billed twice a beat forever.
    """
    for attempt in range(1, tries + 1):
        before = _digest(brain)
        out = _sweep_once(brain)
        after = _digest(brain)
        if before == after:
            return out
        print(f"[sweep] state changed mid-read (attempt {attempt}/{tries}): "
              "a beat landed inside the sweep, discarding the torn frame", file=sys.stderr)
    return out


def _digest(brain):
    """stateHash() as one validated read, rotated over the free gateways."""
    data = brain.functions.stateHash()._encode_transaction_data()
    last = None
    for attempt in range(3):
        try:
            return batch_call(endpoint(GW_STATE, 0, attempt), brain.address, [data])[0]
        except Exception as e:
            last = scrub(e)
    raise RuntimeError(f"stateHash unreadable on the free pool: {last}")


def push_snapshot(args, brain, w3, tag):
    """Hand the freshly read on-chain state to the worker (key-guarded)."""
    if not args.api or requests is None:
        return
    try:
        snap = read_full_state(brain)
        r = requests.post(args.api.rstrip("/") + "/api/push-snapshot",
                          headers={**BROWSER_UA, "x-daemon-key": args.api_key or ""}, json=snap, timeout=20)
        print(f"[push] snapshot {tag} tick={snap['tick']} -> HTTP {r.status_code}")
    except Exception as e:
        print(f"[push] snapshot {tag} failed: {scrub(e)}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--beats", type=int, default=3, help="number of advance txs when not continuous")
    ap.add_argument("--continuous", action="store_true")
    ap.add_argument("--interval", type=float, default=60.0, help="seconds between beats")
    ap.add_argument("--steps", type=int, default=1, help="brain steps per advance() tx (1-4; ~14.2M gas each on V2)")
    ap.add_argument("--reserve-bnb", type=float, default=0.01, help="stop if balance drops below this")
    ap.add_argument("--max-spend-bnb", type=float, default=0.5, help="cumulative gas budget for this run")
    ap.add_argument("--api", default=None, help="WBB worker base URL; pushes state + events each beat (read-only feed)")
    ap.add_argument("--api-key", default=None, help="daemon shared secret (falls back to DAEMON_KEY from .env)")
    ap.add_argument("--adaptive", action="store_true", help="stretch the interval as the balance drains")
    ap.add_argument("--survive-hours", type=float, default=12.0, help="spread remaining steps over this many hours")
    ap.add_argument("--max-interval", type=float, default=300.0, help="upper bound for the stretched interval (seconds)")
    ap.add_argument("--free-only", action="store_true",
                    help="route nothing through the metered ALCHEMY_BSC_RPC gateway")
    ap.add_argument("--metered-state", action="store_true",
                    help="also run the per-beat full-state sweep on the metered gateway (~121,700 compute units per beat)")
    args = ap.parse_args()

    if not (1 <= args.steps <= 8):
        print("--steps must be in 1..8", file=sys.stderr)
        sys.exit(1)

    load_dotenv(CONTRACTS_ENV)
    if not args.api_key:
        args.api_key = os.environ.get("DAEMON_KEY")

    # the metered gateway leads whenever a key exists, but the URL itself embeds
    # that key, so only the scheme+host is ever echoed
    global GW, GW_STATE
    metered = os.environ.get("ALCHEMY_BSC_RPC")
    if metered:
        SECRETS.append(metered)
    GW, GW_STATE = select_gateways(metered, args.free_only, args.metered_state)
    if metered:
        host = metered.split("?")[0].rsplit("/", 1)[0]
        if args.free_only:
            print("alchemy key present, --free-only: staying on the public gateways")
        else:
            print(f"primary gateway : metered alchemy ({host})")
        if args.metered_state:
            print("state sweep     : metered alchemy, ~121,700 CU per beat")
        else:
            print(f"state sweep     : free gateways only ({N_NEURONS * 4 + N_NEURONS + 9} calls per beat)")
    pk = os.environ.get("DEPLOYER_PRIVATE_KEY")
    if not pk:
        print("missing DEPLOYER_PRIVATE_KEY", file=sys.stderr)
        sys.exit(1)
    pk = pk if pk.startswith("0x") else "0x" + pk

    rec = json.loads(ADDRESSES.read_text(encoding="utf-8"))
    if "WormBrain" not in rec:
        print("WormBrain not deployed yet (see contracts/scripts/deploy_brain.js)", file=sys.stderr)
        sys.exit(1)
    brain_addr = Web3.to_checksum_address(rec["WormBrain"]["address"])
    if BRAIN_ABI.exists():
        abi = json.loads(BRAIN_ABI.read_text(encoding="utf-8"))["abi"]
    else:
        abi = json.loads(BRAIN_ABI_MIN.read_text(encoding="utf-8"))
    blob_hex = json.loads(WEIGHTS.read_text(encoding="utf-8"))["blob"]
    blob = bytes.fromhex(blob_hex[2:] if blob_hex.startswith("0x") else blob_hex)

    w3 = Web3(Web3.HTTPProvider(GW[0]))
    if not w3.is_connected():
        print(f"RPC unreachable ({scrub(GW[0]).split('?')[0].rsplit('/', 1)[0]})", file=sys.stderr)
        sys.exit(1)
    acct = w3.eth.account.from_key(pk)
    brain = w3.eth.contract(address=brain_addr, abi=abi)

    start_balance = w3.eth.get_balance(acct.address)
    spent = 0
    # moving average of the real cost per beat, seeded with the measured V2 step
    cost_wei = 9_450_000 * w3.eth.gas_price
    print(f"node {acct.address} | brain {brain_addr} | tick={brain.functions.tick().call()} "
          f"| balance={Web3.from_wei(start_balance, 'ether')} BNB")
    push_snapshot(args, brain, w3, "startup")

    beats = 0
    consecutive_fail = 0
    while args.continuous or beats < args.beats:
        t0 = time.time()
        tick_before = brain.functions.tick().call()

        try:
            tx = brain.functions.advance(args.steps, blob).build_transaction({
                "from": acct.address, "nonce": w3.eth.get_transaction_count(acct.address),
                "gasPrice": w3.eth.gas_price, "chainId": 56,
            })
            try:
                est = w3.eth.estimate_gas(tx)
            except Exception:
                est = 14_500_000 * args.steps  # V2 per-step cost when estimate is unavailable
            if est > TX_GAS_CAP - 200_000:
                raise RuntimeError(
                    f"advance({args.steps}) needs ~{est} gas, over the BSC per-tx cap "
                    f"{TX_GAS_CAP}; V2 fits only one brain step per tx (--steps 1)"
                )
            tx["gas"] = min(int(est * 1.3), TX_GAS_CAP - 77_216)
            signed = acct.sign_transaction(tx)
            raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
            txh = w3.eth.send_raw_transaction(raw)
            rcpt = w3.eth.wait_for_transaction_receipt(txh, timeout=180)
            if rcpt["status"] != 1:
                raise RuntimeError("advance tx reverted")
            harvest_events(rcpt)

            spent += rcpt["gasUsed"] * w3.eth.gas_price
            # exponential moving average of actual per-beat cost (gas + calldata)
            this_cost = rcpt["gasUsed"] * w3.eth.gas_price
            cost_wei = this_cost if cost_wei == 0 else int(0.3 * this_cost + 0.7 * cost_wei)
            consecutive_fail = 0
            beats += 1
            tick_after = brain.functions.tick().call()
            total_spikes = brain.functions.totalSpikes().call()
            print(f"[beat {beats}] tick {tick_before}->{tick_after} totalSpikes={total_spikes} "
                  f"gasUsed={rcpt['gasUsed']} tx=0x{txh.hex()[-12:]}")
            push_snapshot(args, brain, w3, f"beat {beats}")
            push_events(args, f"beat {beats}")

            bal = w3.eth.get_balance(acct.address)
            if Web3.from_wei(bal, "ether") < args.reserve_bnb:
                print(f"balance {Web3.from_wei(bal, 'ether')} BNB below reserve {args.reserve_bnb}, stopping",
                      file=sys.stderr)
                sys.exit(3)
            if Web3.from_wei(spent, "ether") > args.max_spend_bnb:
                print(f"cumulative spend {Web3.from_wei(spent, 'ether')} BNB exceeded budget "
                      f"{args.max_spend_bnb}, stopping", file=sys.stderr)
                sys.exit(3)
        except Exception as e:
            consecutive_fail += 1
            print(f"[beat {beats+1}] failed: {scrub(e)}", file=sys.stderr)
            if consecutive_fail >= 5:
                print("too many consecutive failures, exiting (avoid burning gas for nothing)",
                      file=sys.stderr)
                sys.exit(2)

        if args.continuous or beats < args.beats:
            wait = args.interval
            if args.adaptive:
                # stretch the cadence so the steps left in the wallet are spread
                # over --survive-hours: a slowing heartbeat, never a fake one
                bal_now = w3.eth.get_balance(acct.address)
                free = max(0, bal_now - Web3.to_wei(args.reserve_bnb, "ether"))
                steps_left = free // max(1, cost_wei)
                if steps_left > 0:
                    need = args.survive_hours * 3600.0 / steps_left
                    wait = min(args.max_interval, max(args.interval, need))
                else:
                    wait = args.max_interval
                if abs(wait - args.interval) > 1:
                    print(f"[pace] {wait:.0f}s/beat (≈{steps_left} steps left, target {args.survive_hours:.0f}h)")
            time.sleep(max(0.0, wait - (time.time() - t0)))

    print(f"\ndone: {beats} beats, tick now at {brain.functions.tick().call()}, "
          f"spent ~{Web3.from_wei(spent, 'ether')} BNB on gas")


if __name__ == "__main__":
    main()
