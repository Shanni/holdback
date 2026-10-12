// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Minimal ERC-20 surface. TIP-20 stablecoins on Tempo implement it (6 decimals).
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title HoldbackEscrow
/// @notice Auth-capture escrow for any ERC-20 / TIP-20 token: the EVM (Tempo) rail
///         of Holdback. Lifecycle, following the x402 auth-capture scheme:
///
///   authorize  payer locks `amount` of `token` for `receiver` until `authorizationExpiry`
///   capture    receiver takes `captureAmount` <= held before expiry; the rest goes back to payer
///   void       receiver releases the hold; everything goes back to payer
///   reclaim    payer takes it all back: before expiry only if the policy allows it,
///              at/after expiry always (the hold was never captured)
///
///   Every path ends the payment; a payment settles exactly once.
contract HoldbackEscrow {
    enum Status {
        None, // never authorized
        Authorized, // funds held
        Captured, // receiver was paid (remainder, if any, refunded)
        Voided, // receiver refunded the payer in full
        Reclaimed // payer took the funds back
    }

    /// Packed into 3 storage slots. Every new slot costs 250k gas on Tempo, so this is
    /// the floor for (payer, receiver, token) plus amount/expiry/flags.
    struct Payment {
        // slot 0: 20 + 8 + 1 + 1 bytes
        address payer;
        uint64 authorizationExpiry; // unix seconds; capture must happen strictly before
        Status status;
        bool payerCanReclaimBeforeExpiry;
        // slot 1: 20 + 12 bytes
        address receiver;
        uint96 amount; // held amount (token base units)
        // slot 2
        address token;
    }

    mapping(bytes32 paymentId => Payment) public payments;

    event Authorized(
        bytes32 indexed paymentId,
        address indexed payer,
        address indexed receiver,
        address token,
        uint256 amount,
        uint64 authorizationExpiry,
        bool payerCanReclaimBeforeExpiry
    );
    event Captured(bytes32 indexed paymentId, uint256 capturedAmount, uint256 refundedAmount);
    event Voided(bytes32 indexed paymentId, uint256 refundedAmount);
    event Reclaimed(bytes32 indexed paymentId, uint256 refundedAmount);

    error PaymentExists();
    error InvalidPayment();
    error NotAuthorized(); // payment is not in the Authorized (held) state
    error Unauthorized(); // caller may not perform this action
    error AuthorizationExpired();
    error ReclaimNotAllowed();
    error CaptureTooLarge();
    error TransferFailed();

    /// @notice Payer locks `amount` of `token` for `receiver`. The payer must have
    ///         approved this contract for at least `amount` first.
    /// @param paymentId  caller-chosen unique id (e.g. keccak of the order); first come first served
    function authorize(
        bytes32 paymentId,
        address receiver,
        address token,
        uint256 amount,
        uint64 authorizationExpiry,
        bool payerCanReclaimBeforeExpiry
    ) external {
        if (payments[paymentId].status != Status.None) revert PaymentExists();
        if (
            receiver == address(0) || token == address(0) || amount == 0 || amount > type(uint96).max
                || authorizationExpiry <= block.timestamp
        ) revert InvalidPayment();

        payments[paymentId] = Payment({
            payer: msg.sender,
            authorizationExpiry: authorizationExpiry,
            status: Status.Authorized,
            payerCanReclaimBeforeExpiry: payerCanReclaimBeforeExpiry,
            receiver: receiver,
            amount: uint96(amount),
            token: token
        });

        _safeTransferFrom(token, msg.sender, address(this), amount);
        emit Authorized(paymentId, msg.sender, receiver, token, amount, authorizationExpiry, payerCanReclaimBeforeExpiry);
    }

    /// @notice Receiver takes `captureAmount` (0 < captureAmount <= held) before expiry.
    ///         The uncaptured remainder is refunded to the payer in the same call.
    function capture(bytes32 paymentId, uint256 captureAmount) external {
        Payment storage p = _held(paymentId);
        if (msg.sender != p.receiver) revert Unauthorized();
        if (block.timestamp >= p.authorizationExpiry) revert AuthorizationExpired();
        uint256 held = p.amount;
        if (captureAmount == 0 || captureAmount > held) revert CaptureTooLarge();

        p.status = Status.Captured;
        uint256 refund = held - captureAmount;
        _safeTransfer(p.token, p.receiver, captureAmount);
        if (refund > 0) _safeTransfer(p.token, p.payer, refund);
        emit Captured(paymentId, captureAmount, refund);
    }

    /// @notice Receiver cancels the hold (e.g. a losing bid); payer gets everything back.
    function void(bytes32 paymentId) external {
        Payment storage p = _held(paymentId);
        if (msg.sender != p.receiver) revert Unauthorized();

        p.status = Status.Voided;
        uint256 refund = p.amount;
        _safeTransfer(p.token, p.payer, refund);
        emit Voided(paymentId, refund);
    }

    /// @notice Payer takes the funds back: before expiry only if the policy allows it,
    ///         at or after expiry always (the receiver never captured).
    function reclaim(bytes32 paymentId) external {
        Payment storage p = _held(paymentId);
        if (msg.sender != p.payer) revert Unauthorized();
        if (block.timestamp < p.authorizationExpiry && !p.payerCanReclaimBeforeExpiry) revert ReclaimNotAllowed();

        p.status = Status.Reclaimed;
        uint256 refund = p.amount;
        _safeTransfer(p.token, p.payer, refund);
        emit Reclaimed(paymentId, refund);
    }

    function _held(bytes32 paymentId) private view returns (Payment storage p) {
        p = payments[paymentId];
        if (p.status != Status.Authorized) revert NotAuthorized();
    }

    // Tolerates tokens that return nothing (USDT-style) as well as ones that return bool.
    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        if (token.code.length == 0) revert TransferFailed();
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
