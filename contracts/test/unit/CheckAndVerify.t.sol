// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IEnclaveRegistry} from "../../src/EnclaveRegistry.sol";
import {RegistryBase} from "../utils/RegistryBase.sol";

/// SPEC §3.4 checkSigner (first failure wins), verifyProof, proofDigest, livenessDigest.
contract CheckAndVerifyTest is RegistryBase {
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    address internal signer;

    function setUp() public override {
        super.setUp();
        signer = _register();
    }

    function _assertCode(address s, bytes32 o, IEnclaveRegistry.Check expected) internal view {
        assertEq(uint8(_code(s, o)), uint8(expected));
    }

    // ------------------------------------------------------------ checkSigner

    function test_check_OK() public view {
        (IEnclaveRegistry.Check code, IEnclaveRegistry.Signer memory s, IEnclaveRegistry.Endpoint memory e) =
            registry.checkSigner(signer, originHash);
        assertEq(uint8(code), uint8(IEnclaveRegistry.Check.OK));
        assertEq(s.agentId, AGENT);
        assertEq(e.operator, operator);
    }

    function test_check_UNKNOWN_SIGNER() public {
        _assertCode(makeAddr("nobody"), originHash, IEnclaveRegistry.Check.UNKNOWN_SIGNER);
    }

    function test_check_SIGNER_REVOKED() public {
        vm.prank(owner);
        registry.revokeSigner(signer);
        _assertCode(signer, originHash, IEnclaveRegistry.Check.SIGNER_REVOKED);
    }

    /// Revoked beats expired.
    function test_check_SIGNER_REVOKED_beforeExpired() public {
        vm.prank(owner);
        registry.revokeSigner(signer);
        vm.warp(START + 604800);
        _assertCode(signer, originHash, IEnclaveRegistry.Check.SIGNER_REVOKED);
    }

    function test_check_SIGNER_EXPIRED_atExpiresAt() public {
        vm.warp(START + 604800 - 1);
        _assertCode(signer, originHash, IEnclaveRegistry.Check.OK);
        vm.warp(START + 604800);
        _assertCode(signer, originHash, IEnclaveRegistry.Check.SIGNER_EXPIRED);
    }

    function test_check_ENDPOINT_MISMATCH() public {
        vm.prank(owner);
        bytes32 h2 = registry.addEndpoint(AGENT, ORIGIN_B, payTo, operator);
        _assertCode(signer, h2, IEnclaveRegistry.Check.ENDPOINT_MISMATCH);
    }

    function test_check_ENDPOINT_INACTIVE() public {
        vm.prank(owner);
        registry.retireEndpoint(originHash);
        _assertCode(signer, originHash, IEnclaveRegistry.Check.ENDPOINT_INACTIVE);
    }

    function test_check_AGENT_MISMATCH() public {
        vm.startPrank(owner);
        registry.retireEndpoint(originHash);
        registry.addEndpoint(AGENT2, ORIGIN, payTo, operator);
        vm.stopPrank();
        _assertCode(signer, originHash, IEnclaveRegistry.Check.AGENT_MISMATCH);
    }

    /// Rotating the endpoint's operator evicts every signer the old operator registered.
    function test_check_OPERATOR_MISMATCH_afterRotation() public {
        _rotateOperator(operator2);
        _assertCode(signer, originHash, IEnclaveRegistry.Check.OPERATOR_MISMATCH);
        // A signer registered by the new operator verifies.
        Vm.Wallet memory fresh = vm.createWallet("fresh enclave");
        bytes memory att = _attest(_input(fresh));
        vm.prank(operator2);
        address s2 = registry.registerSigner(AGENT, originHash, att, "");
        _assertCode(s2, originHash, IEnclaveRegistry.Check.OK);
        _assertCode(signer, originHash, IEnclaveRegistry.Check.OPERATOR_MISMATCH);
    }

    /// Re-adding the same operator (payTo changed) keeps the signer valid.
    function test_check_sameOperatorReadded_OK() public {
        vm.startPrank(owner);
        registry.retireEndpoint(originHash);
        registry.addEndpoint(AGENT, ORIGIN, makeAddr("payTo2"), operator);
        vm.stopPrank();
        _assertCode(signer, originHash, IEnclaveRegistry.Check.OK);
    }

    function test_check_RELEASE_NOT_APPROVED_deprecated() public {
        vm.prank(owner);
        registry.setReleaseStatus(AGENT, releaseId, IEnclaveRegistry.ReleaseStatus.Deprecated);
        _assertCode(signer, originHash, IEnclaveRegistry.Check.RELEASE_NOT_APPROVED);
        vm.prank(owner);
        registry.setReleaseStatus(AGENT, releaseId, IEnclaveRegistry.ReleaseStatus.Approved);
        _assertCode(signer, originHash, IEnclaveRegistry.Check.OK);
    }

    function test_check_RELEASE_NOT_APPROVED_revoked() public {
        vm.prank(owner);
        registry.setReleaseStatus(AGENT, releaseId, IEnclaveRegistry.ReleaseStatus.Revoked);
        _assertCode(signer, originHash, IEnclaveRegistry.Check.RELEASE_NOT_APPROVED);
    }

    /// Operator mismatch is reported before release status.
    function test_check_OPERATOR_MISMATCH_beforeRelease() public {
        _rotateOperator(operator2);
        vm.prank(owner);
        registry.setReleaseStatus(AGENT, releaseId, IEnclaveRegistry.ReleaseStatus.Deprecated);
        _assertCode(signer, originHash, IEnclaveRegistry.Check.OPERATOR_MISMATCH);
    }

    function test_check_renewedSignerOkAfterOriginalTtl() public {
        vm.warp(START + 6 days);
        AttInput memory a = _input(enclave);
        bytes memory att = _attest(a);
        vm.prank(operator);
        registry.renewSigner(signer, att, "");
        vm.warp(START + 8 days);
        _assertCode(signer, originHash, IEnclaveRegistry.Check.OK);
    }

    // ------------------------------------------------------------ verifyProof

    function _proof(uint64 issuedAt) internal view returns (IEnclaveRegistry.ExecutionProof memory p) {
        p.agentId = AGENT;
        p.releaseId = releaseId;
        p.requestId = keccak256("request id");
        p.requestHash = keccak256("request");
        p.responseHash = keccak256("response");
        p.inputsHash = keccak256("inputs");
        p.paymentId = keccak256("nonce");
        p.issuedAt = issuedAt;
        p.expiresAt = issuedAt + 600;
    }

    function _sign(uint256 key, IEnclaveRegistry.ExecutionProof memory p) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, registry.proofDigest(p));
        return abi.encodePacked(r, s, v);
    }

    function _verify(IEnclaveRegistry.ExecutionProof memory p, bytes memory sig)
        internal
        view
        returns (IEnclaveRegistry.Check)
    {
        return registry.verifyProof(p, sig, originHash);
    }

    function _assertVerify(IEnclaveRegistry.ExecutionProof memory p, bytes memory sig, IEnclaveRegistry.Check c)
        internal
        view
    {
        assertEq(uint8(_verify(p, sig)), uint8(c));
    }

    function test_verify_OK() public view {
        IEnclaveRegistry.ExecutionProof memory p = _proof(uint64(block.timestamp));
        _assertVerify(p, _sign(enclave.privateKey, p), IEnclaveRegistry.Check.OK);
    }

    function test_verify_BAD_SIGNATURE_length() public view {
        IEnclaveRegistry.ExecutionProof memory p = _proof(uint64(block.timestamp));
        bytes memory sig = _sign(enclave.privateKey, p);
        bytes memory short = new bytes(64);
        for (uint256 i = 0; i < 64; i++) {
            short[i] = sig[i];
        }
        _assertVerify(p, short, IEnclaveRegistry.Check.BAD_SIGNATURE);
        _assertVerify(p, abi.encodePacked(sig, bytes1(0)), IEnclaveRegistry.Check.BAD_SIGNATURE);
        _assertVerify(p, "", IEnclaveRegistry.Check.BAD_SIGNATURE);
    }

    function test_verify_BAD_SIGNATURE_badV() public view {
        IEnclaveRegistry.ExecutionProof memory p = _proof(uint64(block.timestamp));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(enclave.privateKey, registry.proofDigest(p));
        _assertVerify(p, abi.encodePacked(r, s, v - 27), IEnclaveRegistry.Check.BAD_SIGNATURE);
        _assertVerify(p, abi.encodePacked(r, s, uint8(29)), IEnclaveRegistry.Check.BAD_SIGNATURE);
    }

    /// The malleable twin (n - s, flipped v) recovers the same key and must be rejected.
    function test_verify_BAD_SIGNATURE_highS() public view {
        IEnclaveRegistry.ExecutionProof memory p = _proof(uint64(block.timestamp));
        bytes32 digest = registry.proofDigest(p);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(enclave.privateKey, digest);
        bytes32 highS = bytes32(SECP256K1_N - uint256(s));
        uint8 flipped = v == 27 ? 28 : 27;
        assertEq(ecrecover(digest, flipped, r, highS), enclave.addr);
        _assertVerify(p, abi.encodePacked(r, highS, flipped), IEnclaveRegistry.Check.BAD_SIGNATURE);
    }

    function test_verify_BAD_SIGNATURE_unrecoverable() public view {
        IEnclaveRegistry.ExecutionProof memory p = _proof(uint64(block.timestamp));
        _assertVerify(p, abi.encodePacked(bytes32(0), bytes32(0), uint8(27)), IEnclaveRegistry.Check.BAD_SIGNATURE);
    }

    /// Another key's valid signature recovers an unregistered signer.
    function test_verify_otherKey_UNKNOWN_SIGNER() public {
        IEnclaveRegistry.ExecutionProof memory p = _proof(uint64(block.timestamp));
        Vm.Wallet memory other = vm.createWallet("other");
        _assertVerify(p, _sign(other.privateKey, p), IEnclaveRegistry.Check.UNKNOWN_SIGNER);
    }

    /// A tampered field changes the digest, so the recovered address is someone else.
    function test_verify_tamperedField_UNKNOWN_SIGNER() public view {
        IEnclaveRegistry.ExecutionProof memory p = _proof(uint64(block.timestamp));
        bytes memory sig = _sign(enclave.privateKey, p);
        p.responseHash = keccak256("other response");
        _assertVerify(p, sig, IEnclaveRegistry.Check.UNKNOWN_SIGNER);
    }

    function test_verify_propagatesCheckSigner() public {
        IEnclaveRegistry.ExecutionProof memory p = _proof(uint64(block.timestamp));
        bytes memory sig = _sign(enclave.privateKey, p);
        _rotateOperator(operator2);
        _assertVerify(p, sig, IEnclaveRegistry.Check.OPERATOR_MISMATCH);
        vm.prank(owner);
        registry.revokeSigner(signer);
        _assertVerify(p, sig, IEnclaveRegistry.Check.SIGNER_REVOKED);
    }

    function test_verify_wrongOrigin_ENDPOINT_MISMATCH() public {
        vm.prank(owner);
        bytes32 h2 = registry.addEndpoint(AGENT, ORIGIN_B, payTo, operator);
        IEnclaveRegistry.ExecutionProof memory p = _proof(uint64(block.timestamp));
        assertEq(
            uint8(registry.verifyProof(p, _sign(enclave.privateKey, p), h2)),
            uint8(IEnclaveRegistry.Check.ENDPOINT_MISMATCH)
        );
    }

    function test_verify_AGENT_MISMATCH() public view {
        IEnclaveRegistry.ExecutionProof memory p = _proof(uint64(block.timestamp));
        p.agentId = AGENT2;
        _assertVerify(p, _sign(enclave.privateKey, p), IEnclaveRegistry.Check.AGENT_MISMATCH);
    }

    function test_verify_releaseId_RELEASE_NOT_APPROVED() public view {
        IEnclaveRegistry.ExecutionProof memory p = _proof(uint64(block.timestamp));
        p.releaseId = keccak256("other release");
        _assertVerify(p, _sign(enclave.privateKey, p), IEnclaveRegistry.Check.RELEASE_NOT_APPROVED);
    }

    function test_verify_PROOF_EXPIRED() public view {
        IEnclaveRegistry.ExecutionProof memory p = _proof(uint64(block.timestamp));
        p.expiresAt = uint64(block.timestamp - 1);
        _assertVerify(p, _sign(enclave.privateKey, p), IEnclaveRegistry.Check.PROOF_EXPIRED);
        p.expiresAt = uint64(block.timestamp);
        _assertVerify(p, _sign(enclave.privateKey, p), IEnclaveRegistry.Check.OK);
    }

    function test_verify_skew_minus120_OK() public view {
        IEnclaveRegistry.ExecutionProof memory p = _proof(uint64(block.timestamp - 120));
        _assertVerify(p, _sign(enclave.privateKey, p), IEnclaveRegistry.Check.OK);
    }

    function test_verify_skew_minus121_PROOF_CLOCK_SKEW() public view {
        IEnclaveRegistry.ExecutionProof memory p = _proof(uint64(block.timestamp - 121));
        _assertVerify(p, _sign(enclave.privateKey, p), IEnclaveRegistry.Check.PROOF_CLOCK_SKEW);
    }

    function test_verify_skew_plus120_OK() public view {
        IEnclaveRegistry.ExecutionProof memory p = _proof(uint64(block.timestamp + 120));
        _assertVerify(p, _sign(enclave.privateKey, p), IEnclaveRegistry.Check.OK);
    }

    function test_verify_skew_plus121_PROOF_CLOCK_SKEW() public view {
        IEnclaveRegistry.ExecutionProof memory p = _proof(uint64(block.timestamp + 121));
        _assertVerify(p, _sign(enclave.privateKey, p), IEnclaveRegistry.Check.PROOF_CLOCK_SKEW);
    }

    // ---------------------------------------------------------------- digests

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("AttestedExecution"),
                keccak256("1"),
                block.chainid,
                address(registry)
            )
        );
    }

    function test_proofDigest_isEip712() public view {
        IEnclaveRegistry.ExecutionProof memory p = _proof(1234);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "ExecutionProof(uint256 agentId,bytes32 releaseId,bytes32 requestId,bytes32 requestHash,bytes32 responseHash,bytes32 inputsHash,bytes32 paymentId,uint64 issuedAt,uint64 expiresAt)"
                ),
                p.agentId,
                p.releaseId,
                p.requestId,
                p.requestHash,
                p.responseHash,
                p.inputsHash,
                p.paymentId,
                p.issuedAt,
                p.expiresAt
            )
        );
        assertEq(registry.proofDigest(p), keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash)));
    }

    function test_livenessDigest_isEip712() public view {
        bytes32 challenge = keccak256("challenge");
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Liveness(uint256 agentId,bytes32 releaseId,bytes32 originHash,bytes32 challenge,uint64 issuedAt)"
                ),
                AGENT,
                releaseId,
                originHash,
                challenge,
                uint64(99)
            )
        );
        assertEq(
            registry.livenessDigest(AGENT, releaseId, originHash, challenge, 99),
            keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash))
        );
    }
}
