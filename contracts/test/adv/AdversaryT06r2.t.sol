// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {HeaderGrammar} from "../HeaderGrammar.sol";
import {AdvT06r2Cases as C} from "./AdvT06r2Cases.sol";

/// Adversary T06 r2. INV-18: the Solidity header grammars must agree with the TS core parser on every
/// input, not only on vectors/headers.json. Cases and TS verdicts come from
/// scripts/adversary-t06-r2/gen.ts (regenerate with `node scripts/adversary-t06-r2/gen.ts`).
contract AdversaryT06r2 is Test {
    function test_adv_bytes32_matchesTs() public pure {
        C.Scalar[] memory c = C.bytes32Cases();
        for (uint256 i = 0; i < c.length; i++) {
            (bool ok, bytes32 v) = HeaderGrammar.parseBytes32(string(c[i].value));
            assertEq(ok, c[i].accept, string(abi.encodePacked("bytes32 #", vm.toString(i))));
            if (ok) assertEq(v, bytes32(vm.parseBytes(string(c[i].value))));
        }
    }

    function test_adv_retryAfter_matchesTs() public pure {
        C.Scalar[] memory c = C.retryCases();
        for (uint256 i = 0; i < c.length; i++) {
            assertEq(
                HeaderGrammar.isRetryAfter(string(c[i].value)), c[i].accept, string.concat("retry #", vm.toString(i))
            );
        }
    }

    function test_adv_payerSig_matchesTs() public pure {
        C.Scalar[] memory c = C.payerCases();
        for (uint256 i = 0; i < c.length; i++) {
            (bool ok, uint256 t,) = HeaderGrammar.parsePayerSig(string(c[i].value));
            assertEq(ok, c[i].accept, string.concat("payerSig #", vm.toString(i)));
            if (ok) assertEq(t, c[i].n, string.concat("payerSig seconds #", vm.toString(i)));
        }
    }

    function _proofs(uint256 part) internal pure returns (C.Proof[] memory) {
        if (part == 0) return C.proofCases0();
        if (part == 1) return C.proofCases1();
        if (part == 2) return C.proofCases2();
        if (part == 3) return C.proofCases3();
        if (part == 4) return C.proofCases4();
        if (part == 5) return C.proofCases5();
        if (part == 6) return C.proofCases6();
        if (part == 7) return C.proofCases7();
        if (part == 8) return C.proofCases8();
        if (part == 9) return C.proofCases9();
        if (part == 10) return C.proofCases10();
        if (part == 11) return C.proofCases11();
        if (part == 12) return C.proofCases12();
        revert("regenerate: more proof parts than _proofs knows");
    }

    /// External so a revert inside the parser (for example an EVM stack overflow) is observable.
    function decode(string memory header)
        external
        pure
        returns (HeaderGrammar.Err, HeaderGrammar.AttestedProof memory)
    {
        return HeaderGrammar.decodeAttestedProof(header);
    }

    /// One part per external call, so memory starts fresh each time. `mode` 0: verdict and fields
    /// match TS (a revert counts as a refusal); 1: count reverts; 2: count refusal reasons that
    /// disagree with the text's JCS validity. Returns (cases, accepted, failures).
    function checkPart(uint256 part, uint8 mode) external view returns (uint256 n, uint256 accepted, uint256 bad) {
        C.Proof[] memory c = _proofs(part);
        n = c.length;
        for (uint256 i = 0; i < c.length; i++) {
            HeaderGrammar.Err err = HeaderGrammar.Err.NotJcs;
            HeaderGrammar.AttestedProof memory a;
            bool reverted = true;
            try this.decode{gas: 30_000_000}(string(c[i].header)) returns (
                HeaderGrammar.Err e, HeaderGrammar.AttestedProof memory got
            ) {
                (err, a, reverted) = (e, got, false);
            } catch {}
            bool ok = err == HeaderGrammar.Err.None;
            if (mode == 1) {
                if (reverted) {
                    bad++;
                    console2.log("reverted:", c[i].name);
                }
                continue;
            }
            if (mode == 2) {
                if (c[i].accept || reverted) continue;
                bool syntax = err == HeaderGrammar.Err.NotJcs || err == HeaderGrammar.Err.Base64;
                if (syntax == c[i].jcsValid) {
                    bad++;
                    console2.log(
                        c[i].jcsValid ? "valid JCS, refused as syntax:" : "not JCS, refused as field:",
                        c[i].name,
                        uint8(err)
                    );
                }
                continue;
            }
            assertEq(ok, c[i].accept, c[i].name);
            if (!ok) continue;
            accepted++;
            assertEq(a.proof.inputsHash, c[i].b[0], c[i].name);
            assertEq(a.proof.paymentId, c[i].b[1], c[i].name);
            assertEq(a.proof.releaseId, c[i].b[2], c[i].name);
            assertEq(a.proof.requestHash, c[i].b[3], c[i].name);
            assertEq(a.proof.requestId, c[i].b[4], c[i].name);
            assertEq(a.proof.responseHash, c[i].b[5], c[i].name);
            assertEq(a.proof.agentId, c[i].agentId, c[i].name);
            assertEq(a.proof.expiresAt, c[i].expiresAt, c[i].name);
            assertEq(a.proof.issuedAt, c[i].issuedAt, c[i].name);
            assertEq(a.signature, c[i].signature, c[i].name);
            assertEq(a.signer, c[i].signer, c[i].name);
        }
    }

    /// Each test runs one part of the cases, under the default per-test gas limit.
    /// mode 0, INV-18: accept/refuse verdict and every decoded field equal TS decodeAttestedProof.
    /// mode 1: every header gets a verdict; none makes the parser revert (TS refuses all cleanly).
    /// mode 2: a text that is valid JCS (TS: strict base64, UTF-8, jcs(parse(t)) == t) is not refused
    /// as not_jcs/base64, and one that is not JCS is refused as one of those.
    function _run(uint256 part, uint8 mode) internal view {
        if (part >= C.PROOF_PARTS) return;
        (uint256 n, uint256 accepted, uint256 bad) = this.checkPart(part, mode);
        assertGt(n, 0);
        if (mode == 0) console2.log("cases", n, "accepted", accepted);
        if (mode == 1) assertEq(bad, 0, "decodeAttestedProof reverted instead of refusing");
        if (mode == 2) assertEq(bad, 0, "refusal reason disagrees with JCS validity");
    }

    function test_adv_partsCovered() public pure {
        assertEq(C.PROOF_PARTS, 13, "regenerate: update _proofs and the per-part tests");
    }

    function test_adv_attestedProof_verdictMatchesTs_00() public view {
        _run(0, 0);
    }

    function test_adv_attestedProof_verdictMatchesTs_01() public view {
        _run(1, 0);
    }

    function test_adv_attestedProof_verdictMatchesTs_02() public view {
        _run(2, 0);
    }

    function test_adv_attestedProof_verdictMatchesTs_03() public view {
        _run(3, 0);
    }

    function test_adv_attestedProof_verdictMatchesTs_04() public view {
        _run(4, 0);
    }

    function test_adv_attestedProof_verdictMatchesTs_05() public view {
        _run(5, 0);
    }

    function test_adv_attestedProof_verdictMatchesTs_06() public view {
        _run(6, 0);
    }

    function test_adv_attestedProof_verdictMatchesTs_07() public view {
        _run(7, 0);
    }

    function test_adv_attestedProof_verdictMatchesTs_08() public view {
        _run(8, 0);
    }

    function test_adv_attestedProof_verdictMatchesTs_09() public view {
        _run(9, 0);
    }

    function test_adv_attestedProof_verdictMatchesTs_10() public view {
        _run(10, 0);
    }

    function test_adv_attestedProof_verdictMatchesTs_11() public view {
        _run(11, 0);
    }

    function test_adv_attestedProof_verdictMatchesTs_12() public view {
        _run(12, 0);
    }

    function test_adv_attestedProof_neverReverts_00() public view {
        _run(0, 1);
    }

    function test_adv_attestedProof_neverReverts_01() public view {
        _run(1, 1);
    }

    function test_adv_attestedProof_neverReverts_02() public view {
        _run(2, 1);
    }

    function test_adv_attestedProof_neverReverts_03() public view {
        _run(3, 1);
    }

    function test_adv_attestedProof_neverReverts_04() public view {
        _run(4, 1);
    }

    function test_adv_attestedProof_neverReverts_05() public view {
        _run(5, 1);
    }

    function test_adv_attestedProof_neverReverts_06() public view {
        _run(6, 1);
    }

    function test_adv_attestedProof_neverReverts_07() public view {
        _run(7, 1);
    }

    function test_adv_attestedProof_neverReverts_08() public view {
        _run(8, 1);
    }

    function test_adv_attestedProof_neverReverts_09() public view {
        _run(9, 1);
    }

    function test_adv_attestedProof_neverReverts_10() public view {
        _run(10, 1);
    }

    function test_adv_attestedProof_neverReverts_11() public view {
        _run(11, 1);
    }

    function test_adv_attestedProof_neverReverts_12() public view {
        _run(12, 1);
    }

    function test_adv_attestedProof_reasonClassMatchesJcs_00() public view {
        _run(0, 2);
    }

    function test_adv_attestedProof_reasonClassMatchesJcs_01() public view {
        _run(1, 2);
    }

    function test_adv_attestedProof_reasonClassMatchesJcs_02() public view {
        _run(2, 2);
    }

    function test_adv_attestedProof_reasonClassMatchesJcs_03() public view {
        _run(3, 2);
    }

    function test_adv_attestedProof_reasonClassMatchesJcs_04() public view {
        _run(4, 2);
    }

    function test_adv_attestedProof_reasonClassMatchesJcs_05() public view {
        _run(5, 2);
    }

    function test_adv_attestedProof_reasonClassMatchesJcs_06() public view {
        _run(6, 2);
    }

    function test_adv_attestedProof_reasonClassMatchesJcs_07() public view {
        _run(7, 2);
    }

    function test_adv_attestedProof_reasonClassMatchesJcs_08() public view {
        _run(8, 2);
    }

    function test_adv_attestedProof_reasonClassMatchesJcs_09() public view {
        _run(9, 2);
    }

    function test_adv_attestedProof_reasonClassMatchesJcs_10() public view {
        _run(10, 2);
    }

    function test_adv_attestedProof_reasonClassMatchesJcs_11() public view {
        _run(11, 2);
    }

    function test_adv_attestedProof_reasonClassMatchesJcs_12() public view {
        _run(12, 2);
    }
}
