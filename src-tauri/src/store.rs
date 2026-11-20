//! Хранилище данных хаба и приложений: каждый ключ — отдельный файл.
//!
//! `<корень>/<пространство>/<часть>/<часть>.json` — JSON-значение,
//! `<…>.bin` + `<…>.type` — двоичное значение (Blob) и его MIME-тип.
//! Пространство — `hub` (сам хаб) или id приложения. Ключ — строка с «/» как разделителем.
//!
//! Части ключа экранируются так, чтобы имя файла было допустимо на Windows и не зависело
//! от регистра: остаются только `a-z 0-9 - _ .`, всё остальное (и заглавные буквы) — `%XX` по байтам UTF-8.
//! Файл пишется во временный и переименовывается — недописанного файла не бывает.

use serde::Serialize;
use serde_json::{Map, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct Store {
    root: PathBuf,
    lock: Mutex<()>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct BlobMeta {
    #[serde(rename = "type")]
    pub mime: String,
    pub size: u64,
}

#[derive(Serialize, Debug)]
pub struct Stat {
    pub kind: &'static str,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    pub size: u64,
}

#[derive(Serialize, Debug, Default)]
pub struct Dump {
    pub json: Map<String, Value>,
    pub blobs: Map<String, Value>,
}

const MAX_KEY: usize = 512;
const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2",
    "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

pub fn valid_ns(ns: &str) -> bool {
    let b = ns.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'-' | b'_' | b'.'))
        && !ns.ends_with('.')
}

pub fn encode_segment(seg: &str) -> String {
    let bytes = seg.as_bytes();
    let mut out = String::with_capacity(seg.len());
    for (i, &c) in bytes.iter().enumerate() {
        let plain = c.is_ascii_lowercase()
            || c.is_ascii_digit()
            || c == b'-'
            || c == b'_'
            || (c == b'.' && i != 0 && i != bytes.len() - 1);
        if plain {
            out.push(c as char);
        } else {
            out.push_str(&format!("%{:02X}", c));
        }
    }
    // зарезервированные имена Windows (con, nul, com1…) — даже с расширением
    let stem = out.split('.').next().unwrap_or("");
    if RESERVED.contains(&stem) {
        let first = out.as_bytes()[0];
        out = format!("%{:02X}{}", first, &out[1..]);
    }
    out
}

