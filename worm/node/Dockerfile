# syntax=docker/dockerfile:1
# Community keep-alive node for the on-chain worm.
#
# Anyone can run this: advance() is permissionless and deterministic -- your
# node produces the exact same next state as mine. One step costs ~9.4M gas on
# BSC mainnet (~0.0005 BNB at 0.05 gwei). The node only advances the animal;
# it never stimulates it. The wallet key is supplied at run time via the
# environment and is never baked into the image or any file.
#
# Build (context = repository root):
#   docker build -t worm-node -f worm/node/Dockerfile .
# Run (your own wallet, your own gas):
#   docker run -d --name worm-node -e DEPLOYER_PRIVATE_KEY=<your-key> worm-node
# Custom run (slower heart, and feed the public dashboard with a shared key):
#   docker run -d --name worm-node -e DEPLOYER_PRIVATE_KEY=<your-key> \
#     -e DAEMON_KEY=<key> worm-node --continuous --interval 300 \
#     --adaptive --api https://api.bscworm.com

FROM python:3.12-slim

WORKDIR /app
COPY worm/node/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# the node needs exactly three committed public files: the address registry,
# the seeded connectome blob and the minimal ABI fallback
COPY contracts/deployed_addresses.json /app/contracts/deployed_addresses.json
COPY worm/data/brain_weights.json /app/worm/data/brain_weights.json
COPY worm/node/ /app/worm/node/

ENTRYPOINT ["python", "/app/worm/node/brain_daemon.py"]
CMD ["--continuous", "--interval", "60", "--adaptive", \
     "--survive-hours", "24", "--reserve-bnb", "0.01", "--max-spend-bnb", "0.2"]
