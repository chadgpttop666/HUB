//! Хранилище данных хаба и приложений: каждый ключ — отдельный файл.
//!
//! `<корень>/<пространство>/<часть>/<часть>.json` — JSON-значение,
//! `<…>.bin` + `<…>.type` — двоичное значение (Blob) и его MIME-тип.
//! Пространство — `hub` (сам хаб) или id приложения. Ключ — строка с «/» как разделителем.
//!
//! Части ключа экранируются так, чтобы имя файла было допустимо на Windows и не зависело
//! от регистра: остаются только `a-z 0-9 - _ .`, всё остальное (и заглавные буквы) — `%XX` по байтам UTF-8.
//! Файл пишется во временный и переименовывается — недописанного файла не бывает.
//!
//! Содержимое файлов зашифровано ключом данных (crypto::seal). Пока хаб заперт, ключа нет —
//! хранилище ничего не читает и не пишет. Незашифрованные файлы этапа 1 читаются,
//! а `encrypt_all` переписывает их зашифрованными.
//! Каждое изменение через обычные set/remove попадает в список для синхронизации (`take_changes`).

use crate::crypto::{self, DataKey};
use crate::sync::{Clock, Op, Revision};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use serde_json::{Map, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Store {
    root: PathBuf,
    lock: Mutex<()>,
    key: RwLock<Option<DataKey>>,
    outbox: Option<PathBuf>,
    changes: Mutex<BTreeMap<String, Change>>,
    last_change: AtomicU64,
    mutation: Mutex<()>,
    revisions: Mutex<Revisions>,
}

#[derive(Default)]
struct Revisions {
    device: String,
    namespaces: BTreeMap<String, BTreeMap<String, Revision>>,
}

/// Изменение ключа: для журнала синхронизации.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Change {
    pub ns: String,
    pub key: String,
    pub ts: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<Clock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<Op>,
}

pub(crate) fn local_only(ns: &str, key: &str) -> bool {
    (ns == "hub" && (key == "settings-local" || key.starts_with("device/") || key.starts_with("conflicts/causal/")))
        || (ns == "calendar" && key == "device/calendar-import")
}

