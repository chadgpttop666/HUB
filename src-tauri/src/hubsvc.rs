//! Пароль, замок и синхронизация: команды для оболочки и фоновая работа.
//!
//! Файлы устройства (в папке данных приложения, рядом с data/):
//!   keys.json         запертый ключ данных (пароль и ключ восстановления); сам по себе бесполезен
//!   sync/outbox/     подтверждённые правки до записи в журнал — зашифрованы
//!   sync/state.json   журналы, версии, номер устройства — зашифровано ключом данных
//!   sync/target.json  куда синхронизировать и токен Drive — зашифровано
//!   sync/folders.json где на этом устройстве лежат помеченные папки — зашифровано
//!   sync/bisync/<id>/ служебные списки rclone bisync

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::crypto::{self, DataKey, KeyFile};
use crate::rclone::{self, Rclone, Target};
use crate::store::{now_ms, Store};
use crate::sync::{self, FolderDef, SyncError};

pub const PLATFORM: &str = if cfg!(any(target_os = "android", target_os = "ios")) { "phone" } else { "pc" };
const FOREGROUND_SYNC_MS: u64 = 30 * 1000;
const BACKGROUND_SYNC_MS: u64 = 5 * 60 * 1000;
const QUIET_AFTER_EDIT_MS: u64 = 2000;
const MIN_RESUME_CHECK_MS: u64 = 5000;
const RETRY_MS: u64 = 60 * 1000;

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalFolder {
    pub path: String,
    /// первая синхронизация (с пробным прогоном) уже прошла
    pub started: bool,
    #[serde(default)]
    pub problem: Option<SyncError>,
    #[serde(default)]
    pub last_sync: Option<u64>,
}

#[derive(Default)]
struct Runtime {
    state: Option<sync::State>,
    target: Option<Target>,
    folders: BTreeMap<String, LocalFolder>,
    rclone: Option<Rclone>,
    progress: SyncProgress,
    keys_pending: bool,
    last_maintenance: u64,
    generation: u64,
    device: String,
}

pub struct Hub {
    base: PathBuf,
    rt: Mutex<Runtime>,
    wake: (Mutex<Wake>, Condvar),
    foreground: AtomicBool,
    busy: AtomicBool,
}

#[derive(Default)]
struct Wake {
    manual: bool,
    activity: bool,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    /// off | idle | running | offline | error
    state: String,
    phase: &'static str,
    detail: String,
    problem: Option<SyncError>,
    maintenance_problem: Option<SyncError>,
    last_sync: Option<u64>,
    last_sent: Option<sync::Transfer>,
    last_received: Option<sync::Transfer>,
    last_attempt: Option<u64>,
    retry_at: Option<u64>,
    pending: usize,
}

