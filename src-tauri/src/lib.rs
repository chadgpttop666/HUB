//! Ядро хаба (этап 1): файлы данных, список приложений, протокол hubapp:// для песочниц,
//! системные уведомления и глобальная клавиша Ctrl+Alt+Пробел.
//!
//! Чего здесь пока нет — шифрования, rclone и входа в Google: это этап 2 (см. docs/design-doc.md).

pub mod store;

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Component, Path, PathBuf};
use store::{Dump, Stat, Store};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

struct Paths {
    data: PathBuf,
    apps: PathBuf,
}

/* ───────── данные ───────── */

#[tauri::command]
async fn data_dump(store: State<'_, Store>, ns: String) -> Result<Dump, String> {
    store.dump(&ns)
}

#[tauri::command]
async fn data_get(store: State<'_, Store>, ns: String, key: String) -> Result<Option<Value>, String> {
    store.get_json(&ns, &key)
}

#[tauri::command]
async fn data_stat(store: State<'_, Store>, ns: String, key: String) -> Result<Option<Stat>, String> {
    store.stat(&ns, &key)
}

#[tauri::command]
async fn data_set(store: State<'_, Store>, ns: String, key: String, value: Value) -> Result<(), String> {
    store.set_json(&ns, &key, &value)
}

#[tauri::command]
async fn data_remove(store: State<'_, Store>, ns: String, key: String) -> Result<(), String> {
    store.remove(&ns, &key)
}

#[tauri::command]
async fn blob_get(store: State<'_, Store>, ns: String, key: String) -> Result<Response, String> {
    match store.get_blob(&ns, &key)? {
        Some(bytes) => Ok(Response::new(bytes)),
        None => Err(format!("нет данных: {key}")),
    }
}

/// Тело запроса — сами байты; пространство, ключ и тип — в заголовках hub-ns, hub-key, hub-type (ключ и тип — encodeURIComponent).
#[tauri::command]
async fn blob_put(store: State<'_, Store>, request: Request<'_>) -> Result<(), String> {
    let header = |name: &str| -> Result<String, String> {
        let raw = request.headers().get(name).ok_or(format!("нет заголовка {name}"))?;
        let s = raw.to_str().map_err(|e| e.to_string())?;
        percent_decode(s).ok_or(format!("заголовок {name} не читается"))
    };
    let (ns, key, mime) = (header("hub-ns")?, header("hub-key")?, header("hub-type").unwrap_or_default());
    match request.body() {
        InvokeBody::Raw(bytes) => store.set_blob(&ns, &key, &mime, bytes),
        InvokeBody::Json(_) => Err("ожидались байты".into()),
    }
}

/* ───────── приложения ───────── */

#[derive(Serialize)]
struct AppEntry {
    id: String,
    source: &'static str,
    manifest: Value,
}

fn valid_app_id(id: &str) -> bool {
    store::valid_ns(id) && id != "hub"
}

/// Встроенные — внутри хаба (apps/index.json в собранном интерфейсе); свои — папки в <данные хаба>/apps.
/// Своё приложение с тем же id заменяет встроенное.
#[tauri::command]
fn apps_list(app: AppHandle, paths: State<'_, Paths>) -> Result<Vec<AppEntry>, String> {
    let resolver = app.asset_resolver();
    let mut out: Vec<AppEntry> = Vec::new();
    let builtin: Vec<String> = resolver
        .get("/apps/index.json".into())
        .and_then(|a| serde_json::from_slice(&a.bytes).ok())
        .unwrap_or_default();
    for id in builtin.into_iter().filter(|id| valid_app_id(id)) {
        if let Some(m) = resolver.get(format!("/apps/{id}/manifest.json")).and_then(|a| serde_json::from_slice::<Value>(&a.bytes).ok()) {
            out.push(AppEntry { id, source: "builtin", manifest: m });
        }
    }
    if let Ok(rd) = fs::read_dir(&paths.apps) {
        let mut dirs: Vec<_> = rd.flatten().filter(|e| e.path().is_dir()).collect();
        dirs.sort_by_key(|e| e.file_name());
        for e in dirs {
            let id = e.file_name().to_string_lossy().to_string();
            if !valid_app_id(&id) {
                continue;
            }
            let Ok(bytes) = fs::read(e.path().join("manifest.json")) else { continue };
            match serde_json::from_slice::<Value>(&bytes) {
                Ok(m) => {
                    out.retain(|a| a.id != id);
                    out.push(AppEntry { id, source: "user", manifest: m });
                }
                Err(err) => eprintln!("[хаб] {}: manifest.json не читается: {err}", e.path().display()),
            }
        }
    }
    Ok(out)
}

