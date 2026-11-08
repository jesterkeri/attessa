// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {P384Verifier} from "nitro-validator/P384Verifier.sol";
import {IP384Verifier} from "nitro-validator/IP384Verifier.sol";
import {CertManager} from "nitro-validator/CertManager.sol";
import {ICertManager} from "nitro-validator/ICertManager.sol";
import {NitroValidator} from "nitro-validator/NitroValidator.sol";
import {CertManagerDemo} from "../../lib/nitro-validator/test/helpers/CertManagerDemo.sol";
import {EnclaveRegistry} from "../../src/EnclaveRegistry.sol";
import {DeployRegistry} from "../../script/DeployRegistry.s.sol";
import {ValidatorStackDeployer, RegistryDeployer} from "../../script/DeployBase.sol";

/// Answers NitroValidator's two getters with a genuine stack, and nothing else: the look-alike from
/// T10 Codex r1 M2. A registry embedding it would trust whatever it returns.
contract LookAlikeValidator {
    ICertManager public immutable certManager;
    IP384Verifier public immutable p384Verifier;

    constructor(ICertManager c, IP384Verifier p) {
        certManager = c;
        p384Verifier = p;
    }
}

/// P384Verifier's interface, accepting every signature.
contract AcceptAllP384 is IP384Verifier {
    function verifyP384SignatureWithHints(bytes memory, bytes memory, bytes memory, bytes memory)
        external
        pure
        returns (bool)
    {
        return true;
    }
}

contract DeployRegistryHarness is DeployRegistry {
    function runWith(address validator) external returns (EnclaveRegistry) {
        return _run(validator);
    }

    function registriesForTest() external view returns (address, address) {
        return _registries();
    }
}

