//! Синхронизация (этап 2).
//!
//! **Данные хаба и приложений** — журналами, как в диздоке: каждое устройство пишет только свой
//! журнал `hub/changes-<устройство>/<номер>.json` и читает чужие, поэтому файлы на Drive не конфликтуют.
//! Запись журнала содержит правку и версии, которые видел её автор. Независимые правки
//! одного ключа видны в «Настройках», пока пользователь не выберет версию.
//!
//! **Помеченные папки** (Obsidian и др.) — `rclone bisync` между папкой и `folders/<id>` на Drive,
//! со стоп-краном против массового удаления, пробным прогоном перед первой синхронизацией и
//! копиями обеих версий при конфликте (`…sync-conflict1`, `…sync-conflict2`).
//!
//! Ежедневно — снимок каждой папки и данных хаба в `snapshots/<id>/<дата>`, хранится 30 последних.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::crypto::{self, DataKey};
use crate::rclone::{Rclone, CRYPT};
use crate::store::{local_only, now_ms, write_atomic, Store};

pub const SNAPSHOTS_KEEP: usize = 30;
const SEP: char = '\u{1}';

/* ───────── состояние этого устройства (зашифровано ключом данных) ───────── */

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct State {
    pub device: String,
    /// номер последнего отправленного куска своего журнала
    pub seq: u64,
    /// чужие журналы: устройство → последний применённый номер
    pub seen: BTreeMap<String, u64>,
    /// ключ → (время, устройство) последней известной версии
    pub versions: BTreeMap<String, (u64, String)>,
    #[serde(default)]
    contexts: BTreeMap<String, Clock>,
    /// Значения дублируются в состоянии только для записей с несколькими версиями.
    #[serde(default)]
    branches: BTreeMap<String, Vec<Op>>,
    /// ключи, изменённые здесь и ещё не отправленные: ключ → время
    pub dirty: BTreeMap<String, u64>,
    /// загруженные двоичные значения (sha256)
    pub blobs: BTreeSet<String>,
    pub bootstrapped: bool,
    pub last_sync: Option<u64>,
    #[serde(default)]
    pub last_sent: Option<Transfer>,
    #[serde(default)]
    pub key_upload_pending: bool,
    #[serde(default)]
    pub last_received: Option<Transfer>,
    /// папка (или "hub") → день последнего снимка
    pub snapshot_days: BTreeMap<String, String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Transfer {
    pub at: u64,
    pub count: usize,
}

pub fn load_sealed<T: for<'de> Deserialize<'de> + Default>(path: &Path, key: &DataKey) -> Result<T, String> {
    match fs::read(path) {
        Ok(b) => serde_json::from_slice(&crypto::open(key, &b)?).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

pub fn save_sealed<T: Serialize>(path: &Path, key: &DataKey, value: &T) -> Result<(), String> {
    let bytes = crypto::seal(key, &serde_json::to_vec(value).map_err(|e| e.to_string())?);
    write_atomic(path, &bytes)
}

pub fn new_device_id(prefix: &str) -> String {
    let mut b = [0u8; 3];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut b);
    format!("{prefix}-{:02x}{:02x}{:02x}", b[0], b[1], b[2])
}

fn id_of(ns: &str, key: &str) -> String {
    format!("{ns}{SEP}{key}")
}

fn split_id(id: &str) -> (&str, &str) {
    id.split_once(SEP).unwrap_or((id, ""))
}

pub type Clock = BTreeMap<String, u64>;

#[derive(Clone, Debug)]
pub(crate) struct Revision {
    pub ts: u64,
    pub dev: String,
    pub context: Option<Clock>,
}

impl Revision {
    pub fn clock(&self) -> Clock {
        let mut clock = Clock::new();
        self.include_in(&mut clock);
        clock
    }

    pub fn include_in(&self, clock: &mut Clock) {
        if let Some(context) = &self.context {
            for (dev, ts) in context {
                let seen = clock.entry(dev.clone()).or_default();
                *seen = (*seen).max(*ts);
            }
        }
        let seen = clock.entry(self.dev.clone()).or_default();
        *seen = (*seen).max(self.ts);
    }

    pub fn in_clock(&self, clock: &Clock) -> bool {
        clock.get(&self.dev).is_some_and(|ts| *ts >= self.ts)
    }

    fn covers(&self, other: &Self) -> bool {
        (self.dev == other.dev && self.ts >= other.ts)
            || self.context.as_ref().is_some_and(|clock| other.in_clock(clock))
    }

    fn stamp(&self) -> (u64, &str) { (self.ts, &self.dev) }

    fn supersedes(&self, other: &Self) -> bool {
        self.covers(other) || (!other.covers(self) && self.context.is_none() && other.context.is_none() && self.stamp() > other.stamp())
    }
}

impl State {
    fn revision(&self, id: &str) -> Option<Revision> {
        let (ts, dev) = self.versions.get(id)?;
        let mut revision = Revision { ts: *ts, dev: dev.clone(), context: self.contexts.get(id).cloned() };
        if let Some(heads) = self.branches.get(id) {
            let winner = heads.last().expect("головная версия");
            let mut clock = revision.clock();
            for head in heads.iter().filter(|op| op.same_value(winner)) {
                head.revision().include_in(&mut clock);
            }
            revision.context = Some(clock);
        }
        Some(revision)
    }

    pub(crate) fn attach(&self, store: &Store) {
        store.init_revisions(&self.device, self.versions.keys().filter_map(|id| {
            let (ns, key) = split_id(id);
            Some((ns.into(), key.into(), self.revision(id)?))
        }));
    }
}

/* ───────── журнал ───────── */

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Op {
    pub ns: String,
    pub key: String,
    pub ts: u64,
    pub dev: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub del: bool,
    #[serde(default, deserialize_with = "present_json", skip_serializing_if = "Option::is_none")]
    pub json: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<Clock>,
}

fn present_json<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}

impl Op {
    fn revision(&self) -> Revision {
        Revision { ts: self.ts, dev: self.dev.clone(), context: self.context.clone() }
    }

    fn stamp(&self) -> (u64, &str) { (self.ts, &self.dev) }

    fn same_value(&self, other: &Self) -> bool {
        self.del == other.del && self.json == other.json && self.blob == other.blob && self.mime == other.mime
    }

    pub(crate) fn read(store: &Store, ns: &str, key: &str, rev: Revision) -> Result<(Self, Option<Vec<u8>>), String> {
        let mut op = Self { ns: ns.into(), key: key.into(), ts: rev.ts, dev: rev.dev, context: rev.context,
            del: false, json: None, blob: None, mime: None };
        let mut bytes = None;
        match store.stat(ns, key)? {
            None => op.del = true,
            Some(stat) if stat.kind == "json" => op.json = store.get_json(ns, key)?,
            Some(stat) => {
                let content = store.get_blob(ns, key)?.ok_or("Не удалось прочитать двоичные данные")?;
                op.blob = Some(format!("{:x}", Sha256::digest(&content)));
                op.mime = stat.mime;
                bytes = Some(content);
            }
        }
        Ok((op, bytes))
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Segment {
    pub v: u32,
    pub dev: String,
    pub seq: u64,
    pub ops: Vec<Op>,
}

#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub pushed: usize,
    pub applied: usize,
    pub conflicts: usize,
    /// пространства, которые поменялись из-за чужих правок — их надо перечитать
    pub changed: BTreeSet<String>,
}

fn crypt(path: &str) -> String {
    format!("{CRYPT}:{path}")
}

/// Отметить изменения, накопленные хранилищем: они уйдут в журнал.
pub fn absorb(store: &Store, st: &mut State) -> Result<bool, String> {
    let _g = store.mutation_guard();
    let mut conflicts_changed = false;
    for change in store.changes() {
        let id = id_of(&change.ns, &change.key);
        if st.versions.get(&id).is_some_and(|(ts, dev)| *ts == change.ts && *dev == st.device) {
            continue;
        }
        let context = change.context.or_else(|| st.revision(&id).map(|r| r.clock())).unwrap_or_default();
        let revision = Revision { ts: change.ts, dev: st.device.clone(), context: Some(context) };
        let old = st.branches.get(&id).cloned().unwrap_or_else(|| {
            change.previous.into_iter().collect()
        });
        if old.is_empty() {
            st.versions.insert(id.clone(), (revision.ts, revision.dev.clone()));
            st.contexts.insert(id.clone(), revision.context.clone().unwrap_or_default());
            store.set_revision(&change.ns, &change.key, revision);
        } else {
            let (op, _) = Op::read(store, &change.ns, &change.key, revision)?;
            let heads = add_head(old, op);
            conflicts_changed |= update_conflict(store, &id, &heads, st.branches.contains_key(&id))?;
            save_heads(store, st, &id, heads);
        }
        st.dirty.insert(id, change.ts);
    }
    Ok(conflicts_changed)
}

pub fn pending_info(store: &Store, st: &State) -> (usize, u64) {
    let mut count = st.dirty.len();
    let mut last = st.dirty.values().copied().max().unwrap_or(0);
    for change in store.changes() {
        if !st.dirty.contains_key(&id_of(&change.ns, &change.key)) {
            count += 1;
        }
        last = last.max(change.ts);
    }
    (count, last)
}

pub fn checkpoint(store: &Store, st: &State, path: &Path, key: &DataKey) -> Result<(), String> {
    save_sealed(path, key, st)?;
    store.acknowledge_changes(|c| st.versions.get(&id_of(&c.ns, &c.key)).is_some_and(|(ts, dev)| *ts == c.ts && *dev == st.device))
}

/// Первое устройство: всё, что уже есть в хабе, — в журнал.
pub fn bootstrap(store: &Store, st: &mut State) -> Result<(), String> {
    absorb(store, st)?;
    let ts = now_ms();
    for ns in store.namespaces() {
        for (key, _) in store.keys(&ns)? {
            if local_only(&ns, &key) {
                continue;
            }
            let id = id_of(&ns, &key);
            if st.versions.contains_key(&id) { continue; }
            st.dirty.insert(id.clone(), ts);
            st.contexts.insert(id.clone(), Clock::new());
            st.versions.insert(id, (ts, st.device.clone()));
        }
    }
    st.bootstrapped = true;
    st.attach(store);
    Ok(())
}

#[derive(Clone, Copy)]
pub enum ExchangeStep {
    Receiving,
    Sending,
    ReserveSequence,
}

#[cfg(test)]
fn sync_hub(store: &Store, r: &Rclone, st: &mut State) -> Result<Report, SyncError> {
    let mut report = Report::default();
    exchange(store, r, st, &mut report, |step, st| {
        if matches!(step, ExchangeStep::ReserveSequence) {
            store.acknowledge_changes(|c| st.versions.get(&id_of(&c.ns, &c.key)).is_some_and(|(ts, dev)| *ts == c.ts && *dev == st.device)).map_err(SyncError::msg)?;
        }
        Ok(())
    })?;
    Ok(report)
}

pub fn exchange(
    store: &Store,
    r: &Rclone,
    st: &mut State,
    report: &mut Report,
    mut progress: impl FnMut(ExchangeStep, &State) -> Result<(), SyncError>,
) -> Result<(), SyncError> {
    if absorb(store, st).map_err(SyncError::msg)? { report.changed.insert("hub".into()); }
    // Сначала публикуем свои версии, даже если после чтения они станут конфликтными.
    if !st.dirty.is_empty() {
        progress(ExchangeStep::Sending, st)?;
        push(store, r, st, report, |st| progress(ExchangeStep::ReserveSequence, st))?;
        if report.pushed > 0 { st.last_sent = Some(Transfer { at: now_ms(), count: report.pushed }); }
    }
    progress(ExchangeStep::Receiving, st)?;
    let received = pull(store, r, st, report);
    if report.applied > 0 { st.last_received = Some(Transfer { at: now_ms(), count: report.applied }); }
    received?;
    st.last_sync = Some(now_ms());
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncError {
    /// offline | error | needs-resync | safety-abort | locked
    pub kind: String,
    pub message: String,
    #[serde(default)]
    pub code: String,
}

impl SyncError {
    pub fn from_output(o: &crate::rclone::Output) -> Self {
        let s = o.stderr.to_ascii_lowercase();
        if s.contains("safety abort") || s.contains("too many deletes") {
            return Self { kind: "safety-abort".into(), message: "Стоп-кран остановил массовое удаление. Проверьте файлы перед продолжением.".into(), code: "safety-abort".into() };
        }
        if s.contains("--resync") {
            return Self { kind: "needs-resync".into(), message: o.err(), code: "needs-resync".into() };
        }
        let code = o.problem();
        Self { kind: if code == "network" { "offline" } else { "error" }.into(), message: o.err(), code: code.into() }
    }
    pub fn msg(m: impl Into<String>) -> Self {
        let message = m.into();
        let code = crate::rclone::classify_error(&message);
        SyncError { kind: if code == "network" { "offline" } else { "error" }.into(), message, code: code.into() }
    }
}

fn pull(store: &Store, r: &Rclone, st: &mut State, rep: &mut Report) -> Result<(), SyncError> {
    let o = r.run(&["lsf", "--recursive", "--files-only", "--include", "/changes-*/*.json", &crypt("hub/")], None);
    if !o.ok {
        return if o.not_found() { Ok(()) } else { Err(SyncError::from_output(&o)) };
    }
    let listing = o.text();
    let mut segments: Vec<(&str, u64)> = listing.lines().filter_map(|line| {
        let (dir, file) = line.split_once('/')?;
        let device = dir.strip_prefix("changes-")?;
        let seq = file.strip_suffix(".json")?.parse().ok()?;
        (device != st.device && seq > st.seen.get(device).copied().unwrap_or(0)).then_some((device, seq))
    }).collect();
    segments.sort_unstable();
    segments.dedup();
    let mut deferred = BTreeSet::new();
    'segments: for (dev, seq) in segments {
        if deferred.contains(dev) { continue; }
        let o = r.run(&["cat", &crypt(&format!("hub/changes-{dev}/{seq:08}.json"))], None);
        if !o.ok {
            return Err(SyncError::from_output(&o));
        }
        let seg: Segment = serde_json::from_slice(&o.stdout).map_err(|e| SyncError::msg(format!("Журнал {dev}/{seq} не читается: {e}")))?;
        for op in seg.ops {
            if !apply(store, r, st, op, rep)? {
                // Правка с этого устройства появилась уже после отправки. Повторим
                // сегмент после её публикации, не пропуская ни одну версию.
                deferred.insert(dev);
                continue 'segments;
            }
        }
        st.seen.insert(dev.into(), seq);
    }
    Ok(())
}

fn add_head(mut heads: Vec<Op>, op: Op) -> Vec<Op> {
    let revision = op.revision();
    if heads.iter().any(|head| head.revision().supersedes(&revision)) {
        return heads;
    }
    heads.retain(|head| !revision.supersedes(&head.revision()));
    heads.push(op);
    heads.sort_by(|a, b| a.stamp().cmp(&b.stamp()));
    heads
}

fn conflict_key(id: &str) -> String {
    format!("conflicts/causal/{:x}", Sha256::digest(id))
}

fn update_conflict(store: &Store, id: &str, heads: &[Op], was_branched: bool) -> Result<bool, String> {
    let winner = heads.last().expect("должна остаться хотя бы одна версия");
    if heads.iter().all(|head| head.same_value(winner)) {
        if !was_branched { return Ok(false); }
        let key = conflict_key(id);
        let existed = store.stat("hub", &key)?.is_some();
        store.remove_quiet("hub", &key)?;
        return Ok(existed);
    }
    let mut basis = Clock::new();
    for head in heads { head.revision().include_in(&mut basis); }
    let value = json!({ "ns": winner.ns, "key": winner.key, "at": winner.ts, "basis": basis, "variants": heads });
    store.set_json_quiet("hub", &conflict_key(id), &value)?;
    Ok(true)
}

fn save_heads(store: &Store, st: &mut State, id: &str, heads: Vec<Op>) {
    let winner = heads.last().expect("должна остаться хотя бы одна версия");
    let (ns, key) = (winner.ns.clone(), winner.key.clone());
    st.versions.insert(id.into(), (winner.ts, winner.dev.clone()));
    if let Some(context) = &winner.context { st.contexts.insert(id.into(), context.clone()); }
    else { st.contexts.remove(id); }
    if heads.len() > 1 { st.branches.insert(id.into(), heads); }
    else { st.branches.remove(id); }
    store.set_revision(&ns, &key, st.revision(id).expect("сохранённая версия"));
}

pub(crate) fn read_remote_blob(r: &Rclone, sha: &str) -> Result<Vec<u8>, SyncError> {
    if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(SyncError::msg("Некорректная ссылка на двоичные данные"));
    }
    let o = r.run(&["cat", &crypt(&format!("hub/blobs/{sha}"))], None);
    if !o.ok { return Err(SyncError::from_output(&o)); }
    if format!("{:x}", Sha256::digest(&o.stdout)) != sha {
        return Err(SyncError::msg("Содержимое файла не совпадает с журналом синхронизации"));
    }
    Ok(o.stdout)
}

fn apply(store: &Store, r: &Rclone, st: &mut State, op: Op, rep: &mut Report) -> Result<bool, SyncError> {
    if local_only(&op.ns, &op.key) { return Ok(true); }
    let id = id_of(&op.ns, &op.key);
    let ns = op.ns.clone();
    let key = op.key.clone();
    let can_apply = || !st.dirty.contains_key(&id) && store.pending_at(&ns, &key).is_none();
    let lock = store.mutation_guard();
    if !can_apply() { return Ok(false); }
    let current = st.revision(&id);
    let incoming = op.revision();
    let heads = if let Some(heads) = st.branches.get(&id) {
        if heads.iter().any(|head| head.revision().supersedes(&incoming)) { return Ok(true); }
        add_head(heads.clone(), op)
    } else if let Some(revision) = &current {
        if revision.supersedes(&incoming) { return Ok(true); }
        if incoming.supersedes(revision) { vec![op] }
        else {
            // Если процесс оборвался после записи конфликта, файл уже содержит
            // исходную версию, даже если видимое значение успело смениться.
            let saved = store.get_json("hub", &conflict_key(&id)).map_err(SyncError::msg)?
                .and_then(|v| serde_json::from_value::<Vec<Op>>(v["variants"].clone()).ok())
                .and_then(|ops| ops.into_iter().find(|v| v.stamp() == revision.stamp()));
            let previous = match saved {
                Some(saved) => saved,
                None => Op::read(store, &ns, &key, revision.clone()).map_err(SyncError::msg)?.0,
            };
            add_head(vec![previous], op)
        }
    } else { vec![op] };
    let winner = heads.last().expect("должна остаться хотя бы одна версия");
    let replace = current.as_ref().map(Revision::stamp) != Some(winner.stamp());
    let mut lock = Some(lock);
    let bytes = if replace {
        if let Some(sha) = &winner.blob {
            // Загрузка файла не блокирует запись из интерфейса.
            drop(lock.take());
            let bytes = read_remote_blob(r, sha)?;
            lock = Some(store.mutation_guard());
            if !can_apply() { return Ok(false); }
            Some(bytes)
        } else { None }
    } else { None };
    let _lock = lock;
    let was_branched = st.branches.contains_key(&id);
    if update_conflict(store, &id, &heads, was_branched).map_err(SyncError::msg)? {
        rep.changed.insert("hub".into());
        if heads.iter().any(|head| !head.same_value(winner)) { rep.conflicts += 1; }
    }
    if replace {
        if winner.del {
            store.remove_quiet(&ns, &key).map_err(SyncError::msg)?;
        } else if let Some(value) = &winner.json {
            store.set_json_quiet(&ns, &key, value).map_err(SyncError::msg)?;
        } else if let (Some(sha), Some(bytes)) = (&winner.blob, bytes) {
            store.set_blob_quiet(&ns, &key, winner.mime.as_deref().unwrap_or(""), &bytes).map_err(SyncError::msg)?;
            st.blobs.insert(sha.clone());
        }
        rep.applied += 1;
        rep.changed.insert(ns);
    }
    save_heads(store, st, &id, heads);
    Ok(true)
}

fn push(
    store: &Store, r: &Rclone, st: &mut State, rep: &mut Report,
    reserve_sequence: impl FnOnce(&State) -> Result<(), SyncError>,
) -> Result<(), SyncError> {
    let mut ops = Vec::new();
    let mut sent = Vec::new();
    for (id, ts) in &st.dirty {
        let (ns, key) = split_id(id);
        let (op, bytes) = {
            let _g = store.mutation_guard();
            if store.pending_at(ns, key).is_some_and(|pending| pending != *ts) { continue; }
            let rev = Revision { ts: *ts, dev: st.device.clone(), context: st.contexts.get(id).cloned() };
            Op::read(store, ns, key, rev).map_err(SyncError::msg)?
        };
        if let (Some(sha), Some(bytes)) = (&op.blob, bytes) {
            if !st.blobs.contains(sha) {
                let o = r.run(&["rcat", &crypt(&format!("hub/blobs/{sha}"))], Some(&bytes));
                if !o.ok { return Err(SyncError::from_output(&o)); }
                st.blobs.insert(sha.clone());
            }
        }
        ops.push(op);
        sent.push(id.clone());
    }
    if ops.is_empty() { return Ok(()); }
    // Номер резервируется на диске до отправки. После прерывания не перезапишем уже загруженный сегмент.
    st.seq += 1;
    reserve_sequence(st)?;
    let seq = st.seq;
    let seg = Segment { v: 1, dev: st.device.clone(), seq, ops };
    let bytes = serde_json::to_vec(&seg).map_err(|e| SyncError::msg(e.to_string()))?;
    let o = r.run(&["rcat", &crypt(&format!("hub/changes-{}/{seq:08}.json", st.device))], Some(&bytes));
    if !o.ok {
        return Err(SyncError::from_output(&o));
    }
    for id in sent { st.dirty.remove(&id); }
    rep.pushed = seg.ops.len();
    Ok(())
}

/* ───────── снимки ───────── */

pub fn today() -> String {
    // дата по UTC: снимок раз в сутки, точный час не важен
    let days = now_ms() / 86_400_000;
    let (y, m, d) = civil_from_days(days as i64);
    format!("{y:04}-{m:02}-{d:02}")
}

pub(crate) fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Снимок `src` (путь внутри crypt) в `snapshots/<name>/<сегодня>`, не чаще раза в день; хранится 30.
pub fn snapshot(r: &Rclone, st: &mut State, name: &str, src: &str) -> Result<bool, SyncError> {
    let day = today();
    if st.snapshot_days.get(name) == Some(&day) {
        return Ok(false);
    }
    let o = r.run(&["copy", &crypt(src), &crypt(&format!("snapshots/{name}/{day}"))], None);
    if !o.ok {
        if o.not_found() {
            return Ok(false);
        }
        return Err(SyncError::from_output(&o));
    }
    st.snapshot_days.insert(name.into(), day);
    let o = r.run(&["lsf", "--dirs-only", &crypt(&format!("snapshots/{name}/"))], None);
    if o.ok {
        let mut days: Vec<String> = o.text().lines().map(|l| l.trim_end_matches('/').to_string()).collect();
        days.sort();
        while days.len() > SNAPSHOTS_KEEP {
            let old = days.remove(0);
            let _ = r.run(&["purge", &crypt(&format!("snapshots/{name}/{old}"))], None);
        }
    }
    Ok(true)
}

/* ───────── помеченные папки ───────── */

/// Описание папки — общее для всех устройств (лежит в данных хаба: hub/sync-folders/<id>).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FolderDef {
    pub id: String,
    pub name: String,
    /// "two-way" — в обе стороны; "backup" — только копия в облако
    pub mode: String,
    #[serde(default)]
    pub exclude: Vec<String>,
}

