//! Ключи хаба (замок 2 диздока).
//!
//! 1. Данные шифруются случайным **ключом данных** (32 байта, XChaCha20-Poly1305).
//! 2. Ключ данных заперт ключом из пароля (Argon2id). Смена пароля перезаписывает только keys.json.
//! 3. Тот же ключ данных заперт **ключом восстановления** — 32 знака на бумаге.
//!    Забыли пароль и потеряли бумагу — данных нет.
//! 4. Пароли для rclone crypt выводятся из ключа данных (HKDF) и передаются rclone только в памяти.

use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::{Zeroize, Zeroizing};

pub const MAGIC: &[u8; 4] = b"HUB1";
const NONCE: usize = 24;
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: без I, L, O, U

#[derive(Clone)]
pub struct DataKey(Zeroizing<[u8; 32]>);

impl std::fmt::Debug for DataKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DataKey(…)")
    }
}

impl DataKey {
    pub fn random() -> Self {
        let mut k = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut k);
        DataKey(Zeroizing::new(k))
    }
    #[cfg(test)]
    pub fn from_bytes(b: [u8; 32]) -> Self {
        DataKey(Zeroizing::new(b))
    }
    fn cipher(&self) -> XChaCha20Poly1305 {
        XChaCha20Poly1305::new((&*self.0).into())
    }
    /// Пароль для rclone crypt и т. п.: свой у каждого назначения, не раскрывает сам ключ.
    pub fn derive(&self, purpose: &str) -> String {
        let hk = Hkdf::<Sha256>::new(Some(b"hub derive v1"), &*self.0);
        let mut out = Zeroizing::new([0u8; 32]);
        hk.expand(purpose.as_bytes(), &mut *out).expect("32 байта HKDF всегда можно");
        B64URL.encode(&*out)
    }
}

