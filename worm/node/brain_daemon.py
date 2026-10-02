"""Resident brain node -- keeps the on-chain worm alive, tick by tick.

Unlike heartbeat_daemon.py (which simulates off-chain and only posts a
stateRoot commitment), WormBrain lives entirely inside the contract: this node
merely calls advance() / occasionally stimulate(). All 302 neuron states are
already on-chain, so there is nothing to persist locally -- restart-safe by
construction, and anyone could run the same script.

Safety rails (it spends real BNB):
  - The private key is only read from contracts/.env and never printed.
  - Stops immediately if the wallet balance drops below --reserve-bnb.
  - Cumulative spend is capped by --max-spend-bnb for the whole run.
  - After 5 consecutive failures it exits with an alarm (never flails).

Usage:
  python worm/node/brain_daemon.py --beats 3                    # demo a few beats
  python worm/node/brain_daemon.py --continuous --interval 60   # 7x24 resident
  optional: --steps 1 --poke-every 25 --reserve-bnb 0.01 --max-spend-bnb 0.5
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from web3 import Web3

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
CONTRACTS_ENV = ROOT / "contracts" / ".env"
ADDRESSES = ROOT / "contracts" / "deployed_addresses.json"
BRAIN_ABI = ROOT / "contracts" / "artifacts" / "contracts" / "WormBrain.sol" / "WormBrain.json"
WEIGHTS = ROOT / "worm" / "data" / "brain_weights.json"

RPC = "https://bsc-dataseed1.bnbchain.org"
MASK64 = (1 << 64) - 1
SEED = 20261002
N_NEURONS = 302
Q = 1 << 20  # SCALE, matches brain_spec


def mix64(x):
    """splitmix64, identical to brain_spec.mix64 -- used to pick poke targets."""
    x = (x + 0x9E3779B97F4A7C15) & MASK64
    z = x
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK64
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK64
    return (z ^ (z >> 31)) & MASK64


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--beats", type=int, default=3, help="number of advance txs when not continuous")
    ap.add_argument("--continuous", action="store_true")
    ap.add_argument("--interval", type=float, default=60.0, help="seconds between beats")
    ap.add_argument("--steps", type=int, default=1, help="brain steps per advance() tx (1-4; ~8.6M gas each)")
    ap.add_argument("--poke-every", type=int, default=0, help="if >0, stimulate one deterministically chosen neuron every N beats")
    ap.add_argument("--poke-amp-q20", type=int, default=3 * Q, help="stimulus amplitude in Q20")
    ap.add_argument("--reserve-bnb", type=float, default=0.01, help="stop if balance drops below this")
    ap.add_argument("--max-spend-bnb", type=float, default=0.5, help="cumulative gas budget for this run")
    args = ap.parse_args()

    if not (1 <= args.steps <= 8):
        print("--steps must be in 1..8", file=sys.stderr)
        sys.exit(1)

    load_dotenv(CONTRACTS_ENV)
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

    beats = 0
    consecutive_fail = 0
    while args.continuous or beats < args.beats:
        t0 = time.time()
        tick_before = brain.functions.tick().call()

        # optional deterministic poke: same input tick => same target for anyone replaying
        if args.poke_every > 0 and beats > 0 and beats % args.poke_every == 0:
            target = mix64((tick_before << 16) ^ SEED) % N_NEURONS
            try:
                txh = brain.functions.stimulate(target, args.poke_amp_q20).build_transaction({
                    "from": acct.address, "nonce": w3.eth.get_transaction_count(acct.address),
                    "gasPrice": w3.eth.gas_price, "chainId": 56,
                })
                txh["gas"] = w3.eth.estimate_gas(txh)
                signed = acct.sign_transaction(txh)
                w3.eth.wait_for_transaction_receipt(
                    w3.eth.send_raw_transaction(getattr(signed, "raw_transaction", None) or signed.rawTransaction),
                    timeout=120,
                )
                print(f"[poke] stimulated neuron {target} amp={args.poke_amp_q20}")
            except Exception as e:
                print(f"[poke] failed: {e}", file=sys.stderr)

        try:
            tx = brain.functions.advance(args.steps, blob).build_transaction({
                "from": acct.address, "nonce": w3.eth.get_transaction_count(acct.address),
                "gasPrice": w3.eth.gas_price, "chainId": 56,
            })
            try:
                est = w3.eth.estimate_gas(tx)
                tx["gas"] = int(est * 1.3)
            except Exception:
                tx["gas"] = 12_000_000 * args.steps  # generous fallback
            signed = acct.sign_transaction(tx)
            raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
            txh = w3.eth.send_raw_transaction(raw)
            rcpt = w3.eth.wait_for_transaction_receipt(txh, timeout=180)
            if rcpt["status"] != 1:
                raise RuntimeError("advance tx reverted")

            spent += rcpt["gasUsed"] * w3.eth.gas_price
            consecutive_fail = 0
            beats += 1
            tick_after = brain.functions.tick().call()
            total_spikes = brain.functions.totalSpikes().call()
            print(f"[beat {beats}] tick {tick_before}->{tick_after} totalSpikes={total_spikes} "
                  f"gasUsed={rcpt['gasUsed']} tx=0x{txh.hex()[-12:]}")

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