pub const MARKER: &str = ".hubsync";

pub fn folder_id(name: &str) -> String {
    let base: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let mut b = [0u8; 2];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut b);
    format!("{}-{:02x}{:02x}", if base.is_empty() { "folder" } else { &base[..base.len().min(24)] }, b[0], b[1])
}

pub fn write_marker(path: &Path, def: &FolderDef) -> Result<(), String> {
    let v = json!({ "id": def.id, "mode": def.mode, "encrypt": true, "exclude": def.exclude });
    fs::write(path.join(MARKER), serde_json::to_vec_pretty(&v).map_err(|e| e.to_string())?).map_err(|e| format!("{}: {e}", path.display()))
}

pub fn read_marker(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path.join(MARKER)).ok()?).ok()
}

fn remote_of(def: &FolderDef) -> String {
    crypt(&format!("folders/{}", def.id))
}

fn filter_args(def: &FolderDef) -> Vec<String> {
    let mut a = Vec::new();
    for e in &def.exclude {
        a.push("--exclude".to_string());
        a.push(e.clone());
    }
    a
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    /// есть только здесь — уйдут на Drive
    pub upload: Vec<String>,
    /// есть только на Drive — придут сюда
    pub download: Vec<String>,
    /// есть в обоих местах и различаются — останется более новая
    pub differ: Vec<String>,
    pub same: usize,
}

