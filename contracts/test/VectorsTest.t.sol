// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EnclaveRegistry, IEnclaveRegistry} from "../src/EnclaveRegistry.sol";
import {RegistryBase} from "./utils/RegistryBase.sol";
import {HeaderGrammar} from "./HeaderGrammar.sol";
import {console2} from "forge-std/console2.sol";

/// INV-18: the shared vectors in ../vectors (T03) checked against EnclaveRegistry. Wherever the
/// registry computes a value itself (originHash, releaseId, signer, digests, signature checks), the
/// registry's own function is what's compared; values the registry never computes (requestHash,
/// responseHash, inputsHash, requestId) are recomputed here from their SPEC §2.2 definitions. The
/// registry parses no headers, so the §2.5 header grammars run through the test-only HeaderGrammar.
contract VectorsTest is RegistryBase {
    function _read(string memory name) internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/../vectors/", name, ".json"));
    }

    function _at(string memory list, uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(".", list, "[", vm.toString(i), "].", field);
    }

    function _count(string memory json, string memory list) internal view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(".", list, "[", vm.toString(n), "]"))) {
            n++;
        }
        assertGt(n, 0, string.concat("empty vector list ", list));
        console2.log(string.concat("cases ", list, ":"), n);
    }

    function _startsWith(bytes memory s, bytes memory prefix) internal pure returns (bool) {
        if (s.length < prefix.length) return false;
        for (uint256 i = 0; i < prefix.length; i++) {
            if (s[i] != prefix[i]) return false;
        }
        return true;
    }

    /// A registry whose runtime code sits at `at`, on chain `id` (vectors fix both).
    function _registryAt(address at, uint256 id) internal returns (EnclaveRegistry r) {
        vm.etch(at, address(registry).code);
        vm.chainId(id);
        r = EnclaveRegistry(at);
    }

    // ---------------------------------------------------------------- origins

    /// SPEC §2.1 / §3.4 addEndpoint: the registry accepts every normalized origin (prefix and
    /// 9-267 byte length) and its originHash is keccak256(utf8(normalized)).
    function test_vectors_origins_valid() public {
        string memory json = _read("origins");
        EnclaveRegistry local = new EnclaveRegistry(address(identity), address(nitro), address(0), true);
        uint256 n = _count(json, "valid");
        for (uint256 i = 0; i < n; i++) {
            string memory name = vm.parseJsonString(json, _at("valid", i, "name"));
            string memory normalized = vm.parseJsonString(json, _at("valid", i, "normalized"));
            bool isLocal = vm.parseJsonBool(json, _at("valid", i, "local"));
            assertEq(bytes(normalized).length, vm.parseJsonUint(json, _at("valid", i, "bytes")), name);
            EnclaveRegistry r = isLocal ? local : registry;
            vm.startPrank(owner);
            bytes32 h = r.addEndpoint(AGENT, normalized, payTo, operator);
            r.retireEndpoint(h); // several vectors normalize to the same origin
            vm.stopPrank();
            assertEq(h, vm.parseJsonBytes32(json, _at("valid", i, "originHash")), name);
            assertEq(h, keccak256(bytes(normalized)), name);
        }
    }

    /// The on-chain check is only prefix + length (SPEC §2.1: "On chain, addEndpoint checks the
    /// prefix ... and the length 9-267"). Vectors rejected for those reasons must revert
    /// InvalidOrigin. The other reasons (trailing dot, IP literal, userinfo, invalid URL) are
    /// normalizeOrigin rules the SDK applies before submitting; the registry can't check them.
    function test_vectors_origins_invalid_prefixAndLength() public {
        string memory json = _read("origins");
        EnclaveRegistry local = new EnclaveRegistry(address(identity), address(nitro), address(0), true);
        uint256 n = _count(json, "invalid");
        uint256 checked;
        for (uint256 i = 0; i < n; i++) {
            string memory reason = vm.parseJsonString(json, _at("invalid", i, "reason"));
            bool isLength = keccak256(bytes(reason)) == keccak256("length");
            bool isScheme = keccak256(bytes(reason)) == keccak256("not_https");
            if (!isLength && !isScheme) continue;
            bytes memory input = bytes(vm.parseJsonString(json, _at("invalid", i, "input")));
            bool isLocal = vm.parseJsonBool(json, _at("invalid", i, "local"));
            // "http://localhost" with no port is a normalizeOrigin rejection on --network local,
            // but it carries the on-chain local prefix "http://localhost", so a local registry
            // accepts it by design (SPEC §3.4 addEndpoint).
            if (isLocal && _startsWith(input, "http://localhost") && input.length >= 9 && input.length <= 267) {
                vm.prank(owner);
                local.addEndpoint(AGENT, string(input), payTo, operator);
                continue;
            }
            vm.prank(owner);
            vm.expectRevert(EnclaveRegistry.InvalidOrigin.selector);
            (isLocal ? local : registry).addEndpoint(AGENT, string(input), payTo, operator);
            checked++;
        }
        assertGt(checked, 0);
    }

    // ----------------------------------------------------------------- hashes

    function _upperAscii(bytes memory s) internal pure returns (bytes memory out) {
        out = new bytes(s.length);
        for (uint256 i = 0; i < s.length; i++) {
            bytes1 c = s[i];
            out[i] = (c >= "a" && c <= "z") ? bytes1(uint8(c) - 32) : c;
        }
    }

    function test_vectors_requestHash() public view {
        string memory json = _read("hashes");
        uint256 n = _count(json, "requestHash");
        for (uint256 i = 0; i < n; i++) {
            bytes memory method = _upperAscii(bytes(vm.parseJsonString(json, _at("requestHash", i, "method"))));
            bytes32 h = keccak256(
                abi.encodePacked(
                    method,
                    bytes1(0),
                    vm.parseJsonString(json, _at("requestHash", i, "pathAndQuery")),
                    bytes1(0),
                    vm.parseJsonBytes(json, _at("requestHash", i, "body"))
                )
            );
            assertEq(
                h,
                vm.parseJsonBytes32(json, _at("requestHash", i, "expected")),
                vm.parseJsonString(json, _at("requestHash", i, "name"))
            );
        }
    }

    function test_vectors_responseHash() public view {
        string memory json = _read("hashes");
        uint256 n = _count(json, "responseHash");
        for (uint256 i = 0; i < n; i++) {
            assertEq(
                keccak256(vm.parseJsonBytes(json, _at("responseHash", i, "body"))),
                vm.parseJsonBytes32(json, _at("responseHash", i, "expected")),
                vm.parseJsonString(json, _at("responseHash", i, "name"))
            );
        }
    }

    /// inputsHash = keccak256(utf8(JCS(inputs))); Solidity has no JCS, so the vector's `jcs` text is hashed.
    function test_vectors_inputsHash() public view {
        string memory json = _read("hashes");
        uint256 n = _count(json, "inputsHash");
        for (uint256 i = 0; i < n; i++) {
            assertEq(
                keccak256(bytes(vm.parseJsonString(json, _at("inputsHash", i, "jcs")))),
                vm.parseJsonBytes32(json, _at("inputsHash", i, "expected")),
                vm.parseJsonString(json, _at("inputsHash", i, "name"))
            );
        }
    }

    /// releaseId through approveRelease where the registry accepts the PCRs; the all-zero vector is
    /// hash-only (approveRelease rejects it with InvalidPcr).
    function test_vectors_releaseId() public {
        string memory json = _read("hashes");
        uint256 n = _count(json, "releaseId");
        for (uint256 i = 0; i < n; i++) {
            string memory name = vm.parseJsonString(json, _at("releaseId", i, "name"));
            bytes memory p0 = vm.parseJsonBytes(json, _at("releaseId", i, "pcr0"));
            bytes memory p1 = vm.parseJsonBytes(json, _at("releaseId", i, "pcr1"));
            bytes memory p2 = vm.parseJsonBytes(json, _at("releaseId", i, "pcr2"));
            bytes32 expected = vm.parseJsonBytes32(json, _at("releaseId", i, "expected"));
            assertEq(keccak256(abi.encodePacked(p0, p1, p2)), expected, name);
            if (keccak256(p0) == keccak256(new bytes(48))) {
                vm.prank(owner);
                vm.expectRevert(EnclaveRegistry.InvalidPcr.selector);
                registry.approveRelease(AGENT2, p0, p1, p2, SOURCE_REF);
                continue;
            }
            vm.prank(owner);
            assertEq(registry.approveRelease(AGENT2, p0, p1, p2, SOURCE_REF), expected, name);
        }
    }

    /// requestId = keccak256(asset ‖ payer ‖ nonce), each 32-byte left-padded.
    function test_vectors_requestId() public view {
        string memory json = _read("hashes");
        uint256 n = _count(json, "requestId");
        for (uint256 i = 0; i < n; i++) {
            bytes32 h = keccak256(
                abi.encode(
                    vm.parseJsonAddress(json, _at("requestId", i, "asset")),
                    vm.parseJsonAddress(json, _at("requestId", i, "payer")),
                    vm.parseJsonBytes32(json, _at("requestId", i, "nonce"))
                )
            );
            assertEq(
                h,
                vm.parseJsonBytes32(json, _at("requestId", i, "expected")),
                vm.parseJsonString(json, _at("requestId", i, "name"))
            );
        }
    }

    // ---------------------------------------------------------------- binding

    function test_vectors_binding_typehash() public view {
        string memory json = _read("binding");
        bytes32 expected = vm.parseJsonBytes32(json, ".typehash");
        assertEq(keccak256(bytes(vm.parseJsonString(json, ".typehashPreimage"))), expected);
        assertEq(registry.BINDING_TYPEHASH(), expected);
    }

    /// user_data = abi.encode(BINDING_TYPEHASH, chainId, registry, agentId, originHash), 160 bytes,
    /// the exact expression registerSigner step 6 compares against.
    function test_vectors_binding_userData() public view {
        string memory json = _read("binding");
        uint256 n = _count(json, "userData");
        for (uint256 i = 0; i < n; i++) {
            string memory name = vm.parseJsonString(json, _at("userData", i, "name"));
            bytes memory ud = abi.encode(
                registry.BINDING_TYPEHASH(),
                vm.parseJsonUint(json, _at("userData", i, "chainId")),
                vm.parseJsonAddress(json, _at("userData", i, "registry")),
                vm.parseJsonUint(json, _at("userData", i, "agentId")),
                vm.parseJsonBytes32(json, _at("userData", i, "originHash"))
            );
            assertEq(ud.length, 160, name);
            assertEq(ud, vm.parseJsonBytes(json, _at("userData", i, "expected")), name);
        }
    }

    /// One user_data vector through registerSigner itself: a registry at the vector's address on
    /// the vector's chain accepts exactly that user_data (agentId and originHash from this fixture,
    /// since an endpoint needs the origin string, which binding vectors don't carry).
    function test_vectors_binding_userData_acceptedByRegistry() public {
        string memory json = _read("binding");
        address at = vm.parseJsonAddress(json, _at("userData", 0, "registry"));
        uint256 id = vm.parseJsonUint(json, _at("userData", 0, "chainId"));
        EnclaveRegistry r = _registryAt(at, id);
        vm.startPrank(owner);
        bytes32 rid = r.approveRelease(AGENT, pcr0, pcr1, pcr2, SOURCE_REF);
        bytes32 oh = r.addEndpoint(AGENT, ORIGIN, payTo, operator);
        vm.stopPrank();
        assertEq(rid, releaseId);
        AttInput memory a = _input(enclave);
        a.userData = abi.encode(vm.parseJsonBytes32(json, ".typehash"), id, at, AGENT, oh);
        bytes memory att = _attest(a);
        vm.prank(operator);
        assertEq(r.registerSigner(AGENT, oh, att, ""), enclave.addr);
    }

    /// signer = address(keccak256(public_key[1:65])), derived by registerSigner itself.
    function test_vectors_binding_signer() public {
        string memory json = _read("binding");
        uint256 n = _count(json, "signer");
        for (uint256 i = 0; i < n; i++) {
            string memory name = vm.parseJsonString(json, _at("signer", i, "name"));
            AttInput memory a = _input(enclave);
            a.publicKey = vm.parseJsonBytes(json, _at("signer", i, "publicKey"));
            assertEq(_register(a), vm.parseJsonAddress(json, _at("signer", i, "expected")), name);
        }
    }

    // ----------------------------------------------------------------- eip712

    function _domainSeparator(string memory json, string memory list, uint256 i) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(vm.parseJsonString(json, ".domain.name"))),
                keccak256(bytes(vm.parseJsonString(json, ".domain.version"))),
                vm.parseJsonUint(json, _at(list, i, "chainId")),
                vm.parseJsonAddress(json, _at(list, i, "verifyingContract"))
            )
        );
    }

    function test_vectors_eip712_typehashes() public view {
        string memory json = _read("eip712");
        assertEq(
            keccak256(bytes(vm.parseJsonString(json, ".typeStrings.ExecutionProof"))),
            vm.parseJsonBytes32(json, ".typehashes.ExecutionProof")
        );
        assertEq(
            keccak256(bytes(vm.parseJsonString(json, ".typeStrings.Liveness"))),
            vm.parseJsonBytes32(json, ".typehashes.Liveness")
        );
    }

    function _proof(string memory json, uint256 i) internal pure returns (IEnclaveRegistry.ExecutionProof memory p) {
        p.agentId = vm.parseJsonUint(json, _at("proof", i, "agentId"));
        p.releaseId = vm.parseJsonBytes32(json, _at("proof", i, "releaseId"));
        p.requestId = vm.parseJsonBytes32(json, _at("proof", i, "requestId"));
        p.requestHash = vm.parseJsonBytes32(json, _at("proof", i, "requestHash"));
        p.responseHash = vm.parseJsonBytes32(json, _at("proof", i, "responseHash"));
        p.inputsHash = vm.parseJsonBytes32(json, _at("proof", i, "inputsHash"));
        p.paymentId = vm.parseJsonBytes32(json, _at("proof", i, "paymentId"));
        p.issuedAt = uint64(vm.parseJsonUint(json, _at("proof", i, "issuedAt")));
        p.expiresAt = uint64(vm.parseJsonUint(json, _at("proof", i, "expiresAt")));
    }

    /// Domain separator, struct hash, and registry.proofDigest on the vector's chain and address.
    function test_vectors_eip712_proof() public {
        string memory json = _read("eip712");
        bytes32 typehash = vm.parseJsonBytes32(json, ".typehashes.ExecutionProof");
        uint256 n = _count(json, "proof");
        for (uint256 i = 0; i < n; i++) {
            string memory name = vm.parseJsonString(json, _at("proof", i, "name"));
            bytes32 ds = _domainSeparator(json, "proof", i);
            assertEq(ds, vm.parseJsonBytes32(json, _at("proof", i, "domainSeparator")), name);
            IEnclaveRegistry.ExecutionProof memory p = _proof(json, i);
            bytes32 structHash = keccak256(
                abi.encode(
                    typehash,
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
            assertEq(structHash, vm.parseJsonBytes32(json, _at("proof", i, "structHash")), name);
            bytes32 digest = vm.parseJsonBytes32(json, _at("proof", i, "digest"));
            assertEq(keccak256(abi.encodePacked("\x19\x01", ds, structHash)), digest, name);
            EnclaveRegistry r = _registryAt(
                vm.parseJsonAddress(json, _at("proof", i, "verifyingContract")),
                vm.parseJsonUint(json, _at("proof", i, "chainId"))
            );
            assertEq(r.proofDigest(p), digest, name);
        }
    }

    struct Liveness {
        uint256 agentId;
        bytes32 releaseId;
        bytes32 originHash;
        bytes32 challenge;
        uint64 issuedAt;
    }

    function _liveness(string memory json, uint256 i) internal pure returns (Liveness memory l) {
        l.agentId = vm.parseJsonUint(json, _at("liveness", i, "agentId"));
        l.releaseId = vm.parseJsonBytes32(json, _at("liveness", i, "releaseId"));
        l.originHash = vm.parseJsonBytes32(json, _at("liveness", i, "originHash"));
        l.challenge = vm.parseJsonBytes32(json, _at("liveness", i, "challenge"));
        l.issuedAt = uint64(vm.parseJsonUint(json, _at("liveness", i, "issuedAt")));
    }

    function test_vectors_eip712_liveness() public {
        string memory json = _read("eip712");
        bytes32 typehash = vm.parseJsonBytes32(json, ".typehashes.Liveness");
        uint256 n = _count(json, "liveness");
        for (uint256 i = 0; i < n; i++) {
            string memory name = vm.parseJsonString(json, _at("liveness", i, "name"));
            bytes32 ds = _domainSeparator(json, "liveness", i);
            assertEq(ds, vm.parseJsonBytes32(json, _at("liveness", i, "domainSeparator")), name);
            Liveness memory l = _liveness(json, i);
            bytes32 structHash =
                keccak256(abi.encode(typehash, l.agentId, l.releaseId, l.originHash, l.challenge, l.issuedAt));
            assertEq(structHash, vm.parseJsonBytes32(json, _at("liveness", i, "structHash")), name);
            bytes32 digest = vm.parseJsonBytes32(json, _at("liveness", i, "digest"));
            assertEq(keccak256(abi.encodePacked("\x19\x01", ds, structHash)), digest, name);
            EnclaveRegistry r = _registryAt(
                vm.parseJsonAddress(json, _at("liveness", i, "verifyingContract")),
                vm.parseJsonUint(json, _at("liveness", i, "chainId"))
            );
            assertEq(r.livenessDigest(l.agentId, l.releaseId, l.originHash, l.challenge, l.issuedAt), digest, name);
        }
    }

    /// Valid signatures recover to their signer. Signatures over a proof digest also go through
    /// registry.verifyProof: valid ones pass the signature check (the signer isn't registered here,
    /// so the answer is UNKNOWN_SIGNER), invalid ones are refused with BAD_SIGNATURE.
    function test_vectors_eip712_signatures() public {
        string memory json = _read("eip712");
        uint256 nProofs = _count(json, "proof");
        uint256 n = _count(json, "signatures");
        for (uint256 i = 0; i < n; i++) {
            uint256 throughRegistry;
            string memory name = vm.parseJsonString(json, _at("signatures", i, "name"));
            bytes32 digest = vm.parseJsonBytes32(json, _at("signatures", i, "digest"));
            bytes memory sig = vm.parseJsonBytes(json, _at("signatures", i, "signature"));
            bool valid = vm.parseJsonBool(json, _at("signatures", i, "valid"));
            if (valid) {
                (bytes32 r, bytes32 s, uint8 v) = (bytes32(0), bytes32(0), uint8(sig[64]));
                assembly {
                    r := mload(add(sig, 32))
                    s := mload(add(sig, 64))
                }
                assertEq(ecrecover(digest, v, r, s), vm.parseJsonAddress(json, _at("signatures", i, "signer")), name);
            }
            for (uint256 j = 0; j < nProofs; j++) {
                if (vm.parseJsonBytes32(json, _at("proof", j, "digest")) != digest) continue;
                EnclaveRegistry reg = _registryAt(
                    vm.parseJsonAddress(json, _at("proof", j, "verifyingContract")),
                    vm.parseJsonUint(json, _at("proof", j, "chainId"))
                );
                IEnclaveRegistry.Check code = reg.verifyProof(_proof(json, j), sig, bytes32(0));
                if (valid) assertEq(uint8(code), uint8(IEnclaveRegistry.Check.UNKNOWN_SIGNER), name);
                else assertEq(uint8(code), uint8(IEnclaveRegistry.Check.BAD_SIGNATURE), name);
                throughRegistry++;
            }
            assertTrue(valid || throughRegistry > 0, string.concat("invalid signature not checked: ", name));
        }
    }

    // ---------------------------------------------------------------- headers

    /// SPEC §2.5 grammars, run through the Solidity adapter in HeaderGrammar.sol. Every valid case
    /// parses to the vector's fields; every invalid case is refused (X-Attested-Proof: for the
    /// vector's stated reason).

    function test_vectors_headers_bytes32() public view {
        string memory json = _read("headers");
        uint256 n = _count(json, "bytes32.valid");
        for (uint256 i = 0; i < n; i++) {
            string memory name = vm.parseJsonString(json, _at("bytes32.valid", i, "name"));
            string memory value = vm.parseJsonString(json, _at("bytes32.valid", i, "value"));
            (bool ok, bytes32 b) = HeaderGrammar.parseBytes32(value);
            assertTrue(ok, name);
            assertEq(b, vm.parseBytes32(value), name);
        }
        n = _count(json, "bytes32.invalid");
        for (uint256 i = 0; i < n; i++) {
            (bool ok,) = HeaderGrammar.parseBytes32(vm.parseJsonString(json, _at("bytes32.invalid", i, "value")));
            assertFalse(ok, vm.parseJsonString(json, _at("bytes32.invalid", i, "name")));
        }
    }

    function test_vectors_headers_retryAfter() public view {
        string memory json = _read("headers");
        uint256 n = _count(json, "retryAfter.valid");
        for (uint256 i = 0; i < n; i++) {
            assertTrue(
                HeaderGrammar.isRetryAfter(vm.parseJsonString(json, _at("retryAfter.valid", i, "value"))),
                vm.parseJsonString(json, _at("retryAfter.valid", i, "name"))
            );
        }
        n = _count(json, "retryAfter.invalid");
        for (uint256 i = 0; i < n; i++) {
            assertFalse(
                HeaderGrammar.isRetryAfter(vm.parseJsonString(json, _at("retryAfter.invalid", i, "value"))),
                vm.parseJsonString(json, _at("retryAfter.invalid", i, "name"))
            );
        }
    }

    function test_vectors_headers_payerSig() public view {
        string memory json = _read("headers");
        uint256 n = _count(json, "payerSig.valid");
        for (uint256 i = 0; i < n; i++) {
            string memory name = vm.parseJsonString(json, _at("payerSig.valid", i, "name"));
            (bool ok, uint256 t, bytes memory sig) =
                HeaderGrammar.parsePayerSig(vm.parseJsonString(json, _at("payerSig.valid", i, "header")));
            assertTrue(ok, name);
            assertEq(t, vm.parseJsonUint(json, _at("payerSig.valid", i, "unixSeconds")), name);
            assertEq(sig, vm.parseJsonBytes(json, _at("payerSig.valid", i, "signature")), name);
            string memory requestId = vm.parseJsonString(json, _at("payerSig.valid", i, "requestId"));
            (bool idOk,) = HeaderGrammar.parseBytes32(requestId);
            assertTrue(idOk, name);
            assertEq(
                string(HeaderGrammar.payerSigMessage(requestId, t)),
                vm.parseJsonString(json, _at("payerSig.valid", i, "message")),
                name
            );
            bytes32 digest = HeaderGrammar.payerSigDigest(requestId, t);
            assertEq(digest, vm.parseJsonBytes32(json, _at("payerSig.valid", i, "digest")), name);
            assertEq(
                HeaderGrammar.recover(digest, sig), vm.parseJsonAddress(json, _at("payerSig.valid", i, "signer")), name
            );
        }
        n = _count(json, "payerSig.invalid");
        for (uint256 i = 0; i < n; i++) {
            (bool ok,,) = HeaderGrammar.parsePayerSig(vm.parseJsonString(json, _at("payerSig.invalid", i, "header")));
            assertFalse(ok, vm.parseJsonString(json, _at("payerSig.invalid", i, "name")));
        }
    }

    /// Valid cases: the decoded fields equal the vector's JSON, the signature recovers to the signer
    /// over registry.proofDigest on the vector's chain and address, and verifyProof gets past the
    /// signature check (UNKNOWN_SIGNER, since no signer is registered here).
    function test_vectors_headers_attestedProof_valid() public {
        string memory json = _read("headers");
        uint256 n = _count(json, "attestedProof.valid");
        for (uint256 i = 0; i < n; i++) {
            _checkAttestedProof(json, i);
        }
    }

    function _checkAttestedProof(string memory json, uint256 i) internal {
        string memory name = vm.parseJsonString(json, _at("attestedProof.valid", i, "name"));
        string memory header = vm.parseJsonString(json, _at("attestedProof.valid", i, "header"));
        string memory text = vm.parseJsonString(json, _at("attestedProof.valid", i, "json"));
        (bool b64, bytes memory decoded) = HeaderGrammar.decodeBase64(header);
        assertTrue(b64, name);
        assertEq(string(decoded), text, name);

        (HeaderGrammar.Err err, HeaderGrammar.AttestedProof memory a) = HeaderGrammar.decodeAttestedProof(header);
        assertEq(uint8(err), uint8(HeaderGrammar.Err.None), name);
        _assertProofFields(a.proof, text, name);
        assertEq(a.signature, vm.parseJsonBytes(json, _at("attestedProof.valid", i, "signature")), name);
        assertEq(a.signer, vm.parseJsonAddress(json, _at("attestedProof.valid", i, "signer")), name);

        EnclaveRegistry r = _registryAt(
            vm.parseJsonAddress(json, _at("attestedProof.valid", i, "verifyingContract")),
            vm.parseJsonUint(json, _at("attestedProof.valid", i, "chainId"))
        );
        assertEq(HeaderGrammar.recover(r.proofDigest(a.proof), a.signature), a.signer, name);
        assertEq(
            uint8(r.verifyProof(a.proof, a.signature, bytes32(0))), uint8(IEnclaveRegistry.Check.UNKNOWN_SIGNER), name
        );
    }

    function _assertProofFields(IEnclaveRegistry.ExecutionProof memory p, string memory text, string memory name)
        internal
        pure
    {
        assertEq(p.agentId, vm.parseJsonUint(text, ".proof.agentId"), name);
        assertEq(p.releaseId, vm.parseJsonBytes32(text, ".proof.releaseId"), name);
        assertEq(p.requestId, vm.parseJsonBytes32(text, ".proof.requestId"), name);
        assertEq(p.requestHash, vm.parseJsonBytes32(text, ".proof.requestHash"), name);
        assertEq(p.responseHash, vm.parseJsonBytes32(text, ".proof.responseHash"), name);
        assertEq(p.inputsHash, vm.parseJsonBytes32(text, ".proof.inputsHash"), name);
        assertEq(p.paymentId, vm.parseJsonBytes32(text, ".proof.paymentId"), name);
        assertEq(p.issuedAt, vm.parseJsonUint(text, ".proof.issuedAt"), name);
        assertEq(p.expiresAt, vm.parseJsonUint(text, ".proof.expiresAt"), name);
    }

    function _headerErr(string memory reason) internal pure returns (HeaderGrammar.Err) {
        bytes32 h = keccak256(bytes(reason));
        if (h == keccak256("base64")) return HeaderGrammar.Err.Base64;
        if (h == keccak256("not_jcs")) return HeaderGrammar.Err.NotJcs;
        if (h == keccak256("unknown_field")) return HeaderGrammar.Err.UnknownField;
        if (h == keccak256("missing_field")) return HeaderGrammar.Err.MissingField;
        if (h == keccak256("field_grammar")) return HeaderGrammar.Err.FieldGrammar;
        revert(string.concat("unknown attestedProof reason: ", reason));
    }

    function test_vectors_headers_attestedProof_invalid() public view {
        string memory json = _read("headers");
        uint256 n = _count(json, "attestedProof.invalid");
        for (uint256 i = 0; i < n; i++) {
            string memory name = vm.parseJsonString(json, _at("attestedProof.invalid", i, "name"));
            HeaderGrammar.Err expected = _headerErr(vm.parseJsonString(json, _at("attestedProof.invalid", i, "reason")));
            (HeaderGrammar.Err err,) =
                HeaderGrammar.decodeAttestedProof(vm.parseJsonString(json, _at("attestedProof.invalid", i, "header")));
            assertEq(uint8(err), uint8(expected), name);
        }
    }
}
