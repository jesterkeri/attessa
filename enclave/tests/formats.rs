//! SPEC §2 formats against values computed independently with Foundry `cast` 1.8.1
//! (keccak, abi-encode, `wallet sign --data` for EIP-712). Key = scalar 1, a public dummy.

mod common;

use attessa_enclave::enclave::sign;
use attessa_enclave::formats::*;
use common::{hex32, recover};
use k256::ecdsa::SigningKey;
use serde_json::json;

const ORIGIN_HASH: &str = "0xedba3f8cfcd4165f73cd4641ced2b2ec0d3ba4338e3eec30edd58777d86b53b2";
const RELEASE_ID: &str = "0x79415a8460aad0c8ae8d2eb4b4c7a7cb2d4d546b453e170add25071572b0fd69";
const REQUEST_HASH: &str = "0xcb031aac258cff653c347294959904eca3b9161d5116a69aec6793755ff3d647";
const ADDRESS_OF_KEY_ONE: &str = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";

fn registry() -> [u8; 20] {
    [0x11; 20]
}

fn chain() -> [u8; 32] {
    parse_u256("11142220").unwrap()
}

#[test]
fn origin_normalisation() {
    let ok = [
        ("https://example.com", "https://example.com"),
        (
            "https://Example.COM:443/path?q=1#frag",
            "https://example.com",
        ),
        ("https://example.com:8443/", "https://example.com:8443"),
        ("https://faß.de:8443", "https://xn--fa-hia.de:8443"),
        ("https://Bücher.example", "https://xn--bcher-kva.example"),
        ("https://a", "https://a"),
    ];
    for (input, want) in ok {
        assert_eq!(normalize_origin(input).as_deref(), Some(want), "{input}");
    }
    let bad = [
        "http://example.com",
        "http://localhost:8080",
        "https://example.com.",
        "https://1.2.3.4",
        "https://[::1]",
        "https://user:pw@example.com",
        "https://user@example.com",
        "ftp://example.com",
        "not a url",
    ];
    for input in bad {
        assert_eq!(normalize_origin(input), None, "{input}");
    }
}

#[test]
fn origin_length_bounds() {
    // "https://" + host = 267 bytes is the maximum; labels of 63 chars keep it a valid DNS name.
    let label = "a".repeat(63);
    let host_259 = format!("{label}.{label}.{label}.{label}.{}", "b".repeat(3));
    assert_eq!(host_259.len(), 259);
    let max = format!("https://{host_259}");
    assert_eq!(max.len(), 267);
    assert_eq!(normalize_origin(&max).as_deref(), Some(max.as_str()));
    let over = format!("https://{host_259}b");
    assert_eq!(over.len(), 268);
    assert_eq!(normalize_origin(&over), None);
}

#[test]
fn origin_hash_matches_cast() {
    assert_eq!(to_hex(&origin_hash("https://example.com")), ORIGIN_HASH);
    assert_eq!(
        to_hex(&origin_hash("https://xn--fa-hia.de:8443")),
        "0x152d7cb4e451ad4269e8d795aa60f10d7e77f957ce7e9f21ff4a5c5d62784d62"
    );
}

