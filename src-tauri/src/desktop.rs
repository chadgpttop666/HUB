//! Только для ПК: значок в трее, мини-окно ввода поверх других программ, автозапуск, закрытие в трей.
//!
//! Настройки этого устройства, которые нужны до входа (окно закрывается в трей ещё до пароля),
//! лежат открытым файлом `prefs.json` рядом с data/: в них нет ничего личного.

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::ManagerExt;

use crate::hubsvc::Hub;
use crate::store::Store;

pub const MINI: &str = "mini";
const MINI_W: f64 = 600.0;
const MINI_H: f64 = 132.0;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    /// Крестик прячет хаб в трей: Ctrl+Alt+Пробел продолжает работать
    pub close_to_tray: bool,
    /// Подсказку «хаб в трее» уже показывали
    pub tray_hint_shown: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { close_to_tray: true, tray_hint_shown: false }
    }
}

pub struct Desktop {
    file: PathBuf,
    prefs: Mutex<Prefs>,
}

impl Desktop {
    pub fn new(base: PathBuf) -> Self {
        let file = base.join("prefs.json");
        let prefs = fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Desktop { file, prefs: Mutex::new(prefs) }
    }
    fn get(&self) -> Prefs {
        self.prefs.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    fn update(&self, f: impl FnOnce(&mut Prefs)) -> Result<(), String> {
        let mut p = self.prefs.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut p);
        let tmp = self.file.with_extension("tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(&*p).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &self.file).map_err(|e| e.to_string())
    }
}

/* ───────── окна ───────── */

pub fn bring_to_front(app: &AppHandle) {
    hide_mini(app);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn main_in_front(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .map(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
        .unwrap_or(false)
}

/// Ctrl+Alt+Пробел: хаб впереди — курсор в его строку ввода; иначе — мини-окно поверх других программ.
pub fn hotkey(app: &AppHandle) {
    if main_in_front(app) {
        let _ = app.emit_to("main", "hub://capture", ());
    } else {
        show_mini(app);
    }
}

pub fn show_mini(app: &AppHandle) {
    let w = match app.get_webview_window(MINI) {
        Some(w) => w,
        None => match WebviewWindowBuilder::new(app, MINI, WebviewUrl::App("mini.html".into()))
            .title("Мысль в корзину")
            .inner_size(MINI_W, MINI_H)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .build()
        {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[хаб] мини-окно не открылось: {e}");
                return bring_to_front(app);
            }
        },
    };
    // по центру сверху того экрана, где сейчас мышь
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| w.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let (pos, size, scale) = (m.position(), m.size(), m.scale_factor());
        let x = pos.x + ((size.width as f64 - MINI_W * scale) / 2.0) as i32;
        let y = pos.y + (size.height as f64 * 0.16) as i32;
        let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
    }
    let _ = w.show();
    let _ = w.set_focus();
    let _ = app.emit_to(MINI, "mini://shown", ());
}

pub fn hide_mini(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MINI) {
        let _ = w.hide();
    }
}

/// События окон: крестик главного окна — в трей; мини-окно прячется, когда уходит фокус.
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    let app = window.app_handle();
    match (window.label(), event) {
        ("main", WindowEvent::CloseRequested { api, .. }) => {
            let d = app.state::<Desktop>();
            if !d.get().close_to_tray {
                app.state::<Hub>().flush(&app.state::<Store>());
                // спрятанное мини-окно не должно держать хаб запущенным
                if let Some(m) = app.get_webview_window(MINI) {
                    let _ = m.destroy();
                }
                return;
            }
            api.prevent_close();
            let _ = window.hide();
            if !d.get().tray_hint_shown {
                let _ = d.update(|p| p.tray_hint_shown = true);
                use tauri_plugin_notification::NotificationExt;
                let _ = app
                    .notification()
                    .builder()
                    .title("Хаб работает в трее")
                    .body("Ctrl+Alt+Пробел — мысль в корзину из любой программы. Выйти — правой кнопкой по значку хаба.")
                    .show();
            }
        }
        (MINI, WindowEvent::CloseRequested { api, .. }) => {
            api.prevent_close();
            let _ = window.hide();
        }
        (MINI, WindowEvent::Focused(false)) => {
            let _ = window.hide();
        }
        _ => {}
    }
}

/* ───────── трей ───────── */

pub fn tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Открыть хаб", true, None::<&str>)?;
    let capture = MenuItem::with_id(app, "capture", "Мысль в корзину", true, Some("Ctrl+Alt+Space"))?;
    let lock = MenuItem::with_id(app, "lock", "Заблокировать", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &capture, &lock, &PredefinedMenuItem::separator(app)?, &exit])?;
    let mut b = TrayIconBuilder::with_id("hub").tooltip("Хаб").menu(&menu).show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.on_menu_event(|app, e| match e.id().as_ref() {
        "open" => bring_to_front(app),
        "capture" => show_mini(app),
        "lock" => {
            // запирает оболочка: она закрывает приложения и сама вызывает lock
            let _ = app.emit_to("main", "hub://lock-request", ());
        }
        "quit" => quit(app),
        _ => {}
    })
    .on_tray_icon_event(|tray, e| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
            bring_to_front(tray.app_handle());
        }
    })
    .build(app)?;
    Ok(())
}

fn quit(app: &AppHandle) {
    app.state::<Hub>().flush(&app.state::<Store>());
    app.exit(0);
}

/* ───────── команды ───────── */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    /// saved — в корзине; sealed — заперто до входа
    status: &'static str,
    /// сколько в корзине (когда хаб открыт)
    count: Option<usize>,
}

#[tauri::command]
pub fn quick_capture(app: AppHandle, hub: State<'_, Hub>, store: State<'_, Store>, text: String) -> Result<CaptureResult, String> {
    let status = hub.quick().capture(&store, &text, &hub.device())?;
    let mut count = None;
    if status == "saved" {
        count = store.keys("hub").ok().map(|k| k.iter().filter(|(k, _)| k.starts_with("inbox/")).count());
        let _ = app.emit_to("main", "hub://data-changed", json!({ "namespaces": ["hub"] }));
        hub.poke();
    }
    Ok(CaptureResult { status, count })
}

#[tauri::command]
pub fn mini_hide(app: AppHandle) {
    hide_mini(&app);
}

#[tauri::command]
pub fn mini_open_hub(app: AppHandle) {
    bring_to_front(&app);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPrefs {
    close_to_tray: bool,
    autostart: bool,
    pending: usize,
}

#[tauri::command]
pub fn desktop_prefs(app: AppHandle, d: State<'_, Desktop>, hub: State<'_, Hub>) -> DesktopPrefs {
    DesktopPrefs {
        close_to_tray: d.get().close_to_tray,
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        pending: hub.quick().pending_count(),
    }
}

#[tauri::command]
pub fn desktop_set(app: AppHandle, d: State<'_, Desktop>, close_to_tray: Option<bool>, autostart: Option<bool>) -> Result<(), String> {
    if let Some(v) = close_to_tray {
        d.update(|p| p.close_to_tray = v)?;
    }
    if let Some(v) = autostart {
        let a = app.autolaunch();
        if v { a.enable() } else { a.disable() }.map_err(|e| format!("Автозапуск не изменился: {e}"))?;
    }
    Ok(())
}

/// Запуск при входе в систему: окно не показывать, хаб ждёт в трее.
pub const HIDDEN_ARG: &str = "--hidden";
