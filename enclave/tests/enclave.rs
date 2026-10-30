//! Enclave behaviour (SPEC §4, INV-15, INV-16, INV-17, INV-22).

mod common;

use attessa_enclave::enclave::{serve_connection, write_frame, Enclave, MAX_FRAME};
use attessa_enclave::formats::*;
use attessa_enclave::rules::{self, Inputs, RequestBody};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use common::*;
use serde_json::{json, Value};
use std::io::{Cursor, Read, Write};
use std::sync::Mutex;

const LIVENESS_SIG_KEY_ONE: &str = "0x3077ea189cff91c1d49fc66ccee563c3537ef26b0032007890fb5dd62e9e24b17c118f9557475700fcd40e47c056b8d7a71ec2376b76f6de073b8e7fdc2329271c";

fn s(v: &Value) -> &str {
    v.as_str().expect("string field")
}

fn domain() -> [u8; 32] {
    domain_separator(&parse_u256("11142220").unwrap(), &[0x11; 20])
}

fn proof_digest(p: &Value) -> [u8; 32] {
    let proof = ExecutionProof {
        agent_id: parse_u256(s(&p["agentId"])).unwrap(),
        release_id: hex32(s(&p["releaseId"])),
        request_id: hex32(s(&p["requestId"])),
        request_hash: hex32(s(&p["requestHash"])),
        response_hash: hex32(s(&p["responseHash"])),
        inputs_hash: hex32(s(&p["inputsHash"])),
        payment_id: hex32(s(&p["paymentId"])),
        issued_at: s(&p["issuedAt"]).parse().unwrap(),
        expires_at: s(&p["expiresAt"]).parse().unwrap(),
    };
    typed_digest(&domain(), &proof.struct_hash())
}

#[test]
fn configure_binds_normalised_origin_and_attests_key() {
    let (mut e, attested) = configured(key_one());
    let reply = call(&mut e, &json!({"type": "attest"}));
    assert_eq!(
        s(&reply["signer"]),
        "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
    );
    let calls = attested.lock().unwrap();
    assert_eq!(
        calls.len(),
        2,
        "one attestation at configure, one per attest"
    );
    let (user_data, public_key) = &calls[1];
    let want = binding_user_data(
        &parse_u256("11142220").unwrap(),
        &[0x11; 20],
        &parse_u256("7").unwrap(),
        &origin_hash("https://example.com"),
    );
    assert_eq!(user_data, &want);
    assert_eq!(public_key.len(), 65);
    assert_eq!(public_key[0], 0x04);
    assert_eq!(
        to_hex(&keccak(&public_key[1..])[12..]),
        "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
    );
    let doc = B64.decode(s(&reply["attestation"])).unwrap();
    assert_eq!(doc, [b"FAKE-COSE".as_slice(), &want, public_key].concat());
}

#[test]
fn liveness_signature_matches_cast_and_fields_are_strings() {
    let (mut e, _) = configured(key_one());
    let challenge = format!("0x{}", "ee".repeat(32));
    let reply = call(&mut e, &json!({"type": "liveness", "challenge": challenge}));
    assert_eq!(
        reply["liveness"],
        json!({
            "agentId": "7",
            "releaseId": "0x79415a8460aad0c8ae8d2eb4b4c7a7cb2d4d546b453e170add25071572b0fd69",
            "originHash": "0xedba3f8cfcd4165f73cd4641ced2b2ec0d3ba4338e3eec30edd58777d86b53b2",
            "challenge": challenge,
            "issuedAt": "1761782400",
        })
    );
    assert_eq!(s(&reply["signature"]), LIVENESS_SIG_KEY_ONE);
    let bad = call(
        &mut e,
        &json!({"type": "liveness", "challenge": format!("0x{}", "EE".repeat(32))}),
    );
    assert_eq!(bad, json!({"error": "bad_frame"}));
}