impl SyncProgress {
    fn observe(&mut self, store: &Store, st: &sync::State) {
        self.last_sync = st.last_sync;
        self.last_sent = st.last_sent;
        self.last_received = st.last_received;
        self.pending = sync::pending_info(store, st).0;
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FolderStatus {
    pub id: String,
    pub name: String,
    pub mode: String,
    pub path: Option<String>,
    pub started: bool,
    pub problem: Option<SyncError>,
    pub conflicts: Vec<String>,
    pub last_sync: Option<u64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub configured: bool,
    pub kind: String,
    #[serde(flatten)]
    progress: SyncProgress,
    pub device: String,
    pub folders: Vec<FolderStatus>,
}

impl Hub {
    pub fn new(base: PathBuf) -> Self {
        Hub { base, rt: Mutex::new(Runtime::default()), wake: (Mutex::default(), Condvar::new()), foreground: AtomicBool::new(true), busy: AtomicBool::new(false) }
    }
    fn keys_path(&self) -> PathBuf {
        self.base.join("keys.json")
    }
    fn sync_dir(&self) -> PathBuf {
        self.base.join("sync")
    }
    fn rt(&self) -> std::sync::MutexGuard<'_, Runtime> {
        self.rt.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn read_keys(&self) -> Option<KeyFile> {
        serde_json::from_slice(&fs::read(self.keys_path()).ok()?).ok()
    }
    fn write_keys(&self, kf: &KeyFile) -> Result<(), String> {
        let tmp = self.keys_path().with_extension("tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(kf).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        fs::rename(&tmp, self.keys_path()).map_err(|e| e.to_string())
    }
    /// Номер этого устройства (известен, когда хаб открыт); иначе — «pc»/«phone».
    pub fn device(&self) -> String {
        let rt = self.rt();
        if rt.device.is_empty() { PLATFORM.into() } else { rt.device.clone() }
    }
    pub fn quick(&self) -> crate::quick::Quick {
        crate::quick::Quick::new(&self.base)
    }
    /// Сохранить состояние синхронизации перед выходом из программы.
    pub fn flush(&self, store: &Store) -> Result<(), String> {
        if store.is_open() {
            let mut rt = self.rt();
            self.save_runtime(store, &mut rt)?;
        }
        Ok(())
    }
    /// После входа: ключ корзины на месте, мысли из мини-окна, оставленные при запертом хабе, — в корзине.
    fn opened(&self, store: &Store) {
        match self.quick().after_unlock(store) {
            Ok(n) if n > 0 => eprintln!("[хаб] из мини-окна в корзину: {n}"),
            Ok(_) => {}
            Err(e) => eprintln!("[хаб] мысли из мини-окна не забраны: {e}"),
        }
    }
    pub fn poke(&self) {
        let (m, c) = &self.wake;
        m.lock().unwrap_or_else(|e| e.into_inner()).manual = true;
        c.notify_all();
    }

    /// После входа: состояние синхронизации этого устройства.
    fn open_runtime(&self, store: &Store, key: &DataKey) -> Result<(), String> {
        store.load_outbox()?;
        let dir = self.sync_dir();
        let mut state: sync::State = sync::load_sealed(&dir.join("state.json"), key)?;
        if state.device.is_empty() {
            state.device = sync::new_device_id(PLATFORM);
        }
        let target: Option<Target> = match sync::load_sealed::<Target>(&dir.join("target.json"), key)? {
            t if t.kind.is_empty() => None,
            t => Some(t),
        };
        let folders: BTreeMap<String, LocalFolder> = sync::load_sealed(&dir.join("folders.json"), key)?;
        let mut rt = self.rt();
        rt.generation += 1;
        rt.device = state.device.clone();
        rt.keys_pending = state.key_upload_pending;
        rt.progress = SyncProgress { state: "idle".into(), ..Default::default() };
        rt.progress.observe(store, &state);
        rt.state = Some(state);
        rt.target = target;
        rt.folders = folders;
        rt.rclone = None;
        Ok(())
    }

    fn save_runtime(&self, store: &Store, rt: &mut Runtime) -> Result<(), String> {
        let key = store.data_key()?;
        let dir = self.sync_dir();
        if let Some(st) = rt.state.as_mut() {
            st.key_upload_pending = rt.keys_pending;
            sync::absorb(store, st);
            sync::checkpoint(store, st, &dir.join("state.json"), &key)?;
        }
        sync::save_sealed(&dir.join("target.json"), &key, &rt.target.clone().unwrap_or_default())?;
        sync::save_sealed(&dir.join("folders.json"), &key, &rt.folders)?;
        Ok(())
    }

    fn rclone(&self, store: &Store, rt: &mut Runtime) -> Result<(), String> {
        if rt.rclone.is_none() {
            let target = rt.target.clone().ok_or("синхронизация не настроена")?;
            rt.rclone = Some(Rclone::with_crypt(&target, &store.data_key()?)?);
        }
        Ok(())
    }

    fn folder_defs(store: &Store) -> Vec<FolderDef> {
        let Ok(d) = store.dump("hub") else { return vec![] };
        d.json.into_iter().filter(|(k, _)| k.starts_with("sync-folders/")).filter_map(|(_, v)| serde_json::from_value(v).ok()).collect()
    }

    pub fn status(&self, store: &Store) -> SyncStatus {
        let defs = if store.is_open() { Self::folder_defs(store) } else { vec![] };
        let (mut status, local_folders) = {
            let rt = self.rt();
            (SyncStatus {
                configured: rt.target.is_some(),
                kind: rt.target.as_ref().map(|t| t.kind.clone()).unwrap_or_default(),
                progress: if rt.target.is_none() {
                    SyncProgress { state: "off".into(), ..Default::default() }
                } else {
                    let mut progress = rt.progress.clone();
                    if let Some(st) = &rt.state { progress.observe(store, st); }
                    progress
                },
                device: rt.device.clone(),
                folders: vec![],
            }, rt.folders.clone())
        };
        status.folders = defs
            .into_iter()
            .map(|d| {
                let lf = local_folders.get(&d.id);
                let conflicts = lf.filter(|f| !f.path.is_empty()).map(|f| sync::find_conflicts(Path::new(&f.path))).unwrap_or_default();
                FolderStatus {
                    path: lf.map(|f| f.path.clone()).filter(|p| !p.is_empty()),
                    started: lf.map(|f| f.started).unwrap_or(false),
                    problem: lf.and_then(|f| f.problem.clone()),
                    last_sync: lf.and_then(|f| f.last_sync),
                    conflicts,
                    id: d.id,
                    name: d.name,
                    mode: d.mode,
                }
            })
            .collect();
        status
    }

    fn phase(
        &self, app: &AppHandle, generation: u64, st: &sync::State, phase: &'static str, detail: String,
    ) -> Result<(), SyncError> {
        let progress = {
            let mut rt = self.rt();
            if rt.generation != generation {
                return Err(SyncError::msg("Сеанс синхронизации завершён"));
            }
            rt.progress.observe(&app.state::<Store>(), st);
            rt.progress.phase = phase;
            rt.progress.detail = detail;
            rt.progress.clone()
        };
        let _ = app.emit("hub://sync-progress", progress);
        Ok(())
    }

    fn checkpoint(&self, store: &Store, generation: u64, st: &sync::State) -> Result<(), SyncError> {
        let rt = self.rt();
        if rt.generation != generation {
            return Err(SyncError::msg("Сеанс синхронизации завершён"));
        }
        let key = store.data_key().map_err(SyncError::msg)?;
        sync::checkpoint(store, st, &self.sync_dir().join("state.json"), &key).map_err(SyncError::msg)
    }

    fn run_once(&self, app: &AppHandle, maintenance: bool) {
        let store = app.state::<Store>();
        let (generation, mut st) = {
            let mut rt = self.rt();
            if !store.is_open() || rt.target.is_none() { return; }
            let Some(st) = rt.state.take() else { return };
            self.busy.store(true, Ordering::SeqCst);
            rt.progress.state = "running".into();
            rt.progress.problem = None;
            rt.progress.last_attempt = Some(now_ms());
            rt.progress.retry_at = None;
            (rt.generation, st)
        };
        let mut report = sync::Report::default();
        let mut result = (|| {
            self.phase(app, generation, &st, "prepare", String::new())?;
            let r = {
                let mut rt = self.rt();
                if rt.generation != generation { return Err(SyncError::msg("Сеанс синхронизации завершён")); }
                self.rclone(&store, &mut rt).map_err(SyncError::msg)?;
                rt.rclone.as_ref().expect("rclone есть").clone()
            };
            if !st.bootstrapped {
                sync::bootstrap(&store, &mut st).map_err(SyncError::msg)?;
            }
            let exchange = sync::exchange(&store, &r, &mut st, &mut report, |step, st| match step {
                sync::ExchangeStep::Receiving => {
                    self.checkpoint(&store, generation, st)?;
                    self.phase(app, generation, st, "receive", String::new())
                }
                sync::ExchangeStep::Sending => self.phase(app, generation, st, "send", String::new()),
                sync::ExchangeStep::ReserveSequence => self.checkpoint(&store, generation, st),
            });
            // Фиксируем получение и отправку до резервного копирования, даже если успела только одна стадия.
            self.checkpoint(&store, generation, &st)?;
            if !report.changed.is_empty() {
                let _ = app.emit("hub://data-changed", json!({ "namespaces": report.changed }));
            }
            exchange?;

            let key_target = {
                let rt = self.rt();
                if rt.generation != generation { return Ok(()); }
                rt.keys_pending.then(|| rt.target.clone()).flatten()
            };
            if let Some(target) = key_target {
                self.phase(app, generation, &st, "keys", String::new())?;
                let kf = self.read_keys().ok_or_else(|| SyncError::msg("Локальный файл ключей не читается"))?;
                let base = Rclone::base(&target).map_err(SyncError::msg)?;
                let json = serde_json::to_vec_pretty(&kf).map_err(|e| SyncError::msg(e.to_string()))?;
                let o = base.run(&["rcat", &rclone::base_path(&target, "keys.json")], Some(&json));
                if !o.ok { return Err(SyncError::from_output(&o)); }
                let mut rt = self.rt();
                if rt.generation == generation {
                    // Если одновременно сменили пароль, следующий проход должен загрузить новый файл.
                    rt.keys_pending = self.read_keys().and_then(|current| serde_json::to_vec_pretty(&current).ok()).as_deref() != Some(json.as_slice());
                    st.key_upload_pending = rt.keys_pending;
                }
            }

            if maintenance {
                let maintenance_problem = self.maintain(app, &store, generation, &r, &mut st)?;
                let mut rt = self.rt();
                if rt.generation == generation {
                    rt.progress.maintenance_problem = maintenance_problem;
                    rt.last_maintenance = now_ms();
                }
            }
            Ok(())
        })();
        {
            let mut rt = self.rt();
            if rt.generation == generation {
                sync::absorb(&store, &mut st);
                rt.progress.observe(&store, &st);
                rt.state = Some(st);
                if let Err(err) = self.save_runtime(&store, &mut rt) {
                    if result.is_ok() {
                        rt.progress.phase = "save";
                        result = Err(SyncError::msg(err));
                    }
                }
                match result {
                    Ok(()) => {
                        rt.progress.state = "idle".into();
                        rt.progress.phase = "";
                        rt.progress.detail.clear();
                    }
                    Err(err) => {
                        rt.progress.state = if err.kind == "offline" { "offline".into() } else { "error".into() };
                        rt.progress.problem = Some(err);
                        rt.progress.retry_at = Some(now_ms().saturating_add(RETRY_MS));
                    }
                }
            }
        }
        self.busy.store(false, Ordering::SeqCst);
        let _ = app.emit("hub://sync", self.status(&store));
    }

    fn maintain(
        &self, app: &AppHandle, store: &Store, generation: u64, r: &Rclone, st: &mut sync::State,
    ) -> Result<Option<SyncError>, SyncError> {
        self.phase(app, generation, st, "snapshot", String::new())?;
        let mut warning = sync::snapshot(r, st, "hub", "hub").err();
        let wd = self.sync_dir().join("bisync");
        for def in Self::folder_defs(store) {
            let folder = self.rt().folders.get(&def.id).cloned();
            let Some(mut folder) = folder else { continue };
            if !folder.started || folder.path.is_empty() || folder.problem.as_ref().is_some_and(|p| !["offline", "error"].contains(&p.kind.as_str())) {
                continue;
            }
            self.phase(app, generation, st, "folders", def.name.clone())?;
            match sync::folder_sync(r, &def, Path::new(&folder.path), &wd.join(&def.id), false, false) {
                Ok(_) => {
                    folder.problem = None;
                    folder.last_sync = Some(now_ms());
                    self.phase(app, generation, st, "snapshot", def.name.clone())?;
                    if let Err(err) = sync::snapshot(r, st, &format!("folder-{}", def.id), &format!("folders/{}", def.id)) {
                        warning = Some(err);
                    }
                }
                Err(err) => folder.problem = Some(err),
            }
            let mut rt = self.rt();
            if rt.generation != generation { return Ok(warning); }
            rt.folders.insert(def.id, folder);
        }
        Ok(warning)
    }

    /// В открытом Хабе проверяем новые данные чаще. Снимки и папки — по прежнему интервалу.
    pub fn spawn_worker(app: AppHandle) {
        std::thread::spawn(move || {
            let mut previous_pending = 0;
            loop {
                let hub = app.state::<Hub>();
                let wake = {
                    let (m, c) = &hub.wake;
                    let guard = m.lock().unwrap_or_else(|e| e.into_inner());
                    let (mut flags, _) = c.wait_timeout_while(guard, Duration::from_secs(1), |w| !w.manual && !w.activity)
                        .unwrap_or_else(|e| e.into_inner());
                    std::mem::take(&mut *flags)
                };
                let store = app.state::<Store>();
                if !store.is_open() { continue; }
                let foreground = hub.foreground.load(Ordering::SeqCst);
                let now = now_ms();
                let (due, maintenance, progress) = {
                    let mut rt = hub.rt();
                    if rt.target.is_none() { continue; }
                    let Some(st) = &rt.state else { continue };
                    let (pending, last_edit) = sync::pending_info(&store, st);
                    let quiet_period_done = pending > 0 && now.saturating_sub(last_edit) >= QUIET_AFTER_EDIT_MS;
                    let leaving_with_edits = wake.activity && !foreground && pending > 0;
                    let since_attempt = now.saturating_sub(rt.progress.last_attempt.unwrap_or(0));
                    let resumed = wake.activity && foreground && since_attempt >= MIN_RESUME_CHECK_MS;
                    let interval = if foreground { FOREGROUND_SYNC_MS } else { BACKGROUND_SYNC_MS };
                    let due = wake.manual || (rt.progress.retry_at.is_none_or(|retry| now >= retry)
                        && (quiet_period_done || leaving_with_edits || resumed || since_attempt >= interval));
                    let maintenance = wake.manual || now.saturating_sub(rt.last_maintenance) >= BACKGROUND_SYNC_MS;
                    rt.progress.pending = pending;
                    let progress = (pending != previous_pending).then(|| rt.progress.clone());
                    previous_pending = pending;
                    (due, maintenance, progress)
                };
                if due { hub.run_once(&app, maintenance); }
                else if let Some(progress) = progress { let _ = app.emit("hub://sync-progress", progress); }
            }
        });
    }
}

/* ───────── команды: пароль и замок ───────── */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubStatus {
    setup_done: bool,
    unlocked: bool,
    has_old_data: bool,
    platform: &'static str,
}

#[tauri::command]
pub fn hub_status(hub: State<'_, Hub>, store: State<'_, Store>) -> HubStatus {
    HubStatus { setup_done: hub.read_keys().is_some(), unlocked: store.is_open(), has_old_data: !store.namespaces().is_empty(), platform: PLATFORM }
}

fn check_password(p: &str) -> Result<(), String> {
    if p.chars().count() < 8 {
        return Err("Пароль — не короче 8 знаков".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn setup_create(hub: State<'_, Hub>, store: State<'_, Store>, password: String) -> Result<String, String> {
    if hub.read_keys().is_some() {
        return Err("Хаб уже настроен".into());
    }
    check_password(&password)?;
    let c = crypto::create(&password)?;
    store.set_key(Some(c.key.clone()));
    store.encrypt_all()?;
    hub.write_keys(&c.file)?;
    hub.open_runtime(&store, &c.key)?;
    hub.opened(&store);
    Ok(c.recovery)
}

#[tauri::command]
pub async fn unlock(app: AppHandle, hub: State<'_, Hub>, store: State<'_, Store>, password: String) -> Result<(), String> {
    let kf = hub.read_keys().ok_or("Хаб ещё не настроен")?;
    let key = crypto::unlock_password(&kf, &password)?;
    store.set_key(Some(key.clone()));
    hub.open_runtime(&store, &key)?;
    hub.opened(&store);
    let _ = app.emit("hub://sync", hub.status(&store));
    hub.poke();
    Ok(())
}

#[tauri::command]
pub async fn unlock_with_recovery(hub: State<'_, Hub>, store: State<'_, Store>, code: String, new_password: String) -> Result<(), String> {
    let kf = hub.read_keys().ok_or("Хаб ещё не настроен")?;
    check_password(&new_password)?;
    let key = crypto::unlock_recovery(&kf, &code)?;
    let kf2 = crypto::change_password(&kf, &key, &new_password)?;
    hub.write_keys(&kf2)?;
    store.set_key(Some(key.clone()));
    hub.open_runtime(&store, &key)?;
    hub.opened(&store);
    hub.rt().keys_pending = true;
    hub.poke();
    Ok(())
}

#[tauri::command]
pub async fn change_password(hub: State<'_, Hub>, store: State<'_, Store>, old_password: String, new_password: String) -> Result<(), String> {
    let kf = hub.read_keys().ok_or("Хаб ещё не настроен")?;
    check_password(&new_password)?;
    let key = crypto::unlock_password(&kf, &old_password).map_err(|_| "Старый пароль неверный".to_string())?;
    let kf2 = crypto::change_password(&kf, &key, &new_password)?;
    hub.write_keys(&kf2)?;
    let _ = store;
    hub.rt().keys_pending = true;
    hub.poke();
    Ok(())
}

#[tauri::command]
pub fn lock(hub: State<'_, Hub>, store: State<'_, Store>) -> Result<(), String> {
    {
        let mut rt = hub.rt();
        if store.is_open() {
            let _ = hub.save_runtime(&store, &mut rt);
        }
        *rt = Runtime { generation: rt.generation + 1, ..Runtime::default() };
    }
    store.set_key(None);
    Ok(())
}

/* ───────── команды: синхронизация ───────── */

#[tauri::command]
pub async fn sync_status(app: AppHandle) -> Result<SyncStatus, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<Hub>().status(&app.state::<Store>()))
        .await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_now(hub: State<'_, Hub>) {
    hub.poke();
}

#[tauri::command]
pub fn sync_activity(hub: State<'_, Hub>, foreground: bool) {
    hub.foreground.store(foreground, Ordering::SeqCst);
    let (flags, wake) = &hub.wake;
    flags.lock().unwrap_or_else(|e| e.into_inner()).activity = true;
    wake.notify_all();
}

/// Проверка без Google: HUB_SYNC_LOCAL=<папка> — «Drive» изображает обычная папка (только для тестов).
fn test_target(t: Target) -> Target {
    match (t.token.strip_prefix("local:"), std::env::var("HUB_SYNC_LOCAL")) {
        (Some(p), Ok(_)) => Target { kind: "local".into(), path: p.to_string(), ..Default::default() },
        _ => t,
    }
}

// rclone принимает ответ Google на одном порту, поэтому вход может быть только один.
#[derive(Default, Clone)]
pub struct DriveAuth(std::sync::Arc<std::sync::atomic::AtomicU8>);

const AUTH_IDLE: u8 = 0;
const AUTH_RUNNING: u8 = 1;
const AUTH_CANCELLED: u8 = 2;

#[tauri::command]
pub fn drive_cancel(auth: State<'_, DriveAuth>) {
    let _ = auth.0.compare_exchange(AUTH_RUNNING, AUTH_CANCELLED, Ordering::SeqCst, Ordering::SeqCst);
}

/// Вход в Google через rclone: браузер с запросом прав drive.file, ответ ловит rclone на 127.0.0.1:53682.
#[tauri::command]
pub async fn drive_authorize(app: AppHandle, auth: State<'_, DriveAuth>, client_id: String, client_secret: String) -> Result<String, String> {
    if let Ok(p) = std::env::var("HUB_SYNC_LOCAL") {
        return Ok(format!("local:{p}"));
    }
    use tauri_plugin_opener::OpenerExt;
    let auth = auth.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        auth.0.compare_exchange(AUTH_IDLE, AUTH_RUNNING, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "Вход в Google уже начат")?;
        let result = rclone::authorize(&client_id, &client_secret, move |url| {
            let _ = app.opener().open_url(url, None::<&str>);
        }, || auth.0.load(Ordering::SeqCst) == AUTH_CANCELLED);
        auth.0.store(AUTH_IDLE, Ordering::SeqCst);
        result
    }).await.map_err(|e| e.to_string())?
}

fn remote_keys(t: &Target) -> Result<Option<KeyFile>, String> {
    let base = Rclone::base(t)?;
    let o = base.run(&["cat", &rclone::base_path(t, "keys.json")], None);
    if !o.ok {
        if o.offline() {
            return Err("Нет связи с Drive".into());
        }
        if o.not_found() {
            return Ok(None);
        }
        return Err(o.err());
    }
    serde_json::from_slice(&o.stdout).map(Some).map_err(|e| format!("keys.json на Drive не читается: {e}"))
}

/// Подключить синхронизацию на настроенном хабе. Если на Drive хаба ещё нет — это первое устройство.
#[tauri::command]
pub async fn sync_connect(hub: State<'_, Hub>, store: State<'_, Store>, target: Target) -> Result<String, String> {
    let target = test_target(target);
    let key = store.data_key()?;
    let local = hub.read_keys().ok_or("Хаб ещё не настроен")?;
    let first = match remote_keys(&target)? {
        None => true,
        Some(kf) if kf.id == local.id => false,
        Some(_) => return Err("На этом Drive уже есть другой хаб. Чтобы работать с ним, переустановите хаб на этом устройстве и выберите «Подключить к существующему».".into()),
    };
    // проверка, что crypt работает (и rclone на месте), до сохранения
    let r = Rclone::with_crypt(&target, &key)?;
    let o = r.run(&["mkdir", &format!("{}:hub", rclone::CRYPT)], None);
    if !o.ok {
        return Err(o.err());
    }
    {
        let mut rt = hub.rt();
        rt.target = Some(target);
        rt.rclone = Some(r);
        rt.keys_pending = first;
        if let Some(st) = rt.state.as_mut() {
            if !first {
                st.bootstrapped = true;
            }
        }
        hub.save_runtime(&store, &mut rt)?;
    }
    hub.poke();
    Ok(if first { "first".into() } else { "rejoined".into() })
}

/// Новое устройство: ключи берутся с Drive, пароль — тот же, что на первом устройстве.
#[tauri::command]
pub async fn setup_join(app: AppHandle, hub: State<'_, Hub>, store: State<'_, Store>, target: Target, password: String) -> Result<(), String> {
    if hub.read_keys().is_some() {
        return Err("Хаб на этом устройстве уже настроен".into());
    }
    let target = test_target(target);
    let kf = remote_keys(&target)?.ok_or("Хаб не видит существующую папку «Hub». Войдите в тот же аккаунт Google с Client ID и Client Secret с первого устройства. На первом устройстве дождитесь синхронизации.")?;
    let key = crypto::unlock_password(&kf, &password)?;
    hub.write_keys(&kf)?;
    store.set_key(Some(key.clone()));
    store.encrypt_all()?;
    hub.open_runtime(&store, &key)?;
    hub.opened(&store);
    {
        let mut rt = hub.rt();
        rt.target = Some(target);
        if let Some(st) = rt.state.as_mut() {
            st.bootstrapped = true;
        }
        hub.save_runtime(&store, &mut rt)?;
    }
    let _ = app.emit("hub://sync", hub.status(&store));
    hub.poke();
    Ok(())
}

#[tauri::command]
pub fn sync_disconnect(hub: State<'_, Hub>, store: State<'_, Store>) -> Result<(), String> {
    let mut rt = hub.rt();
    if hub.busy.load(Ordering::SeqCst) {
        return Err("Дождитесь окончания синхронизации перед отключением".into());
    }
    rt.target = None;
    rt.rclone = None;
    hub.save_runtime(&store, &mut rt)
}

/// OAuth-пара текущего подключения, без токена и только после повторного ввода пароля.
#[tauri::command]
pub async fn sync_saved_drive_client(app: AppHandle, password: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let hub = app.state::<Hub>();
        let store = app.state::<Store>();
        if !store.is_open() {
            return Err("Сначала разблокируйте Хаб".into());
        }
        let kf = hub.read_keys().ok_or("Хаб ещё не настроен")?;
        crypto::unlock_password(&kf, &password)?;
        let rt = hub.rt();
        let target = rt.target.as_ref().filter(|t| t.kind == "drive")
            .ok_or("На этом устройстве нет сохранённого подключения Google Drive")?;
        if target.client_id.trim().is_empty() || target.client_secret.trim().is_empty() {
            return Err("В этом подключении нет сохранённой пары Client ID и Client Secret".into());
        }
        Ok(json!({ "clientId": &target.client_id, "clientSecret": &target.client_secret }))
    }).await.map_err(|e| e.to_string())?
}

/// Пароли crypt для обычного rclone — только после повторного ввода пароля хаба.
#[tauri::command]
pub async fn sync_rclone_passwords(hub: State<'_, Hub>, password: String) -> Result<Value, String> {
    let kf = hub.read_keys().ok_or("Хаб ещё не настроен")?;
    let key = crypto::unlock_password(&kf, &password)?;
    let (p1, p2) = rclone::crypt_passwords(&key);
    Ok(json!({ "password": p1, "password2": p2, "remote": "Hub/crypt" }))
}

/* ───────── команды: папки ───────── */

fn folder_def(store: &Store, id: &str) -> Result<FolderDef, String> {
    let v = store.get_json("hub", &format!("sync-folders/{id}"))?.ok_or("нет такой папки")?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

fn check_dir(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path.trim());
    if !p.is_absolute() {
        return Err("Нужен полный путь к папке".into());
    }
    fs::create_dir_all(&p).map_err(|e| {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            "Нет доступа к папке. На телефоне: Настройки → Приложения → Хаб → «Доступ ко всем файлам»".to_string()
        } else {
            format!("{}: {e}", p.display())
        }
    })?;
    fs::read_dir(&p).map_err(|e| format!("Папка не читается: {e}. На телефоне нужен «Доступ ко всем файлам» для хаба"))?;
    Ok(p)
}

