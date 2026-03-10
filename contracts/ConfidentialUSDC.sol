// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984} from "./vendor/token/ERC7984/ERC7984.sol";
import {ERC7984ERC20Wrapper} from "./vendor/token/ERC7984/extensions/ERC7984ERC20Wrapper.sol";

/// @title ConfidentialUSDC
/// @notice A confidential wrapper for USDC using the ERC7984 standard backed by
///         the OpenZeppelin ERC7984ERC20Wrapper implementation.
///
///         Wrapping:  wrap(address to, uint256 amount) — pull USDC, mint cUSDC to `to`
///         Unwrapping (two-step, trustless via Zama FHE coprocessor):
///           1. unwrap(from, to, encAmount, inputProof) — burn cUSDC, mark handle for decryption
///           2. finalizeUnwrap(handle, clearAmount, decryptionProof) — verify KMS proof, release USDC
///
/// @dev On Sepolia: after unwrap() is mined, query https://relayer.testnet.zama.org to obtain
///      clearAmount + decryptionProof, then call finalizeUnwrap(). Anyone may call finalizeUnwrap.
///      On Hardhat: use hre.fhevm.publicDecrypt([handle]) to simulate the relayer in tests.
///
///      Since USDC has 6 decimals and _maxDecimals() returns 6, the rate is 1:1 with no scaling.
contract ConfidentialUSDC is ZamaEthereumConfig, ERC7984ERC20Wrapper {
    constructor(address usdc)
        ERC7984("Confidential USDC", "cUSDC", "")
        ERC7984ERC20Wrapper(IERC20(usdc))
    {}
}
