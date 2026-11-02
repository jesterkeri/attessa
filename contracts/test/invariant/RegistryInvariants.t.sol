// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {EnclaveRegistry, IEnclaveRegistry} from "../../src/EnclaveRegistry.sol";
import {MockNitroValidator, MockIdentityRegistry, MockSelfRegistry} from "../mocks/Mocks.sol";
import {RegistryHandler} from "./RegistryHandler.sol";

/// INVARIANTS.md INV-1 to INV-8 and INV-24 for EnclaveRegistry, fuzzed through RegistryHandler.
contract RegistryInvariants is Test {
    EnclaveRegistry internal registry;
    RegistryHandler internal handler;
    MockSelfRegistry internal selfReg;

    function setUp() public {
        vm.warp(1_800_000_000);
        MockIdentityRegistry identity = new MockIdentityRegistry();
        MockNitroValidator nitro = new MockNitroValidator();
        selfReg = new MockSelfRegistry();
        registry = new EnclaveRegistry(address(identity), address(nitro), address(selfReg), false);
        handler = new RegistryHandler(registry, nitro, identity);
        identity.setOwner(1, handler.owner());
        identity.setOwner(2, handler.owner());
        identity.setOwner(3, handler.stranger());
        selfReg.set(7, handler.owner(), true, true);
        selfReg.set(8, handler.stranger(), true, true);

        // Baseline through the handler (so the model tracks it): release 0 approved for agent 1,
        // origin 0 Active for agent 1 run by `operator`, and key 0 registered there.
        handler.approveRelease(0, 0, 0);
        handler.addEndpoint(0, 0, 0, 0, 0);
        handler.registerSigner(1, 0, 0, 0, 0, 2000, 0);
        require(handler.registered() == 1 && handler.mismatches() == 0, "baseline");

        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = RegistryHandler.approveRelease.selector;
        selectors[1] = RegistryHandler.setReleaseStatus.selector;
        selectors[2] = RegistryHandler.addEndpoint.selector;
        selectors[3] = RegistryHandler.retireEndpoint.selector;
        selectors[4] = RegistryHandler.revokeSigner.selector;
        selectors[5] = RegistryHandler.linkSelfAgent.selector;
        selectors[6] = RegistryHandler.registerSigner.selector;
        selectors[7] = RegistryHandler.renewSigner.selector;
        selectors[8] = RegistryHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// Every call's success or exact revert matched the SPEC §3.4 reference model.
    function invariant_modelAgreesOnEveryCall() public view {
        assertEq(handler.mismatches(), 0, handler.lastMismatch());
    }

    /// INV-1: a signer exists only via registerSigner, and equals address(keccak(public_key[1:])).
    function invariant_INV1_signerOnlyFromValidatedAttestation() public view {
        assertEq(handler.inv1Violations(), 0);
        for (uint8 k = 0; k < 4; k++) {
            IEnclaveRegistry.Signer memory s = registry.signers(handler.keyAddr(k));
            assertEq(uint8(s.status), handler.gSigner(k).status, "signer status differs from model");
        }
        address[3] memory others = [handler.owner(), handler.operator(), handler.stranger()];
        for (uint256 i = 0; i < 3; i++) {
            assertEq(uint8(registry.signers(others[i]).status), 0, "non-enclave address became a signer");
        }
    }

    /// INV-2: releaseId is the attestation's PCRs, Approved for the agent when registered.
    function invariant_INV2_releaseApprovedAtRegistration() public view {
        assertEq(handler.inv2Violations(), 0);
        for (uint8 k = 0; k < 4; k++) {
            RegistryHandler.GSigner memory g = handler.gSigner(k);
            if (g.status == 0) continue;
            assertEq(registry.signers(handler.keyAddr(k)).releaseId, handler.releaseIds(g.rIdx));
        }
    }

    /// INV-3: no zero PCR, no ts outside [now - 1800, now + 60], and no underflow (model agreement).
    function invariant_INV3_freshNonDebugAttestation() public view {
        assertEq(handler.inv3Violations(), 0);
    }

    /// INV-4: user_data was exactly the 160-byte binding.
    function invariant_INV4_exactBinding() public view {
        assertEq(handler.inv4Violations(), 0);
    }

    /// INV-5: only ownerOf(agentId) changes agent state; only the endpoint operator registers.
    function invariant_INV5_onlyOwnerAndOperator() public view {
        assertEq(handler.unauthorized(), 0);
        for (uint256 agent = 1; agent <= 3; agent++) {
            assertEq(registry.selfLinks(agent), handler.gSelfLink(agent));
        }
    }

    /// INV-6: one record per origin; while Active its agentId, payTo, operator don't change.
    function invariant_INV6_activeEndpointImmutable() public view {
        for (uint8 o = 0; o < 2; o++) {
            IEnclaveRegistry.Endpoint memory e = registry.endpoints(handler.originHashes(o));
            RegistryHandler.GEndpoint memory g = handler.gEndpoint(o);
            assertEq(uint8(e.status), g.status);
            if (g.status == 1) {
                assertEq(e.agentId, g.agentId);
                assertEq(e.payTo, g.payTo);
                assertEq(e.operator, g.operator);
            }
        }
    }

    /// INV-7: Revoked releases and signers stay Revoked.
    function invariant_INV7_revokedIsTerminal() public view {
        for (uint256 agent = 1; agent <= 3; agent++) {
            for (uint8 r = 0; r < 3; r++) {
                if (handler.gReleaseEverRevoked(agent, r)) {
                    assertEq(
                        uint8(registry.releases(agent, handler.releaseIds(r)).status),
                        uint8(IEnclaveRegistry.ReleaseStatus.Revoked)
                    );
                }
                assertEq(uint8(registry.releases(agent, handler.releaseIds(r)).status), handler.gRelease(agent, r));
            }
        }
        for (uint8 k = 0; k < 4; k++) {
            if (handler.gSigner(k).everRevoked) {
                assertEq(
                    uint8(registry.signers(handler.keyAddr(k)).status), uint8(IEnclaveRegistry.SignerStatus.Revoked)
                );
            }
        }
    }

    /// INV-24: after registration only expiresAt and attestationHash ever change.
    function invariant_INV24_renewChangesOnlyExpiryAndHash() public view {
        assertEq(handler.inv24Violations(), 0);
        for (uint8 k = 0; k < 4; k++) {
            RegistryHandler.GSigner memory g = handler.gSigner(k);
            if (g.status == 0) continue;
            IEnclaveRegistry.Signer memory s = registry.signers(handler.keyAddr(k));
            assertEq(s.agentId, g.agentId);
            assertEq(s.releaseId, handler.releaseIds(g.rIdx));
            assertEq(s.originHash, handler.originHashes(g.oIdx));
            assertEq(s.operator, g.operator);
            assertEq(s.registeredAt, g.registeredAt);
            assertEq(s.expiresAt, g.expiresAt);
        }
    }

    /// INV-8: checkSigner equals the reference model (including the operator match) for every
    /// signer and origin, so OK holds exactly when the model's conjunction holds.
    function invariant_INV8_checkSignerMatchesModel() public view {
        bytes32[3] memory origins = [handler.originHashes(0), handler.originHashes(1), handler.UNKNOWN_ORIGIN()];
        for (uint8 k = 0; k < 4; k++) {
            for (uint256 o = 0; o < 3; o++) {
                (IEnclaveRegistry.Check code,,) = registry.checkSigner(handler.keyAddr(k), origins[o]);
                assertEq(uint8(code), uint8(handler.modelCheck(k, origins[o])), "checkSigner differs from model");
            }
        }
    }
}