/// Пометить папку: метка .hubsync в папке, описание — в данных хаба (другие устройства его увидят).
#[tauri::command]
pub async fn folder_add(hub: State<'_, Hub>, store: State<'_, Store>, path: String, name: String, mode: String, exclude: Vec<String>) -> Result<String, String> {
    let p = check_dir(&path)?;
    let name = if name.trim().is_empty() { p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or("Папка".into()) } else { name.trim().to_string() };
    let def = match sync::read_marker(&p).and_then(|m| m.get("id").and_then(Value::as_str).map(str::to_string)) {
        Some(id) if store.get_json("hub", &format!("sync-folders/{id}"))?.is_some() => folder_def(&store, &id)?,
        _ => FolderDef { id: sync::folder_id(&name), name, mode: if mode == "backup" { "backup".into() } else { "two-way".into() }, exclude },
    };
    sync::write_marker(&p, &def)?;
    store.set_json("hub", &format!("sync-folders/{}", def.id), &serde_json::to_value(&def).map_err(|e| e.to_string())?)?;
    let mut rt = hub.rt();
    rt.folders.insert(def.id.clone(), LocalFolder { path: p.to_string_lossy().to_string(), started: false, problem: None, last_sync: None });
    hub.save_runtime(&store, &mut rt)?;
    Ok(def.id)
}

