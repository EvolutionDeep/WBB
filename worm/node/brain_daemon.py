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
  --api https://wbb-worker.<subdomain>.workers.dev pushes the freshly read
  on-chain state + this node's own event logs to the Cloudflare Worker each
  beat (needs DAEMON_KEY in .env or --api-key), so the frontend poll path costs
  zero extra RPC. Those pushes are read-only feeds; nothing is enqueued here.
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
WEIGHTS = ROOT / "worm" / "data" / "brain_weights.json"

RPC = "https://bsc-dataseed1.bnbchain.org"
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
        print(f"[push] events {tag} failed: {e}", file=sys.stderr)


# public dataseeds rate-limit eth_call inside big batches: rotate endpoints
# per chunk, throttle between chunks, back off and retry on limit errors
RPC_LIST = [
    "https://bsc-dataseed1.bnbchain.org",
    "https://bsc-dataseed.binance.org",
    "https://bsc-dataseed1.defibit.io",
]


def read_full_state(brain, w3):
    """Batch-read the whole on-chain brain state: 1217 getters in ~13 batch RPCs.

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
        # public dataseeds forbid big eth_call batches; concurrent singles
        # rotated over endpoints stay under every per-method limit
        for attempt in range(4):
            url = RPC_LIST[(i + attempt) % len(RPC_LIST)]
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
    with ThreadPoolExecutor(24) as ex:
        for i, res in ex.map(one, range(len(datas))):
            results[i] = res

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


def push_snapshot(args, brain, w3, tag):
    """Hand the freshly read on-chain state to the worker (key-guarded)."""
    if not args.api or requests is None:
        return
    try:
        snap = read_full_state(brain, w3)
        r = requests.post(args.api.rstrip("/") + "/api/push-snapshot",
                          headers={**BROWSER_UA, "x-daemon-key": args.api_key or ""}, json=snap, timeout=20)
        print(f"[push] snapshot {tag} tick={snap['tick']} -> HTTP {r.status_code}")
    except Exception as e:
        print(f"[push] snapshot {tag} failed: {e}", file=sys.stderr)


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
    args = ap.parse_args()

    if not (1 <= args.steps <= 8):
        print("--steps must be in 1..8", file=sys.stderr)
        sys.exit(1)

    load_dotenv(CONTRACTS_ENV)
    if not args.api_key:
        args.api_key = os.environ.get("DAEMON_KEY")
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
    abi = json.loads(BRAIN_ABI.read_text(encoding="utf-8"))["abi"]
    blob_hex = json.loads(WEIGHTS.read_text(encoding="utf-8"))["blob"]
    blob = bytes.fromhex(blob_hex[2:] if blob_hex.startswith("0x") else blob_hex)

    w3 = Web3(Web3.HTTPProvider(RPC))
    if not w3.is_connected():
        print("RPC unreachable", file=sys.stderr)
        sys.exit(1)
    acct = w3.eth.account.from_key(pk)
    brain = w3.eth.contract(address=brain_addr, abi=abi)

    start_balance = w3.eth.get_balance(acct.address)
    spent = 0
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
            print(f"[beat {beats+1}] failed: {e}", file=sys.stderr)
            if consecutive_fail >= 5:
                print("too many consecutive failures, exiting (avoid burning gas for nothing)",
                      file=sys.stderr)
                sys.exit(2)

        if args.continuous or beats < args.beats:
            time.sleep(max(0.0, args.interval - (time.time() - t0)))

    print(f"\ndone: {beats} beats, tick now at {brain.functions.tick().call()}, "
          f"spent ~{Web3.from_wei(spent, 'ether')} BNB on gas")


if __name__ == "__main__":
    main()
