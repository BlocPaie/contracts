// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract ERC20Vault is Ownable {
    using SafeERC20 for IERC20;

    // ── Types ──────────────────────────────────────────────────────────

    enum ChequeStatus {
        NotCreated,
        Pending,
        Executed,
        Cancelled
    }

    struct Cheque {
        // slot 0
        bytes32 invoiceHash;
        // slot 1 (packed: 16 + 1 = 17 bytes)
        uint128 amount;
        uint8 status;
        // slot 2
        uint256 createdAt;
    }

    // ── Events ──────────────────────────────────────────────────────────

    event FundsDeposited(uint256 amount);
    event FundsWithdrawn(uint256 amount);
    event ChequeCreated(address indexed payee, uint256 indexed chequeId, bytes32 indexed invoiceHash, uint256 amount);
    event ChequeExecuted(address indexed payee, uint256 indexed chequeId);
    event ChequeCancelled(address indexed payee, uint256 indexed chequeId);

    // ── Errors ──────────────────────────────────────────────────────────

    error ZeroAmount();
    error ZeroAddress();
    error InsufficientAvailableBalance();
    error InvoiceAlreadyRegistered();
    error InvalidInvoiceHash();
    error InvalidChequeId();
    error ChequeNotPending();

    // ── Immutables ──────────────────────────────────────────────────────

    IERC20 public immutable USDC;

    // ── State ───────────────────────────────────────────────────────────

    uint256 public allocatedBalance;
    mapping(bytes32 => bool) public invoiceRegistry;
    mapping(address => Cheque[]) public cheques;

    // ── Constructor ─────────────────────────────────────────────────────

    constructor(address _owner, address _usdc) Ownable(_owner) {
        if (_usdc == address(0)) revert ZeroAddress();
        USDC = IERC20(_usdc);
    }

    // ── Owner Functions ─────────────────────────────────────────────────

    function depositFunds(uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        USDC.safeTransferFrom(msg.sender, address(this), amount);
        emit FundsDeposited(amount);
    }

    function withdrawFunds(uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        uint256 available = USDC.balanceOf(address(this)) - allocatedBalance;
        if (amount > available) revert InsufficientAvailableBalance();
        USDC.safeTransfer(msg.sender, amount);
        emit FundsWithdrawn(amount);
    }

    function registerInvoice(bytes32 invoiceHash, address payee, uint128 amount) external onlyOwner returns (uint256 chequeId) {
        if (invoiceHash == bytes32(0)) revert InvalidInvoiceHash();
        if (payee == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (invoiceRegistry[invoiceHash]) revert InvoiceAlreadyRegistered();
        uint256 available = USDC.balanceOf(address(this)) - allocatedBalance;
        if (amount > available) revert InsufficientAvailableBalance();

        invoiceRegistry[invoiceHash] = true;
        allocatedBalance += amount;

        cheques[payee].push(Cheque({
            invoiceHash: invoiceHash,
            amount: amount,
            status: uint8(ChequeStatus.Pending),
            createdAt: block.timestamp
        }));
        chequeId = cheques[payee].length - 1;

        emit ChequeCreated(payee, chequeId, invoiceHash, amount);
    }

    function cancelCheque(address payee, uint256 chequeId) external onlyOwner {
        Cheque[] storage payeeCheques = cheques[payee];
        if (chequeId >= payeeCheques.length) revert InvalidChequeId();
        Cheque storage cheque = payeeCheques[chequeId];
        if (cheque.status != uint8(ChequeStatus.Pending)) revert ChequeNotPending();

        cheque.status = uint8(ChequeStatus.Cancelled);
        allocatedBalance -= cheque.amount;

        emit ChequeCancelled(payee, chequeId);
    }

    // ── Payee Functions ─────────────────────────────────────────────────

    function executeCheque(uint256 chequeId) external {
        Cheque[] storage payeeCheques = cheques[msg.sender];
        if (chequeId >= payeeCheques.length) revert InvalidChequeId();
        Cheque storage cheque = payeeCheques[chequeId];
        if (cheque.status != uint8(ChequeStatus.Pending)) revert ChequeNotPending();

        cheque.status = uint8(ChequeStatus.Executed);
        allocatedBalance -= cheque.amount;

        emit ChequeExecuted(msg.sender, chequeId);

        USDC.safeTransfer(msg.sender, cheque.amount);
    }

    // ── View Functions ──────────────────────────────────────────────────

    function getCheque(address payee, uint256 chequeId) external view returns (Cheque memory) {
        if (chequeId >= cheques[payee].length) revert InvalidChequeId();
        return cheques[payee][chequeId];
    }

    function getCheques(address payee) external view returns (Cheque[] memory) {
        return cheques[payee];
    }

    function getChequeCount(address payee) external view returns (uint256) {
        return cheques[payee].length;
    }
}
