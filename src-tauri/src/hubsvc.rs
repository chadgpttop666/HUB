//! Пароль, замок и синхронизация: команды для оболочки и фоновая работа.
//!
//! Файлы устройства (в папке данных приложения, рядом с data/):
//!   keys.json         запертый ключ данных (пароль и ключ восстановления); сам по себе бесполезен
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
const IDLE_SYNC_MS: u64 = 5 * 60 * 1000;
const QUIET_AFTER_EDIT_MS: u64 = 4000;
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
    status: String,
    message: String,
    keys_pending: bool,
    last_try: u64,
}

pub struct Hub {
    base: PathBuf,
    rt: Mutex<Runtime>,
    wake: (Mutex<bool>, Condvar),
    busy: AtomicBool,
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
    /// off | idle | running | offline | error
    pub state: String,
    pub message: String,
    pub last_sync: Option<u64>,
    pub device: String,
    pub folders: Vec<FolderStatus>,
}

impl Hub {
    pub fn new(base: PathBuf) -> Self {
        Hub { base, rt: Mutex::new(Runtime::default()), wake: (Mutex::new(false), Condvar::new()), busy: AtomicBool::new(false) }
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
    pub fn poke(&self) {
        let (m, c) = &self.wake;
        *m.lock().unwrap_or_else(|e| e.into_inner()) = true;
        c.notify_all();
    }

    /// После входа: состояние синхронизации этого устройства.
    fn open_runtime(&self, key: &DataKey) -> Result<(), String> {
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
        rt.state = Some(state);
        rt.target = target;
        rt.folders = folders;
        rt.rclone = None;
        rt.status = "idle".into();
        rt.message.clear();
        Ok(())
    }

    fn save_runtime(&self, store: &Store, rt: &mut Runtime) -> Result<(), String> {
        let key = store.data_key()?;
        let dir = self.sync_dir();
        if let Some(st) = rt.state.as_mut() {
            sync::absorb(store, st);
            sync::save_sealed(&dir.join("state.json"), &key, st)?;
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
        let rt = self.rt();
        let folders = defs
            .into_iter()
            .map(|d| {
                let lf = rt.folders.get(&d.id);
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
        SyncStatus {
            configured: rt.target.is_some(),
            kind: rt.target.as_ref().map(|t| t.kind.clone()).unwrap_or_default(),
            state: if rt.target.is_none() { "off".into() } else { rt.status.clone() },
            message: rt.message.clone(),
            last_sync: rt.state.as_ref().and_then(|s| s.last_sync),
            device: rt.state.as_ref().map(|s| s.device.clone()).unwrap_or_default(),
            folders,
        }
    }

    /// Один проход: данные хаба, снимок, ключи, папки.
    pub fn run_once(&self, app: &AppHandle) {
        let store = app.state::<Store>();
        if !store.is_open() || self.busy.swap(true, Ordering::SeqCst) {
            return;
        }
        let emit_status = |h: &Hub| {
            let _ = app.emit("hub://sync", h.status(&store));
        };
        {
            let mut rt = self.rt();
            if rt.target.is_none() || rt.state.is_none() {
                self.busy.store(false, Ordering::SeqCst);
                return;
            }
            rt.status = "running".into();
            rt.last_try = now_ms();
        }
        emit_status(self);
        let result = (|| -> Result<(), SyncError> {
            let mut rt = self.rt();
            self.rclone(&store, &mut rt).map_err(SyncError::msg)?;
            let r = rt.rclone.take().expect("rclone есть");
            let mut st = rt.state.take().expect("состояние есть");
            drop(rt);
            let res = (|| {
                if !st.bootstrapped {
                    sync::bootstrap(&store, &mut st).map_err(SyncError::msg)?;
                }
                let rep = sync::sync_hub(&store, &r, &mut st)?;
                if !rep.changed.is_empty() {
                    let _ = app.emit("hub://data-changed", json!({ "namespaces": rep.changed }));
                }
                let _ = sync::snapshot(&r, &mut st, "hub", "hub");
                Ok::<_, SyncError>(rep)
            })();
            // ключи на Drive (после смены пароля или первого подключения)
            let keys_pending = self.rt().keys_pending;
            if res.is_ok() && keys_pending {
                let target = self.rt().target.clone();
                if let (Some(kf), Some(t)) = (self.read_keys(), target) {
                    if let Ok(base) = Rclone::base(&t) {
                        let o = base.run(&["rcat", &rclone::base_path(&t, "keys.json")], Some(&serde_json::to_vec_pretty(&kf).unwrap_or_default()));
                        if o.ok {
                            self.rt().keys_pending = false;
                        }
                    }
                }
            }
            // папки
            let defs = Self::folder_defs(&store);
            let wd = self.sync_dir().join("bisync");
            for def in defs {
                let lf = self.rt().folders.get(&def.id).cloned();
                let Some(mut lf) = lf else { continue };
                if !lf.started || lf.path.is_empty() || lf.problem.as_ref().map(|p| p.kind != "offline" && p.kind != "error").unwrap_or(false) {
                    continue; // ждёт пробного прогона или решения человека (стоп-кран, пересинхронизация)
                }
                match sync::folder_sync(&r, &def, Path::new(&lf.path), &wd.join(&def.id), false, false) {
                    Ok(_) => {
                        lf.problem = None;
                        lf.last_sync = Some(now_ms());
                        let _ = sync::snapshot(&r, &mut st, &format!("folder-{}", def.id), &format!("folders/{}", def.id));
                    }
                    Err(e) => lf.problem = Some(e),
                }
                self.rt().folders.insert(def.id.clone(), lf);
            }
            let mut rt = self.rt();
            rt.state = Some(st);
            rt.rclone = Some(r);
            let _ = self.save_runtime(&store, &mut rt);
            res.map(|_| ())
        })();
        {
            let mut rt = self.rt();
            match result {
                Ok(()) => {
                    rt.status = "idle".into();
                    rt.message.clear();
                }
                Err(e) => {
                    rt.status = if e.kind == "offline" { "offline".into() } else { "error".into() };
                    rt.message = e.message;
                }
            }
        }
        self.busy.store(false, Ordering::SeqCst);
        emit_status(self);
    }

    /// Фоновая работа: после паузы в правках, раз в 5 минут и по просьбе.
    pub fn spawn_worker(app: AppHandle) {
        std::thread::spawn(move || loop {
            let hub = app.state::<Hub>();
            {
                let (m, c) = &hub.wake;
                let guard = m.lock().unwrap_or_else(|e| e.into_inner());
                let (mut g, _) = c.wait_timeout(guard, Duration::from_secs(3)).unwrap_or_else(|e| e.into_inner());
                let forced = *g;
                *g = false;
                drop(g);
                let store = app.state::<Store>();
                if !store.is_open() {
                    continue;
                }
                // правки ждут отправки: новые в хранилище или уже отмеченные, но не ушедшие (сделаны во время прошлой синхронизации)
                let (n, last_change) = store.pending_changes();
                let (last_sync, dirty_last, failing, last_try) = {
                    let rt = hub.rt();
                    let st = rt.state.as_ref();
                    (
                        st.and_then(|s| s.last_sync).unwrap_or(0),
                        st.and_then(|s| s.dirty.values().max().copied()),
                        rt.status == "offline" || rt.status == "error",
                        rt.last_try,
                    )
                };
                let now = now_ms();
                let edited = if n > 0 { Some(last_change) } else { dirty_last };
                let quiet = edited.map(|t| now.saturating_sub(t) > QUIET_AFTER_EDIT_MS).unwrap_or(false);
                // без сети или после ошибки — не чаще раза в минуту
                let backoff = failing && now.saturating_sub(last_try) < RETRY_MS;
                let due = forced || (!backoff && (quiet || now.saturating_sub(last_sync.max(last_try)) > IDLE_SYNC_MS));
                if !due {
                    continue;
                }
            }
            hub.run_once(&app);
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
    store.take_changes();
    hub.write_keys(&c.file)?;
    hub.open_runtime(&c.key)?;
    Ok(c.recovery)
}

#[tauri::command]
pub async fn unlock(app: AppHandle, hub: State<'_, Hub>, store: State<'_, Store>, password: String) -> Result<(), String> {
    let kf = hub.read_keys().ok_or("Хаб ещё не настроен")?;
    let key = crypto::unlock_password(&kf, &password)?;
    store.set_key(Some(key.clone()));
    hub.open_runtime(&key)?;
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
    hub.open_runtime(&key)?;
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
        *rt = Runtime::default();
    }
    store.set_key(None);
    Ok(())
}

/* ───────── команды: синхронизация ───────── */

#[tauri::command]
pub fn sync_status(hub: State<'_, Hub>, store: State<'_, Store>) -> SyncStatus {
    hub.status(&store)
}

#[tauri::command]
pub fn sync_now(hub: State<'_, Hub>) {
    hub.poke();
}

/// Проверка без Google: HUB_SYNC_LOCAL=<папка> — «Drive» изображает обычная папка (только для тестов).
fn test_target(t: Target) -> Target {
    match (t.token.strip_prefix("local:"), std::env::var("HUB_SYNC_LOCAL")) {
        (Some(p), Ok(_)) => Target { kind: "local".into(), path: p.to_string(), ..Default::default() },
        _ => t,
    }
}

/// Вход в Google через rclone: браузер с запросом прав drive.file, ответ ловит rclone на 127.0.0.1:53682.
#[tauri::command]
pub async fn drive_authorize(app: AppHandle, client_id: String, client_secret: String) -> Result<String, String> {
    if let Ok(p) = std::env::var("HUB_SYNC_LOCAL") {
        return Ok(format!("local:{p}"));
    }
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    use tauri_plugin_opener::OpenerExt;
    let mut cfg = serde_json::Map::new();
    cfg.insert("scope".into(), json!("drive.file"));
    if !client_id.trim().is_empty() {
        cfg.insert("client_id".into(), json!(client_id.trim()));
        cfg.insert("client_secret".into(), json!(client_secret.trim()));
    }
    use base64::Engine;
    let blob = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cfg).map_err(|e| e.to_string())?);
    let bin = rclone::locate();
    let mut cmd = Command::new(&bin);
    // страница «Вход выполнен» в браузере — своя, вместо белой страницы rclone
    let page = std::env::temp_dir().join("hub-auth-page.html");
    let _ = fs::write(&page, include_str!("auth_page.html"));
    cmd.args(["authorize", "drive", &blob, "--auth-no-open-browser", "--config", ""]);
    if page.is_file() {
        cmd.arg("--template").arg(&page);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| format!("rclone не запустился ({}): {e}", bin.display()))?;
    let stderr = child.stderr.take().ok_or("нет вывода rclone")?;
    let app2 = app.clone();
    let reader = std::thread::spawn(move || {
        let mut all = String::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Some(i) = line.find("http://127.0.0.1:53682/auth") {
                let url = line[i..].split_whitespace().next().unwrap_or("").to_string();
                let _ = app2.opener().open_url(url, None::<&str>);
            }
            all.push_str(&line);
            all.push('\n');
        }
        all
    });
    let out = tauri::async_runtime::spawn_blocking(move || child.wait_with_output()).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    let log = reader.join().unwrap_or_default();
    let text = format!("{}\n{}", String::from_utf8_lossy(&out.stdout), log);
    rclone::parse_authorize_token(&text).ok_or_else(|| {
        if text.contains("--->") {
            // вход прошёл, но ответ rclone в незнакомом виде — сохранить для разбора
            let _ = fs::write(std::env::temp_dir().join("hub-auth-output.txt"), &text);
            return "Вход в Google прошёл, но хаб не понял ответ rclone. Его копия — в hub-auth-output.txt во временной папке; пришлите её разработчику".to_string();
        }
        let last = log.lines().filter(|l| l.contains("ERROR") || l.contains("Error")).last().unwrap_or("вход не завершён").to_string();
        format!("Не удалось войти в Google: {last}")
    })
}

fn remote_keys(t: &Target) -> Result<Option<KeyFile>, String> {
    let base = Rclone::base(t)?;
    let o = base.run(&["cat", &rclone::base_path(t, "keys.json")], None);
    if !o.ok {
        if o.offline() {
            return Err("Нет связи с Drive".into());
        }
        let s = o.stderr.to_lowercase();
        if s.contains("not found") {
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
    let kf = remote_keys(&target)?.ok_or("На этом Drive хаба нет — сначала настройте хаб на первом устройстве и включите там синхронизацию")?;
    let key = crypto::unlock_password(&kf, &password)?;
    hub.write_keys(&kf)?;
    store.set_key(Some(key.clone()));
    store.encrypt_all()?;
    store.take_changes();
    hub.open_runtime(&key)?;
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
    rt.target = None;
    rt.rclone = None;
    hub.save_runtime(&store, &mut rt)
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
    let r = rt.rclone.take().expect("rclone есть");
    drop(rt);
    let out = f(&r);
    hub.rt().rclone = Some(r);
    Ok(out)
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