fn change_id(ns: &str, key: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(ns);
    hash.update([0]);
    hash.update(key);
    format!("{:x}", hash.finalize())
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub const LOCKED: &str = "Хаб заперт";

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
    pub basis: BTreeMap<String, Clock>,
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

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
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
        Store { root, lock: Mutex::new(()), key: RwLock::new(None), outbox: None, changes: Mutex::default(), last_change: AtomicU64::new(0), mutation: Mutex::default(), revisions: Mutex::default() }
    }

    pub fn with_outbox(root: PathBuf, outbox: PathBuf) -> Self {
        Self { outbox: Some(outbox), ..Self::new(root) }
    }

    /// После входа восстанавливаем правки, подтверждённые перед закрытием процесса.
    pub fn load_outbox(&self) -> Result<(), String> {
        let Some(dir) = &self.outbox else { return Ok(()) };
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(format!("Очередь синхронизации: {e}")),
        };
        let data_key = self.data_key()?;
        let mut changes = self.changes.lock().unwrap_or_else(|e| e.into_inner());
        for entry in entries {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("sealed") {
                continue;
            }
            let bytes = fs::read(path).map_err(|e| format!("Очередь синхронизации: {e}"))?;
            let change: Change = serde_json::from_slice(&crypto::open(&data_key, &bytes)?).map_err(|e| e.to_string())?;
            let id = change_id(&change.ns, &change.key);
            self.last_change.fetch_max(change.ts, Ordering::Relaxed);
            changes.entry(id).or_insert(change);
        }
        Ok(())
    }

    pub fn set_key(&self, key: Option<DataKey>) {
        *self.key.write().unwrap_or_else(|e| e.into_inner()) = key;
    }

    pub fn is_open(&self) -> bool {
        self.key.read().unwrap_or_else(|e| e.into_inner()).is_some()
    }

    pub fn data_key(&self) -> Result<DataKey, String> {
        self.key.read().unwrap_or_else(|e| e.into_inner()).clone().ok_or_else(|| LOCKED.to_string())
    }

    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
        Ok(crypto::seal(&self.data_key()?, plain))
    }

    fn unseal(&self, bytes: Vec<u8>) -> Result<Vec<u8>, String> {
        let key = self.data_key()?;
        if crypto::is_sealed(&bytes) {
            crypto::open(&key, &bytes)
        } else {
            Ok(bytes) // файл этапа 1, ещё не зашифрован
        }
    }

    pub(crate) fn mutation_guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.mutation.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn init_revisions(&self, device: &str, revisions: impl Iterator<Item = (String, String, Revision)>) {
        let _g = self.mutation_guard();
        let mut index = self.revisions.lock().unwrap_or_else(|e| e.into_inner());
        *index = Revisions { device: device.into(), ..Default::default() };
        for (ns, key, revision) in revisions {
            self.last_change.fetch_max(revision.ts, Ordering::Relaxed);
            index.namespaces.entry(ns).or_default().insert(key, revision);
        }
        for change in self.changes() {
            let keys = index.namespaces.entry(change.ns).or_default();
            if keys.get(&change.key).is_some_and(|r| r.dev == device && r.ts == change.ts) { continue; }
            let context = change.context.or_else(|| keys.get(&change.key).map(Revision::clock));
            keys.insert(change.key, Revision { ts: change.ts, dev: device.into(), context });
        }
    }

    pub(crate) fn set_revision(&self, ns: &str, key: &str, revision: Revision) {
        self.revisions.lock().unwrap_or_else(|e| e.into_inner()).namespaces
            .entry(ns.into()).or_default().insert(key.into(), revision);
    }

    fn prepare_change(&self, ns: &str, key: &str, basis: Option<Clock>) -> Result<Option<Change>, String> {
        if local_only(ns, key) {
            return Ok(None);
        }
        let index = self.revisions.lock().unwrap_or_else(|e| e.into_inner());
        let current = index.namespaces.get(ns).and_then(|keys| keys.get(key));
        let mut context = basis.unwrap_or_else(|| current.map(Revision::clock).unwrap_or_default());
        let mut previous = None;
        if let Some(revision) = current {
            if revision.dev == index.device {
                revision.include_in(&mut context);
            } else if !revision.in_clock(&context) {
                previous = Some(Op::read(self, ns, key, revision.clone())?.0);
            }
        }
        // Несколько правок между проходами синхронизации сжимаются в одну. Сохраняем
        // предшествующую чужую версию, если первый локальный редактор ещё её не видел.
        if previous.is_none() {
            previous = self.changes.lock().unwrap_or_else(|e| e.into_inner())
                .get(&change_id(ns, key)).and_then(|c| c.previous.clone());
        }
        let floor = context.values().copied().max().unwrap_or(0).max(current.map_or(0, |r| r.ts));
        let ts = now_ms().max(floor.saturating_add(1)).max(self.last_change.load(Ordering::Relaxed).saturating_add(1));
        self.last_change.store(ts, Ordering::Relaxed);
        Ok(Some(Change { ns: ns.into(), key: key.into(), ts, context: Some(context), previous }))
    }

    fn record(&self, change: Option<Change>) -> Result<Option<Clock>, String> {
        let Some(change) = change else { return Ok(None) };
        let ns = &change.ns;
        let key = &change.key;
        let id = change_id(ns, key);
        let device = self.revisions.lock().unwrap_or_else(|e| e.into_inner()).device.clone();
        let revision = Revision { ts: change.ts, dev: device, context: change.context.clone() };
        let clock = revision.clock();
        self.set_revision(ns, key, revision);
        let mut changes = self.changes.lock().unwrap_or_else(|e| e.into_inner());
        // Даже при ошибке диска сохраняем правку для повтора в текущем сеансе.
        changes.insert(id.clone(), change.clone());
        if let Some(dir) = &self.outbox {
            let bytes = serde_json::to_vec(&change).map_err(|e| e.to_string())?;
            write_atomic(&dir.join(format!("{id}.sealed")), &self.seal(&bytes)?)?;
        }
        Ok(Some(clock))
    }

    pub(crate) fn pending_at(&self, ns: &str, key: &str) -> Option<u64> {
        self.changes.lock().unwrap_or_else(|e| e.into_inner()).get(&change_id(ns, key)).map(|c| c.ts)
    }

    pub(crate) fn changes(&self) -> Vec<Change> {
        self.changes.lock().unwrap_or_else(|e| e.into_inner()).values().cloned().collect()
    }

    /// Маркер можно снять только после записи состояния журнала на диск.
    pub(crate) fn acknowledge_changes(&self, included: impl Fn(&Change) -> bool) -> Result<(), String> {
        let mut changes = self.changes.lock().unwrap_or_else(|e| e.into_inner());
        let mut result = Ok(());
        changes.retain(|id, change| {
            if !included(change) {
                return true;
            }
            if let Some(dir) = &self.outbox {
                if let Err(e) = remove_if_exists(&dir.join(format!("{id}.sealed"))) {
                    result = Err(e);
                    return true;
                }
            }
            false
        });
        result
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
        self.set_json_from(ns, key, value, None).map(|_| ())
    }

    pub fn set_json_from(&self, ns: &str, key: &str, value: &Value, basis: Option<Clock>) -> Result<Option<Clock>, String> {
        let _g = self.mutation_guard();
        let change = self.prepare_change(ns, key, basis)?;
        self.set_json_quiet(ns, key, value)?;
        self.record(change)
    }

    /// Запись без отметки для синхронизации — так применяются изменения с других устройств.
    pub fn set_json_quiet(&self, ns: &str, key: &str, value: &Value) -> Result<(), String> {
        let base = self.key_base(ns, key)?;
        let compact = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        // маленькие файлы — с отступами, чтобы их было удобно читать глазами
        let bytes = if compact.len() < 64 * 1024 { serde_json::to_vec_pretty(value).map_err(|e| e.to_string())? } else { compact };
        let bytes = self.seal(&bytes)?;
        let _g = self.guard();
        write_atomic(&with_ext(&base, ".json"), &bytes)?;
        remove_if_exists(&with_ext(&base, ".bin"))?;
        remove_if_exists(&with_ext(&base, ".type"))?;
        Ok(())
    }

    pub fn set_blob(&self, ns: &str, key: &str, mime: &str, bytes: &[u8]) -> Result<(), String> {
        self.set_blob_from(ns, key, mime, bytes, None).map(|_| ())
    }

    pub fn set_blob_from(&self, ns: &str, key: &str, mime: &str, bytes: &[u8], basis: Option<Clock>) -> Result<Option<Clock>, String> {
        let _g = self.mutation_guard();
        let change = self.prepare_change(ns, key, basis)?;
        self.set_blob_quiet(ns, key, mime, bytes)?;
        self.record(change)
    }

    pub fn set_blob_quiet(&self, ns: &str, key: &str, mime: &str, bytes: &[u8]) -> Result<(), String> {
        let base = self.key_base(ns, key)?;
        let sealed = self.seal(bytes)?;
        let _g = self.guard();
        write_atomic(&with_ext(&base, ".bin"), &sealed)?;
        write_atomic(&with_ext(&base, ".type"), mime.as_bytes())?;
        remove_if_exists(&with_ext(&base, ".json"))?;
        Ok(())
    }

    pub fn get_json(&self, ns: &str, key: &str) -> Result<Option<Value>, String> {
        let path = with_ext(&self.key_base(ns, key)?, ".json");
        match fs::read(&path) {
            Ok(b) => serde_json::from_slice(&self.unseal(b)?).map(Some).map_err(|e| format!("{}: {e}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    }

    pub fn get_blob(&self, ns: &str, key: &str) -> Result<Option<Vec<u8>>, String> {
        let path = with_ext(&self.key_base(ns, key)?, ".bin");
        match fs::read(&path) {
            Ok(b) => Ok(Some(self.unseal(b)?)),
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
            return Ok(Some(Stat { kind: "blob", mime: Some(mime), size: plain_size(m.len()) }));
        }
        Ok(None)
    }

    pub fn remove(&self, ns: &str, key: &str) -> Result<(), String> {
        self.remove_from(ns, key, None).map(|_| ())
    }

    pub fn remove_from(&self, ns: &str, key: &str, basis: Option<Clock>) -> Result<Option<Clock>, String> {
        let _g = self.mutation_guard();
        let change = self.prepare_change(ns, key, basis)?;
        self.remove_quiet(ns, key)?;
        self.record(change)
    }

    pub fn remove_quiet(&self, ns: &str, key: &str) -> Result<(), String> {
        self.data_key()?;
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
        let _mutation = self.mutation_guard();
        let key = self.data_key()?;
        let dir = self.ns_dir(ns)?;
        let mut out = Dump::default();
        let _g = self.guard();
        if dir.exists() { walk(&dir, &mut Vec::new(), &mut out, &key)?; }
        if let Some(revisions) = self.revisions.lock().unwrap_or_else(|e| e.into_inner()).namespaces.get(ns) {
            out.basis = revisions.iter().map(|(key, rev)| (key.clone(), rev.clock())).collect();
        }
        Ok(out)
    }

    /// Все пространства данных (папки верхнего уровня).
    pub fn namespaces(&self) -> Vec<String> {
        let mut out: Vec<String> = fs::read_dir(&self.root)
            .map(|rd| rd.flatten().filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| valid_ns(n)).collect())
            .unwrap_or_default();
        out.sort();
        out
    }

    /// Все ключи пространства с видом значения: для первой выгрузки на Drive.
    pub fn keys(&self, ns: &str) -> Result<Vec<(String, bool)>, String> {
        let d = self.dump(ns)?;
        let mut out: Vec<(String, bool)> = d.json.keys().map(|k| (k.clone(), false)).collect();
        out.extend(d.blobs.keys().map(|k| (k.clone(), true)));
        out.sort();
        Ok(out)
    }

    /// Зашифровать всё, что осталось открытым с этапа 1. Возвращает число переписанных файлов.
    pub fn encrypt_all(&self) -> Result<usize, String> {
        let key = self.data_key()?;
        let _g = self.guard();
        let mut n = 0;
        let mut stack = vec![self.root.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                    continue;
                }
                let name = e.file_name().to_string_lossy().to_string();
                if !(name.ends_with(".json") || name.ends_with(".bin")) {
                    continue;
                }
                let bytes = fs::read(&p).map_err(|e| format!("{}: {e}", p.display()))?;
                if !crypto::is_sealed(&bytes) {
                    write_atomic(&p, &crypto::seal(&key, &bytes))?;
                    n += 1;
                }
            }
        }
        Ok(n)
    }
}

