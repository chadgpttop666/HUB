//! Мысль в корзину из мини-окна (Ctrl+Alt+Пробел) — в том числе когда хаб заперт.
//!
//! Хаб открыт — элемент сразу ложится в корзину (`hub/inbox/<id>`).
//! Хаб заперт — данные хаба закрыты, писать в них нечем. Тогда мысль запирается **открытым ключом**
//! этого устройства (sealed box: X25519 + XSalsa20-Poly1305) и ложится файлом в `pending/`.
//! Закрытый ключ хранится в данных хаба (`hub/device/inbox-secret`, зашифрован ключом данных,
//! не синхронизируется), поэтому прочитать такие мысли можно только после пароля: при входе они
//! переезжают в корзину, а файлы удаляются.
//! Кто сел за запертый ПК, может добавить мысль, но не может прочитать ни её, ни остальное.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use crypto_box::{PublicKey, SecretKey};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

use crate::store::{now_ms, Store};

const SECRET_KEY: &str = "device/inbox-secret";

pub struct Quick {
    pending: PathBuf,
    public: PathBuf,
}

impl Quick {
    pub fn new(base: &Path) -> Self {
        Quick { pending: base.join("pending"), public: base.join("inbox.pub") }
    }

    /// После входа: убедиться, что пара ключей есть, и забрать мысли, оставленные при запертом хабе.
    pub fn after_unlock(&self, store: &Store) -> Result<usize, String> {
        let secret = match store.get_json("hub", SECRET_KEY)?.and_then(|v| v.as_str().map(str::to_string)) {
            Some(b) => {
                let bytes: [u8; 32] = B64.decode(b).map_err(|e| e.to_string())?.try_into().map_err(|_| "ключ корзины повреждён")?;
                SecretKey::from(bytes)
            }
            None => {
                let sk = SecretKey::generate(&mut rand::rngs::OsRng);
                store.set_json_quiet("hub", SECRET_KEY, &json!(B64.encode(sk.to_bytes())))?;
                sk
            }
        };
        let public = B64.encode(secret.public_key().as_bytes());
        if fs::read_to_string(&self.public).ok().as_deref() != Some(public.as_str()) {
            fs::write(&self.public, &public).map_err(|e| e.to_string())?;
        }
        let mut n = 0;
        let Ok(rd) = fs::read_dir(&self.pending) else { return Ok(0) };
        let mut files: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().map(|x| x == "bin").unwrap_or(false)).collect();
        files.sort();
        for f in files {
            let opened = fs::read(&f).ok().and_then(|b| secret.unseal(&b).ok()).and_then(|plain| serde_json::from_slice::<Value>(&plain).ok());
            match opened {
                Some(item) => {
                    let id = item["id"].as_str().unwrap_or("").to_string();
                    if !id.is_empty() {
                        store.set_json("hub", &format!("inbox/{id}"), &item)?;
                        n += 1;
                    }
                    let _ = fs::remove_file(&f);
                }
                None => eprintln!("[хаб] мысль из мини-окна не открылась и оставлена: {}", f.display()),
            }
        }
        Ok(n)
    }

    /// Сохранить мысль: в корзину или, если хаб заперт, запертым файлом. Возвращает "saved" или "sealed".
    pub fn capture(&self, store: &Store, text: &str, device: &str) -> Result<&'static str, String> {
        let text = text.trim();
        if text.is_empty() {
            return Err("Напишите мысль и нажмите Enter".into());
        }
        let item = make_item(text, device);
        if store.is_open() {
            store.set_json("hub", &format!("inbox/{}", item["id"].as_str().unwrap_or("")), &item)?;
            return Ok("saved");
        }
        let public = fs::read_to_string(&self.public).map_err(|_| "Хаб ещё не настроен — войдите в него хотя бы раз".to_string())?;
        let bytes: [u8; 32] = B64.decode(public.trim()).map_err(|e| e.to_string())?.try_into().map_err(|_| "ключ корзины повреждён")?;
        let sealed = PublicKey::from(bytes)
            .seal(&mut rand::rngs::OsRng, &serde_json::to_vec(&item).map_err(|e| e.to_string())?)
            .map_err(|_| "мысль не запечаталась")?;
        fs::create_dir_all(&self.pending).map_err(|e| e.to_string())?;
        let name = format!("{}-{}.bin", now_ms(), &item["id"].as_str().unwrap_or("x"));
        let tmp = self.pending.join(format!("{name}.tmp"));
        fs::write(&tmp, sealed).map_err(|e| e.to_string())?;
        fs::rename(&tmp, self.pending.join(name)).map_err(|e| e.to_string())?;
        Ok("sealed")
    }

    pub fn pending_count(&self) -> usize {
        fs::read_dir(&self.pending).map(|rd| rd.flatten().filter(|e| e.path().extension().map(|x| x == "bin").unwrap_or(false)).count()).unwrap_or(0)
    }
}

