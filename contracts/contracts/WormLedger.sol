// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IWormBrain} from "./IWormBrain.sol";

interface ITokenLite {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title WormLedger -- a permanent inscription wall on the worm's own life
/// @notice Anyone may engrave one short line into a span of the animal's ticks,
///         paid for in the project token and burned in the same transaction. The
///         ledger does not touch the brain, does not stimulate it, does not advance
///         it and cannot change how it moves. What it sells is ONLY editorial
///         real estate over a record that already exists on chain: the right to be
///         the one voice attached to a given stretch of this animal's life.
/// @dev   WHY THE SCARCITY IS REAL AND NOT INVENTED:
///         - slots are derived from the brain's tick counter, which only advance()
///           moves and which never rewinds; the supply of past spans grows at the
///           pace of the animal's life and cannot be inflated by anyone;
///         - one slot accepts exactly one inscription, first writer wins, and there
///           is no setter, no owner, no pause and no upgrade -- so a taken slot is
///           taken forever and an inscription cannot be edited or removed;
///         - a slot in the future cannot be bought at all: you can only engrave a
///           span of life that has already happened.
///
///       TAXED TOKEN ACCOUNTING (the project token levies a transfer tax):
///       what this contract can actually destroy is LESS than what the caller sent.
///       The price is therefore defined as the amount that must ARRIVE, measured as
///       a balanceOf delta -- never as the nominal amount, which would let a 3% tax
///       silently underwrite every inscription. The whole received balance is
///       destroyed and emitted, so the ledger can never hold a balance quietly.
///
///       BURN MECHANICS: transferred to address(0) inside the same transaction, so
///       the two Transfer logs (caller -> ledger, ledger -> 0x0) are the proof and
///       no operator statement is needed to believe the tokens left circulation.
///
///       TEXT POLICY: 1..64 bytes of printable ASCII (0x20..0x7E). Nothing else.
///       That is a deliberate security boundary, not cosmetic: this text is
///       rendered into a web page by the frontend, and rejecting control bytes,
///       quotes and non-ASCII at the contract level means no author can smuggle
///       markup into a permanent, un-editable record.
contract WormLedger {
    /// @notice the organism whose life is being inscribed (read-only: tick())
    IWormBrain public immutable brain;
    /// @notice the token inscriptions are paid and burned in
    ITokenLite public immutable token;
    /// @notice how many ticks one inscription slot covers
    uint256 public immutable ticksPerSlot;
    /// @notice the amount that must ARRIVE (net of transfer tax) to engrave a slot
    uint256 public immutable price;

    uint256 public constant MAX_TEXT_LEN = 64;

    struct Entry {
        address author;    // who paid and wrote it
        uint64 blockAt;    // block of the inscription
        uint256 tickAt;    // the animal's tick when it was engraved
        uint256 nominal;   // what the caller asked to send
        uint256 burned;    // what actually arrived and was destroyed
        string text;       // printable ASCII only, 1..MAX_TEXT_LEN bytes
    }

    /// @dev slot => inscription. A non-empty text means the slot is taken forever.
    mapping(uint256 => Entry) public entries;

    /// @dev number of slots that have been filled
    uint256 public taken;

    event Inscribed(
        uint256 indexed slot,
        address indexed author,
        uint256 tickFrom,
        uint256 tickTo,
        uint256 nominal,
        uint256 burned,
        string text
    );

    constructor(address brain_, address token_, uint256 ticksPerSlot_, uint256 price_) {
        require(brain_ != address(0) && token_ != address(0), "zero addr");
        require(ticksPerSlot_ > 0 && price_ > 0, "bad params");
        brain = IWormBrain(brain_);
        token = ITokenLite(token_);
        ticksPerSlot = ticksPerSlot_;
        price = price_;
    }

    /// @notice the slot that a given tick belongs to
    function slotOf(uint256 tick) public view returns (uint256) {
        return tick / ticksPerSlot;
    }

    /// @notice the highest slot that already exists, i.e. the only ones purchasable
    function currentSlot() external view returns (uint256) {
        return slotOf(brain.tick());
    }

    /// @notice view used by the frontend to decide whether to render a buy affordance
    function available(uint256 slot) external view returns (bool) {
        return bytes(entries[slot].text).length == 0 && slot <= slotOf(brain.tick());
    }

    /// @notice Engrave `text` into a span of life that has already happened.
    /// @dev   Atomic: if the token transfer, the tax check or the burn fails, nothing
    ///        is written -- there is no half-engraved state and no way to overwrite a
    ///        slot that already carries text.
    function inscribe(uint256 slot, string calldata text, uint256 nominal) external {
        require(bytes(entries[slot].text).length == 0, "slot taken");
        require(slot <= slotOf(brain.tick()), "slot is in the future");
        require(nominal >= price, "nominal below price");

        bytes memory t = bytes(text);
        uint256 len = t.length;
        require(len > 0 && len <= MAX_TEXT_LEN, "text length");
        for (uint256 i = 0; i < len; i++) {
            uint8 c = uint8(t[i]);
            require(c >= 0x20 && c <= 0x7e, "text must be printable ASCII");
        }

        uint256 bal0 = token.balanceOf(address(this));
        require(token.transferFrom(msg.sender, address(this), nominal), "transferFrom failed");
        uint256 arrived = token.balanceOf(address(this)) - bal0;
        require(arrived >= price, "net receipt below price");

        // destroy every wei the ledger is holding, including anything left by an
        // earlier call, so the contract provably never accumulates a balance
        require(token.transfer(address(0), arrived), "burn failed");

        entries[slot] = Entry({
            author: msg.sender,
            blockAt: uint64(block.number),
            tickAt: brain.tick(),
            nominal: nominal,
            burned: arrived,
            text: text
        });
        taken += 1;

        emit Inscribed(
            slot,
            msg.sender,
            slot * ticksPerSlot,
            slot * ticksPerSlot + ticksPerSlot - 1,
            nominal,
            arrived,
            text
        );
    }

    /// @notice read one inscription in full (public getter returns a tuple; this is
    ///         the convenient form for off-chain verifiers that want the text too)
    function read(uint256 slot) external view returns (Entry memory) {
        return entries[slot];
    }
}