/// размер открытого содержимого по размеру зашифрованного файла
fn plain_size(sealed: u64) -> u64 {
    sealed.saturating_sub((crypto::MAGIC.len() + 24 + 16) as u64)
}

fn walk(dir: &Path, prefix: &mut Vec<String>, out: &mut Dump, dkey: &DataKey) -> Result<(), String> {
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
                walk(&path, prefix, out, dkey)?;
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
            let read = fs::read(&path).map_err(|e| e.to_string()).and_then(|b| {
                let plain = if crypto::is_sealed(&b) { crypto::open(dkey, &b)? } else { b };
                serde_json::from_slice::<Value>(&plain).map_err(|e| e.to_string())
            });
            match read {
                Ok(v) => {
                    out.json.insert(key, v);
                }
                Err(e) => eprintln!("[хаб] файл данных не читается и пропущен: {}: {e}", path.display()),
            }
        } else {
            let size = entry.metadata().map(|m| plain_size(m.len())).unwrap_or(0);
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
        s.set_key(Some(DataKey::random()));
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

    #[test]
    fn encrypted_on_disk_and_locked_without_key() {
        let (d, s) = store();
        s.set_json("hub", "inbox/a", &json!({"text": "секретная мысль"})).unwrap();
        let raw = fs::read(d.path().join("hub/inbox/a.json")).unwrap();
        assert!(crypto::is_sealed(&raw));
        assert!(!String::from_utf8_lossy(&raw).contains("секрет"));
        s.set_key(None);
        assert_eq!(s.get_json("hub", "inbox/a").unwrap_err(), LOCKED);
        assert_eq!(s.dump("hub").unwrap_err(), LOCKED);
        assert!(s.set_json("hub", "x", &json!(1)).is_err());
    }

    #[test]
    fn stage1_plaintext_is_read_and_encrypted() {
        let (d, s) = store();
        fs::create_dir_all(d.path().join("repetition/localstorage")).unwrap();
        fs::write(d.path().join("repetition/localstorage/tb-meta.json"), br#"{"version":2}"#).unwrap();
        assert_eq!(s.get_json("repetition", "localstorage/tb-meta").unwrap(), Some(json!({"version": 2})));
        assert_eq!(s.encrypt_all().unwrap(), 1);
        assert!(crypto::is_sealed(&fs::read(d.path().join("repetition/localstorage/tb-meta.json")).unwrap()));
        assert_eq!(s.dump("repetition").unwrap().json.get("localstorage/tb-meta"), Some(&json!({"version": 2})));
        assert_eq!(s.encrypt_all().unwrap(), 0);
    }

    #[test]
    fn changes_are_recorded_except_quiet() {
        let (_d, s) = store();
        s.set_json("hub", "a", &json!(1)).unwrap();
        s.set_json_quiet("hub", "b", &json!(2)).unwrap();
        s.remove("hub", "a").unwrap();
        let ch: Vec<_> = s.changes().into_iter().map(|c| (c.ns, c.key)).collect();
        assert_eq!(ch, vec![("hub".into(), "a".into())]);
        s.acknowledge_changes(|_| true).unwrap();
        assert!(s.changes().is_empty());
        assert_eq!(s.namespaces(), vec!["hub".to_string()]);
    }
}