#[test]
fn evaluate_signs_a_verifiable_proof() {
    let (mut e, _) = configured([0x42; 32]);
    let signer = s(&call(&mut e, &json!({"type": "attest"}))["signer"]).to_string();
    let body = body("11142220", PAY_TO, SEPOLIA_USDC, "5");
    let reply = call(&mut e, &evaluate_msg(&body, inputs(PAY_TO, "0x", "3")));
    let response = B64.decode(s(&reply["response"])).unwrap();
    let p = &reply["proof"];
    assert_eq!(s(&p["agentId"]), "7");
    assert_eq!(s(&p["requestId"]), format!("0x{}", "aa".repeat(32)));
    assert_eq!(s(&p["paymentId"]), format!("0x{}", "dd".repeat(32)));
    assert_eq!(
        s(&p["requestHash"]),
        to_hex(&request_hash("POST", "/v1/evaluate", &body))
    );
    assert_eq!(s(&p["responseHash"]), to_hex(&keccak(&response)));
    let parsed: Value = serde_json::from_slice(&response).unwrap();
    assert_eq!(parsed["verdict"], "allow");
    assert_eq!(parsed["reasons"], json!([]));
    assert_eq!(parsed["rulesVersion"], "1");
    assert_eq!(
        s(&p["inputsHash"]),
        to_hex(&keccak(jcs(&parsed["inputs"]).unwrap().as_bytes())),
        "inputsHash == keccak256(JCS(response.inputs)) (INV-17)"
    );
    assert_eq!(parsed["inputs"], inputs(PAY_TO, "0x", "3"));
    assert_eq!(s(&p["issuedAt"]), CLOCK.to_string());
    assert_eq!(s(&p["expiresAt"]), (CLOCK + 600).to_string());
    assert_eq!(recover(&proof_digest(p), s(&reply["signature"])), signer);
    // Every response frame is itself JCS.
    let raw = e
        .handle(
            evaluate_msg(&body, inputs(PAY_TO, "0x", "3"))
                .to_string()
                .as_bytes(),
        )
        .unwrap();
    let v: Value = serde_json::from_slice(&raw).unwrap();
    assert_eq!(jcs(&v).unwrap().into_bytes(), raw);
}

#[test]
fn second_configure_is_bad_frame_and_binding_unchanged() {
    let (mut e, attested) = configured(key_one());
    let before = attested.lock().unwrap()[0].clone();
    let mut other = configure_msg("8");
    other["origin"] = json!("https://other.example");
    assert_eq!(call(&mut e, &other), json!({"error": "bad_frame"}));
    assert_eq!(
        call(&mut e, &configure_msg("7")),
        json!({"error": "bad_frame"})
    );
    let reply = call(&mut e, &json!({"type": "attest"}));
    assert_eq!(
        s(&reply["signer"]),
        "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
    );
    let calls = attested.lock().unwrap();
    assert_eq!(calls.len(), 2, "rejected configures attest nothing");
    assert_eq!(calls[1], before, "binding and key unchanged");
    drop(calls);
    let live = call(
        &mut e,
        &json!({"type": "liveness", "challenge": format!("0x{}", "ee".repeat(32))}),
    );
    assert_eq!(live["liveness"]["agentId"], "7");
}

#[test]
fn requests_before_configure_are_not_configured() {
    let mut e = Enclave::new(FakeNsm::with_key(key_one()), fixed_clock);
    let ev = evaluate_msg(
        &body("11142220", PAY_TO, SEPOLIA_USDC, "5"),
        inputs(PAY_TO, "0x", "3"),
    );
    for msg in [
        json!({"type": "attest"}),
        json!({"type": "liveness", "challenge": format!("0x{}", "ee".repeat(32))}),
        ev,
    ] {
        assert_eq!(call(&mut e, &msg), json!({"error": "not_configured"}));
    }
}

#[test]
fn malformed_frames_are_bad_frame() {
    let (mut e, _) = configured(key_one());
    for frame in [
        &b"not json"[..],
        b"{}",
        b"[]",
        br#"{"type":"nope"}"#,
        br#"{"type":1}"#,
        br#"{"type":"attest","x":"1"}"#,
    ] {
        assert_eq!(
            call_raw(&mut e, frame),
            json!({"error": "bad_frame"}),
            "{}",
            String::from_utf8_lossy(frame)
        );
    }
}

