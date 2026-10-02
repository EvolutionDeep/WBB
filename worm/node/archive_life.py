"""Life archive -- export the worm's entire on-chain biography to CSV (read-only).

Every advance() step emits an Advanced(tick, fired, totalSpikes) event. This
script scans those events from the brain's deployment block to today and writes
one row per heartbeat: the tick, the block, the timestamp, the tx, how many
neurons fired in that step and the cumulative spike count. The result is a
complete, independently verifiable life log: anyone can re-run it against the
chain and get the same rows (plus the tip of the tail as the animal keeps
walking). Nothing here sends a transaction; the key in .env is never read.

Usage:
  python worm/node/archive_life.py                       # writes life_log.csv
  python worm/node/archive_life.py --out some/path.csv   # custom destination
"""
import argparse
import csv
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

from dotenv import load_dotenv

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
ADDRESSES = ROOT / "contracts" / "deployed_addresses.json"

# public gateways disagree about eth_getLogs: publicnode answers wide ranges but
# 403s the oldest blocks, dataseed variants handle the rest in modest chunks.
# Each range is tried across all of them until one serves it.
RPC_LIST = [
    "https://bsc-rpc.publicnode.com",
    "https://bsc-dataseed3.bnbchain.org",
    "https://bsc-dataseed4.bnbchain.org",
    "https://bsc-dataseed1.defibit.io",
]
TOPIC_ADVANCED = "0xb7496a18e89474c0d4762a4afb060c98a0dc0928ba8e47dad1cba99b601209b9"
CHUNK = 2000  # block range per eth_getLogs: inside every public gate's limit
MIN_CHUNK = 250
# free tiers throttle hard; one quiet request at a time beats a retry storm
THROTTLE_S = 0.4
_last_req = [0.0]


def rpc(method, params, rpc_list=None, retries=2):
    urls = rpc_list or RPC_LIST
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    last_err = None
    for attempt in range(retries):
        for url in urls:
            gap = time.time() - _last_req[0]
            if gap < THROTTLE_S:
                time.sleep(THROTTLE_S - gap)
            try:
                req = urllib.request.Request(url, data=body, headers={
                    "content-type": "application/json",
                    "user-agent": "Mozilla/5.0 (compatible; wbb-life-archiver)",
                })
                with urllib.request.urlopen(req, timeout=30) as r:
                    _last_req[0] = time.time()
                    j = json.loads(r.read().decode())
                if "error" in j:
                    raise RuntimeError(j["error"])
                return j["result"]
            except Exception as e:
                _last_req[0] = time.time()
                last_err = e
        time.sleep(2.0 * (attempt + 1))
    raise last_err or RuntimeError("all RPC endpoints failed")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HERE / "life_log.csv"))
    args = ap.parse_args()

    rec = json.loads(ADDRESSES.read_text(encoding="utf-8"))
    brain = rec["WormBrain"]["address"]
    start = int(rec["WormBrain"]["blockNumber"])
    # a private Alchemy endpoint (if configured) sees archive history that
    # public gateways refuse; its URL contains a key, so it is never printed
    load_dotenv(ROOT / "contracts" / ".env")
    alchemy = os.environ.get("ALCHEMY_BSC_RPC")
    rpc_list = ([alchemy] if alchemy else []) + RPC_LIST
    head = int(rpc("eth_blockNumber", []), 16)

    def scan(frm, to, out, gaps):
        try:
            logs = rpc("eth_getLogs", [{
                "address": brain, "topics": [TOPIC_ADVANCED],
                "fromBlock": hex(frm), "toBlock": hex(to),
            }], rpc_list=rpc_list)
        except Exception as e:
            if to - frm > MIN_CHUNK:  # halve and retry: limits are range-shaped
                mid = (frm + to) // 2
                scan(frm, mid, out, gaps)
                scan(mid + 1, to, out, gaps)
                return
            gaps.append((frm, to))
            print(f"warn: {frm}-{to} unserved: {e}", file=sys.stderr)
            return
        for lg in logs:
            out.append({"tick": int(lg["topics"][1], 16),           # indexed
                        "block": int(lg["blockNumber"], 16),
                        "tx": lg["transactionHash"],
                        "fired_this_step": int(lg["data"][2:66], 16),
                        "total_spikes": int(lg["data"][66:130], 16)})

    rows, gaps = [], []
    for frm in range(start, head + 1, CHUNK):
        scan(frm, min(head, frm + CHUNK - 1), rows, gaps)

    # attach wall-clock timestamps: one getBlock per distinct event block, cached
    ts_cache = {}
    for r in rows:
        b = r["block"]
        if b not in ts_cache:
            ts_cache[b] = int(rpc("eth_getBlockByNumber", [hex(b), False], rpc_list=rpc_list)["timestamp"], 16)
        r["timestamp_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts_cache[b]))

    rows.sort(key=lambda r: r["tick"])
    with open(args.out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["tick", "block", "timestamp_utc", "tx",
                                          "fired_this_step", "total_spikes"])
        w.writeheader()
        w.writerows(rows)

    first = rows[0] if rows else None
    last = rows[-1] if rows else None
    print(f"archived {len(rows)} heartbeats -> {args.out}")
    if first and last:
        span = ts_cache[last["block"]] - ts_cache[first["block"]]
        print(f"life: tick {first['tick']} ({first['timestamp_utc']}) -> "
              f"tick {last['tick']} ({last['timestamp_utc']}), span {span/3600:.1f}h")
    if gaps:
        print(f"NOTE: {len(gaps)} block range(s) unserved even after halving; the archive may have gaps.",
              file=sys.stderr)


if __name__ == "__main__":
    main()
