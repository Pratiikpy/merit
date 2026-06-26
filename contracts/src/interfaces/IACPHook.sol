// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal ERC-165 — the subset MeritJob/MeritVerificationHook need.
interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @title IACPHook — the ERC-8183 (Agentic Commerce) lifecycle hook.
/// @notice An ERC-8183 job calls `beforeAction` / `afterAction` around each hookable lifecycle transition
/// (fund, submit, complete, reject), passing the function `selector` and ABI-encoded `data`. A hook observes
/// a transition, and may GATE it by reverting in `beforeAction`. Merit ships {MeritVerificationHook}, which
/// gates `complete` (the escrow release) on a recorded proof-of-citation verdict — so any ERC-8183 job that
/// names it inherits verification-native settlement without trusting the counterparty.
interface IACPHook is IERC165 {
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;

    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}
