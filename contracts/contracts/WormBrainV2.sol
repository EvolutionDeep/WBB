// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title WormBrainV2 —— the on-chain worm that LEARNS from every touch
/// @notice Same deterministic EVM simulation as WormBrain v1 (302 LIF neurons +
///         2D body + chemotaxis, byte-identical to worm/brain_spec.py), plus a
///         persistent per-neuron memory trace M:
///           - sensitization: stimulate(idx, amp) writes M[idx] += K_MEM*amp,
///             clamped to +-M_CAP. Unlike the stimulus current (which decays
///             within ~30 steps), M never fades on its own -- every touch is
///             remembered for the rest of the worm's on-chain life;
///           - expression: every step each neuron receives a chronic bias
///             current G_MEM*M[i], so the animal's future dynamics permanently
///             reflect its interaction history;
///           - habituation: every spike of neuron i erodes its own memory
///             (M[i] *= M_SPIKE_DECAY), bounding runaway sensitization exactly
///             like the biological preparation.
///         M is part of stateHash() (prefix "WORM-BRAIN-v2"), so learning is
///         provable on-chain and reproducible by anyone.
/// @dev   Q20 fixed point; truncating int256 division; sha256. Genesis is still
///        two-phase (empty constructor + one-shot seed()) because of EIP-3860.
///        M starts at zero: a newborn worm with no memories yet.
contract WormBrainV2 {
    uint256 public constant N = 302;
    uint256 private constant MASK64 = (1 << 64) - 1;

    // ---- Q20 constants, value-for-value identical to brain_spec ----
    int256 private constant SCALE = 1048576;
    int256 private constant A_SYN = 52429;
    int256 private constant A_MEM = 83886;
    int256 private constant GATE_OFF = 419430;
    int256 private constant V_THRESH = 650117;
    int256 private constant POST_SUP = 1258291;
    int256 private constant I_CAP = 3145728;
    int256 private constant V_LO = -2621440;
    int256 private constant V_HI = 4194304;
    int256 private constant GAIN = 2726298;
    int256 private constant NOISE_AMP = 943718;
    int256 private constant STIM_DECAY = 943718;
    int256 private constant STIM_CAP = 8388608;
    int256 private constant G_ATTR_C = 2516582;
    int256 private constant G_ATTR_DC = 5033165;
    int256 private constant G_OLI = 1153434;
    int256 private constant AVERT_TH = 996147;
    int256 private constant G_AVERT = 6291456;
    int256 private constant FOOD_X = 65011712;
    int256 private constant FOOD_Y = 39845888;
    int256 private constant R_FIELD = 23068672;
    int256 private constant POS_LO_X = 524288;
    int256 private constant POS_HI_X = 83361792;
    int256 private constant POS_LO_Y = 524288;
    int256 private constant POS_HI_Y = 51904512;
    int256 private constant F_SPEED = 188744;
    int256 private constant DT = 20972;
    int256 private constant TURN_CONT = 419430;
    int256 private constant G_LU = 943718;
    int256 private constant G_LT = 838861;
    int256 private constant DRIVE_BASE = 262144;
    int256 private constant DRIVE_SPAN = 786432;
    int256 private constant SEED = 20261002;
    // small constants inlined in the spec
    int256 private constant KLIN_EPS = 105;      // q(0.0001)
    int256 private constant TURN_MAG_LO = 157286; // q(0.15)
    int256 private constant TURN_MAG_SPAN = 367002; // q(0.35)
    // ---- v2 memory-trace constants ----
    int256 private constant K_MEM = 262144;          // q(0.25)  memory write gain
    int256 private constant M_CAP = 2097152;         // q(2.0)   memory clamp
    int256 private constant G_MEM = 262144;          // q(0.25)  expression gain (max bias +-0.5)
    int256 private constant M_SPIKE_DECAY = 1043333; // q(0.995) habituation per spike

    // ---- State ----
    address public immutable deployer;            // seeds the genesis genome exactly once
    bool private seeded;
    bytes32 public connRoot;                 // genome anchor: keccak256(connBlob), locked against tampering
    uint256 public edgeCount;
    int256[N] public V;                      // membrane voltage
    int256[N] public gate;                   // synaptic gate (low-passed firing rate)
    int256[N] public stim;                   // injected external stimulus current (transient)
    int256[N] public M;                      // v2 persistent memory trace (learning)
    uint256[N] public spikeCount;            // cumulative spike count per neuron
    int256 public px;
    int256 public py;
    int256 public hx;                        // heading unit vector
    int256 public hy;
    uint256 public tick;
    uint256 public totalSpikes;
    int256 private cprev;

    // ---- Neuron group indices ----
    uint256[] public attrSensors;
    uint256[] public oliSensors;
    uint256[] public avertSensors;
    uint256[] public motorFwd;
    uint256[] public interAva;
    uint256[] public interAvb;
    uint256[] public turnIn;
    uint256 public awcl;
    uint256 public awcr;
    uint256 public awal;
    uint256 public awar;

    event Advanced(uint256 indexed tick, uint256 fired, uint256 totalSpikes);
    event Stimulated(uint256 indexed idx, int256 amp);
    event Seeded(bytes32 connRoot, uint256 edgeCount);

    /// @dev Genesis bundle. Passed as one calldata struct because 17 free parameters
    ///      overflow the Yul stack even under viaIR; the ABI encoding is identical
    ///      to the old flat parameter list. M is NOT part of genesis: a newborn
    ///      worm starts with zero memories and earns them through stimulation.
    struct Genesis {
        bytes blob;
        int256[N] v;
        uint256[] attr;
        uint256[] oli;
        uint256[] avert;
        uint256[] fwd;
        uint256[] ava;
        uint256[] avb;
        uint256[] turn;
        uint256 awcl;
        uint256 awcr;
        uint256 awal;
        uint256 awar;
        int256 px;
        int256 py;
        int256 hx;
        int256 hy;
    }

    constructor() {
        deployer = msg.sender;
    }

    /// @notice Genesis load, callable exactly once by the deployer (see EIP-3860 note in v1).
    ///         The connectome blob arrives in this tx's calldata, so connRoot is proven
    ///         on-chain as keccak256(blob), byte-identical to the brain_spec.py genome.
    function seed(Genesis calldata gen) external {
        require(!seeded, "already seeded");
        require(msg.sender == deployer, "only deployer");
        require(gen.blob.length % 8 == 0, "bad blob");
        seeded = true;
        connRoot = keccak256(gen.blob);
        edgeCount = gen.blob.length / 8;
        for (uint256 i = 0; i < N; i++) V[i] = gen.v[i];
        attrSensors = gen.attr;
        oliSensors = gen.oli;
        avertSensors = gen.avert;
        motorFwd = gen.fwd;
        interAva = gen.ava;
        interAvb = gen.avb;
        turnIn = gen.turn;
        awcl = gen.awcl; awcr = gen.awcr; awal = gen.awal; awar = gen.awar;
        px = gen.px; py = gen.py; hx = gen.hx; hy = gen.hy;
        cprev = _conc(gen.px, gen.py);
        emit Seeded(connRoot, edgeCount);
    }

    // ---- Public entry points ----

    /// @notice Permissionlessly advance the brain by n steps; the caller supplies the
    ///         canonical connectome blob in the tx (verified against connRoot).
    function advance(uint256 n, bytes calldata connBlob) external {
        require(seeded, "not seeded");
        require(n > 0 && n <= 500, "n range");
        require(connBlob.length == edgeCount * 8, "blob len");
        require(keccak256(connBlob) == connRoot, "bad connome");
        bytes memory cb = connBlob;           // copy calldata->memory once, reuse across steps
        for (uint256 k = 0; k < n; k++) {
            uint256 fired = _step(cb);
            emit Advanced(tick, fired, totalSpikes);
        }
    }

    /// @notice Accept stimulation: inject current into neuron idx (positive or negative)
    ///         AND write a persistent memory trace (sensitization). The current decays
    ///         away within ~30 steps; the memory stays (eroded only by that neuron's
    ///         own spikes -- habituation).
    function stimulate(uint256 idx, int256 amp) external {
        require(seeded, "not seeded");
        require(idx < N, "idx");
        int256 v = stim[idx] + amp;
        if (v > STIM_CAP) v = STIM_CAP;
        if (v < -STIM_CAP) v = -STIM_CAP;
        stim[idx] = v;
        int256 m = M[idx] + (K_MEM * amp) / SCALE;
        if (m > M_CAP) m = M_CAP;
        if (m < -M_CAP) m = -M_CAP;
        M[idx] = m;
        emit Stimulated(idx, amp);
    }

    /// @notice Canonical state hash: 32B prefix ("WORM-BRAIN-v2") + V/gate/stim/M +
    ///         px,py,hx,hy + tick, each as a 32-byte big-endian word, then sha256.
    ///         Byte-identical to brain_spec.State.state_hash().
    function stateHash() public view returns (bytes32) {
        bytes32[] memory w = new bytes32[](1 + 4 * N + 5);
        uint256 j = 0;
        w[j++] = "WORM-BRAIN-v2";
        for (uint256 i = 0; i < N; i++) w[j++] = bytes32(uint256(V[i]));
        for (uint256 i = 0; i < N; i++) w[j++] = bytes32(uint256(gate[i]));
        for (uint256 i = 0; i < N; i++) w[j++] = bytes32(uint256(stim[i]));
        for (uint256 i = 0; i < N; i++) w[j++] = bytes32(uint256(M[i]));
        w[j++] = bytes32(uint256(px));
        w[j++] = bytes32(uint256(py));
        w[j++] = bytes32(uint256(hx));
        w[j++] = bytes32(uint256(hy));
        w[j++] = bytes32(tick);
        return sha256(abi.encodePacked(w));
    }

    // ---- Internal: single-step dynamics (strictly mirrors the order of brain_spec.step) ----

    function _step(bytes memory cb) private returns (uint256) {
        uint256 st = tick;
        int256 c = _conc(px, py);
        int256 dcdt = c - cprev;
        cprev = c;

        // sensory input I_sens
        int256[N] memory Isens;
        for (uint256 k = 0; k < attrSensors.length; k++) {
            uint256 i = attrSensors[k];
            int256 dpos = dcdt > 0 ? dcdt : int256(0);
            Isens[i] += (G_ATTR_C * c) / SCALE + (G_ATTR_DC * dpos) / SCALE;
        }
        for (uint256 k = 0; k < oliSensors.length; k++) {
            uint256 i = oliSensors[k];
            Isens[i] += (G_OLI * (SCALE - c)) / SCALE;
        }
        for (uint256 k = 0; k < avertSensors.length; k++) {
            uint256 i = avertSensors[k];
            if (c > AVERT_TH) Isens[i] += (G_AVERT * (c - AVERT_TH)) / SCALE;
        }
        for (uint256 i = 0; i < N; i++) Isens[i] += _noise(st, i);
        for (uint256 i = 0; i < N; i++) Isens[i] += stim[i];
        // v2 memory expression: chronic bias current from the persistent trace
        for (uint256 i = 0; i < N; i++) Isens[i] += (G_MEM * M[i]) / SCALE;

        // gate low-pass
        for (uint256 i = 0; i < N; i++) {
            int256 drive = V[i] - GATE_OFF;
            if (drive < 0) drive = 0;
            gate[i] += ((drive - gate[i]) * A_SYN) / SCALE;
        }

        // I_net = GAIN * clip(S@gate), sparse accumulation
        int256[N] memory acc;
        uint256 E = edgeCount;
        for (uint256 e = 0; e < E; e++) {
            uint256 word;
            assembly { word := mload(add(cb, add(32, mul(e, 8)))) }
            uint256 src = (word >> 240) & 0xffff;
            uint256 dst = (word >> 224) & 0xffff;
            uint256 wbits = (word >> 192) & 0xffffffff;
            int256 w = int256(wbits);
            if (wbits & 0x80000000 != 0) w -= int256(uint(0x100000000));
            int256 g = gate[src];
            acc[dst] += (w * g) / SCALE;
        }
        for (uint256 i = 0; i < N; i++) {
            int256 inet = _clip(acc[i], -I_CAP, I_CAP);
            inet = (GAIN * inet) / SCALE;
            V[i] += ((inet + Isens[i] - V[i]) * A_MEM) / SCALE;
        }

        // spike + repolarize + clamp
        uint256 fired = 0;
        for (uint256 i = 0; i < N; i++) {
            if (V[i] >= V_THRESH) {
                spikeCount[i] += 1;
                fired += 1;
                V[i] -= POST_SUP;
                // v2 habituation: firing erodes this neuron's own memory trace
                if (M[i] != 0) M[i] = (M[i] * M_SPIKE_DECAY) / SCALE;
            }
            V[i] = _clip(V[i], V_LO, V_HI);
        }
        totalSpikes += fired;

        // group readout
        int256 r_fwd = _mean(motorFwd);
        int256 r_avb = _mean(interAvb);
        int256 r_turn = _mean(turnIn);

        int256 t = _clip(r_fwd + r_avb / 2, 0, SCALE);
        int256 drv = DRIVE_BASE + (DRIVE_SPAN * t) / SCALE;
        int256 speed = (F_SPEED * drv) / SCALE;
        int256 step_len = (speed * DT) / SCALE;
        px += (step_len * hx) / SCALE;
        py += (step_len * hy) / SCALE;

        int256 lr = (gate[awcl] + gate[awcr]) - (gate[awal] + gate[awar]);
        int256 turn_cmd = (G_LU * lr) / SCALE + (G_LT * r_turn) / SCALE;
        int256 dth = (turn_cmd * DT * TURN_CONT) / (SCALE * SCALE);
        _rotate(dth);
        if (dcdt < -KLIN_EPS) {
            if (int256(_rand01(st, 7) % uint256(SCALE)) < SCALE / 50) {
                int256 mag = TURN_MAG_LO + int256(_rand01(st, 9) % uint256(TURN_MAG_SPAN));
                _rotate(turn_cmd >= 0 ? mag : -mag);
            }
        }

        px = _clip(px, POS_LO_X, POS_HI_X);
        py = _clip(py, POS_LO_Y, POS_HI_Y);

        // stimulus decay (memory M deliberately does NOT decay here)
        for (uint256 i = 0; i < N; i++) {
            if (stim[i] != 0) stim[i] = (stim[i] * STIM_DECAY) / SCALE;
        }
        tick = st + 1;
        return fired;
    }

    // ---- Helpers (identical to v1) ----

    function _conc(int256 _px, int256 _py) private pure returns (int256) {
        int256 dx = _px - FOOD_X;
        int256 dy = _py - FOOD_Y;
        int256 d2 = (dx * dx + dy * dy) / SCALE;
        int256 r2 = (R_FIELD * R_FIELD) / SCALE;
        return (SCALE * r2) / (r2 + d2 + 1);
    }

    function _rotate(int256 dth) private {
        int256 oldx = hx;
        int256 nhx = hx - (hy * dth) / SCALE;
        int256 nhy = hy + (oldx * dth) / SCALE;
        int256 l2 = nhx * nhx + nhy * nhy;
        if (l2 > 0) {
            int256 l = int256(_isqrt(uint256(l2)));
            if (l > 0) {
                hx = (nhx * SCALE) / l;
                hy = (nhy * SCALE) / l;
            }
        }
        hx = _clip(hx, -SCALE, SCALE);
        hy = _clip(hy, -SCALE, SCALE);
    }

    function _mean(uint256[] storage g) private view returns (int256) {
        uint256 n = g.length;
        if (n == 0) return 0;
        int256 s = 0;
        for (uint256 k = 0; k < n; k++) s += gate[g[k]];
        return s / int256(n);
    }

    function _clip(int256 x, int256 lo, int256 hi) private pure returns (int256) {
        return x < lo ? lo : (x > hi ? hi : x);
    }

    function _mix64(uint256 x) private pure returns (uint256) {
        x = (x + 0x9E3779B97F4A7C15) & MASK64;
        uint256 z = x;
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK64;
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK64;
        z = z ^ (z >> 31);
        return z & MASK64;
    }

    function _noise(uint256 st, uint256 i) private pure returns (int256) {
        uint256 u = _mix64(((st << 16) ^ i ^ uint256(SEED)) & MASK64);
        return int256((u * uint256(NOISE_AMP)) >> 64);
    }

    function _rand01(uint256 st, uint256 salt) private pure returns (uint256) {
        return _mix64(((st << 16) ^ salt ^ (uint256(SEED) * 2654435761)) & MASK64);
    }

    function _isqrt(uint256 x) private pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = x;
        uint256 y = (z + 1) >> 1;
        while (y < z) {
            z = y;
            y = (z + x / z) >> 1;
        }
        return z;
    }
}