pub fn decode_segment(name: &str) -> Option<String> {
    let b = name.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            if i + 2 >= b.len() {
                return None;
            }
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn with_ext(base: &Path, ext: &str) -> PathBuf {
    let mut s = base.as_os_str().to_owned();
    s.push(ext);
    PathBuf::from(s)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("нет папки")?;
    fs::create_dir_all(dir).map_err(|e| format!("папка {}: {e}", dir.display()))?;
    let tmp = with_ext(path, ".tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
        f.write_all(bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
        f.sync_all().map_err(|e| format!("{}: {e}", tmp.display()))?;
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("{}: {e}", path.display())
    })
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

impl Store {
    pub fn new(root: PathBuf) -> Self {
        Store { root, lock: Mutex::new(()) }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn ns_dir(&self, ns: &str) -> Result<PathBuf, String> {
        if !valid_ns(ns) {
            return Err(format!("недопустимое имя пространства данных: {ns}"));
        }
        Ok(self.root.join(ns))
    }

    /// путь без расширения: <корень>/<ns>/<часть>/<часть>
    fn key_base(&self, ns: &str, key: &str) -> Result<PathBuf, String> {
        if key.is_empty() || key.len() > MAX_KEY {
            return Err(format!("ключ — от 1 до {MAX_KEY} байт"));
        }
        let mut p = self.ns_dir(ns)?;
        for seg in key.split('/') {
            if seg.is_empty() || seg == "." || seg == ".." {
                return Err(format!("в ключе пустая часть или «.»/«..»: {key}"));
            }
            p.push(encode_segment(seg));
        }
        Ok(p)
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn set_json(&self, ns: &str, key: &str, value: &Value) -> Result<(), String> {
        let base = self.key_base(ns, key)?;
        let compact = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        // маленькие файлы — с отступами, чтобы их было удобно читать глазами
        let bytes = if compact.len() < 64 * 1024 { serde_json::to_vec_pretty(value).map_err(|e| e.to_string())? } else { compact };
        let _g = self.guard();
        write_atomic(&with_ext(&base, ".json"), &bytes)?;
        remove_if_exists(&with_ext(&base, ".bin"))?;
        remove_if_exists(&with_ext(&base, ".type"))
    }

    pub fn set_blob(&self, ns: &str, key: &str, mime: &str, bytes: &[u8]) -> Result<(), String> {
        let base = self.key_base(ns, key)?;
        let _g = self.guard();
        write_atomic(&with_ext(&base, ".bin"), bytes)?;
        write_atomic(&with_ext(&base, ".type"), mime.as_bytes())?;
        remove_if_exists(&with_ext(&base, ".json"))
    }

    pub fn get_json(&self, ns: &str, key: &str) -> Result<Option<Value>, String> {
        let path = with_ext(&self.key_base(ns, key)?, ".json");
        match fs::read(&path) {
            Ok(b) => serde_json::from_slice(&b).map(Some).map_err(|e| format!("{}: {e}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    }

    pub fn get_blob(&self, ns: &str, key: &str) -> Result<Option<Vec<u8>>, String> {
        let path = with_ext(&self.key_base(ns, key)?, ".bin");
        match fs::read(&path) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    }

    pub fn stat(&self, ns: &str, key: &str) -> Result<Option<Stat>, String> {
        let base = self.key_base(ns, key)?;
        if let Ok(m) = fs::metadata(with_ext(&base, ".json")) {
            return Ok(Some(Stat { kind: "json", mime: None, size: m.len() }));
        }
        if let Ok(m) = fs::metadata(with_ext(&base, ".bin")) {
            let mime = fs::read_to_string(with_ext(&base, ".type")).unwrap_or_default();
            return Ok(Some(Stat { kind: "blob", mime: Some(mime), size: m.len() }));
        }
        Ok(None)
    }

    pub fn remove(&self, ns: &str, key: &str) -> Result<(), String> {
        let base = self.key_base(ns, key)?;
        let ns_dir = self.ns_dir(ns)?;
        let _g = self.guard();
        for ext in [".json", ".bin", ".type"] {
            remove_if_exists(&with_ext(&base, ext))?;
        }
        // пустые папки ключа убираем до папки пространства
        let mut dir = base.parent().map(Path::to_path_buf);
        while let Some(d) = dir {
            if d == ns_dir || !d.starts_with(&ns_dir) || fs::remove_dir(&d).is_err() {
                break;
            }
            dir = d.parent().map(Path::to_path_buf);
        }
        Ok(())
    }

    /// Все данные пространства: JSON-значения целиком, у Blob — только тип и размер.
    pub fn dump(&self, ns: &str) -> Result<Dump, String> {
        let dir = self.ns_dir(ns)?;
        let mut out = Dump::default();
        if !dir.exists() {
            return Ok(out);
        }
        let _g = self.guard();
        walk(&dir, &mut Vec::new(), &mut out)?;
        Ok(out)
    }
}

fn walk(dir: &Path, prefix: &mut Vec<String>, out: &mut Dump) -> Result<(), String> {
    let mut entries: Vec<_> = fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            if let Some(seg) = decode_segment(&name) {
                prefix.push(seg);
                walk(&path, prefix, out)?;
                prefix.pop();
            }
            continue;
        }
        let (stem, kind) = if let Some(s) = name.strip_suffix(".json") {
            (s, "json")
        } else if let Some(s) = name.strip_suffix(".bin") {
            (s, "bin")
        } else {
            continue; // .type, .tmp и чужие файлы
        };
        let Some(seg) = decode_segment(stem) else { continue };
        let key = if prefix.is_empty() { seg } else { format!("{}/{}", prefix.join("/"), seg) };
        if kind == "json" {
            match fs::read(&path).map_err(|e| e.to_string()).and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|e| e.to_string())) {
                Ok(v) => {
                    out.json.insert(key, v);
                }
                Err(e) => eprintln!("[хаб] файл данных не читается и пропущен: {}: {e}", path.display()),
            }
        } else {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let mime = fs::read_to_string(with_ext(&path.with_extension(""), ".type")).unwrap_or_default();
            out.blobs.insert(key, serde_json::json!({ "type": mime, "size": size }));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::new(dir.path().to_path_buf());
        (dir, s)
    }

    #[test]
    fn segments_roundtrip_and_are_safe() {
        for s in ["tb-records", "Tb-Records", "теория", "a b", "a.b", ".hidden", "end.", "con", "NUL", "com1.txt", "%", "x%2F"] {
            let e = encode_segment(s);
            assert!(e.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"-_.%ABCDEF".contains(&c)), "{s} → {e}");
            assert!(!e.starts_with('.') && !e.ends_with('.'), "{s} → {e}");
            assert_eq!(decode_segment(&e).as_deref(), Some(s), "{s} → {e}");
        }
        assert_eq!(encode_segment("tb-records"), "tb-records");
        assert_ne!(encode_segment("A"), encode_segment("a"));
        assert!(!RESERVED.contains(&encode_segment("con").as_str()));
    }

    #[test]
    fn json_set_get_dump_remove() {
        let (_d, s) = store();
        s.set_json("hub", "inbox", &json!([{"id": 1, "text": "мысль"}])).unwrap();
        s.set_json("repetition", "localStorage/tb-records", &json!({"a": 1})).unwrap();
        s.set_json("repetition", "localStorage/Tb-Meta", &json!("raw string")).unwrap();
        assert_eq!(s.get_json("hub", "inbox").unwrap(), Some(json!([{"id": 1, "text": "мысль"}])));
        let d = s.dump("repetition").unwrap();
        assert_eq!(d.json.get("localStorage/tb-records"), Some(&json!({"a": 1})));
        assert_eq!(d.json.get("localStorage/Tb-Meta"), Some(&json!("raw string")));
        assert!(s.dump("hub").unwrap().json.contains_key("inbox"));
        s.remove("repetition", "localStorage/tb-records").unwrap();
        s.remove("repetition", "localStorage/Tb-Meta").unwrap();
        assert!(s.dump("repetition").unwrap().json.is_empty());
        assert!(!s.root().join("repetition").join("localstorage").exists());
    }

    #[test]
    fn blob_replaces_json_and_back() {
        let (_d, s) = store();
        s.set_json("app", "k", &json!(1)).unwrap();
        s.set_blob("app", "k", "video/mp4", b"\x00\x01\x02").unwrap();
        assert!(s.get_json("app", "k").unwrap().is_none());
        assert_eq!(s.get_blob("app", "k").unwrap().unwrap(), b"\x00\x01\x02");
        let st = s.stat("app", "k").unwrap().unwrap();
        assert_eq!((st.kind, st.mime.as_deref(), st.size), ("blob", Some("video/mp4"), 3));
        let d = s.dump("app").unwrap();
        assert_eq!(d.blobs.get("k"), Some(&json!({"type": "video/mp4", "size": 3})));
        s.set_json("app", "k", &json!(2)).unwrap();
        assert!(s.get_blob("app", "k").unwrap().is_none());
        assert_eq!(s.stat("app", "k").unwrap().unwrap().kind, "json");
    }

    #[test]
    fn rejects_bad_names() {
        let (_d, s) = store();
        for ns in ["", "Hub", "../x", "a/b", "x.", "a b"] {
            assert!(s.set_json(ns, "k", &json!(1)).is_err(), "ns {ns:?}");
        }
        for key in ["", "a//b", "../x", "a/./b", "/a", "a/"] {
            assert!(s.set_json("ok", key, &json!(1)).is_err(), "key {key:?}");
        }
        assert!(s.set_json("ok", &"x".repeat(600), &json!(1)).is_err());
    }
}