/// Папка с другого устройства: куда её положить здесь.
#[tauri::command]
pub async fn folder_place(hub: State<'_, Hub>, store: State<'_, Store>, id: String, path: String) -> Result<(), String> {
    folder_def(&store, &id)?;
    let p = check_dir(&path)?;
    let mut rt = hub.rt();
    rt.folders.insert(id, LocalFolder { path: p.to_string_lossy().to_string(), started: false, problem: None, last_sync: None });
    hub.save_runtime(&store, &mut rt)
}

fn with_rclone<T>(hub: &Hub, store: &Store, f: impl FnOnce(&Rclone) -> T) -> Result<T, String> {
    let mut rt = hub.rt();
    hub.rclone(store, &mut rt)?;
    let r = rt.rclone.as_ref().expect("rclone есть").clone();
    drop(rt);
    Ok(f(&r))
}

fn local_folder(hub: &Hub, id: &str) -> Result<LocalFolder, String> {
    hub.rt().folders.get(id).cloned().filter(|f| !f.path.is_empty()).ok_or_else(|| "Папка ещё не выбрана на этом устройстве".to_string())
}

/// Пробный прогон: что уйдёт, что придёт, что различается. Ничего не меняет.
#[tauri::command]
pub async fn folder_preview(hub: State<'_, Hub>, store: State<'_, Store>, id: String) -> Result<sync::Preview, String> {
    let def = folder_def(&store, &id)?;
    let lf = local_folder(&hub, &id)?;
    with_rclone(&hub, &store, |r| sync::folder_preview(r, &def, Path::new(&lf.path)))?.map_err(|e| e.message)
}

