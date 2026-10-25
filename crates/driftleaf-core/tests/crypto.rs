use driftleaf_core::{decrypt, derive_key, encrypt};
#[test]
fn node_vectors_and_faults() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/crypto.json")).unwrap();
    let salt = hex::decode(fixture["saltHex"].as_str().unwrap()).unwrap();
    let key = derive_key(fixture["passphrase"].as_str().unwrap(), &salt).unwrap();
    assert_eq!(
        hex::encode(key.as_ref()),
        fixture["keyHex"].as_str().unwrap()
    );
    for vector in fixture["vectors"].as_array().unwrap() {
        let packed = hex::decode(vector["packedHex"].as_str().unwrap()).unwrap();
        let expected = hex::decode(vector["plaintextHex"].as_str().unwrap()).unwrap();
        assert_eq!(*decrypt(&packed, &key).unwrap(), expected);
        let roundtrip = encrypt(&expected, &key).unwrap();
        assert_eq!(*decrypt(&roundtrip, &key).unwrap(), expected);
        let mut corrupt = packed.clone();
        corrupt[12] ^= 1;
        assert!(decrypt(&corrupt, &key).is_err());
        for length in [0, 11, 12, 27] {
            assert!(decrypt(&packed[..length], &key).is_err());
        }
        let wrong = zeroize::Zeroizing::new([0u8; 32]);
        assert!(decrypt(&packed, &wrong).is_err());
    }
    assert!(derive_key("test", &[0u8; 15]).is_err());
}
