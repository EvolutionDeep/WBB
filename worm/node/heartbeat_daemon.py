"""Resident heartbeat daemon -- keeps the worm on mainnet continuously "alive".

Single-language Python closed loop:
  persist simulation state -> advance the LIF a few steps per epoch -> compute a
  deterministic stateRoot -> cross-check the digest against the contract's
  beatDigest view -> sign with the node key -> beat() onto mainnet ->
  persist state after landing, then wait for the next epoch.

Safety design:
  - The private key is only read from contracts/.env and never printed.
  - On startup, align with the on-chain latestTick to guarantee strict
    monotonicity (safe across restarts / multiple instances).
  - Verify the digest via the contract view before sending, to prevent signature
    domain mismatches.
  - Auto-retry with tick realignment on failure; exit with an alarm after
    repeated failures (never silently hang).

Usage:
  python worm/node/heartbeat_daemon.py --beats 5      # run 5 beats then exit (demo)
  python worm/node/heartbeat_daemon.py --continuous   # 7x24 resident
  optional: --interval 30 --steps 500
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path

import numpy as np
from Crypto.Hash import keccak
from dotenv import load_dotenv
import os
from web3 import Web3
from eth_keys import keys

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
NPZ = ROOT / "worm" / "data" / "connectome_cook2019.npz"
STATE_FILE = HERE / "worm_state.json"
CONTRACTS_ENV = ROOT / "contracts" / ".env"
ADDRESSES = ROOT / "contracts" / "deployed_addresses.json"
HB_ABI = ROOT / "contracts" / "artifacts" / "contracts" / "WormHeartbeat.sol" / "WormHeartbeat.json"

RPC = "https://bsc-dataseed1.bnbchain.org"
ARENA = (80.0, 50.0)
FOOD = np.array([62.0, 38.0])
LAM = 16.0


# ---------- connectome ----------
def load_connectome():
    d = np.load(NPZ, allow_pickle=True)
    names = [str(n) for n in d["neurons"]]
    W_chem, W_elec = d["W_chem"], d["W_elec"]
    gaba = re.compile(r"^(D[BV]A|DB\d|AS\d+|DVA|R25|AVC)")
    sign = np.array([-1.0 if gaba.match(n) else 1.0 for n in names])
    S = W_chem * sign[:, None] + W_elec
    S = S / np.maximum(np.abs(S).sum(axis=1, keepdims=True), 1e-6)
    idx = {n: i for i, n in enumerate(names)}
    sensors = np.array([idx[n] for n in names if re.match(r"AWA[LR]|AWC[LR]", n)])
    motor = np.array([idx[n] for n in names if re.match(r"(DA|VA|VB)\d+", n)])
    return S, sensors, motor


def init_state(rng_seed):
    d = np.load(NPZ, allow_pickle=True)
    N = len(d["neurons"])
    rng = np.random.default_rng(seed=rng_seed)
    return {
        "tick": 0,
        "V": rng.uniform(0, 0.3, N),
        "gate": np.zeros(N),
        "pos": np.array([12.0, 10.0]),
        "heading": 0.3,
        "rng_state": rng.bit_generator.state,
    }


def save_state(st):
    payload = {
        "tick": int(st["tick"]),
        "V": st["V"].tolist(),
        "gate": st["gate"].tolist(),
        "pos": st["pos"].tolist(),
        "heading": float(st["heading"]),
        "rng_state": st["rng_state"],
    }
    STATE_FILE.write_text(json.dumps(payload), encoding="utf-8")


def load_state(rng_seed):
    if not STATE_FILE.exists():
        return init_state(rng_seed)
    p = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    rng = np.random.default_rng()
    rng.bit_generator.state = p["rng_state"]
    return {
        "tick": int(p["tick"]),
        "V": np.array(p["V"]),
        "gate": np.array(p["gate"]),
        "pos": np.array(p["pos"]),
        "heading": float(p["heading"]),
        "rng_state": p["rng_state"],
        "_rng": rng,
    }


# ---------- simulation advance ----------
def advance(st, S, sensors, motor, steps, dt=0.02):
    rng = st.get("_rng") or np.random.default_rng()
    V, gate, pos = st["V"], st["gate"], st["pos"]
    heading = st["heading"]
    c_prev = np.exp(-np.sum((pos - FOOD) ** 2) / (2 * LAM ** 2))
    for _ in range(steps):
        c = np.exp(-np.sum((pos - FOOD) ** 2) / (2 * LAM ** 2))
        dcdt = (c - c_prev) / dt
        c_prev = c
        I = np.zeros_like(V)
        I[sensors] += 2.4 * c + 0.6 * max(dcdt, 0) * 8.0
        I += rng.uniform(0, 0.35, V.shape)
        gate += (-gate + np.maximum(V - 0.4, 0)) * dt / 0.4
        V += (-V + np.clip(2.2 * (S @ gate), -3, 3) + I) * dt / 0.25
        fired = V >= 0.62
        V[fired] -= 1.2
        V = np.clip(V, -2.5, 4.0)
        drive = 0.25 + 0.75 * float(np.clip(gate[motor].mean() if len(motor) else 0, 0, 1))
        heading += (0.5 if dcdt < -1e-4 else 0.0) + (c - 0.5) * 0.02
        pos = pos + 0.18 * drive * dt * np.array([np.cos(heading), np.sin(heading)])
        pos = np.clip(pos, [0.5, 0.5], [ARENA[0] - 0.5, ARENA[1] - 0.5])
    st["V"], st["gate"], st["pos"], st["heading"] = V, gate, pos, heading
    st["_rng"] = rng
    return st


# ---------- state root commitment ----------
def q16(x):
    return np.round(np.asarray(x, float) * 1000).astype("<i2").tobytes()


def q32(x):
    return np.round(np.asarray(x, float) * 1000).astype("<i4").tobytes()


def compute_state_root(st):
    blob = q16(st["V"]) + q32(st["pos"]) + np.uint64(st["tick"]).astype("<u8").tobytes()
    h = keccak.new(digest_bits=256)
    h.update(blob)
    return "0x" + h.hexdigest()


def beat_digest(tick, state_root_hex):
    raw = b"WORM-BEAT-v1" + int(tick).to_bytes(8, "big") + bytes.fromhex(state_root_hex[2:])
    h = keccak.new(digest_bits=256)
    h.update(raw)
    return h.digest()


# ---------- on-chain interaction ----------
def connect(pk):
    w3 = Web3(Web3.HTTPProvider(RPC))
    if not w3.is_connected():
        raise RuntimeError("RPC unreachable")
    acct = w3.eth.account.from_key(pk)
    rec = json.loads(ADDRESSES.read_text(encoding="utf-8"))
    hb_addr = rec["WormHeartbeat"]["address"]
    abi = json.loads(HB_ABI.read_text(encoding="utf-8"))["abi"]
    hb = w3.eth.contract(address=w3.to_checksum_address(hb_addr), abi=abi)
    return w3, acct, hb, hb_addr


def submit_beat(w3, acct, hb, tick, state_root, pk):
    # verify the digest against the contract view (prevent signature domain mismatch)
    onchain_digest = hb.functions.beatDigest(tick, state_root).call()
    my_digest = beat_digest(tick, state_root)
    if onchain_digest != my_digest:
        raise RuntimeError("digest mismatch, refusing to send")

    k = keys.PrivateKey(bytes.fromhex(pk[2:] if pk.startswith("0x") else pk))
    sig = k.sign_msg_hash(my_digest)
    v = sig.v + 27
    r_hex = "0x" + sig.r.to_bytes(32, "big").hex()
    s_hex = "0x" + sig.s.to_bytes(32, "big").hex()

    nonce = w3.eth.get_transaction_count(acct.address)
    gp = w3.eth.gas_price
    fn = hb.functions.beat(tick, state_root, v, r_hex, s_hex)
    tx = fn.build_transaction({
        "from": acct.address, "nonce": nonce, "gasPrice": gp, "chainId": 56,
    })
    est = w3.eth.estimate_gas(tx)
    tx["gas"] = int(est * 1.3)
    signed = acct.sign_transaction(tx)
    raw = getattr(signed, "raw_transaction", None) or getattr(signed, "rawTransaction")
    txh = w3.eth.send_raw_transaction(raw)
    rcpt = w3.eth.wait_for_transaction_receipt(txh, timeout=120)
    return rcpt, txh.hex()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--beats", type=int, default=5)
    ap.add_argument("--continuous", action="store_true")
    ap.add_argument("--interval", type=float, default=30.0)
    ap.add_argument("--steps", type=int, default=500)
    ap.add_argument("--seed", type=int, default=20261002)
    args = ap.parse_args()

    load_dotenv(CONTRACTS_ENV)
    pk = os.environ.get("DEPLOYER_PRIVATE_KEY")
    if not pk:
        print("missing DEPLOYER_PRIVATE_KEY", file=sys.stderr)
        sys.exit(1)

    S, sensors, motor = load_connectome()
    st = load_state(args.seed)
    w3, acct, hb, hb_addr = connect(pk)

    chain_tick = hb.functions.latestTick().call()
    if st["tick"] <= chain_tick:
        st["tick"] = chain_tick  # align with the chain to guarantee strict monotonicity
    print(f"node {acct.address} | contract {hb_addr} | on-chain latestTick={chain_tick} | local tick={st['tick']}")

    beats = 0
    consecutive_fail = 0
    while args.continuous or beats < args.beats:
        t0 = time.time()
        st = advance(st, S, sensors, motor, args.steps)
        st["tick"] += args.steps
        sr = compute_state_root(st)
        try:
            rcpt, txh = submit_beat(w3, acct, hb, st["tick"], sr, pk)
            ok = rcpt["status"] == 1
            if not ok:
                raise RuntimeError("tx reverted")
            save_state(st)
            consecutive_fail = 0
            new_tick = hb.functions.latestTick().call()
            hist = hb.functions.historyLength().call()
            print(f"[beat {beats+1}] tick={st['tick']} -> on-chain latestTick={new_tick} history={hist} "
                  f"pos=({st['pos'][0]:.1f},{st['pos'][1]:.1f}) tx=0x{txh[-12:]}")
        except Exception as e:
            consecutive_fail += 1
            print(f"[beat {beats+1}] failed: {e}", file=sys.stderr)
            # realign to avoid nonce/tick drift
            try:
                st["tick"] = hb.functions.latestTick().call()
            except Exception:
                pass
            if consecutive_fail >= 5:
                print("too many consecutive failures, exiting (avoid burning gas for nothing)", file=sys.stderr)
                sys.exit(2)

        beats += 1
        if args.continuous or beats < args.beats:
            time.sleep(max(0.0, args.interval - (time.time() - t0)))

    print(f"\ndone: {beats} beats. latestTick now at {hb.functions.latestTick().call()}")


if __name__ == "__main__":
    main()