/// Элемент корзины того же вида, что делает оболочка (ui/js/state.js).
pub fn make_item(text: &str, device: &str) -> Value {
    let ms = now_ms();
    let mut r = [0u8; 4];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut r);
    let id = format!("{}{}", base36(ms), base36(u32::from_le_bytes(r) as u64 % 2_176_782_336)); // как в JS: время + 6 случайных знаков
    json!({ "id": id, "text": text, "created": iso(ms), "device": device, "tags": tags(text), "source": Value::Null })
        .as_object()
        .map(|o| Value::Object(o.iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k.clone(), v.clone())).collect()))
        .unwrap_or(Value::Null)
}

fn base36(mut n: u64) -> String {
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(D[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// «#слово» → метки (строчными, без повторов)
pub fn tags(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '#' && (i == 0 || chars[i - 1].is_whitespace()) {
            let w: String = chars[i + 1..].iter().take_while(|c| c.is_alphanumeric() || **c == '_' || **c == '-').collect();
            if !w.is_empty() {
                let w = w.to_lowercase();
                if !out.contains(&w) {
                    out.push(w);
                }
            }
        }
        i += 1;
    }
    out
}

/// ISO-время в UTC, как Date.toISOString(): 2026-11-20T18:30:05.123Z
pub fn iso(ms: u64) -> String {
    let secs = ms / 1000;
    let (y, mo, d) = crate::sync::civil_from_days((secs / 86_400) as i64);
    let s = secs % 86_400;
    format!("{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", s / 3600, (s / 60) % 60, s % 60, ms % 1000)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::DataKey;

    #[test]
    fn locked_capture_is_sealed_and_arrives_after_unlock() {
        let d = tempfile::tempdir().unwrap();
        let store = Store::new(d.path().join("data"));
        let key = DataKey::random();
        let q = Quick::new(d.path());
        // до первого входа ключа корзины нет — запечатать нечем
        assert!(q.capture(&store, "мысль", "pc").is_err());
        store.set_key(Some(key.clone()));
        assert_eq!(q.after_unlock(&store).unwrap(), 0);
        assert_eq!(q.capture(&store, "открыто #Учёба", "pc").unwrap(), "saved");
        store.set_key(None);
        assert_eq!(q.capture(&store, "секретная мысль при запертом хабе #идея", "pc").unwrap(), "sealed");
        assert_eq!(q.pending_count(), 1);
        let raw = fs::read_dir(d.path().join("pending")).unwrap().flatten().next().unwrap().path();
        assert!(!String::from_utf8_lossy(&fs::read(&raw).unwrap()).contains("секрет"), "на диске не читается");
        store.set_key(Some(key));
        assert_eq!(q.after_unlock(&store).unwrap(), 1);
        assert_eq!(q.pending_count(), 0);
        let inbox: Vec<Value> = store.dump("hub").unwrap().json.into_iter().filter(|(k, _)| k.starts_with("inbox/")).map(|(_, v)| v).collect();
        assert_eq!(inbox.len(), 2);
        let sealed = inbox.iter().find(|i| i["text"].as_str().unwrap().starts_with("секретная")).unwrap();
        assert_eq!(sealed["tags"], json!(["идея"]));
        assert!(sealed["created"].as_str().unwrap().ends_with('Z'));
    }

    #[test]
    fn helpers() {
        assert_eq!(tags("#А и #б-в, #а не#г"), vec!["а", "б-в"]);
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_795_200_000_123), "2026-11-20T18:40:00.123Z");
        assert_eq!(base36(35), "z");
    }
}