#[test]
fn invalid_configure_is_rejected_and_does_not_use_up_the_one_shot() {
    let mut e = Enclave::new(FakeNsm::with_key(key_one()), fixed_clock);
    let mut bad = Vec::new();
    for (field, value) in [
        ("origin", json!("http://example.com")),
        ("origin", json!("https://1.2.3.4")),
        ("origin", json!("https://example.com.")),
        ("chainId", json!("011142220")),
        ("chainId", json!(11142220)),
        (
            "registry",
            json!("0x111111111111111111111111111111111111111A"),
        ),
        ("agentId", json!("-1")),
        ("rpcAllowedChains", json!(["x"])),
    ] {
        let mut m = configure_msg("7");
        m[field] = value;
        bad.push(m);
    }
    let mut extra = configure_msg("7");
    extra["extra"] = json!("1");
    bad.push(extra);
    let mut missing = configure_msg("7");
    missing.as_object_mut().unwrap().remove("rpcAllowedChains");
    bad.push(missing);
    for m in bad {
        assert_eq!(call(&mut e, &m), json!({"error": "bad_frame"}), "{m}");
    }
    assert!(call(&mut e, &configure_msg("7")).get("signer").is_some());
}

#[test]
fn nsm_unavailable_is_fatal() {
    let mut nsm = FakeNsm::with_key(key_one());
    nsm.fail = true;
    let mut e = Enclave::new(nsm, fixed_clock);
    assert!(e.handle(configure_msg("7").to_string().as_bytes()).is_err());
}

