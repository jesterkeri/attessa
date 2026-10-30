// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {NitroValidator} from "nitro-validator/NitroValidator.sol";
import {EnclaveRegistry, IEnclaveRegistry} from "../../src/EnclaveRegistry.sol";
import {MockNitroValidator} from "../mocks/Mocks.sol";
import {RegistryBase} from "../utils/RegistryBase.sol";

/// Validator that forwards to a MockNitroValidator and, inside `validateAttestationWithHints`,
/// re-enters the registry once with the call it was armed with. Records the re-entry's revert data.
contract ReentrantValidator {
    MockNitroValidator public immutable inner;
    EnclaveRegistry public registry;
    bytes public reentryCall;
    bool public reentered;
    bool public reentryOk;
    bytes public reentryRevert;

    constructor(MockNitroValidator inner_) {
        inner = inner_;
    }

    function arm(EnclaveRegistry registry_, bytes calldata call_) external {
        registry = registry_;
        reentryCall = call_;
        reentered = false;
    }

    function decodeAttestationTbs(bytes calldata attestation)
        external
        view
        returns (bytes memory attestationTbs, bytes memory signature)
    {
        return inner.decodeAttestationTbs(attestation);
    }

    function validateAttestationWithHints(bytes calldata tbs, bytes calldata sig, bytes calldata hints)
        external
        returns (NitroValidator.Ptrs memory ptrs)
    {
        if (!reentered && reentryCall.length != 0) {
            reentered = true;
            (reentryOk, reentryRevert) = address(registry).call(reentryCall);
        }
        return inner.validateAttestationWithHints(tbs, sig, hints);
    }

    /// Lets the validator itself act as an endpoint operator.
    function callRegistry(bytes calldata call_) external returns (bool ok, bytes memory ret) {
        (ok, ret) = address(registry).call(call_);
    }
}

