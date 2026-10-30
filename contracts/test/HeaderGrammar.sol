// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IEnclaveRegistry} from "../src/EnclaveRegistry.sol";

/// SPEC §2.5 header grammars in Solidity, for INV-18. Test-only: the registry never parses headers.
/// This exists to show each grammar reads the same way in Solidity as in TypeScript and Rust, by
/// running every case in vectors/headers.json through it (VectorsTest).
library HeaderGrammar {
    /// Why a header was refused. The names match the `reason` values in vectors/headers.json.
    enum Err {
        None,
        Base64,
        NotJcs,
        UnknownField,
        MissingField,
        FieldGrammar
    }

    struct AttestedProof {
        IEnclaveRegistry.ExecutionProof proof;
        bytes signature;
        address signer;
    }

    /// `<unixSeconds>` is held to a safe JS integer, the bound the TypeScript parser applies.
    uint256 internal constant MAX_UNIX_SECONDS = 2 ** 53 - 1;
    uint256 internal constant SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
    uint256 internal constant SECP256K1_N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    // ------------------------------------------------------------ scalar grammars

    /// `X-Request-Id` and `X-Attest-Challenge`: `0x[0-9a-f]{64}`.
    function parseBytes32(string memory v) internal pure returns (bool ok, bytes32 out) {
        bytes memory s = bytes(v);
        bytes memory b;
        (ok, b) = _hex(s, 0, s.length, 32);
        if (ok) out = bytes32(b);
    }

    /// `Retry-After`: whole seconds, `0|[1-9][0-9]*`.
    function isRetryAfter(string memory v) internal pure returns (bool) {
        bytes memory s = bytes(v);
        return _digits(s, 0, s.length);
    }

    /// `X-Attest-Payer-Sig`: `<unixSeconds>.<0x65-byte-hex>`.
    function parsePayerSig(string memory v)
        internal
        pure
        returns (bool ok, uint256 unixSeconds, bytes memory signature)
    {
        bytes memory s = bytes(v);
        uint256 dot = s.length;
        for (uint256 i = 0; i < s.length; i++) {
            if (s[i] == ".") {
                dot = i;
                break;
            }
        }
        if (dot == s.length) return (false, 0, "");
        (ok, unixSeconds) = _uint(s, 0, dot, MAX_UNIX_SECONDS);
        if (!ok) return (false, 0, "");
        (ok, signature) = _hex(s, dot + 1, s.length, 65);
        if (!ok) return (false, 0, "");
    }

    /// The ASCII string the payer signs: `attested-exec:results:<requestId lowercase>:<unixSeconds>`.
    function payerSigMessage(string memory requestId, uint256 unixSeconds) internal pure returns (bytes memory) {
        bytes memory id = bytes(requestId);
        bytes memory lower = new bytes(id.length);
        for (uint256 i = 0; i < id.length; i++) {
            bytes1 c = id[i];
            lower[i] = (c >= "A" && c <= "Z") ? bytes1(uint8(c) + 32) : c;
        }
        return abi.encodePacked("attested-exec:results:", lower, ":", _decimal(unixSeconds));
    }

    /// EIP-191 `personal_sign` digest of `payerSigMessage`.
    function payerSigDigest(string memory requestId, uint256 unixSeconds) internal pure returns (bytes32) {
        bytes memory m = payerSigMessage(requestId, unixSeconds);
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n", _decimal(m.length), m));
    }

    /// SPEC §2.3 signature rules: 65 bytes r ‖ s ‖ v, v in {27, 28}, high-s rejected. address(0) on refusal.
    function recover(bytes32 digest, bytes memory sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v = uint8(sig[64]);
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
        }
        if (v != 27 && v != 28) return address(0);
        if (uint256(r) == 0 || uint256(r) >= SECP256K1_N) return address(0);
        if (uint256(s) == 0 || uint256(s) > SECP256K1_N_HALF) return address(0);
        return ecrecover(digest, v, r, s);
    }

    // --------------------------------------------------------------- base64

    /// RFC 4648 standard alphabet with padding, canonical: non-empty, length a multiple of 4,
    /// `=` only as trailing padding, and the bits under the padding zero.
    function decodeBase64(string memory v) internal pure returns (bool ok, bytes memory out) {
        bytes memory s = bytes(v);
        uint256 n = s.length;
        if (n == 0 || n % 4 != 0) return (false, "");
        uint256 pad = s[n - 1] == "=" ? (s[n - 2] == "=" ? 2 : 1) : 0;
        out = new bytes((n / 4) * 3 - pad);
        uint256 acc;
        uint256 o;
        for (uint256 i = 0; i < n - pad; i++) {
            (bool okC, uint256 x) = _b64(s[i]);
            if (!okC) return (false, "");
            acc = (acc << 6) | x;
            if (i % 4 == 3) {
                out[o++] = bytes1(uint8(acc >> 16));
                out[o++] = bytes1(uint8(acc >> 8));
                out[o++] = bytes1(uint8(acc));
                acc = 0;
            }
        }
        if (pad == 2) {
            if (acc & 0xf != 0) return (false, "");
            out[o] = bytes1(uint8(acc >> 4));
        } else if (pad == 1) {
            if (acc & 0x3 != 0) return (false, "");
            out[o] = bytes1(uint8(acc >> 10));
            out[o + 1] = bytes1(uint8(acc >> 2));
        }
        return (true, out);
    }

    function _b64(bytes1 c) private pure returns (bool, uint256) {
        if (c >= "A" && c <= "Z") return (true, uint8(c) - 65);
        if (c >= "a" && c <= "z") return (true, uint8(c) - 71);
        if (c >= "0" && c <= "9") return (true, uint8(c) + 4);
        if (c == "+") return (true, 62);
        if (c == "/") return (true, 63);
        return (false, 0);
    }

    // ------------------------------------------------------- X-Attested-Proof

    // Object kinds the JSON reader walks: the top-level header object, its `proof`, anything else.
    uint8 private constant TOP = 0;
    uint8 private constant PROOF = 1;
    uint8 private constant OTHER = 2;

    // `seen` bits: proof fields 0-8 in JCS key order, then proof, signature, signer.
    uint256 private constant PROOF_FIELDS = (1 << 9) - 1;
    uint256 private constant SEEN_PROOF = 1 << 9;
    uint256 private constant SEEN_SIGNATURE = 1 << 10;
    uint256 private constant SEEN_SIGNER = 1 << 11;
    uint256 private constant TOP_FIELDS = SEEN_PROOF | SEEN_SIGNATURE | SEEN_SIGNER;

    struct Reader {
        bytes b;
        uint256 i;
        Err sem; // first field error; a syntax or canonical-form error outranks it
        uint256 seen;
        AttestedProof out;
    }

    /// `X-Attested-Proof`: base64 of JCS `{"proof":{...strings...},"signature":"0x...","signer":"0x..."}`.
    ///
    /// The JSON reader accepts the subset of JCS output a header can be: objects, strings without
    /// escapes, integers, true/false/null, no whitespace, keys strictly ascending. Anything outside it
    /// is not_jcs. Every field value is a string, so the accepted set is exactly the canonical form
    /// with each field matching its §2.3 grammar. Byte order of keys equals JCS's UTF-16 order for
    /// every key below U+E000, and no accepted key is outside ASCII.
    function decodeAttestedProof(string memory v) internal pure returns (Err, AttestedProof memory) {
        (bool ok, bytes memory text) = decodeBase64(v);
        AttestedProof memory empty;
        if (!ok) return (Err.Base64, empty);
        Reader memory r;
        r.b = text;
        if (!_object(r, TOP) || r.i != text.length) return (Err.NotJcs, empty);
        if (r.sem != Err.None) return (r.sem, empty);
        return (Err.None, r.out);
    }

    function _flag(Reader memory r, Err e) private pure {
        if (r.sem == Err.None) r.sem = e;
    }

    function _peek(Reader memory r) private pure returns (bytes1) {
        return r.i < r.b.length ? r.b[r.i] : bytes1(0);
    }

    function _eat(Reader memory r, bytes1 c) private pure returns (bool) {
        if (_peek(r) != c) return false;
        r.i++;
        return true;
    }

    function _object(Reader memory r, uint8 kind) private pure returns (bool) {
        if (!_eat(r, "{")) return false;
        if (!_eat(r, "}")) {
            uint256 prevStart;
            uint256 prevEnd;
            bool first = true;
            while (true) {
                (bool ok, uint256 ks, uint256 ke) = _string(r);
                if (!ok) return false;
                if (!first && !_less(r.b, prevStart, prevEnd, ks, ke)) return false;
                (first, prevStart, prevEnd) = (false, ks, ke);
                if (!_eat(r, ":")) return false;
                if (!_member(r, kind, ks, ke)) return false;
                if (_eat(r, ",")) continue;
                if (!_eat(r, "}")) return false;
                break;
            }
        }
        if (kind == TOP && r.seen & TOP_FIELDS != TOP_FIELDS) _flag(r, Err.MissingField);
        if (kind == PROOF && r.seen & PROOF_FIELDS != PROOF_FIELDS) _flag(r, Err.MissingField);
        return true;
    }

    /// A string token without escapes or control characters; returns the content's byte range.
    function _string(Reader memory r) private pure returns (bool, uint256 start, uint256 end) {
        if (!_eat(r, '"')) return (false, 0, 0);
        start = r.i;
        while (r.i < r.b.length) {
            bytes1 c = r.b[r.i];
            if (c == '"') {
                end = r.i;
                r.i++;
                return (true, start, end);
            }
            if (c == "\\" || uint8(c) < 0x20) return (false, 0, 0);
            r.i++;
        }
        return (false, 0, 0);
    }

    /// Any value, checked for syntax and canonical form only.
    function _skip(Reader memory r) private pure returns (bool) {
        bytes1 c = _peek(r);
        if (c == '"') {
            (bool ok,,) = _string(r);
            return ok;
        }
        if (c == "{") return _object(r, OTHER);
        if (c == "t") return _literal(r, "true");
        if (c == "f") return _literal(r, "false");
        if (c == "n") return _literal(r, "null");
        if (c == "-" || (c >= "0" && c <= "9")) return _integer(r);
        return false;
    }

    function _literal(Reader memory r, bytes memory word) private pure returns (bool) {
        for (uint256 k = 0; k < word.length; k++) {
            if (!_eat(r, word[k])) return false;
        }
        return true;
    }

    /// `-?(0|[1-9][0-9]*)`, not `-0`, and not followed by a fraction or exponent.
    function _integer(Reader memory r) private pure returns (bool) {
        bool neg = _eat(r, "-");
        uint256 start = r.i;
        while (_peek(r) >= "0" && _peek(r) <= "9") {
            r.i++;
        }
        if (r.i == start) return false;
        if (r.b[start] == "0" && (r.i - start > 1 || neg)) return false;
        bytes1 c = _peek(r);
        return c != "." && c != "e" && c != "E";
    }

    function _member(Reader memory r, uint8 kind, uint256 ks, uint256 ke) private pure returns (bool) {
        if (kind == TOP) {
            if (_keyIs(r.b, ks, ke, "proof")) {
                r.seen |= SEEN_PROOF;
                if (_peek(r) == "{") return _object(r, PROOF);
                _flag(r, Err.FieldGrammar);
                return _skip(r);
            }
            if (_keyIs(r.b, ks, ke, "signature")) {
                r.seen |= SEEN_SIGNATURE;
                return _field(r, 9);
            }
            if (_keyIs(r.b, ks, ke, "signer")) {
                r.seen |= SEEN_SIGNER;
                return _field(r, 10);
            }
            _flag(r, Err.UnknownField);
            return _skip(r);
        }
        if (kind == PROOF) {
            for (uint256 f = 0; f < 9; f++) {
                if (_keyIs(r.b, ks, ke, _proofKey(f))) {
                    r.seen |= 1 << f;
                    return _field(r, f);
                }
            }
            _flag(r, Err.UnknownField);
            return _skip(r);
        }
        return _skip(r);
    }

    /// Proof fields in JCS key order (0-8), then signature (9) and signer (10).
    function _proofKey(uint256 f) private pure returns (bytes memory) {
        if (f == 0) return "agentId";
        if (f == 1) return "expiresAt";
        if (f == 2) return "inputsHash";
        if (f == 3) return "issuedAt";
        if (f == 4) return "paymentId";
        if (f == 5) return "releaseId";
        if (f == 6) return "requestHash";
        if (f == 7) return "requestId";
        return "responseHash";
    }

    /// A string field: the value must be a string token that matches the field's grammar
    /// (SPEC §2.3 JSON encoding: integers decimal, bytes lowercase hex, addresses lowercase).
    function _field(Reader memory r, uint256 f) private pure returns (bool) {
        if (_peek(r) != '"') {
            _flag(r, Err.FieldGrammar);
            return _skip(r);
        }
        (bool ok, uint256 vs, uint256 ve) = _string(r);
        if (!ok) return false;
        bytes memory b = r.b;
        IEnclaveRegistry.ExecutionProof memory p = r.out.proof;
        bool good;
        uint256 n;
        bytes memory h;
        if (f == 0) {
            (good, n) = _uint(b, vs, ve, type(uint256).max);
            p.agentId = n;
        } else if (f == 1 || f == 3) {
            (good, n) = _uint(b, vs, ve, type(uint64).max);
            if (f == 1) p.expiresAt = uint64(n);
            else p.issuedAt = uint64(n);
        } else if (f == 9) {
            (good, h) = _hex(b, vs, ve, 65);
            r.out.signature = h;
        } else if (f == 10) {
            (good, h) = _hex(b, vs, ve, 20);
            if (good) r.out.signer = address(bytes20(h));
        } else {
            (good, h) = _hex(b, vs, ve, 32);
            bytes32 w = good ? bytes32(h) : bytes32(0);
            if (f == 2) p.inputsHash = w;
            else if (f == 4) p.paymentId = w;
            else if (f == 5) p.releaseId = w;
            else if (f == 6) p.requestHash = w;
            else if (f == 7) p.requestId = w;
            else p.responseHash = w;
        }
        if (!good) _flag(r, Err.FieldGrammar);
        return true;
    }

    // -------------------------------------------------------------- helpers

    function _keyIs(bytes memory b, uint256 s, uint256 e, bytes memory key) private pure returns (bool) {
        if (e - s != key.length) return false;
        for (uint256 k = 0; k < key.length; k++) {
            if (b[s + k] != key[k]) return false;
        }
        return true;
    }

    /// b[as:ae] < b[bs:be], bytewise.
    function _less(bytes memory b, uint256 aS, uint256 aE, uint256 bS, uint256 bE) private pure returns (bool) {
        uint256 la = aE - aS;
        uint256 lb = bE - bS;
        for (uint256 k = 0; k < la && k < lb; k++) {
            if (b[aS + k] != b[bS + k]) return b[aS + k] < b[bS + k];
        }
        return la < lb;
    }

    function _nibble(bytes1 c) private pure returns (bool, uint8) {
        if (c >= "0" && c <= "9") return (true, uint8(c) - 48);
        if (c >= "a" && c <= "f") return (true, uint8(c) - 87);
        return (false, 0);
    }

    /// s[from:to] is `0x` followed by exactly 2n lowercase hex digits.
    function _hex(bytes memory s, uint256 from, uint256 to, uint256 n) private pure returns (bool, bytes memory out) {
        if (to - from != 2 + 2 * n || s[from] != "0" || s[from + 1] != "x") return (false, "");
        out = new bytes(n);
        for (uint256 k = 0; k < n; k++) {
            (bool okH, uint8 hi) = _nibble(s[from + 2 + 2 * k]);
            (bool okL, uint8 lo) = _nibble(s[from + 3 + 2 * k]);
            if (!okH || !okL) return (false, "");
            out[k] = bytes1(hi * 16 + lo);
        }
        return (true, out);
    }

    /// s[from:to] is `0|[1-9][0-9]*`.
    function _digits(bytes memory s, uint256 from, uint256 to) private pure returns (bool) {
        if (to <= from) return false;
        if (s[from] == "0" && to - from > 1) return false;
        for (uint256 k = from; k < to; k++) {
            if (s[k] < "0" || s[k] > "9") return false;
        }
        return true;
    }

    /// s[from:to] is `0|[1-9][0-9]*` with a value at most `max`.
    function _uint(bytes memory s, uint256 from, uint256 to, uint256 max) private pure returns (bool, uint256 v) {
        if (!_digits(s, from, to)) return (false, 0);
        for (uint256 k = from; k < to; k++) {
            uint256 d = uint8(s[k]) - 48;
            if (v > (max - d) / 10) return (false, 0);
            v = v * 10 + d;
        }
        return (true, v);
    }

    function _decimal(uint256 v) private pure returns (bytes memory out) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) {
            len++;
        }
        out = new bytes(len);
        for (; v != 0; v /= 10) {
            out[--len] = bytes1(uint8(48 + (v % 10)));
        }
    }
}
