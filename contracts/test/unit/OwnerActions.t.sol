// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EnclaveRegistry, IEnclaveRegistry} from "../../src/EnclaveRegistry.sol";
import {RegistryBase} from "../utils/RegistryBase.sol";

/// SPEC §3.4: linkSelfAgent, approveRelease, setReleaseStatus, addEndpoint, retireEndpoint, revokeSigner.
contract OwnerActionsTest is RegistryBase {
    uint256 internal constant SELF_ID = 77;

    // ------------------------------------------------------------ constants

    function test_constantsAndConstructor() public view {
        assertEq(registry.SIGNER_TTL(), 604800);
        assertEq(registry.MAX_ATTESTATION_AGE(), 1800);
        assertEq(registry.MAX_FUTURE_SKEW(), 60);
        assertEq(registry.MAX_PROOF_SKEW(), 120);
        assertEq(registry.BINDING_TYPEHASH(), keccak256("AttestedExecution.SignerBinding.v1"));
        assertEq(registry.identityRegistry(), address(identity));
        assertEq(registry.nitroValidator(), address(nitro));
        assertEq(registry.selfRegistry(), address(selfReg));
        assertFalse(registry.allowLocalOrigins());
    }

    // ------------------------------------------------------- linkSelfAgent

    function test_linkSelfAgent_storesAndEmits() public {
        selfReg.set(SELF_ID, owner, true, true);
        vm.expectEmit(address(registry));
        emit IEnclaveRegistry.SelfAgentLinked(AGENT, SELF_ID, owner);
        vm.prank(owner);
        registry.linkSelfAgent(AGENT, SELF_ID);
        assertEq(registry.selfLinks(AGENT), SELF_ID);
    }

    function test_linkSelfAgent_NotOwner() public {
        selfReg.set(SELF_ID, stranger, true, true);
        vm.prank(stranger);
        vm.expectRevert(EnclaveRegistry.NotOwner.selector);
        registry.linkSelfAgent(AGENT, SELF_ID);
    }

    function test_linkSelfAgent_SelfDisabled() public {
        EnclaveRegistry noSelf = new EnclaveRegistry(address(identity), address(nitro), address(0), false);
        vm.prank(owner);
        vm.expectRevert(EnclaveRegistry.SelfDisabled.selector);
        noSelf.linkSelfAgent(AGENT, SELF_ID);
    }

    function test_linkSelfAgent_SelfLinkInvalid_otherSelfOwner() public {
        selfReg.set(SELF_ID, stranger, true, true);
        _expectSelfLinkInvalid();
    }

    function test_linkSelfAgent_SelfLinkInvalid_noHumanProof() public {
        selfReg.set(SELF_ID, owner, false, true);
        _expectSelfLinkInvalid();
    }

    function test_linkSelfAgent_SelfLinkInvalid_staleProof() public {
        selfReg.set(SELF_ID, owner, true, false);
        _expectSelfLinkInvalid();
    }

    function test_linkSelfAgent_SelfLinkInvalid_ownerOfReverts() public {
        selfReg.set(SELF_ID, owner, true, true);
        selfReg.setReverts(true, false, false);
        _expectSelfLinkInvalid();
    }

    function test_linkSelfAgent_SelfLinkInvalid_hasHumanProofReverts() public {
        selfReg.set(SELF_ID, owner, true, true);
        selfReg.setReverts(false, true, false);
        _expectSelfLinkInvalid();
    }

    function test_linkSelfAgent_SelfLinkInvalid_isProofFreshReverts() public {
        selfReg.set(SELF_ID, owner, true, true);
        selfReg.setReverts(false, false, true);
        _expectSelfLinkInvalid();
    }

    function _expectSelfLinkInvalid() internal {
        vm.prank(owner);
        vm.expectRevert(EnclaveRegistry.SelfLinkInvalid.selector);
        registry.linkSelfAgent(AGENT, SELF_ID);
        assertEq(registry.selfLinks(AGENT), 0);
    }

    // ------------------------------------------------------------ ownerOf

    /// A burned agent token makes ownerOf revert; every owner function maps that to NotOwner.
    function test_ownerOfRevert_NotOwner_everyOwnerFunction() public {
        address signer = _register();
        identity.setOwner(AGENT, address(0));
        vm.startPrank(owner);
        vm.expectRevert(EnclaveRegistry.NotOwner.selector);
        registry.linkSelfAgent(AGENT, SELF_ID);
        vm.expectRevert(EnclaveRegistry.NotOwner.selector);
        registry.approveRelease(AGENT, pcr0, pcr1, _fill(0x44, 48), SOURCE_REF);
        vm.expectRevert(EnclaveRegistry.NotOwner.selector);
        registry.setReleaseStatus(AGENT, releaseId, IEnclaveRegistry.ReleaseStatus.Deprecated);
        vm.expectRevert(EnclaveRegistry.NotOwner.selector);
        registry.addEndpoint(AGENT, ORIGIN_B, payTo, operator);
        vm.expectRevert(EnclaveRegistry.NotOwner.selector);
        registry.retireEndpoint(originHash);
        vm.expectRevert(EnclaveRegistry.NotOwner.selector);
        registry.revokeSigner(signer);
        vm.stopPrank();
    }

    /// Ownership is read at call time: a new owner gains control, the old one loses it.
    function test_ownerReadAtCallTime() public {
        identity.setOwner(AGENT, stranger);
        vm.prank(owner);
        vm.expectRevert(EnclaveRegistry.NotOwner.selector);
        registry.setReleaseStatus(AGENT, releaseId, IEnclaveRegistry.ReleaseStatus.Deprecated);
        vm.prank(stranger);
        registry.setReleaseStatus(AGENT, releaseId, IEnclaveRegistry.ReleaseStatus.Deprecated);
    }

    // ------------------------------------------------------- approveRelease

    function test_approveRelease_storesAndEmits() public {
        bytes memory p2 = _fill(0x44, 48);
        bytes32 expectedId = keccak256(abi.encodePacked(pcr0, pcr1, p2));
        vm.warp(START + 5);
        vm.expectEmit(address(registry));
        emit IEnclaveRegistry.ReleaseApproved(AGENT, expectedId, pcr0, pcr1, p2, SOURCE_REF);
        vm.prank(owner);
        bytes32 id = registry.approveRelease(AGENT, pcr0, pcr1, p2, SOURCE_REF);
        assertEq(id, expectedId);
        IEnclaveRegistry.Release memory r = registry.releases(AGENT, id);
        assertEq(uint8(r.status), uint8(IEnclaveRegistry.ReleaseStatus.Approved));
        assertEq(r.approvedAt, START + 5);
        assertEq(r.statusChangedAt, START + 5);
        // Approval is per agent.
        assertEq(uint8(registry.releases(AGENT2, id).status), uint8(IEnclaveRegistry.ReleaseStatus.None));
    }

    function test_approveRelease_NotOwner() public {
        address[2] memory callers = [operator, stranger];
        for (uint256 i = 0; i < 2; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(EnclaveRegistry.NotOwner.selector);
            registry.approveRelease(AGENT, pcr0, pcr1, _fill(0x44, 48), SOURCE_REF);
        }
    }

    function test_approveRelease_InvalidPcr_length() public {
        bytes[4] memory bad = [_fill(0x11, 47), _fill(0x11, 49), _fill(0x11, 32), bytes("")];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.startPrank(owner);
            vm.expectRevert(EnclaveRegistry.InvalidPcr.selector);
            registry.approveRelease(AGENT, bad[i], pcr1, pcr2, SOURCE_REF);
            vm.expectRevert(EnclaveRegistry.InvalidPcr.selector);
            registry.approveRelease(AGENT, pcr0, bad[i], pcr2, SOURCE_REF);
            vm.expectRevert(EnclaveRegistry.InvalidPcr.selector);
            registry.approveRelease(AGENT, pcr0, pcr1, bad[i], SOURCE_REF);
            vm.stopPrank();
        }
    }

    function test_approveRelease_InvalidPcr_allZero() public {
        bytes memory zero = new bytes(48);
        vm.startPrank(owner);
        vm.expectRevert(EnclaveRegistry.InvalidPcr.selector);
        registry.approveRelease(AGENT, zero, pcr1, pcr2, SOURCE_REF);
        vm.expectRevert(EnclaveRegistry.InvalidPcr.selector);
        registry.approveRelease(AGENT, pcr0, zero, pcr2, SOURCE_REF);
        vm.expectRevert(EnclaveRegistry.InvalidPcr.selector);
        registry.approveRelease(AGENT, pcr0, pcr1, zero, SOURCE_REF);
        vm.stopPrank();
    }

    function test_approveRelease_InvalidSourceRef() public {
        vm.startPrank(owner);
        vm.expectRevert(EnclaveRegistry.InvalidSourceRef.selector);
        registry.approveRelease(AGENT, pcr0, pcr1, _fill(0x44, 48), "");
        vm.expectRevert(EnclaveRegistry.InvalidSourceRef.selector);
        registry.approveRelease(AGENT, pcr0, pcr1, _fill(0x44, 48), string(_fill("a", 257)));
        // 1 and 256 bytes are accepted.
        registry.approveRelease(AGENT, pcr0, pcr1, _fill(0x44, 48), "a");
        registry.approveRelease(AGENT, pcr0, pcr1, _fill(0x55, 48), string(_fill("a", 256)));
        vm.stopPrank();
    }

    function test_approveRelease_ReleaseExists() public {
        vm.prank(owner);
        vm.expectRevert(EnclaveRegistry.ReleaseExists.selector);
        registry.approveRelease(AGENT, pcr0, pcr1, pcr2, "other");
    }

    /// Revoked is terminal: re-approving the same PCRs is ReleaseExists.
    function test_approveRelease_ReleaseExists_afterRevoke() public {
        vm.startPrank(owner);
        registry.setReleaseStatus(AGENT, releaseId, IEnclaveRegistry.ReleaseStatus.Revoked);
        vm.expectRevert(EnclaveRegistry.ReleaseExists.selector);
        registry.approveRelease(AGENT, pcr0, pcr1, pcr2, SOURCE_REF);
        vm.stopPrank();
    }

    // ----------------------------------------------------- setReleaseStatus

    IEnclaveRegistry.ReleaseStatus internal constant NONE = IEnclaveRegistry.ReleaseStatus.None;
    IEnclaveRegistry.ReleaseStatus internal constant APPROVED = IEnclaveRegistry.ReleaseStatus.Approved;
    IEnclaveRegistry.ReleaseStatus internal constant DEPRECATED = IEnclaveRegistry.ReleaseStatus.Deprecated;
    IEnclaveRegistry.ReleaseStatus internal constant REVOKED = IEnclaveRegistry.ReleaseStatus.Revoked;

    /// Puts the release in `from`; for None returns an id that was never approved.
    function _releaseIn(IEnclaveRegistry.ReleaseStatus from) internal returns (bytes32 id) {
        if (from == NONE) return keccak256("never approved");
        id = releaseId;
        vm.startPrank(owner);
        if (from == DEPRECATED) registry.setReleaseStatus(AGENT, id, DEPRECATED);
        if (from == REVOKED) registry.setReleaseStatus(AGENT, id, REVOKED);
        vm.stopPrank();
    }

    function _allowed(IEnclaveRegistry.ReleaseStatus from, IEnclaveRegistry.ReleaseStatus to) internal {
        bytes32 id = _releaseIn(from);
        vm.warp(block.timestamp + 10);
        vm.expectEmit(address(registry));
        emit IEnclaveRegistry.ReleaseStatusChanged(AGENT, id, from, to);
        vm.prank(owner);
        registry.setReleaseStatus(AGENT, id, to);
        IEnclaveRegistry.Release memory r = registry.releases(AGENT, id);
        assertEq(uint8(r.status), uint8(to));
        assertEq(r.statusChangedAt, block.timestamp);
        assertEq(r.approvedAt, START);
    }

    function _forbidden(IEnclaveRegistry.ReleaseStatus from, IEnclaveRegistry.ReleaseStatus to) internal {
        bytes32 id = _releaseIn(from);
        vm.prank(owner);
        vm.expectRevert(EnclaveRegistry.InvalidTransition.selector);
        registry.setReleaseStatus(AGENT, id, to);
        assertEq(uint8(registry.releases(AGENT, id).status), uint8(from));
    }

    function test_release_Approved_to_Deprecated() public {
        _allowed(APPROVED, DEPRECATED);
    }

    function test_release_Approved_to_Revoked() public {
        _allowed(APPROVED, REVOKED);
    }

    function test_release_Deprecated_to_Approved() public {
        _allowed(DEPRECATED, APPROVED);
    }

    function test_release_Deprecated_to_Revoked() public {
        _allowed(DEPRECATED, REVOKED);
    }

    function test_release_None_to_None_InvalidTransition() public {
        _forbidden(NONE, NONE);
    }

    function test_release_None_to_Approved_InvalidTransition() public {
        _forbidden(NONE, APPROVED);
    }

    function test_release_None_to_Deprecated_InvalidTransition() public {
        _forbidden(NONE, DEPRECATED);
    }

    function test_release_None_to_Revoked_InvalidTransition() public {
        _forbidden(NONE, REVOKED);
    }

    function test_release_Approved_to_None_InvalidTransition() public {
        _forbidden(APPROVED, NONE);
    }

    function test_release_Approved_to_Approved_InvalidTransition() public {
        _forbidden(APPROVED, APPROVED);
    }

    function test_release_Deprecated_to_None_InvalidTransition() public {
        _forbidden(DEPRECATED, NONE);
    }

    function test_release_Deprecated_to_Deprecated_InvalidTransition() public {
        _forbidden(DEPRECATED, DEPRECATED);
    }

    function test_release_Revoked_to_None_InvalidTransition() public {
        _forbidden(REVOKED, NONE);
    }

    function test_release_Revoked_to_Approved_InvalidTransition() public {
        _forbidden(REVOKED, APPROVED);
    }

    function test_release_Revoked_to_Deprecated_InvalidTransition() public {
        _forbidden(REVOKED, DEPRECATED);
    }

    function test_release_Revoked_to_Revoked_InvalidTransition() public {
        _forbidden(REVOKED, REVOKED);
    }

    function test_setReleaseStatus_NotOwner() public {
        address[2] memory callers = [operator, stranger];
        for (uint256 i = 0; i < 2; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(EnclaveRegistry.NotOwner.selector);
            registry.setReleaseStatus(AGENT, releaseId, REVOKED);
        }
    }

    /// Statuses are per agent: AGENT2's owner action can't touch AGENT's release.
    function test_setReleaseStatus_otherAgentIsSeparate() public {
        vm.prank(owner);
        vm.expectRevert(EnclaveRegistry.InvalidTransition.selector);
        registry.setReleaseStatus(AGENT2, releaseId, REVOKED);
        assertEq(uint8(registry.releases(AGENT, releaseId).status), uint8(APPROVED));
    }

    // ---------------------------------------------------------- addEndpoint

    function test_addEndpoint_storesAndEmits() public {
        bytes32 expected = keccak256(bytes(ORIGIN_B));
        vm.expectEmit(address(registry));
        emit IEnclaveRegistry.EndpointAdded(expected, AGENT, ORIGIN_B, payTo, operator2);
        vm.prank(owner);
        bytes32 h = registry.addEndpoint(AGENT, ORIGIN_B, payTo, operator2);
        assertEq(h, expected);
        IEnclaveRegistry.Endpoint memory e = registry.endpoints(h);
        assertEq(e.agentId, AGENT);
        assertEq(e.payTo, payTo);
        assertEq(e.operator, operator2);
        assertEq(uint8(e.status), uint8(IEnclaveRegistry.EndpointStatus.Active));
        assertEq(e.updatedAt, block.timestamp);
    }

    function test_addEndpoint_NotOwner() public {
        address[2] memory callers = [operator, stranger];
        for (uint256 i = 0; i < 2; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(EnclaveRegistry.NotOwner.selector);
            registry.addEndpoint(AGENT, ORIGIN_B, payTo, operator);
        }
    }

    function test_addEndpoint_InvalidOrigin() public {
        string[6] memory bad = [
            "http://seller.example",
            "https://",
            "ftp://seller.example",
            "HTTPS://seller.example",
            "http://localhost:8080",
            string(abi.encodePacked("https://", _fill("a", 260)))
        ];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.prank(owner);
            vm.expectRevert(EnclaveRegistry.InvalidOrigin.selector);
            registry.addEndpoint(AGENT, bad[i], payTo, operator);
        }
    }

    function test_addEndpoint_originLengthBounds() public {
        vm.startPrank(owner);
        registry.addEndpoint(AGENT, "https://a", payTo, operator); // 9 bytes
        registry.addEndpoint(AGENT, string(abi.encodePacked("https://", _fill("b", 259))), payTo, operator); // 267
        vm.stopPrank();
    }

    function test_addEndpoint_localOriginOnlyWhenAllowed() public {
        EnclaveRegistry local = new EnclaveRegistry(address(identity), address(nitro), address(0), true);
        vm.startPrank(owner);
        local.addEndpoint(AGENT, "http://localhost:8080", payTo, operator);
        local.addEndpoint(AGENT, "https://seller.example", payTo, operator);
        vm.expectRevert(EnclaveRegistry.InvalidOrigin.selector);
        local.addEndpoint(AGENT, "http://seller.example", payTo, operator);
        vm.stopPrank();
    }

    function test_addEndpoint_ZeroAddress() public {
        vm.startPrank(owner);
        vm.expectRevert(EnclaveRegistry.ZeroAddress.selector);
        registry.addEndpoint(AGENT, ORIGIN_B, address(0), operator);
        vm.expectRevert(EnclaveRegistry.ZeroAddress.selector);
        registry.addEndpoint(AGENT, ORIGIN_B, payTo, address(0));
        vm.stopPrank();
    }

    function test_addEndpoint_OriginTaken_sameAgent() public {
        vm.prank(owner);
        vm.expectRevert(EnclaveRegistry.OriginTaken.selector);
        registry.addEndpoint(AGENT, ORIGIN, makeAddr("payTo2"), operator2);
        IEnclaveRegistry.Endpoint memory e = registry.endpoints(originHash);
        assertEq(e.payTo, payTo);
        assertEq(e.operator, operator);
    }

    function test_addEndpoint_OriginTaken_otherAgent() public {
        identity.setOwner(3, stranger);
        vm.prank(stranger);
        vm.expectRevert(EnclaveRegistry.OriginTaken.selector);
        registry.addEndpoint(3, ORIGIN, stranger, stranger);
    }

    /// Retired → Active: a retired record is overwritten, including agentId.
    function test_addEndpoint_overwritesRetired() public {
        vm.prank(owner);
        registry.retireEndpoint(originHash);
        identity.setOwner(3, stranger);
        vm.prank(stranger);
        registry.addEndpoint(3, ORIGIN, stranger, stranger);
        IEnclaveRegistry.Endpoint memory e = registry.endpoints(originHash);
        assertEq(e.agentId, 3);
        assertEq(e.operator, stranger);
        assertEq(uint8(e.status), uint8(IEnclaveRegistry.EndpointStatus.Active));
    }

    // -------------------------------------------------------- retireEndpoint

    function test_retireEndpoint_Active_to_Retired() public {
        vm.warp(START + 9);
        vm.expectEmit(address(registry));
        emit IEnclaveRegistry.EndpointRetired(originHash, AGENT);
        vm.prank(owner);
        registry.retireEndpoint(originHash);
        IEnclaveRegistry.Endpoint memory e = registry.endpoints(originHash);
        assertEq(uint8(e.status), uint8(IEnclaveRegistry.EndpointStatus.Retired));
        assertEq(e.updatedAt, START + 9);
        assertEq(e.operator, operator);
    }

    function test_retireEndpoint_NotOwner() public {
        address[2] memory callers = [operator, stranger];
        for (uint256 i = 0; i < 2; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(EnclaveRegistry.NotOwner.selector);
            registry.retireEndpoint(originHash);
        }
    }

    function test_retireEndpoint_Retired_EndpointNotActive() public {
        vm.startPrank(owner);
        registry.retireEndpoint(originHash);
        vm.expectRevert(EnclaveRegistry.EndpointNotActive.selector);
        registry.retireEndpoint(originHash);
        vm.stopPrank();
    }

    /// An unknown origin has agentId 0, whose ownerOf reverts: NotOwner.
    function test_retireEndpoint_unknown_NotOwner() public {
        vm.prank(owner);
        vm.expectRevert(EnclaveRegistry.NotOwner.selector);
        registry.retireEndpoint(keccak256("https://nobody.example"));
    }

    // ---------------------------------------------------------- revokeSigner

    function test_revokeSigner_Active_to_Revoked() public {
        address signer = _register();
        vm.expectEmit(address(registry));
        emit IEnclaveRegistry.SignerRevoked(signer, AGENT);
        vm.prank(owner);
        registry.revokeSigner(signer);
        assertEq(uint8(registry.signers(signer).status), uint8(IEnclaveRegistry.SignerStatus.Revoked));
    }

    /// The owner can revoke an Active signer even after it expired.
    function test_revokeSigner_expiredStillRevocable() public {
        address signer = _register();
        vm.warp(START + registry.SIGNER_TTL() + 1);
        vm.prank(owner);
        registry.revokeSigner(signer);
        assertEq(uint8(registry.signers(signer).status), uint8(IEnclaveRegistry.SignerStatus.Revoked));
    }

    function test_revokeSigner_NotOwner() public {
        address signer = _register();
        address[2] memory callers = [operator, stranger];
        for (uint256 i = 0; i < 2; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(EnclaveRegistry.NotOwner.selector);
            registry.revokeSigner(signer);
        }
    }

    function test_revokeSigner_Revoked_SignerNotActive() public {
        address signer = _register();
        vm.startPrank(owner);
        registry.revokeSigner(signer);
        vm.expectRevert(EnclaveRegistry.SignerNotActive.selector);
        registry.revokeSigner(signer);
        vm.stopPrank();
    }

    function test_revokeSigner_unknown_NotOwner() public {
        vm.prank(owner);
        vm.expectRevert(EnclaveRegistry.NotOwner.selector);
        registry.revokeSigner(makeAddr("nobody"));
    }

    /// Revoked → Active is impossible: the same key can't register again.
    function test_revokedSigner_cannotReregister_SignerExists() public {
        address signer = _register();
        vm.prank(owner);
        registry.revokeSigner(signer);
        vm.warp(START + 1);
        _expectRegisterRevert(_input(enclave), _err(EnclaveRegistry.SignerExists.selector));
    }
}