/// Запустить синхронизацию папки. action: "start" (первая, после пробного прогона, или восстановление),
/// "force" (подтверждённое массовое удаление), "sync" (обычная).
#[tauri::command]
pub async fn folder_sync(app: AppHandle, hub: State<'_, Hub>, store: State<'_, Store>, id: String, action: String) -> Result<Vec<String>, String> {
    let def = folder_def(&store, &id)?;
    let mut lf = local_folder(&hub, &id)?;
    let wd = hub.sync_dir().join("bisync").join(&id);
    let res = with_rclone(&hub, &store, |r| sync::folder_sync(r, &def, Path::new(&lf.path), &wd, action == "start", action == "force"))?;
    let out = match res {
        Ok(rep) => {
            lf.started = true;
            lf.problem = None;
            lf.last_sync = Some(now_ms());
            Ok(rep.conflicts)
        }
        Err(e) => {
            let m = e.message.clone();
            lf.problem = Some(e);
            Err(m)
        }
    };
    {
        let mut rt = hub.rt();
        rt.folders.insert(id, lf);
        hub.save_runtime(&store, &mut rt)?;
    }
    let _ = app.emit("hub://sync", hub.status(&store));
    out
}

#[tauri::command]
pub fn folder_resolve(hub: State<'_, Hub>, id: String, keep: String) -> Result<String, String> {
    let lf = local_folder(&hub, &id)?;
    let r = sync::resolve_conflict(Path::new(&lf.path), &keep)?;
    hub.poke();
    Ok(r)
}

/// Перестать синхронизировать папку на этом устройстве (файлы и копия на Drive остаются).
#[tauri::command]
pub fn folder_forget(hub: State<'_, Hub>, store: State<'_, Store>, id: String) -> Result<(), String> {
    let mut rt = hub.rt();
    rt.folders.remove(&id);
    hub.save_runtime(&store, &mut rt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_rule() {
        assert!(check_password("коротко").is_err());
        assert!(check_password("достаточно длинный").is_ok());
    }
}
