// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Escrow} from "../src/Escrow.sol";
import {Stake} from "../src/Stake.sol";
import {Insurance} from "../src/Insurance.sol";
import {PredictionMarket} from "../src/PredictionMarket.sol";
import {AttestationVerifier} from "../src/AttestationVerifier.sol";
import {MeritJob} from "../src/MeritJob.sol";
import {MeritVerificationHook} from "../src/MeritVerificationHook.sol";
import {MockUSDC} from "../test/MockUSDC.sol";

/// Deploy Escrow to Arc testnet (user-gated — needs a funded key + the live USDC address):
///   forge script script/Deploy.s.sol:DeployEscrow --rpc-url arc_testnet --broadcast --private-key $KEY
/// USDC defaults to Arc's deployed token at 0x3600...0000.
contract DeployEscrow is Script {
    function run() external {
        address usdc = vm.envOr("USDC_ADDRESS", address(0x3600000000000000000000000000000000000000));
        vm.startBroadcast();
        Escrow escrow = new Escrow(usdc);
        vm.stopBroadcast();
        console2.log("Escrow deployed at:", address(escrow));
        console2.log("USDC:", usdc);
    }
}

/// forge script script/Deploy.s.sol:DeployStake --rpc-url arc_testnet --broadcast --private-key $KEY
contract DeployStake is Script {
    function run() external {
        address usdc = vm.envOr("USDC_ADDRESS", address(0x3600000000000000000000000000000000000000));
        address slasher = vm.envAddress("OPERATOR_ADDRESS"); // the Auditor/operator who can slash
        address treasury = vm.envOr("TREASURY_ADDRESS", slasher);
        uint256 cooldown = vm.envOr("STAKE_COOLDOWN", uint256(7 days));
        vm.startBroadcast();
        Stake s = new Stake(usdc, slasher, treasury, cooldown);
        vm.stopBroadcast();
        console2.log("Stake deployed at:", address(s));
    }
}

/// forge script script/Deploy.s.sol:DeployInsurance --rpc-url arc_testnet --broadcast --private-key $KEY
contract DeployInsurance is Script {
    function run() external {
        address usdc = vm.envOr("USDC_ADDRESS", address(0x3600000000000000000000000000000000000000));
        address arbiter = vm.envAddress("OPERATOR_ADDRESS"); // Merit's dispute resolver
        vm.startBroadcast();
        Insurance ins = new Insurance(usdc, arbiter);
        vm.stopBroadcast();
        console2.log("Insurance deployed at:", address(ins));
    }
}

/// forge script script/Deploy.s.sol:DeployMarket --rpc-url arc_testnet --broadcast --private-key $KEY
contract DeployMarket is Script {
    function run() external {
        address usdc = vm.envOr("USDC_ADDRESS", address(0x3600000000000000000000000000000000000000));
        address oracle = vm.envAddress("OPERATOR_ADDRESS"); // resolves markets from the appeal outcome
        vm.startBroadcast();
        PredictionMarket pm = new PredictionMarket(usdc, oracle);
        vm.stopBroadcast();
        console2.log("PredictionMarket deployed at:", address(pm));
    }
}

/// forge script script/Deploy.s.sol:DeployAttestationVerifier --rpc-url arc_testnet --broadcast --private-key $KEY
contract DeployAttestationVerifier is Script {
    function run() external {
        address auditor = vm.envAddress("BUYER_ADDRESS"); // the Auditor (BUYER) wallet that signs attestations
        vm.startBroadcast();
        AttestationVerifier av = new AttestationVerifier(auditor);
        vm.stopBroadcast();
        console2.log("AttestationVerifier deployed at:", address(av));
    }
}

/// forge script script/Deploy.s.sol:DeployMeritVerificationHook --rpc-url arc_testnet --broadcast --private-key $KEY
contract DeployMeritVerificationHook is Script {
    function run() external {
        address validator = vm.envOr("OPERATOR_ADDRESS", msg.sender); // Merit's Auditor operator (records verdicts)
        vm.startBroadcast();
        MeritVerificationHook hook = new MeritVerificationHook(validator);
        vm.stopBroadcast();
        console2.log("MeritVerificationHook deployed at:", address(hook));
    }
}

/// forge script script/Deploy.s.sol:DeployMeritJob --rpc-url arc_testnet --broadcast --private-key $KEY
contract DeployMeritJob is Script {
    function run() external {
        address usdc = vm.envOr("USDC_ADDRESS", address(0x3600000000000000000000000000000000000000));
        vm.startBroadcast();
        MeritJob job = new MeritJob(usdc);
        vm.stopBroadcast();
        console2.log("MeritJob deployed at:", address(job));
    }
}

/// One-shot deploy of the whole Merit contract suite. Logs every address (parsed by scripts/deploy-local.mjs
/// into deployments.json). Self-contained for a LOCAL smoke: set DEPLOY_MOCK_USDC=true to deploy a MockUSDC
/// first; otherwise USDC defaults to Arc's deployed token. Roles default to the deployer when unset.
///   Local smoke:  DEPLOY_MOCK_USDC=true forge script script/Deploy.s.sol:DeployAll
///   Testnet:      forge script script/Deploy.s.sol:DeployAll --rpc-url arc_testnet --broadcast --private-key $KEY
contract DeployAll is Script {
    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address deployer = pk != 0 ? vm.addr(pk) : msg.sender;
        address operator = vm.envOr("OPERATOR_ADDRESS", deployer); // slasher / arbiter / oracle / verdict-recorder
        address auditor = vm.envOr("BUYER_ADDRESS", deployer); // signs attestations
        address treasury = vm.envOr("TREASURY_ADDRESS", operator);
        uint256 cooldown = vm.envOr("STAKE_COOLDOWN", uint256(7 days));
        bool mockUsdc = vm.envOr("DEPLOY_MOCK_USDC", false);
        address usdc = vm.envOr("USDC_ADDRESS", address(0x3600000000000000000000000000000000000000));

        if (pk != 0) vm.startBroadcast(pk);
        else vm.startBroadcast();

        if (mockUsdc) {
            usdc = address(new MockUSDC());
            console2.log("MockUSDC:", usdc);
        }
        Escrow escrow = new Escrow(usdc);
        Stake stake = new Stake(usdc, operator, treasury, cooldown);
        Insurance ins = new Insurance(usdc, operator);
        PredictionMarket pm = new PredictionMarket(usdc, operator);
        AttestationVerifier av = new AttestationVerifier(auditor);
        MeritVerificationHook hook = new MeritVerificationHook(operator);
        MeritJob job = new MeritJob(usdc);

        vm.stopBroadcast();

        console2.log("USDC:", usdc);
        console2.log("Escrow:", address(escrow));
        console2.log("Stake:", address(stake));
        console2.log("Insurance:", address(ins));
        console2.log("PredictionMarket:", address(pm));
        console2.log("AttestationVerifier:", address(av));
        console2.log("MeritVerificationHook:", address(hook));
        console2.log("MeritJob:", address(job));
    }
}