/// Adversary pass on T09 (SLITHER_TRIAGE.md). Each test attacks one triaged Slither result on the
/// unmodified registry. All pass: the triage verdicts hold on this code.
contract AdversaryT09Test is RegistryBase {
    // ------------------------------------------- 1. encode-packed-collision, _releaseIdOf

    /// Every split of the approved 144 bytes into three PCRs other than 48/48/48 is rejected.
    function testFuzz_t09_1_releaseIdOf_everySplitRejected(uint256 a, uint256 b) public {
        a = bound(a, 0, 144);
        b = bound(b, 0, 144 - a);
        vm.assume(!(a == 48 && b == 48));
        bytes memory all = abi.encodePacked(pcr0, pcr1, pcr2);
        AttInput memory input = _input(enclave);
        input.pcr0 = _slice(all, 0, a);
        input.pcr1 = _slice(all, a, b);
        input.pcr2 = _slice(all, a + b, 144 - a - b);
        assertEq(keccak256(abi.encodePacked(input.pcr0, input.pcr1, input.pcr2)), releaseId);
        _expectRegisterRevert(input, _err(EnclaveRegistry.InvalidPcr.selector));
    }

    // ------------------------------------------ 2. encode-packed-collision, approveRelease

    /// The owner cannot approve a shifted split under another agent, nor a shifted split of a
    /// fresh release (which would otherwise squat the 48/48/48 release id).
    function testFuzz_t09_2_approveRelease_everySplitRejected(uint256 a, uint256 b) public {
        a = bound(a, 0, 144);
        b = bound(b, 0, 144 - a);
        vm.assume(!(a == 48 && b == 48));
        bytes memory all = abi.encodePacked(_fill(0x55, 48), _fill(0x66, 48), _fill(0x77, 48));
        vm.prank(owner);
        vm.expectRevert(EnclaveRegistry.InvalidPcr.selector);
        registry.approveRelease(AGENT2, _slice(all, 0, a), _slice(all, a, b), _slice(all, a + b, 144 - a - b), "x");
    }

    // --------------------------------------------------- 5 to 8. reentrancy via validator

    /// A validator that re-enters registerSigner during registerSigner is not the operator.
    function test_t09_5_reentry_registerSigner_isNotOperator() public {
        (EnclaveRegistry reg, ReentrantValidator rv, bytes32 oh) = _reentrantStack(operator);
        bytes memory att = _attestFor(reg, rv, oh, enclave);
        rv.arm(reg, abi.encodeCall(reg.registerSigner, (AGENT, oh, att, "")));
        vm.prank(operator);
        address s = reg.registerSigner(AGENT, oh, att, "");
        assertTrue(rv.reentered());
        assertFalse(rv.reentryOk());
        assertEq(rv.reentryRevert(), _err(EnclaveRegistry.NotOperator.selector));
        assertEq(uint8(reg.signers(s).status), uint8(IEnclaveRegistry.SignerStatus.Active));
    }

    /// The same during renewSigner: the re-entry cannot renew, and the outer renewal still binds
    /// the signer to its original release and origin.
    function test_t09_8_reentry_renewSigner_isNotOperator() public {
        (EnclaveRegistry reg, ReentrantValidator rv, bytes32 oh) = _reentrantStack(operator);
        bytes memory att = _attestFor(reg, rv, oh, enclave);
        vm.prank(operator);
        address s = reg.registerSigner(AGENT, oh, att, "");
        vm.warp(block.timestamp + 1000);
        bytes memory att2 = _attestFor(reg, rv, oh, enclave);
        rv.arm(reg, abi.encodeCall(reg.renewSigner, (s, att2, "")));
        vm.prank(operator);
        reg.renewSigner(s, att2, "");
        assertFalse(rv.reentryOk());
        assertEq(rv.reentryRevert(), _err(EnclaveRegistry.NotOperator.selector));
        assertEq(reg.signers(s).expiresAt, uint64(block.timestamp) + reg.SIGNER_TTL());
        assertEq(reg.signers(s).releaseId, releaseId);
    }

    /// Worst case: the validator is the operator and re-registers the same signer mid-call. The
    /// inner registration lands, the outer then hits SignerExists and the whole call reverts, so no
    /// half-written signer is left.
    function test_t09_6_reentry_operatorIsValidator_noHalfState() public {
        (EnclaveRegistry reg, ReentrantValidator rv, bytes32 oh) = _reentrantStack(address(0));
        bytes memory att = _attestFor(reg, rv, oh, enclave);
        bytes memory call_ = abi.encodeCall(reg.registerSigner, (AGENT, oh, att, ""));
        rv.arm(reg, call_);
        (bool ok, bytes memory ret) = rv.callRegistry(call_);
        assertFalse(ok);
        assertEq(ret, _err(EnclaveRegistry.SignerExists.selector));
        assertEq(uint8(reg.signers(enclave.addr).status), uint8(IEnclaveRegistry.SignerStatus.None));
    }

    // ------------------------------------------------ 9 to 11. missing-zero-check, fail closed

    function test_t09_9_zeroAddresses_failClosed() public {
        EnclaveRegistry reg = new EnclaveRegistry(address(0), address(0), address(0), false);
        vm.prank(owner);
        vm.expectRevert();
        reg.approveRelease(AGENT, pcr0, pcr1, pcr2, SOURCE_REF);
        vm.prank(owner);
        vm.expectRevert();
        reg.addEndpoint(AGENT, ORIGIN, payTo, operator);
        vm.prank(owner);
        vm.expectRevert();
        reg.linkSelfAgent(AGENT, 1);
        vm.prank(operator);
        vm.expectRevert(EnclaveRegistry.EndpointInactive.selector);
        reg.registerSigner(AGENT, originHash, hex"00", "");
        (IEnclaveRegistry.Check code,,) = reg.checkSigner(enclave.addr, originHash);
        assertEq(uint8(code), uint8(IEnclaveRegistry.Check.UNKNOWN_SIGNER));
    }

    /// A zero validator with a real owner: registration still reverts (no attestation accepted).
    function test_t09_10_zeroValidator_registrationReverts() public {
        EnclaveRegistry reg = new EnclaveRegistry(address(identity), address(0), address(0), false);
        vm.startPrank(owner);
        reg.approveRelease(AGENT, pcr0, pcr1, pcr2, SOURCE_REF);
        bytes32 oh = reg.addEndpoint(AGENT, ORIGIN, payTo, operator);
        vm.stopPrank();
        bytes memory att = _attest(_input(enclave));
        vm.prank(operator);
        vm.expectRevert();
        reg.registerSigner(AGENT, oh, att, "");
        assertEq(uint8(reg.signers(enclave.addr).status), uint8(IEnclaveRegistry.SignerStatus.None));
    }

    // ---------------------------------------------------------- 12 to 15. timestamp

    /// verifyProof never reverts on hostile timestamps; it returns a code. Valid signer, any
    /// issuedAt/expiresAt, any block time inside the signer's life.
    function testFuzz_t09_15_verifyProof_timestampsNeverRevert(uint64 issuedAt, uint64 expiresAt, uint32 dt) public {
        address s = _register();
        vm.warp(block.timestamp + bound(dt, 0, 604799));
        IEnclaveRegistry.ExecutionProof memory p;
        p.agentId = AGENT;
        p.releaseId = releaseId;
        p.issuedAt = issuedAt;
        p.expiresAt = expiresAt;
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(enclave.privateKey, registry.proofDigest(p));
        if (uint256(sg) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0) return;
        IEnclaveRegistry.Check code = registry.verifyProof(p, abi.encodePacked(r, sg, v), originHash);
        assertEq(s, enclave.addr);
        uint256 skew = issuedAt > block.timestamp ? issuedAt - block.timestamp : block.timestamp - issuedAt;
        if (block.timestamp > expiresAt) assertEq(uint8(code), uint8(IEnclaveRegistry.Check.PROOF_EXPIRED));
        else if (skew > 120) assertEq(uint8(code), uint8(IEnclaveRegistry.Check.PROOF_CLOCK_SKEW));
        else assertEq(uint8(code), uint8(IEnclaveRegistry.Check.OK));
    }

    /// An attestation timestamp near uint64 max is AttestationFromFuture, not an overflow.
    function test_t09_12_attestationTimestampMax_isFuture() public {
        AttInput memory a = _input(enclave);
        a.timestampMs = type(uint64).max;
        _expectRegisterRevert(a, _err(EnclaveRegistry.AttestationFromFuture.selector));
    }

    // ------------------------------------- coverage vs assertions (mutants that survived 160 tests)

    /// SPEC §3.4 approveRelease/registerSigner: a PCR is rejected only if ALL its bytes are zero.
    /// A PCR whose only non-zero byte is the first is valid (kills `_allZero` skipping byte 0).
    function test_t09_cov_pcrNonZeroOnlyAtFirstByte_isValid() public {
        bytes memory p = new bytes(48);
        p[0] = 0x01;
        _approveAndRegister(p);
    }

    /// Same with the last byte (kills `_allZero` skipping byte 47).
    function test_t09_cov_pcrNonZeroOnlyAtLastByte_isValid() public {
        bytes memory p = new bytes(48);
        p[47] = 0x01;
        _approveAndRegister(p);
    }

    /// SPEC §3.4 addEndpoint: with allowLocalOrigins, a 9-15 byte non-https origin shorter than
    /// "http://localhost" is InvalidOrigin, not a raw calldata-slice revert.
    function test_t09_cov_localAllowed_shortOrigin_isInvalidOrigin() public {
        EnclaveRegistry reg = new EnclaveRegistry(address(identity), address(nitro), address(0), true);
        vm.prank(owner);
        vm.expectRevert(EnclaveRegistry.InvalidOrigin.selector);
        reg.addEndpoint(AGENT, "http://a.b", payTo, operator);
    }

    // ------------------------------------------------------------------- helpers

    function _approveAndRegister(bytes memory p) internal {
        vm.prank(owner);
        bytes32 rid = registry.approveRelease(AGENT, p, pcr1, pcr2, SOURCE_REF);
        AttInput memory a = _input(enclave);
        a.pcr0 = p;
        address s = _register(a);
        assertEq(registry.signers(s).releaseId, rid);
        assertEq(uint8(_code(s, originHash)), uint8(IEnclaveRegistry.Check.OK));
    }

    function _reentrantStack(address op) internal returns (EnclaveRegistry reg, ReentrantValidator rv, bytes32 oh) {
        rv = new ReentrantValidator(nitro);
        reg = new EnclaveRegistry(address(identity), address(rv), address(0), false);
        vm.startPrank(owner);
        reg.approveRelease(AGENT, pcr0, pcr1, pcr2, SOURCE_REF);
        oh = reg.addEndpoint(AGENT, ORIGIN, payTo, op == address(0) ? address(rv) : op);
        vm.stopPrank();
        rv.arm(reg, "");
    }

    function _attestFor(EnclaveRegistry reg, ReentrantValidator, bytes32 oh, Vm.Wallet memory w)
        internal
        returns (bytes memory)
    {
        AttInput memory a = _input(w);
        a.userData = _binding(reg, AGENT, oh);
        return _attest(a);
    }

    function _slice(bytes memory b, uint256 start, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            out[i] = b[start + i];
        }
    }
}