/// Пробный прогон: что сделает первая синхронизация. Ничего не меняет.
pub fn folder_preview(r: &Rclone, def: &FolderDef, path: &Path) -> Result<Preview, SyncError> {
    let remote = remote_of(def);
    let mk = r.run(&["mkdir", &remote], None);
    if !mk.ok {
        return Err(SyncError::from_output(&mk));
    }
    let local = path.to_string_lossy().to_string();
    let mut args: Vec<String> = vec!["check".into(), local, remote, "--size-only".into(), "--combined".into(), "-".into()];
    args.extend(filter_args(def));
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let o = r.run(&argv, None);
    // check возвращает код 1, когда есть различия — это не ошибка
    if !o.ok && (o.code != 1 || o.stdout.is_empty()) {
        return Err(SyncError::from_output(&o));
    }
    // rclone check --combined (проверено на 1.76): «+» — только здесь, «-» — только на Drive, «*» — различаются, «=» — одинаковые
    let mut p = Preview::default();
    for line in o.text().lines() {
        let Some((mark, name)) = line.split_once(' ') else { continue };
        match mark {
            "+" => p.upload.push(name.into()),
            "-" => p.download.push(name.into()),
            "*" => p.differ.push(name.into()),
            "=" => p.same += 1,
            _ => {}
        }
    }
    Ok(p)
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FolderReport {
    pub conflicts: Vec<String>,
}

/// Синхронизировать папку. resync — первая синхронизация или восстановление после сбоя
/// (объединяет обе стороны, ничего не удаляя); force — пропустить стоп-кран (пользователь подтвердил удаление).
pub fn folder_sync(r: &Rclone, def: &FolderDef, path: &Path, workdir: &Path, resync: bool, force: bool) -> Result<FolderReport, SyncError> {
    if !path.is_dir() {
        return Err(SyncError::msg(format!("папки нет: {}", path.display())));
    }
    fs::create_dir_all(workdir).map_err(|e| SyncError::msg(e.to_string()))?;
    let remote = remote_of(def);
    let local = path.to_string_lossy().to_string();
    let wd = workdir.to_string_lossy().to_string();
    let mut args: Vec<String> = if def.mode == "backup" {
        vec!["sync".into(), local, remote, "--max-delete".into(), "50%".into()]
    } else {
        let mk = r.run(&["mkdir", &remote], None);
        if !mk.ok {
            return Err(SyncError::from_output(&mk));
        }
        let mut a: Vec<String> = vec![
            "bisync".into(), local, remote, "--workdir".into(), wd,
            "--compare".into(), "size,modtime".into(), "--create-empty-src-dirs".into(),
            "--resilient".into(), "--recover".into(),
            "--conflict-resolve".into(), "none".into(), "--conflict-loser".into(), "num".into(), "--conflict-suffix".into(), "sync-conflict".into(),
            "--max-delete".into(), "50".into(),
        ];
        if resync {
            a.push("--resync".into());
            a.push("--resync-mode".into());
            a.push("newer".into());
        }
        if force {
            a.push("--force".into());
        }
        a
    };
    if def.mode == "backup" && force {
        args.retain(|x| x != "--max-delete" && x != "50%");
    }
    args.extend(filter_args(def));
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let o = r.run(&argv, None);
    if !o.ok {
        return Err(SyncError::from_output(&o));
    }
    Ok(FolderReport { conflicts: find_conflicts(path) })
}

/// Файлы-конфликты в папке: «заметка.md.sync-conflict1» и т. п. (пути относительно папки, через «/»)
pub fn find_conflicts(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if e.file_name().to_string_lossy().contains(".sync-conflict") {
                if let Ok(rel) = p.strip_prefix(root) {
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
    out.sort();
    out
}

/// Исходное имя для файла-конфликта: «a.md.sync-conflict2» → «a.md»
pub fn conflict_original(rel: &str) -> Option<String> {
    let i = rel.rfind(".sync-conflict")?;
    let tail = &rel[i + ".sync-conflict".len()..];
    if tail.chars().all(|c| c.is_ascii_digit()) {
        Some(rel[..i].to_string())
    } else {
        None
    }
}

/// Оставить выбранную версию: она получает исходное имя, остальные копии этого файла удаляются.
pub fn resolve_conflict(root: &Path, keep_rel: &str) -> Result<String, String> {
    let original = conflict_original(keep_rel).ok_or("это не файл-конфликт")?;
    let safe = |rel: &str| -> Result<PathBuf, String> {
        let p = Path::new(rel);
        if p.components().all(|c| matches!(c, std::path::Component::Normal(_))) { Ok(root.join(p)) } else { Err("недопустимый путь".into()) }
    };
    let keep = safe(keep_rel)?;
    for other in find_conflicts(root) {
        if other != keep_rel && conflict_original(&other).as_deref() == Some(original.as_str()) {
            fs::remove_file(safe(&other)?).map_err(|e| e.to_string())?;
        }
    }
    fs::rename(&keep, safe(&original)?).map_err(|e| e.to_string())?;
    Ok(original)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rclone::Target;

    #[test]
    fn dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_412), (2025, 11, 20));
        assert_eq!(today().len(), 10);
    }

    #[test]
    fn conflict_names() {
        assert_eq!(conflict_original("a/b.md.sync-conflict2").as_deref(), Some("a/b.md"));
        assert_eq!(conflict_original("b.md"), None);
        assert_eq!(conflict_original("x.sync-conflictZ"), None);
    }

    #[test]
    fn resolve_keeps_chosen() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("n.md.sync-conflict1"), "ПК").unwrap();
        fs::write(d.path().join("n.md.sync-conflict2"), "телефон").unwrap();
        assert_eq!(find_conflicts(d.path()).len(), 2);
        resolve_conflict(d.path(), "n.md.sync-conflict2").unwrap();
        assert_eq!(fs::read_to_string(d.path().join("n.md")).unwrap(), "телефон");
        assert!(find_conflicts(d.path()).is_empty());
        assert!(resolve_conflict(d.path(), "../x.sync-conflict1").is_err());
    }

    /* Сквозные проверки с настоящим rclone и папкой вместо Drive. Запускаются, если задан HUB_RCLONE. */

    struct Dev {
        store: Store,
        st: State,
        _dir: tempfile::TempDir,
    }

    fn dev(name: &str, key: &DataKey) -> Dev {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().join("data"));
        store.set_key(Some(key.clone()));
        let st = State { device: name.into(), ..Default::default() };
        st.attach(&store);
        Dev { store, st, _dir: dir }
    }

    fn rc(drive: &Path, key: &DataKey) -> Option<Rclone> {
        std::env::var("HUB_RCLONE").ok()?;
        let t = Target { kind: "local".into(), path: drive.to_string_lossy().to_string(), ..Default::default() };
        Some(Rclone::with_crypt(&t, key).unwrap())
    }

    #[test]
    fn two_devices_merge_and_conflicts() {
        let drive = tempfile::tempdir().unwrap();
        let key = DataKey::random();
        let Some(r) = rc(drive.path(), &key) else { eprintln!("HUB_RCLONE не задан — пропуск"); return };
        let mut pc = dev("pc-1", &key);
        let mut ph = dev("phone-1", &key);

        // ПК: данные этапа 1 уходят целиком
        pc.store.set_json("hub", "inbox/a", &json!({"text": "мысль с ПК"})).unwrap();
        pc.store.set_json("repetition", "localstorage/tb-records", &json!([{"title": "Кант"}])).unwrap();
        pc.store.set_blob("repetition", "indexeddb/media/files_blobs/s1/blob", "video/mp4", &[0u8, 1, 2, 250, 251]).unwrap();
        bootstrap(&pc.store, &mut pc.st).unwrap();
        let rep = sync_hub(&pc.store, &r, &mut pc.st).unwrap();
        assert_eq!(rep.pushed, 3);
        assert!(!fs::read_dir(drive.path().join("crypt")).unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains("hub")), "имена на Drive зашифрованы");

        // телефон получает всё, включая двоичное
        ph.st.bootstrapped = true;
        let rep = sync_hub(&ph.store, &r, &mut ph.st).unwrap();
        assert_eq!(rep.applied, 3);
        assert!(rep.changed.contains("repetition"));
        assert_eq!(ph.store.get_json("hub", "inbox/a").unwrap(), Some(json!({"text": "мысль с ПК"})));
        assert_eq!(ph.store.get_blob("repetition", "indexeddb/media/files_blobs/s1/blob").unwrap().unwrap(), vec![0u8, 1, 2, 250, 251]);

        // разные ключи на разных устройствах — сливаются; удаление доходит
        ph.store.set_json("hub", "inbox/b", &json!({"text": "мысль с телефона"})).unwrap();
        pc.store.remove("hub", "inbox/a").unwrap();
        sync_hub(&ph.store, &r, &mut ph.st).unwrap();
        sync_hub(&pc.store, &r, &mut pc.st).unwrap();
        sync_hub(&ph.store, &r, &mut ph.st).unwrap();
        assert!(pc.store.get_json("hub", "inbox/b").unwrap().is_some());
        assert!(ph.store.get_json("hub", "inbox/a").unwrap().is_none());

        // один ключ на обоих: побеждает более поздняя правка, другая — в конфликтах
        pc.store.set_json("repetition", "localstorage/tb-records", &json!([{"title": "Кант"}, {"title": "с ПК"}])).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        ph.store.set_json("repetition", "localstorage/tb-records", &json!([{"title": "Кант"}, {"title": "с телефона"}])).unwrap();
        sync_hub(&pc.store, &r, &mut pc.st).unwrap();
        let rep = sync_hub(&ph.store, &r, &mut ph.st).unwrap();
        assert_eq!(rep.conflicts, 1, "на телефоне пришла старая версия ПК — она сохранена");
        sync_hub(&pc.store, &r, &mut pc.st).unwrap();
        let want = json!([{"title": "Кант"}, {"title": "с телефона"}]);
        assert_eq!(pc.store.get_json("repetition", "localstorage/tb-records").unwrap(), Some(want.clone()));
        assert_eq!(ph.store.get_json("repetition", "localstorage/tb-records").unwrap(), Some(want.clone()));
        let conflicts: Vec<_> = pc.store.dump("hub").unwrap().json.into_iter().filter(|(k, _)| k.starts_with("conflicts/")).collect();
        assert_eq!(conflicts.len(), 1, "конфликт виден и на ПК");
        assert_eq!(conflicts[0].1["variants"][0]["json"], json!([{"title": "Кант"}, {"title": "с ПК"}]));
        assert_eq!(conflicts[0].1["variants"][1]["json"], want);

        // ничего нового — ничего не отправляется
        let rep = sync_hub(&pc.store, &r, &mut pc.st).unwrap();
        assert_eq!((rep.pushed, rep.applied), (0, 0));

        // снимок раз в день и не больше
        assert!(snapshot(&r, &mut pc.st, "hub", "hub").unwrap());
        assert!(!snapshot(&r, &mut pc.st, "hub", "hub").unwrap());
        let o = r.run(&["lsf", "--dirs-only", &crypt("snapshots/hub/")], None);
        assert_eq!(o.text().trim(), format!("{}/", today()));
    }

    #[test]
    fn both_devices_upload_before_reading_then_resolve() {
        let drive = tempfile::tempdir().unwrap();
        let key = DataKey::random();
        let Some(r) = rc(drive.path(), &key) else { return };
        let mut pc = dev("pc", &key);
        let mut phone = dev("phone", &key);
        let ns = "repetition";
        let card_a = "localstorage/tb-record/r-a";
        let card_b = "localstorage/tb-record/r-b";
        let same = "localstorage/tb-record/r-same";
        let conflict = conflict_key(&id_of(ns, same));

        pc.store.set_json(ns, same, &json!({"record": {"title": "До правок"}})).unwrap();
        sync_hub(&pc.store, &r, &mut pc.st).unwrap();
        sync_hub(&phone.store, &r, &mut phone.st).unwrap();
        pc.store.set_json(ns, card_a, &json!({"record": {"title": "ПК"}})).unwrap();
        phone.store.set_json(ns, card_b, &json!({"record": {"title": "Телефон"}})).unwrap();
        pc.store.set_json(ns, same, &Value::Null).unwrap();
        phone.store.remove(ns, same).unwrap();

        for device in [&mut pc, &mut phone] {
            let mut report = Report::default();
            let err = exchange(&device.store, &r, &mut device.st, &mut report, |step, st| match step {
                ExchangeStep::ReserveSequence => checkpoint(&device.store, st, &device._dir.path().join("state.json"), &key).map_err(SyncError::msg),
                ExchangeStep::Receiving => Err(SyncError::msg("получение ещё не началось")),
                ExchangeStep::Sending => Ok(()),
            }).unwrap_err();
            assert_eq!(err.message, "получение ещё не началось");
            assert_eq!(report.pushed, 2);
            assert!(device.st.dirty.is_empty());
        }

        for device in [&mut pc, &mut phone] {
            assert_eq!(sync_hub(&device.store, &r, &mut device.st).unwrap().conflicts, 1);
            assert!(device.store.get_json(ns, card_a).unwrap().is_some());
            assert!(device.store.get_json(ns, card_b).unwrap().is_some());
        }
        let available = pc.store.get_json("hub", &conflict).unwrap().unwrap();
        assert_eq!(phone.store.get_json("hub", &conflict).unwrap(), Some(available.clone()));
        let versions = available["variants"].as_array().unwrap();
        assert!(versions.iter().any(|v| v.get("json") == Some(&Value::Null)));
        assert!(versions.iter().any(|v| v["del"] == true));

        let state_path = pc._dir.path().join("state.json");
        checkpoint(&pc.store, &pc.st, &state_path, &key).unwrap();
        pc.st = load_sealed(&state_path, &key).unwrap();
        pc.st.attach(&pc.store);
        let basis = serde_json::from_value(available["basis"].clone()).unwrap();
        pc.store.set_json_from(ns, same, &Value::Null, Some(basis)).unwrap();
        sync_hub(&pc.store, &r, &mut pc.st).unwrap();
        sync_hub(&phone.store, &r, &mut phone.st).unwrap();
        phone.st.seen.clear(); // Повторное чтение прежних операций после выбора.
        sync_hub(&phone.store, &r, &mut phone.st).unwrap();
        for device in [&pc, &phone] {
            assert_eq!(device.store.get_json(ns, same).unwrap(), Some(Value::Null));
            assert_eq!(device.store.get_json("hub", &conflict).unwrap(), None);
        }
    }

    #[test]
    fn stale_editor_preserves_received_value() {
        let drive = tempfile::tempdir().unwrap();
        let key = DataKey::random();
        let Some(r) = rc(drive.path(), &key) else { return };
        let mut pc = dev("pc", &key);
        let mut phone = dev("phone", &key);
        let (ns, name) = ("calendar", "events/lesson");
        pc.store.set_json(ns, name, &json!("первая версия")).unwrap();
        sync_hub(&pc.store, &r, &mut pc.st).unwrap();
        sync_hub(&phone.store, &r, &mut phone.st).unwrap();
        let basis = phone.store.dump(ns).unwrap().basis.remove(name).unwrap();
        pc.store.set_json(ns, name, &json!("правка ПК")).unwrap();
        sync_hub(&pc.store, &r, &mut pc.st).unwrap();
        assert_eq!(sync_hub(&phone.store, &r, &mut phone.st).unwrap().conflicts, 0);

        phone.store.set_json_from(ns, name, &json!("правка открытой формы"), Some(basis)).unwrap();
        sync_hub(&phone.store, &r, &mut phone.st).unwrap();
        sync_hub(&pc.store, &r, &mut pc.st).unwrap();
        let conflict = conflict_key(&id_of(ns, name));
        let own = phone.store.get_json("hub", &conflict).unwrap().unwrap();
        assert_eq!(pc.store.get_json("hub", &conflict).unwrap(), Some(own.clone()));
        assert_eq!(own["variants"][0]["json"], "правка ПК");
        assert_eq!(own["variants"][1]["json"], "правка открытой формы");
    }

    #[test]
    fn pending_edits_and_sequence_survive_restart() {
        let root = tempfile::tempdir().unwrap();
        let drive = tempfile::tempdir().unwrap();
        let key = DataKey::random();
        let Some(rclone) = rc(drive.path(), &key) else { return };
        let data = root.path().join("data");
        let outbox = root.path().join("outbox");
        let state_path = root.path().join("state.json");
        let first = Store::with_outbox(data.clone(), outbox.clone());
        first.set_key(Some(key.clone()));
        let initial = State { device: "phone".into(), bootstrapped: true, ..Default::default() };
        checkpoint(&first, &initial, &state_path, &key).unwrap();
        first.set_json("hub", "inbox/retained", &json!({"text": "до перезапуска"})).unwrap();
        let marker = fs::read_dir(&outbox).unwrap().next().unwrap().unwrap().path();
        assert!(crypto::is_sealed(&fs::read(marker).unwrap()));
        drop(first);

        let resumed = Store::with_outbox(data, outbox);
        resumed.set_key(Some(key.clone()));
        resumed.load_outbox().unwrap();
        assert_eq!(resumed.changes().len(), 1);
        let mut state = load_sealed(&state_path, &key).unwrap();
        let mut report = Report::default();
        let interrupted = exchange(&resumed, &rclone, &mut state, &mut report, |step, st| {
            if matches!(step, ExchangeStep::Receiving | ExchangeStep::ReserveSequence) {
                checkpoint(&resumed, st, &state_path, &key).map_err(SyncError::msg)?;
            }
            if matches!(step, ExchangeStep::ReserveSequence) {
                return Err(SyncError::msg("прерывание перед отправкой"));
            }
            Ok(())
        });
        assert!(interrupted.is_err());
        assert_eq!(resumed.changes().len(), 0);
        let mut restored: State = load_sealed(&state_path, &key).unwrap();
        assert_eq!(restored.dirty.len(), 1);
        assert_eq!(restored.seq, 1);
        assert_eq!(sync_hub(&resumed, &rclone, &mut restored).unwrap().pushed, 1);
        assert_eq!(restored.seq, 2);
        assert_eq!(restored.last_sent.unwrap().count, 1);
        let mut receiver = dev("pc", &key);
        assert_eq!(sync_hub(&receiver.store, &rclone, &mut receiver.st).unwrap().applied, 1);
        assert_eq!(receiver.st.last_received.unwrap().count, 1);
        assert_eq!(receiver.store.get_json("hub", "inbox/retained").unwrap(), Some(json!({"text": "до перезапуска"})));
    }

    #[test]
    fn folder_two_way_conflict_and_safety() {
        let drive = tempfile::tempdir().unwrap();
        let key = DataKey::random();
        let Some(r) = rc(drive.path(), &key) else { eprintln!("HUB_RCLONE не задан — пропуск"); return };
        let (a, b, wa, wb) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let def = FolderDef { id: folder_id("Obsidian"), name: "Obsidian".into(), mode: "two-way".into(), exclude: vec![".obsidian/workspace*.json".into()] };
        for i in 0..6 {
            fs::write(a.path().join(format!("n{i}.md")), format!("заметка {i}")).unwrap();
        }
        fs::create_dir_all(a.path().join(".obsidian")).unwrap();
        fs::write(a.path().join(".obsidian/workspace.json"), "{}").unwrap();
        write_marker(a.path(), &def).unwrap();

        let p = folder_preview(&r, &def, a.path()).unwrap();
        assert_eq!(p.upload.len(), 7, "6 заметок и .hubsync, workspace исключён: {:?}", p.upload);
        folder_sync(&r, &def, a.path(), wa.path(), true, false).unwrap();
        let p = folder_preview(&r, &def, b.path()).unwrap();
        assert_eq!(p.download.len(), 7);
        folder_sync(&r, &def, b.path(), wb.path(), true, false).unwrap();
        assert_eq!(fs::read_to_string(b.path().join("n3.md")).unwrap(), "заметка 3");
        assert!(read_marker(b.path()).is_some(), "метка переехала вместе с папкой");
        assert!(!b.path().join(".obsidian/workspace.json").exists());

        std::thread::sleep(std::time::Duration::from_millis(1100));
        fs::write(a.path().join("n1.md"), "версия ПК").unwrap();
        fs::write(b.path().join("n1.md"), "версия телефона").unwrap();
        folder_sync(&r, &def, a.path(), wa.path(), false, false).unwrap();
        let rep = folder_sync(&r, &def, b.path(), wb.path(), false, false).unwrap();
        assert_eq!(rep.conflicts.len(), 2, "{:?}", rep.conflicts);
        resolve_conflict(b.path(), "n1.md.sync-conflict2").unwrap();
        assert!(find_conflicts(b.path()).is_empty());

        for i in 0..6 {
            let _ = fs::remove_file(a.path().join(format!("n{i}.md")));
        }
        let e = folder_sync(&r, &def, a.path(), wa.path(), false, false).unwrap_err();
        assert_eq!(e.kind, "safety-abort", "{e:?}");
        folder_sync(&r, &def, a.path(), wa.path(), true, false).unwrap();
        assert!(a.path().join("n3.md").exists(), "resync вернул файлы");
    }
}