#[test]
fn request_hash_matches_cast() {
    assert_eq!(
        to_hex(&request_hash("POST", "/v1/evaluate", br#"{"a":1}"#)),
        REQUEST_HASH
    );
}

#[test]
fn release_id_matches_cast() {
    assert_eq!(
        to_hex(&release_id(&[1; 48], &[2; 48], &[3; 48])),
        RELEASE_ID
    );
}

#[test]
fn user_data_matches_cast_abi_encode() {
    let agent = parse_u256("7").unwrap();
    let ud = binding_user_data(&chain(), &registry(), &agent, &hex32(ORIGIN_HASH));
    assert_eq!(ud.len(), 160);
    assert_eq!(
        to_hex(&ud),
        "0xb24622f3f6428908d4d6e4f6326726cb263a0d74b13db222bbaaac66273a5fb1\
         0000000000000000000000000000000000000000000000000000000000aa044c\
         0000000000000000000000001111111111111111111111111111111111111111\
         0000000000000000000000000000000000000000000000000000000000000007\
         edba3f8cfcd4165f73cd4641ced2b2ec0d3ba4338e3eec30edd58777d86b53b2"
    );
}

fn proof() -> ExecutionProof {
    ExecutionProof {
        agent_id: parse_u256("7").unwrap(),
        release_id: hex32(RELEASE_ID),
        request_id: [0xaa; 32],
        request_hash: hex32(REQUEST_HASH),
        response_hash: [0xbb; 32],
        inputs_hash: [0xcc; 32],
        payment_id: [0xdd; 32],
        issued_at: 1_761_782_400,
        expires_at: 1_761_783_000,
    }
}

#[test]
fn eip712_digests_match_cast() {
    let ds = domain_separator(&chain(), &registry());
    assert_eq!(
        to_hex(&ds),
        "0xa674b309cfb52e6f7210e49b71ffe21356ff2dcbc22aa611b01e02a2beb6f952"
    );
    assert_eq!(
        to_hex(&typed_digest(&ds, &proof().struct_hash())),
        "0xed795a8e048f4b347590db076b4bde215e902c2d280bbc42a8815a43f353b302"
    );
    let live = Liveness {
        agent_id: parse_u256("7").unwrap(),
        release_id: hex32(RELEASE_ID),
        origin_hash: hex32(ORIGIN_HASH),
        challenge: [0xee; 32],
        issued_at: 1_761_782_400,
    };
    assert_eq!(
        to_hex(&typed_digest(&ds, &live.struct_hash())),
        "0x46ce5fd2762b8314c4955f86b7194b3ba6a0cadebf70cff08565dfaddf588e72"
    );
}

#[test]
fn proof_signature_byte_identical_to_cast_wallet_sign() {
    let key = SigningKey::from_slice(&common::key_one()).unwrap();
    let digest = typed_digest(
        &domain_separator(&chain(), &registry()),
        &proof().struct_hash(),
    );
    let sig = to_hex(&sign(&key, &digest));
    assert_eq!(
        sig,
        "0xe85b2efde6dc9a2bf5bcd858e542579cd4c151596f4b2f5f6828329133e028874a2cdc17498e05a60604c62491dff8dfdbde460c2fb43ff8a50e592cb677e0aa1c"
    );
    assert_eq!(recover(&digest, &sig), ADDRESS_OF_KEY_ONE);
}

#[test]
fn signatures_are_low_s_with_v_27_or_28() {
    let key = SigningKey::from_slice(&[0x5a; 32]).unwrap();
    for i in 0..64u8 {
        let digest = keccak(&[i]);
        let sig = to_hex(&sign(&key, &digest));
        recover(&digest, &sig); // asserts low-s and v in {27, 28}
    }
}

#[test]
fn inputs_hash_matches_cast() {
    let inputs = common::inputs(common::PAY_TO, "0x", "0");
    let canonical = jcs(&inputs).unwrap();
    assert_eq!(
        canonical,
        r#"{"block":{"hash":"0x1234567890123456789012345678901234567890123456789012345678901234","number":"123","timestamp":"1761782400"},"payTo":{"address":"0x2222222222222222222222222222222222222222","balanceWei":"5","code":"0x","nonce":"0"},"source":"forno"}"#
    );
    assert_eq!(
        to_hex(&keccak(canonical.as_bytes())),
        "0x7e5410effef66515369524976bf9cd172ff76bd3ff34fd9d2cdeb54e7102e13f"
    );
}

#[test]
fn jcs_escaping_and_utf16_key_order() {
    // RFC 8785 §3.2.3: keys sort by UTF-16 code units, so U+1F600 (D83D..) sorts before U+FB33.
    let v = json!({"\u{fb33}": "1", "\u{1f600}": "2", "b": "\"\\\u{8}\u{c}\n\r\t\u{1}\u{1f}é", "a": [true, null]});
    assert_eq!(
        jcs(&v).unwrap(),
        "{\"a\":[true,null],\"b\":\"\\\"\\\\\\b\\f\\n\\r\\t\\u0001\\u001fé\",\"\u{1f600}\":\"2\",\"\u{fb33}\":\"1\"}"
    );
    assert_eq!(jcs(&json!({"n": 1})), None, "numbers are refused");
}

#[test]
fn decimal_and_hex_grammar() {
    assert!(is_dec("0") && is_dec("1") && is_dec(&"9".repeat(78)));
    for bad in ["", "01", "+1", "-1", "1.0", " 1", "1e3", "0x1"] {
        assert!(!is_dec(bad), "{bad}");
    }
    assert!(!is_dec(&"9".repeat(79)));
    let max = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    assert_eq!(parse_u256(max), Some([0xff; 32]));
    assert_eq!(
        parse_u256(
            "115792089237316195423570985008687907853269984665640564039457584007913129639936"
        ),
        None
    );
    assert_eq!(parse_bytes32(&format!("0x{}", "AB".repeat(32))), None);
    assert_eq!(
        parse_address("0x22222222222222222222222222222222222222"),
        None
    );
    assert_eq!(parse_hex("0x0", None), None);
    assert_eq!(parse_hex("0x", None), Some(vec![]));
    assert_eq!(parse_hex("12", None), None);
}