/// SPEC §3.5 / ADR-002: DeployRegistry refuses, before any broadcast, a validator that is not the
/// production stack. Chain id and the two pinned registries are faked so the script runs in-process.
contract DeployRegistryTest is Test, ValidatorStackDeployer, RegistryDeployer {
    address internal constant ADMIN = address(0xA11CE);
    DeployRegistryHarness internal script;
    ValidatorStack internal genuine;

    function setUp() public {
        vm.chainId(CELO_SEPOLIA);
        vm.etch(SEPOLIA_IDENTITY, hex"00");
        vm.etch(SEPOLIA_SELF, hex"00");
        genuine = _deployValidatorStack(ADMIN);
        script = new DeployRegistryHarness();
    }

    function test_productionStack_deploysRegistry() public {
        EnclaveRegistry registry = script.runWith(address(genuine.nitroValidator));
        assertEq(registry.nitroValidator(), address(genuine.nitroValidator));
        assertEq(registry.identityRegistry(), SEPOLIA_IDENTITY);
        assertEq(registry.selfRegistry(), SEPOLIA_SELF);
        assertFalse(registry.allowLocalOrigins());
    }

    /// Codex r1 M2's reproduction, through the env var and run() as Joshua would run it.
    function test_lookAlikeValidator_refused_viaEnv() public {
        address impostor = address(new LookAlikeValidator(genuine.certManager, genuine.p384Verifier));
        vm.setEnv("ATTESSA_NITRO_VALIDATOR", vm.toString(impostor));
        DeployRegistry plain = new DeployRegistry();
        vm.expectRevert(bytes("ATTESSA_NITRO_VALIDATOR is not the production NitroValidator"));
        plain.run();
    }

    function test_genuineValidatorOverDemoCertManager_refused() public {
        CertManagerDemo demo = new CertManagerDemo(genuine.p384Verifier, 365 days);
        NitroValidator v = new NitroValidator(demo, genuine.p384Verifier);
        vm.expectRevert(
            bytes("validator's CertManager is not the production CertManager over the validator's P384Verifier")
        );
        script.runWith(address(v));
    }

    /// The validator's P384Verifier immutable is not the one its CertManager uses.
    function test_validatorWithForeignP384_refused() public {
        NitroValidator v = new NitroValidator(genuine.certManager, new AcceptAllP384());
        vm.expectRevert(
            bytes("validator's CertManager is not the production CertManager over the validator's P384Verifier")
        );
        script.runWith(address(v));
    }

    /// Genuine CertManager and NitroValidator code, consistently wired to an accept-all verifier.
    function test_genuineStackOverAcceptAllP384_refused() public {
        IP384Verifier fake = new AcceptAllP384();
        CertManager c = new CertManager(fake, ADMIN, ADMIN);
        NitroValidator v = new NitroValidator(c, fake);
        vm.expectRevert(bytes("validator's P384Verifier is not the production P384Verifier"));
        script.runWith(address(v));
    }

    function test_noCode_refused() public {
        vm.expectRevert(bytes("ATTESSA_NITRO_VALIDATOR has no code"));
        script.runWith(address(0xBEEF));
    }

    function test_mainnetAddresses_pinned() public pure {
        assertEq(MAINNET_IDENTITY, 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432);
        assertEq(MAINNET_SELF, 0xaC3DF9ABf80d0F5c020C06B04Cced27763355944);
        assertEq(CELO_MAINNET, 42220);
    }

    /// On 42220 the registry embeds the mainnet identity and Self registries, not the Sepolia pair.
    function test_mainnet_usesMainnetRegistries() public {
        vm.chainId(CELO_MAINNET);
        vm.etch(MAINNET_IDENTITY, hex"00");
        vm.etch(MAINNET_SELF, hex"00");
        EnclaveRegistry registry = script.runWith(address(genuine.nitroValidator));
        assertEq(registry.identityRegistry(), MAINNET_IDENTITY);
        assertEq(registry.selfRegistry(), MAINNET_SELF);
        assertEq(registry.nitroValidator(), address(genuine.nitroValidator));
        assertFalse(registry.allowLocalOrigins());
    }

    /// Mainnet registries without code: refused before any broadcast.
    function test_mainnet_registriesWithoutCode_refused() public {
        vm.chainId(CELO_MAINNET);
        vm.expectRevert(bytes("ERC-8004 identity registry has no code on this chain"));
        script.runWith(address(genuine.nitroValidator));
    }

    /// Mainnet never takes a CertManagerDemo-backed validator.
    function test_mainnet_demoCertManager_refused() public {
        vm.chainId(CELO_MAINNET);
        vm.etch(MAINNET_IDENTITY, hex"00");
        vm.etch(MAINNET_SELF, hex"00");
        CertManagerDemo demo = new CertManagerDemo(genuine.p384Verifier, 365 days);
        NitroValidator v = new NitroValidator(demo, genuine.p384Verifier);
        vm.expectRevert(
            bytes("validator's CertManager is not the production CertManager over the validator's P384Verifier")
        );
        script.runWith(address(v));
    }

    /// The Sepolia pair is not accepted on mainnet or vice versa: the pair follows block.chainid.
    function test_sepolia_stillUsesSepoliaRegistries() public {
        (address id, address self) = script.registriesForTest();
        assertEq(id, SEPOLIA_IDENTITY);
        assertEq(self, SEPOLIA_SELF);
        vm.chainId(CELO_MAINNET);
        (id, self) = script.registriesForTest();
        assertEq(id, MAINNET_IDENTITY);
        assertEq(self, MAINNET_SELF);
    }

    function _expectOtherChainRefused(uint256 id) internal {
        vm.chainId(id);
        vm.expectRevert(bytes("Celo mainnet (42220) or Celo Sepolia (11142220) only"));
        script.runWith(address(genuine.nitroValidator));
    }

    function test_otherChains_refused() public {
        _expectOtherChainRefused(1);
        _expectOtherChainRefused(44787); // Alfajores
        _expectOtherChainRefused(31337);
        _expectOtherChainRefused(0 + 42221);
    }

    function test_otherChain_registriesRevert() public {
        vm.chainId(1);
        vm.expectRevert(bytes("Celo mainnet (42220) or Celo Sepolia (11142220) only"));
        script.registriesForTest();
    }
}
