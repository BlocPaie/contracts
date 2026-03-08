// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";

/// @notice Minimal ERC-7984 interface — only the functions ConfidentialVault needs.
interface IERC7984 {
    function confidentialBalanceOf(address account) external view returns (euint64);

    function confidentialTransfer(address to, euint64 amount) external returns (euint64 transferred);

    function confidentialTransferFrom(
        address from,
        address to,
        euint64 amount
    ) external returns (euint64 transferred);
}