#[test]
fn key_retries_out_of_range_random() {
    // The curve order n and zero are out of range; the third draw is used.
    let n = hex32("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
    let mut nsm = FakeNsm::with_key(key_one());
    nsm.random = vec![n.to_vec(), vec![0; 32], key_one().to_vec()];
    let mut e = Enclave::new(nsm, fixed_clock);
    let reply = call(&mut e, &configure_msg("7"));
    assert_eq!(
        s(&reply["signer"]),
        "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
    );
}

fn eval_with(e: &mut Enclave<FakeNsm>, body: &[u8], inputs: Value) -> Value {
    call(e, &evaluate_msg(body, inputs))
}

#[test]
fn bad_request_cases() {
    let (mut e, _) = configured(key_one());
    let upper_pay_to = "0x22222222222222222222222222222222222222AA";
    let upper_asset = "0x01C5C0122039549AD1493B8220CABEDD739BC44E";
    let cases: Vec<Vec<u8>> = vec![
        body("11142220", upper_pay_to, SEPOLIA_USDC, "5"),
        body("11142220", PAY_TO, upper_asset, "5"),
        body("42220", PAY_TO, SEPOLIA_USDC, "5"),
        body("011142220", PAY_TO, SEPOLIA_USDC, "5"),
        body("11142220", PAY_TO, SEPOLIA_USDC, "01"),
        body("11142220", PAY_TO, SEPOLIA_USDC, "+1"),
        body("11142220", PAY_TO, SEPOLIA_USDC, "1.0"),
        body("11142220", PAY_TO, SEPOLIA_USDC, "-1"),
        body("11142220", PAY_TO, SEPOLIA_USDC, ""),
        body("11142220", PAY_TO, SEPOLIA_USDC, &"9".repeat(79)),
        br#"{"chainId":"11142220","payTo":"0x2222222222222222222222222222222222222222","asset":"0x01c5c0122039549ad1493b8220cabedd739bc44e","amount":5}"#.to_vec(),
        br#"{"chainId":"11142220","payTo":"0x2222222222222222222222222222222222222222","asset":"0x01c5c0122039549ad1493b8220cabedd739bc44e"}"#.to_vec(),
        br#"{"chainId":"11142220","payTo":"0x2222222222222222222222222222222222222222","asset":"0x01c5c0122039549ad1493b8220cabedd739bc44e","amount":"5","x":"1"}"#.to_vec(),
        br#"{"chainId":"11142220","payTo":"0x2222222222222222222222222222222222222222","payTo":"0x2222222222222222222222222222222222222222","asset":"0x01c5c0122039549ad1493b8220cabedd739bc44e","amount":"5"}"#.to_vec(),
        b"[]".to_vec(),
        b"not json".to_vec(),
        format!(
            r#"{{"chainId":"11142220","payTo":"{PAY_TO}","asset":"{SEPOLIA_USDC}","amount":"5"}}{}"#,
            " ".repeat(2048)
        )
        .into_bytes(),
    ];
    for b in cases {
        assert_eq!(
            eval_with(&mut e, &b, inputs(PAY_TO, "0x", "3")),
            json!({"error": "bad_request"}),
            "{}",
            String::from_utf8_lossy(&b)
        );
    }
    // 78 digits is the top of the grammar; leading/trailing whitespace stays valid JSON.
    let ok = body("11142220", PAY_TO, SEPOLIA_USDC, &"9".repeat(78));
    assert!(eval_with(&mut e, &ok, inputs(PAY_TO, "0x", "3"))
        .get("proof")
        .is_some());
}

#[test]
fn bad_inputs_cases() {
    let (mut e, _) = configured(key_one());
    let b = body("11142220", PAY_TO, SEPOLIA_USDC, "5");
    let mut cases = vec![
        inputs("0x3333333333333333333333333333333333333333", "0x", "3"),
        inputs("0x22222222222222222222222222222222222222AA", "0x", "3"),
        inputs(PAY_TO, "0x6", "3"),
        inputs(PAY_TO, "0x6A", "3"),
        inputs(PAY_TO, "0x", "03"),
        json!("string"),
    ];
    let mut tweak = |path: &[&str], v: Value| {
        let mut i = inputs(PAY_TO, "0x", "3");
        let mut cur = &mut i;
        for p in &path[..path.len() - 1] {
            cur = &mut cur[*p];
        }
        cur[path[path.len() - 1]] = v;
        cases.push(i);
    };
    tweak(&["block", "hash"], json!(format!("0x{}", "AB".repeat(32))));
    tweak(&["block", "number"], json!(123));
    tweak(&["block", "timestamp"], json!("1.5"));
    tweak(&["payTo", "balanceWei"], json!(null));
    tweak(&["source"], json!("buy:"));
    tweak(&["source"], json!("rpc"));
    tweak(&["source"], json!("buy:a b"));
    tweak(&["extra"], json!("1"));
    tweak(&["payTo", "extra"], json!("1"));
    for i in cases {
        assert_eq!(
            eval_with(&mut e, &b, i.clone()),
            json!({"error": "bad_inputs"}),
            "{i}"
        );
    }
    let mut ok = inputs(PAY_TO, "0x", "3");
    ok["source"] = json!("buy:celo-rpc.v1");
    assert!(eval_with(&mut e, &b, ok).get("proof").is_some());
}

#[test]
fn malformed_evaluate_messages_are_bad_frame() {
    let (mut e, _) = configured(key_one());
    let good = evaluate_msg(
        &body("11142220", PAY_TO, SEPOLIA_USDC, "5"),
        inputs(PAY_TO, "0x", "3"),
    );
    let zero = format!("0x{}", "00".repeat(32));
    for (field, value) in [
        ("paymentId", json!(zero)),
        ("paymentId", json!(null)),
        ("requestId", json!(format!("0x{}", "AA".repeat(32)))),
        ("body", json!("%%%")),
        ("method", json!("post")),
        ("method", json!("")),
        ("path", json!("v1/evaluate")),
        ("path", json!("/v1/\u{0}evaluate")),
        ("extra", json!("1")),
    ] {
        let mut m = good.clone();
        m[field] = value;
        assert_eq!(call(&mut e, &m), json!({"error": "bad_frame"}), "{field}");
    }
    let mut m = good.clone();
    m.as_object_mut().unwrap().remove("paymentId");
    assert_eq!(
        call(&mut e, &m),
        json!({"error": "bad_frame"}),
        "absent paymentId"
    );
}

// ---------- rules v1 ----------

fn req(chain_id: &str, pay_to: &str, asset: &str, amount: &str) -> RequestBody {
    rules::parse_request(&body(chain_id, pay_to, asset, amount), chain_id).unwrap()
}

fn verdict(r: &RequestBody, code: &str, nonce: &str, deny: &[&str]) -> Value {
    let i: Inputs = rules::parse_inputs(&inputs(&r.pay_to, code, nonce).to_string(), r).unwrap();
    let denylist: Vec<String> = deny.iter().map(|s| s.to_string()).collect();
    let v: Value = serde_json::from_slice(&rules::evaluate(r, &i, &denylist)).unwrap();
    json!([v["verdict"], v["reasons"]])
}

#[test]
fn rules_v1_each_rule_and_order() {
    let usdc = SEPOLIA_USDC;
    assert_eq!(
        verdict(&req("11142220", PAY_TO, usdc, "5"), "0x", "1", &[]),
        json!(["allow", []])
    );
    assert_eq!(
        verdict(
            &req(
                "11142220",
                PAY_TO,
                "0x0000000000000000000000000000000000000001",
                "5"
            ),
            "0x",
            "1",
            &[]
        ),
        json!(["deny", ["unknown_asset"]])
    );
    assert_eq!(
        verdict(&req("11142220", PAY_TO, usdc, "5"), "0x", "1", &[PAY_TO]),
        json!(["deny", ["deny_listed"]])
    );
    assert_eq!(
        verdict(&req("11142220", PAY_TO, usdc, "5"), "0x6000", "0", &[]),
        json!(["review", ["pay_to_is_contract"]])
    );
    assert_eq!(
        verdict(&req("11142220", PAY_TO, usdc, "5"), "0x", "0", &[]),
        json!(["review", ["pay_to_never_sent"]])
    );
    assert_eq!(
        verdict(&req("11142220", PAY_TO, usdc, "1000000000"), "0x", "1", &[]),
        json!(["allow", []])
    );
    assert_eq!(
        verdict(&req("11142220", PAY_TO, usdc, "1000000001"), "0x", "1", &[]),
        json!(["review", ["large_amount"]])
    );
    assert_eq!(
        verdict(&req("11142220", PAY_TO, usdc, "9999999999"), "0x", "1", &[]),
        json!(["review", ["large_amount"]])
    );
    assert_eq!(
        verdict(&req("11142220", PAY_TO, usdc, "999999999"), "0x", "1", &[]),
        json!(["allow", []])
    );
    // Every rule is evaluated; reasons in rule order; deny wins over review.
    assert_eq!(
        verdict(
            &req(
                "11142220",
                PAY_TO,
                "0x0000000000000000000000000000000000000001",
                "1000000001"
            ),
            "0x",
            "0",
            &[PAY_TO]
        ),
        json!([
            "deny",
            [
                "unknown_asset",
                "deny_listed",
                "pay_to_never_sent",
                "large_amount"
            ]
        ])
    );
    // Mainnet pins: USDC and USA₮ known, the Sepolia USDC is not.
    for asset in [
        "0xceba9300f2b948710d2653dd7b07f33a8b32118c",
        "0xd2ab3c9a02dbbab236bfec45d1d755df4267f771",
    ] {
        assert_eq!(
            verdict(&req("42220", PAY_TO, asset, "5"), "0x", "1", &[]),
            json!(["allow", []])
        );
    }
    assert_eq!(
        verdict(&req("42220", PAY_TO, usdc, "5"), "0x", "1", &[]),
        json!(["deny", ["unknown_asset"]])
    );
    assert_eq!(
        verdict(&req("1", PAY_TO, usdc, "5"), "0x", "1", &[]),
        json!(["deny", ["unknown_asset"]])
    );
}

#[test]
fn response_body_bytes_are_exact_jcs() {
    let r = req("11142220", PAY_TO, SEPOLIA_USDC, "1000000001");
    let i = rules::parse_inputs(&inputs(PAY_TO, "0x", "0").to_string(), &r).unwrap();
    let bytes = rules::evaluate(&r, &i, &[]);
    assert_eq!(
        String::from_utf8(bytes).unwrap(),
        r#"{"inputs":{"block":{"hash":"0x1234567890123456789012345678901234567890123456789012345678901234","number":"123","timestamp":"1761782400"},"payTo":{"address":"0x2222222222222222222222222222222222222222","balanceWei":"5","code":"0x","nonce":"0"},"source":"forno"},"reasons":["pay_to_never_sent","large_amount"],"rulesVersion":"1","verdict":"review"}"#
    );
}

#[test]
fn shipped_denylist_parses() {
    assert!(rules::load_denylist(rules::DENYLIST_V1).is_some());
    assert_eq!(
        rules::load_denylist(r#"["0xAA22222222222222222222222222222222222222"]"#),
        None
    );
}

// ---------- INV-16: determinism ----------

struct SplitMix(u64);
impl SplitMix {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[(self.next() % items.len() as u64) as usize]
    }
    fn hex(&mut self, bytes: usize) -> String {
        let v: Vec<u8> = (0..bytes).map(|_| self.next() as u8).collect();
        to_hex(&v)
    }
    fn dec(&mut self) -> String {
        match self.next() % 4 {
            0 => "0".into(),
            1 => (self.next() % 10).to_string(),
            2 => self.next().to_string(),
            _ => format!("{}{}", 1 + self.next() % 9, self.next()),
        }
    }
}

fn random_case(rng: &mut SplitMix) -> (Vec<u8>, Value) {
    let pay_to = rng.hex(20);
    let asset = rng
        .pick(&[
            SEPOLIA_USDC,
            "0xceba9300f2b948710d2653dd7b07f33a8b32118c",
            "0x0000000000000000000000000000000000000001",
        ])
        .to_string();
    let amount = rng.dec();
    let b = if rng.next().is_multiple_of(2) {
        body("11142220", &pay_to, &asset, &amount)
    } else {
        // Same fields, different key order and whitespace.
        format!("{{ \"amount\" : \"{amount}\", \"asset\":\"{asset}\",\n\"payTo\":\"{pay_to}\",\"chainId\":\"11142220\" }}").into_bytes()
    };
    let code = match rng.next() % 3 {
        0 => "0x".to_string(),
        1 => {
            let n = 1 + (rng.next() % 64) as usize;
            rng.hex(n)
        }
        _ => rng.hex(0),
    };
    let nonce = if rng.next().is_multiple_of(2) {
        "0".to_string()
    } else {
        rng.dec()
    };
    let source = rng.pick(&["forno", "buy:celo-rpc", "buy:x"]).to_string();
    let i = json!({
        "block": {"number": rng.dec(), "hash": rng.hex(32), "timestamp": rng.dec()},
        "payTo": {"address": pay_to, "code": code, "nonce": nonce, "balanceWei": rng.dec()},
        "source": source,
    });
    (b, i)
}

fn run(e: &mut Enclave<FakeNsm>, seed: u64) -> Vec<(Vec<u8>, String)> {
    let mut rng = SplitMix(seed);
    (0..1000)
        .map(|_| {
            let (b, i) = random_case(&mut rng);
            let reply = eval_with(e, &b, i);
            let response = B64.decode(s(&reply["response"])).expect("evaluated");
            (response, s(&reply["proof"]["inputsHash"]).to_string())
        })
        .collect()
}

#[test]
fn determinism_over_1000_random_inputs_run_twice() {
    let (mut a, _) = configured([0x42; 32]);
    let mut b = Enclave::new(FakeNsm::with_key([0x43; 32]), || CLOCK + 12_345);
    call(&mut b, &configure_msg("7"));
    let first = run(&mut a, 0xa77e55a);
    let second = run(&mut b, 0xa77e55a);
    assert_eq!(first.len(), 1000);
    assert_eq!(
        first, second,
        "same (body, inputs) must give byte-identical responses"
    );
    let verdicts: std::collections::BTreeSet<String> = first
        .iter()
        .map(|(r, _)| {
            serde_json::from_slice::<Value>(r).unwrap()["verdict"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(
        verdicts.len(),
        3,
        "the random cases reach allow, review and deny: {verdicts:?}"
    );
}

// ---------- INV-15: the key is never serialised ----------

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

#[test]
fn private_key_never_appears_in_any_response() {
    let key = [0x5c; 32];
    let hex_lower = to_hex(&key);
    let hex_upper = hex_lower[2..].to_uppercase();
    let forms: Vec<Vec<u8>> = vec![
        key.to_vec(),
        hex_lower.clone().into_bytes(),
        hex_lower.as_bytes()[2..].to_vec(),
        hex_upper.into_bytes(),
        B64.encode(key).into_bytes(),
    ];
    let mut e = Enclave::new(FakeNsm::with_key(key), fixed_clock);
    let b = body("11142220", PAY_TO, SEPOLIA_USDC, "5");
    let messages = vec![
        json!({"type": "attest"}),
        configure_msg("7"),
        configure_msg("7"),
        json!({"type": "attest"}),
        json!({"type": "liveness", "challenge": format!("0x{}", "ee".repeat(32))}),
        json!({"type": "liveness", "challenge": "bad"}),
        evaluate_msg(&b, inputs(PAY_TO, "0x", "3")),
        evaluate_msg(&b, inputs(PAY_TO, "0x60", "0")),
        evaluate_msg(
            &body("1", PAY_TO, SEPOLIA_USDC, "5"),
            inputs(PAY_TO, "0x", "3"),
        ),
        evaluate_msg(
            &b,
            inputs("0x3333333333333333333333333333333333333333", "0x", "3"),
        ),
        json!({"type": "nope"}),
    ];
    let mut seen = 0;
    for m in messages {
        let out = e.handle(m.to_string().as_bytes()).unwrap();
        let mut blobs = vec![out.clone()];
        // Look inside every base64 field too (attestation document, response body).
        let v: Value = serde_json::from_slice(&out).unwrap();
        for field in ["attestation", "response"] {
            if let Some(b64) = v.get(field).and_then(Value::as_str) {
                blobs.push(B64.decode(b64).unwrap());
            }
        }
        for blob in &blobs {
            for f in &forms {
                assert!(!contains(blob, f), "key bytes found in reply to {m}");
            }
        }
        seen += 1;
    }
    assert_eq!(seen, 11);
}

// ---------- framing ----------

struct Duplex {
    input: Cursor<Vec<u8>>,
    output: Vec<u8>,
}
impl Read for Duplex {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.input.read(buf)
    }
}
impl Write for Duplex {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.output.write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn frames(bytes: &[u8]) -> Vec<Value> {
    let mut c = Cursor::new(bytes.to_vec());
    let mut out = Vec::new();
    while let Some(f) = attessa_enclave::enclave::read_frame(&mut c).unwrap() {
        out.push(serde_json::from_slice(&f).unwrap());
    }
    out
}

fn serve(input: Vec<u8>) -> Vec<Value> {
    let enclave = Mutex::new(Enclave::new(FakeNsm::with_key(key_one()), fixed_clock));
    let mut d = Duplex {
        input: Cursor::new(input),
        output: Vec::new(),
    };
    serve_connection(&enclave, &mut d).unwrap();
    frames(&d.output)
}

#[test]
fn framing_round_trip_and_limits() {
    let mut input = Vec::new();
    write_frame(&mut input, configure_msg("7").to_string().as_bytes()).unwrap();
    write_frame(&mut input, br#"{"type":"attest"}"#).unwrap();
    let replies = serve(input);
    assert_eq!(replies.len(), 2);
    assert_eq!(
        replies[1]["signer"],
        "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
    );

    // Over 65,536 bytes: bad_frame, then the connection closes (later frames unread).
    let mut input = ((MAX_FRAME + 1) as u32).to_be_bytes().to_vec();
    input.extend(vec![b' '; MAX_FRAME + 1]);
    write_frame(&mut input, br#"{"type":"attest"}"#).unwrap();
    assert_eq!(serve(input), vec![json!({"error": "bad_frame"})]);

    // Zero length is bad_frame too.
    assert_eq!(serve(vec![0, 0, 0, 0]), vec![json!({"error": "bad_frame"})]);

    // Exactly 65,536 bytes is accepted (padded JSON).
    let mut big = br#"{"type":"attest"}"#.to_vec();
    big.resize(MAX_FRAME, b' ');
    let mut input = Vec::new();
    write_frame(&mut input, &big).unwrap();
    assert_eq!(serve(input), vec![json!({"error": "not_configured"})]);

    // Truncated frame: connection closes without a reply.
    let mut input = 100u32.to_be_bytes().to_vec();
    input.extend(b"{}");
    assert_eq!(serve(input), Vec::<Value>::new());
}