/* ───────── протокол hubapp:// ─────────
   /_hub/<путь>  — hub.css, токены, шрифты, hub-app.js (из собранного интерфейса, папка hub/)
   /<id>/<путь>  — файлы приложения: сначала своя папка, потом встроенное
   Ответы с Access-Control-Allow-Origin: *, потому что страницы приложений — в песочнице с «пустым» происхождением. */

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            out.push(u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).ok()?, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn mime_of(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "txt" | "md" => "text/plain; charset=utf-8",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// относительный путь без «..», корня и обратных косых
fn safe_rel(path: &str) -> Option<PathBuf> {
    if path.is_empty() || path.contains('\\') || path.contains('\0') {
        return None;
    }
    let p = Path::new(path);
    if p.components().all(|c| matches!(c, Component::Normal(_))) {
        Some(p.to_path_buf())
    } else {
        None
    }
}

fn serve(app: &AppHandle, uri_path: &str) -> Option<(Vec<u8>, String)> {
    let path = percent_decode(uri_path)?;
    let path = path.trim_start_matches('/');
    let (first, rest) = path.split_once('/')?;
    let rest = if rest.is_empty() || rest.ends_with('/') { format!("{rest}index.html") } else { rest.to_string() };
    let rel = safe_rel(&rest)?;
    let resolver = app.asset_resolver();
    if first == "_hub" {
        let a = resolver.get(format!("/hub/{rest}"))?;
        return Some((a.bytes, mime_of(&rest).to_string()));
    }
    if !valid_app_id(first) {
        return None;
    }
    let paths = app.state::<Paths>();
    let own = paths.apps.join(first);
    if own.join("manifest.json").is_file() {
        let file = own.join(&rel);
        return fs::read(&file).ok().map(|b| (b, mime_of(&rest).to_string()));
    }
    let a = resolver.get(format!("/apps/{first}/{rest}"))?;
    Some((a.bytes, mime_of(&rest).to_string()))
}

fn hubapp_response(app: &AppHandle, request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let builder = tauri::http::Response::builder()
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-cache")
        .header("X-Content-Type-Options", "nosniff");
    if request.method() == tauri::http::Method::OPTIONS {
        return builder.status(204).header("Access-Control-Allow-Headers", "*").body(Vec::new()).unwrap();
    }
    match serve(app, request.uri().path()) {
        Some((bytes, mime)) => builder.status(200).header("Content-Type", mime).body(bytes).unwrap(),
        None => builder.status(404).header("Content-Type", "text/plain; charset=utf-8").body("не найдено".as_bytes().to_vec()).unwrap(),
    }
}

/* ───────── окно, уведомления, сведения ───────── */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HubInfo {
    data_dir: String,
    apps_dir: String,
    version: String,
}

#[tauri::command]
fn hub_info(app: AppHandle, paths: State<'_, Paths>) -> HubInfo {
    HubInfo {
        data_dir: paths.data.display().to_string(),
        apps_dir: paths.apps.display().to_string(),
        version: app.package_info().version.to_string(),
    }
}

#[tauri::command]
fn open_data_dir(paths: State<'_, Paths>) -> Result<(), String> {
    let dir = paths.data.parent().unwrap_or(&paths.data).to_path_buf();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    let cmd = "explorer";
    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let cmd = "xdg-open";
    std::process::Command::new(cmd).arg(&dir).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let title = if title.is_empty() { "Хаб".to_string() } else { title };
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

#[tauri::command]
fn window_focused(window: WebviewWindow) -> bool {
    window.is_focused().unwrap_or(true) && !window.is_minimized().unwrap_or(false)
}

fn bring_to_front(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/* ───────── запуск ───────── */

pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // второй запуск хаба не открывает второе окно, а поднимает первое
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| bring_to_front(app)));
    }

    builder
        .plugin(tauri_plugin_notification::init())
        .register_asynchronous_uri_scheme_protocol("hubapp", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || responder.respond(hubapp_response(&app, &request)));
        })
        .setup(|app| {
            let base = app.path().app_data_dir()?;
            let paths = Paths { data: base.join("data"), apps: base.join("apps") };
            fs::create_dir_all(&paths.data)?;
            fs::create_dir_all(&paths.apps)?;
            app.manage(Store::new(paths.data.clone()));
            app.manage(paths);

            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
                let capture = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, shortcut, event| {
                            if shortcut == &capture && event.state() == ShortcutState::Pressed {
                                bring_to_front(app);
                                let _ = app.emit("hub://capture", ());
                            }
                        })
                        .build(),
                )?;
                if let Err(e) = app.global_shortcut().register(capture) {
                    // клавиша может быть занята другой программой — хаб работает и без неё
                    eprintln!("[хаб] Ctrl+Alt+Пробел не зарегистрирована: {e}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            data_dump,
            data_get,
            data_stat,
            data_set,
            data_remove,
            blob_get,
            blob_put,
            apps_list,
            hub_info,
            open_data_dir,
            notify,
            window_focused
        ])
        .run(tauri::generate_context!())
        .expect("хаб не запустился");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_paths() {
        assert!(safe_rel("index.html").is_some());
        assert!(safe_rel("a/b.js").is_some());
        for bad in ["", "../x", "a/../../x", "/etc/passwd", "a\\b", "C:/x"] {
            assert!(safe_rel(bad).is_none() || bad == "C:/x" && cfg!(not(windows)), "{bad}");
        }
    }

    #[test]
    fn decode() {
        assert_eq!(percent_decode("a%20b").as_deref(), Some("a b"));
        assert_eq!(percent_decode("%D1%82%D0%B5").as_deref(), Some("те"));
        assert_eq!(percent_decode("x%").as_deref(), Some("x%"));
    }
}
