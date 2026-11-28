//! Напоминания вытаскивают из зашифрованного календаря только время и уровень сигнала.
use crate::store::Store;
#[cfg(any(windows, target_os = "android"))]
use crate::store::now_ms;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(any(windows, target_os = "android"))]
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[cfg(any(windows, target_os = "android", test))]
const MAX_REMINDERS: usize = 512;
#[cfg(windows)]
const LATE_MS: u64 = 120_000;

#[derive(Default)]
pub struct Reminders(AtomicBool);

impl Reminders {
    pub fn changed(&self) {
        self.0.store(true, Ordering::Release);
    }
}

#[cfg(any(windows, target_os = "android", test))]
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Silent,
    Normal,
    Alarm,
}

#[cfg(any(windows, target_os = "android", test))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
struct Scheduled {
    id: String,
    at: u64,
    kind: Kind,
}

#[cfg(any(windows, target_os = "android", test))]
#[derive(Deserialize)]
struct Reminder {
    at: u64,
    kind: Kind,
}

#[cfg(any(windows, target_os = "android", test))]
fn schedule(store: &Store, now: u64) -> Result<Vec<Scheduled>, String> {
    let mut entries = store.dump("calendar")?.json.into_iter().filter_map(|(key, event)| {
        let id = key.strip_prefix("events/")?;
        if id.is_empty() || id.len() > 128 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return None;
        }
        let reminder = Reminder::deserialize(event.get("reminder")?).ok()?;
        // Сохраняем оригинал ненадолго для повтора после «Отложить».
        if reminder.at < now.saturating_sub(3_600_000) || reminder.at > 32_503_680_000_000 {
            return None;
        }
        Some(Scheduled { id: id.to_owned(), at: reminder.at, kind: reminder.kind })
    }).collect::<Vec<_>>();
    entries.sort_by(|a, b| a.at.cmp(&b.at).then(a.id.cmp(&b.id)));
    entries.truncate(MAX_REMINDERS);
    Ok(entries)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    supported: bool,
    platform: String,
    notifications: bool,
    exact: bool,
}

#[tauri::command]
pub async fn calendar_permissions(app: AppHandle, request: String) -> Result<Permissions, String> {
    if !app.state::<Store>().is_open() {
        return Err(crate::store::LOCKED.into());
    }
    #[cfg(target_os = "android")]
    {
        if !["", "notifications", "exact"].contains(&request.as_str()) {
            return Err("Неизвестное разрешение".into());
        }
        app.state::<Android>()
            .0
            .run_mobile_plugin_async("permissions", serde_json::json!({ "request": request }))
            .await
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = request;
        Ok(Permissions {
            supported: cfg!(windows),
            platform: "pc".into(),
            notifications: cfg!(windows),
            exact: cfg!(windows),
        })
    }
}

#[cfg(target_os = "android")]
struct Android(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
pub fn android_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("hub-calendar-reminders")
        .setup(|app, api| {
            app.manage(Android(api.register_android_plugin("local.hub.mobile", "CalendarReminders")?));
            Ok(())
        })
        .build()
}