/// HUB1 | nonce(24) | шифртекст с меткой
pub fn seal(key: &DataKey, plain: &[u8]) -> Vec<u8> {
    let mut nonce = [0u8; NONCE];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let ct = key.cipher().encrypt(XNonce::from_slice(&nonce), plain).expect("шифрование в памяти не падает");
    let mut out = Vec::with_capacity(MAGIC.len() + NONCE + ct.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    out
}

pub fn is_sealed(bytes: &[u8]) -> bool {
    bytes.len() >= MAGIC.len() + NONCE + 16 && &bytes[..4] == MAGIC
}

pub fn open(key: &DataKey, bytes: &[u8]) -> Result<Vec<u8>, String> {
    if !is_sealed(bytes) {
        return Err("файл не зашифрован хабом".into());
    }
    let (nonce, ct) = bytes[4..].split_at(NONCE);
    key.cipher().decrypt(XNonce::from_slice(nonce), ct).map_err(|_| "файл не расшифровывается: другой ключ или файл повреждён".to_string())
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Wrapped {
    pub nonce: String,
    pub ct: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Kdf {
    pub alg: String,
    pub m: u32,
    pub t: u32,
    pub p: u32,
    pub salt: String,
}

/// keys.json — лежит на устройстве и (на этапе синхронизации) на Drive, вне crypt:
/// в нём только запертый ключ данных.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct KeyFile {
    pub v: u32,
    pub kdf: Kdf,
    #[serde(rename = "byPassword")]
    pub by_password: Wrapped,
    #[serde(rename = "byRecovery")]
    pub by_recovery: Wrapped,
    pub id: String,
}

fn wrap(kek: &[u8; 32], dek: &DataKey) -> Wrapped {
    let mut nonce = [0u8; NONCE];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let c = XChaCha20Poly1305::new(kek.into());
    let ct = c.encrypt(XNonce::from_slice(&nonce), &dek.0[..]).expect("шифрование в памяти не падает");
    Wrapped { nonce: B64.encode(nonce), ct: B64.encode(ct) }
}

fn unwrap(kek: &[u8; 32], w: &Wrapped) -> Option<DataKey> {
    let nonce = B64.decode(&w.nonce).ok()?;
    let ct = B64.decode(&w.ct).ok()?;
    if nonce.len() != NONCE {
        return None;
    }
    let c = XChaCha20Poly1305::new(kek.into());
    let mut plain = c.decrypt(XNonce::from_slice(&nonce), ct.as_slice()).ok()?;
    if plain.len() != 32 {
        plain.zeroize();
        return None;
    }
    let mut k = [0u8; 32];
    k.copy_from_slice(&plain);
    plain.zeroize();
    Some(DataKey(Zeroizing::new(k)))
}

fn password_kek(password: &str, kdf: &Kdf) -> Result<Zeroizing<[u8; 32]>, String> {
    if kdf.alg != "argon2id" {
        return Err(format!("неизвестный способ ключа: {}", kdf.alg));
    }
    let salt = B64.decode(&kdf.salt).map_err(|e| e.to_string())?;
    let params = Params::new(kdf.m, kdf.t, kdf.p, Some(32)).map_err(|e| e.to_string())?;
    let mut out = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), &salt, &mut *out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

fn recovery_kek(code: &[u8], kdf: &Kdf) -> Zeroizing<[u8; 32]> {
    let salt = B64.decode(&kdf.salt).unwrap_or_default();
    let hk = Hkdf::<Sha256>::new(Some(&salt), code);
    let mut out = Zeroizing::new([0u8; 32]);
    hk.expand(b"hub recovery kek v1", &mut *out).expect("32 байта HKDF всегда можно");
    out
}

/// 20 случайных байт → 32 знака Crockford base32, группами по 4: «7K2M-…»
pub fn format_recovery(bytes: &[u8; 20]) -> String {
    let mut bits: u64 = 0;
    let mut n = 0;
    let mut chars = Vec::with_capacity(32);
    for &b in bytes {
        bits = (bits << 8) | b as u64;
        n += 8;
        while n >= 5 {
            n -= 5;
            chars.push(ALPHABET[((bits >> n) & 31) as usize] as char);
        }
    }
    chars.chunks(4).map(|c| c.iter().collect::<String>()).collect::<Vec<_>>().join("-")
}

/// Терпит строчные буквы, пробелы, дефисы, O вместо 0 и I/L вместо 1.
pub fn parse_recovery(code: &str) -> Option<Zeroizing<[u8; 20]>> {
    let mut vals = Vec::with_capacity(32);
    for c in code.chars() {
        let c = match c.to_ascii_uppercase() {
            ' ' | '-' | '\t' | '\n' => continue,
            'O' => '0',
            'I' | 'L' => '1',
            x => x,
        };
        let v = ALPHABET.iter().position(|&a| a as char == c)?;
        vals.push(v as u64);
    }
    if vals.len() != 32 {
        return None;
    }
    let mut out = Zeroizing::new([0u8; 20]);
    let (mut bits, mut n, mut i) = (0u64, 0, 0);
    for v in vals {
        bits = (bits << 5) | v;
        n += 5;
        if n >= 8 {
            n -= 8;
            out[i] = ((bits >> n) & 0xff) as u8;
            i += 1;
        }
    }
    Some(out)
}

pub struct Created {
    pub file: KeyFile,
    pub key: DataKey,
    pub recovery: String,
}

/// Новый хаб: ключ данных, keys.json и ключ восстановления (показывается один раз).
pub fn create(password: &str) -> Result<Created, String> {
    create_with(password, Kdf { alg: "argon2id".into(), m: 64 * 1024, t: 3, p: 1, salt: String::new() })
}

fn create_with(password: &str, mut kdf: Kdf) -> Result<Created, String> {
    let mut salt = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    kdf.salt = B64.encode(salt);
    let key = DataKey::random();
    let mut rec = Zeroizing::new([0u8; 20]);
    rand::rngs::OsRng.fill_bytes(&mut *rec);
    let mut id = [0u8; 8];
    rand::rngs::OsRng.fill_bytes(&mut id);
    let file = KeyFile {
        v: 1,
        by_password: wrap(&*password_kek(password, &kdf)?, &key),
        by_recovery: wrap(&*recovery_kek(&*rec, &kdf), &key),
        kdf,
        id: B64URL.encode(id),
    };
    Ok(Created { file, key, recovery: format_recovery(&rec) })
}

pub fn unlock_password(file: &KeyFile, password: &str) -> Result<DataKey, String> {
    unwrap(&*password_kek(password, &file.kdf)?, &file.by_password).ok_or_else(|| "Неверный пароль".to_string())
}

pub fn unlock_recovery(file: &KeyFile, code: &str) -> Result<DataKey, String> {
    let rec = parse_recovery(code).ok_or("В ключе восстановления должно быть 32 знака: буквы и цифры")?;
    unwrap(&*recovery_kek(&*rec, &file.kdf), &file.by_recovery).ok_or_else(|| "Ключ восстановления не подходит".to_string())
}

/// Новый пароль запирает тот же ключ данных: сами данные не перешифровываются.
pub fn change_password(file: &KeyFile, key: &DataKey, new_password: &str) -> Result<KeyFile, String> {
    // соль общая с ключом восстановления, поэтому остаётся прежней: ключ восстановления продолжает подходить
    Ok(KeyFile { by_password: wrap(&*password_kek(new_password, &file.kdf)?, key), ..file.clone() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fast(pw: &str) -> Created {
        create_with(pw, Kdf { alg: "argon2id".into(), m: 1024, t: 1, p: 1, salt: String::new() }).unwrap()
    }

    #[test]
    fn seal_open_roundtrip_and_tamper() {
        let k = DataKey::random();
        let s = seal(&k, "привет".as_bytes());
        assert!(is_sealed(&s));
        assert_eq!(open(&k, &s).unwrap(), "привет".as_bytes());
        let mut bad = s.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(open(&k, &bad).is_err());
        assert!(open(&DataKey::random(), &s).is_err());
        assert!(!is_sealed(b"{\"a\":1}"));
    }

    #[test]
    fn recovery_code_format() {
        let b = [7u8, 200, 13, 0, 255, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
        let s = format_recovery(&b);
        assert_eq!(s.len(), 32 + 7);
        assert_eq!(*parse_recovery(&s).unwrap(), b);
        assert_eq!(*parse_recovery(&s.to_lowercase().replace('-', " ")).unwrap(), b);
        assert!(parse_recovery("коротко").is_none());
    }

    #[test]
    fn password_and_recovery_unlock_same_key() {
        let c = fast("лес и туман");
        let a = unlock_password(&c.file, "лес и туман").unwrap();
        let b = unlock_recovery(&c.file, &c.recovery).unwrap();
        assert_eq!(&*a.0, &*c.key.0);
        assert_eq!(&*b.0, &*c.key.0);
        assert_eq!(unlock_password(&c.file, "не тот").unwrap_err(), "Неверный пароль");
        assert!(unlock_recovery(&c.file, &format_recovery(&[0; 20])).is_err());
    }

    #[test]
    fn change_password_keeps_key_and_recovery() {
        let c = fast("старый");
        let f2 = change_password(&c.file, &c.key, "новый").unwrap();
        assert!(unlock_password(&f2, "старый").is_err());
        assert_eq!(&*unlock_password(&f2, "новый").unwrap().0, &*c.key.0);
        assert_eq!(&*unlock_recovery(&f2, &c.recovery).unwrap().0, &*c.key.0);
    }

    #[test]
    fn keyfile_json_roundtrip_and_derive() {
        let c = fast("x");
        let json = serde_json::to_string(&c.file).unwrap();
        let back: KeyFile = serde_json::from_str(&json).unwrap();
        assert!(unlock_password(&back, "x").is_ok());
        let k = DataKey::from_bytes([1; 32]);
        assert_eq!(k.derive("rclone crypt password"), k.derive("rclone crypt password"));
        assert_ne!(k.derive("rclone crypt password"), k.derive("rclone crypt salt"));
    }
}