pub fn start(app: AppHandle) {
    #[cfg(any(windows, target_os = "android"))]
    std::thread::spawn(move || {
        let mut entries = Vec::new();
        let mut previously_open = false;
        #[cfg(windows)]
        let mut desktop = windows::Desktop::default();
        loop {
            let store = app.state::<Store>();
            let open = store.is_open();
            let dirty = app.state::<Reminders>().0.swap(false, Ordering::AcqRel);
            if open && (dirty || !previously_open) {
                match schedule(&store, now_ms()) {
                    Ok(next) if next != entries || !previously_open => {
                        #[cfg(windows)]
                        {
                            desktop.replace(next.clone());
                            entries = next;
                        }
                        #[cfg(target_os = "android")]
                        {
                            let output = app.state::<Android>().0.run_mobile_plugin::<()>("replace", serde_json::json!({ "entries": &next }));
                            if let Err(error) = output {
                                eprintln!("[календарь] {error}");
                                app.state::<Reminders>().changed();
                            } else {
                                entries = next;
                            }
                        }
                    }
                    Err(error) => eprintln!("[календарь] {error}"),
                    _ => {}
                }
            }
            previously_open = open;
            #[cfg(windows)]
            desktop.poll(&app);
            std::thread::sleep(Duration::from_millis(500));
        }
    });
    #[cfg(not(any(windows, target_os = "android")))]
    let _ = app;
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::collections::{BTreeMap, HashSet};
    use std::sync::{Arc, Mutex};
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};
    use tauri_plugin_notification::NotificationExt;

    const SNOOZE_MS: u64 = 5 * 60_000;
    const MAX_RING_MS: u64 = 10 * 60_000;

    #[derive(Default)]
    pub struct Desktop {
        entries: Vec<Scheduled>,
        fired: HashSet<(String, u64)>,
        snoozed: BTreeMap<String, (u64, u64)>,
        active: Option<(Scheduled, u64, Arc<Mutex<Option<bool>>>)>,
    }

    #[link(name = "winmm")]
    extern "system" {
        fn PlaySoundW(sound: *const u16, module: *mut std::ffi::c_void, flags: u32) -> i32;
    }

    fn stop_sound() {
        // Null stops the current asynchronous sound for the process.
        unsafe { PlaySoundW(std::ptr::null(), std::ptr::null_mut(), 0); }
    }

    fn ring() {
        const SND_ALIAS: u32 = 0x0001_0000;
        const SND_ASYNC: u32 = 0x0001;
        const SND_LOOP: u32 = 0x0008;
        let alias: Vec<u16> = "SystemExclamation\0".encode_utf16().collect();
        // SND_ALIAS resolves the system alias on this call. No audio buffer is borrowed.
        unsafe { PlaySoundW(alias.as_ptr(), std::ptr::null_mut(), SND_ALIAS | SND_ASYNC | SND_LOOP); }
    }

    impl Desktop {
        pub fn replace(&mut self, entries: Vec<Scheduled>) {
            self.fired.retain(|(id, at)| entries.iter().any(|e| &e.id == id && e.at == *at));
            self.snoozed.retain(|id, (at, _)| entries.iter().any(|e| &e.id == id && e.at == *at && e.kind == Kind::Alarm));
            if self.active.as_ref().is_some_and(|(e, _, _)| !entries.contains(e)) { stop_sound(); }
            self.entries = entries;
        }

        pub fn poll(&mut self, app: &AppHandle) {
            let now = now_ms();
            if let Some((entry, started, choice)) = &self.active {
                let result = *choice.lock().unwrap_or_else(|e| e.into_inner());
                if result.is_some() || now.saturating_sub(*started) >= MAX_RING_MS {
                    stop_sound();
                    if result == Some(true) && self.entries.contains(entry) {
                        self.snoozed.insert(entry.id.clone(), (entry.at, now + SNOOZE_MS));
                    }
                    if result.is_some() { self.active = None; }
                }
            }
            for entry in &self.entries {
                let key = (entry.id.clone(), entry.at);
                let snooze = self.snoozed.get(&entry.id);
                let due = snooze.map(|(_, due)| *due).unwrap_or(entry.at);
                if now < due || (snooze.is_none() && self.fired.contains(&key)) { continue; }
                if entry.kind == Kind::Alarm && self.active.is_some() && now.saturating_sub(due) <= LATE_MS { continue; }
                self.fired.insert(key);
                self.snoozed.remove(&entry.id);
                if now.saturating_sub(due) > LATE_MS { continue; }
                if entry.kind == Kind::Alarm {
                    ring();
                    crate::desktop::bring_to_front(app);
                    let choice = Arc::new(Mutex::new(None));
                    let response = Arc::clone(&choice);
                    app.dialog().message("Время события в календаре Хаба")
                        .title("Будильник Хаба")
                        .buttons(MessageDialogButtons::OkCancelCustom("Выключить".into(), "Отложить на 5 минут".into()))
                        .show_with_result(move |result| {
                            let snooze = matches!(result, MessageDialogResult::Custom(text) if text == "Отложить на 5 минут");
                            *response.lock().unwrap_or_else(|e| e.into_inner()) = Some(snooze);
                        });
                    self.active = Some((entry.clone(), now, choice));
                } else {
                    let notification = app.notification().builder().title("Календарь Хаба").body("Время события");
                    // На Windows отсутствие звука у этой обвязки создаёт тихий toast.
                    let notification = if entry.kind == Kind::Normal { notification.sound("Default") } else { notification };
                    let _ = notification.show();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn schedule_only_valid_event_reminders_without_titles() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().into());
        store.set_key(Some(crate::crypto::DataKey::random()));
        store.set_json("calendar", "events/one", &json!({ "title": "Личный текст", "reminder": { "at": 12345, "kind": "alarm" } })).unwrap();
        store.set_json("calendar", "events/bad", &json!({ "reminder": { "at": 12345, "kind": "wrong" } })).unwrap();
        store.set_json("calendar", "device/calendar-import", &json!({ "reminder": { "at": 12345, "kind": "normal" } })).unwrap();
        let items = schedule(&store, 10_000).unwrap();
        assert_eq!(items, vec![Scheduled { id: "one".into(), at: 12345, kind: Kind::Alarm }]);
        assert!(!serde_json::to_string(&items).unwrap().contains("Личный"));
    }
}
