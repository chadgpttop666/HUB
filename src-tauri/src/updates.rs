//! Обновления из стабильных релизов этого репозитория. Источник версии, URL и SHA-256
//! один: API GitHub. Установщик запускается только после проверки загруженных байтов.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WebviewWindow};

const RELEASES: &str = "https://api.github.com/repos/chadgpttop666/HUB/releases/latest";
const DOWNLOADS: &str = "https://github.com/chadgpttop666/HUB/releases/download";
const MAX_INSTALLER: u64 = 128 * 1024 * 1024;
const CACHE: &str = "hub-updates";

pub const SUPPORTED: bool = cfg!(any(windows, target_os = "android"));

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    pub version: String,
    pub size: u64,
    #[serde(skip)]
    filename: String,
    #[serde(skip)]
    url: String,
    #[serde(skip)]
    sha256: String,
}

#[derive(Default)]
pub struct Updates {
    available: Mutex<Option<Update>>,
    busy: std::sync::atomic::AtomicBool,
}

struct Operation<'a>(&'a std::sync::atomic::AtomicBool);

impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Release);
    }
}

impl Updates {
    fn begin(&self) -> Result<Operation<'_>, String> {
        use std::sync::atomic::Ordering;
        self.busy
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map_err(|_| "Обновление уже выполняется")?;
        Ok(Operation(&self.busy))
    }
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    state: String,
    size: u64,
    browser_download_url: String,
    digest: Option<String>,
}

fn select_update(release: Release, current: &str, suffix: &str) -> Result<Option<Update>, String> {
    use semver::Version;
    let Some(raw) = release.tag_name.strip_prefix('v') else {
        return Err("GitHub вернул выпуск с неизвестным форматом версии".into());
    };
    let version = Version::parse(raw).map_err(|_| "Не удалось прочитать номер версии на GitHub")?;
    let current =
        Version::parse(current).map_err(|_| "Не удалось прочитать текущую версию хаба")?;
    if release.draft
        || release.prerelease
        || !version.pre.is_empty()
        || !version.build.is_empty()
        || version <= current
    {
        return Ok(None);
    }
    let filename = format!("Hub-{version}-{suffix}");
    let url = format!("{DOWNLOADS}/{}/{filename}", release.tag_name);
    let asset = release
        .assets
        .into_iter()
        .find(|a| a.name == filename && a.state == "uploaded" && a.browser_download_url == url)
        .ok_or("В выпуске GitHub нет установщика для этого устройства")?;
    let sha256 = asset
        .digest
        .and_then(|d| d.strip_prefix("sha256:").map(str::to_owned))
        .filter(|d| d.len() == 64 && d.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or("GitHub не предоставил контрольную сумму установщика")?;
    if !(1..=MAX_INSTALLER).contains(&asset.size) {
        return Err("Размер установщика на GitHub выходит за ожидаемые пределы".into());
    }
    Ok(Some(Update {
        version: version.to_string(),
        size: asset.size,
        filename,
        url,
        sha256: sha256.to_lowercase(),
    }))
}

fn client() -> Result<reqwest::blocking::Client, String> {
    use std::time::Duration;
    let redirects = reqwest::redirect::Policy::custom(|attempt| {
        let url = attempt.url();
        if attempt.previous().len() < 5
            && url.scheme() == "https"
            && url.port().is_none()
            && matches!(
                url.host_str(),
                Some(
                    "api.github.com"
                        | "github.com"
                        | "release-assets.githubusercontent.com"
                        | "objects.githubusercontent.com"
                )
            )
        {
            attempt.follow()
        } else {
            attempt.error("недопустимое перенаправление загрузки")
        }
    });
    reqwest::blocking::Client::builder()
        .https_only(true)
        .user_agent(concat!("HUB/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .redirect(redirects)
        .build()
        .map_err(|_| "Не удалось подготовить подключение к GitHub".into())
}

fn find_update(current: &str, suffix: &str) -> Result<Option<Update>, String> {
    use std::{io::Read, time::Duration};
    let response = client()?
        .get(RELEASES)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .timeout(Duration::from_secs(25))
        .send()
        .map_err(|_| "GitHub не ответил. Проверьте интернет и попробуйте снова")?
        .error_for_status()
        .map_err(|e| {
            format!(
                "GitHub не вернул сведения о выпуске ({})",
                e.status().map_or_else(String::new, |s| s.to_string())
            )
        })?;
    let release = serde_json::from_reader(response.take(1024 * 1024))
        .map_err(|_| "Не удалось прочитать выпуск GitHub")?;
    select_update(release, current, suffix)
}

fn verify_and_copy(
    mut input: impl std::io::Read,
    mut out: impl std::io::Write,
    update: &Update,
) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    let mut buffer = [0; 64 * 1024];
    let mut digest = Sha256::new();
    let mut total = 0;
    loop {
        let n = input
            .read(&mut buffer)
            .map_err(|_| "Загрузка установщика оборвалась")?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > update.size {
            return Err("Размер скачанного установщика не совпадает с опубликованным".into());
        }
        digest.update(&buffer[..n]);
        out.write_all(&buffer[..n])
            .map_err(|e| format!("Не удалось сохранить установщик: {e}"))?;
    }
    if total != update.size || format!("{:x}", digest.finalize()) != update.sha256 {
        return Err("Проверка установщика не прошла. Проверьте обновления заново".into());
    }
    Ok(())
}

fn download(update: &Update, cache: std::path::PathBuf) -> Result<std::path::PathBuf, String> {
    use std::{fs, time::Duration};
    fs::create_dir_all(&cache).map_err(|e| format!("Не удалось открыть кэш обновлений: {e}"))?;
    let file = cache.join(&update.filename);
    if let Ok(cached) = fs::File::open(&file) {
        if verify_and_copy(cached, std::io::sink(), update).is_ok() {
            return Ok(file);
        }
    }
    let response = client()?
        .get(&update.url)
        .timeout(Duration::from_secs(180))
        .send()
        .map_err(|_| "Не удалось скачать установщик с GitHub")?
        .error_for_status()
        .map_err(|_| "Установщик временно недоступен на GitHub")?;
    let mut temp = tempfile::NamedTempFile::new_in(&cache)
        .map_err(|e| format!("Не удалось создать файл установщика: {e}"))?;
    verify_and_copy(response, &mut temp, update)?;
    temp.persist(&file)
        .map_err(|e| format!("Не удалось сохранить установщик: {e}"))?;
    Ok(file)
}

fn main_window(window: &WebviewWindow) -> Result<(), String> {
    if !SUPPORTED {
        return Err("Обновления из хаба доступны на Windows и Android".into());
    }
    if window.label() != "main" || !window.state::<crate::store::Store>().is_open() {
        return Err("Откройте хаб, чтобы обновиться".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn update_check(
    window: WebviewWindow,
    state: State<'_, Updates>,
) -> Result<Option<Update>, String> {
    main_window(&window)?;
    let _operation = state.begin()?;
    *state.available.lock().map_err(|e| e.to_string())? = None;
    let current = window.app_handle().package_info().version.to_string();
    let suffix = if cfg!(windows) {
        "windows-x64-setup.exe"
    } else {
        "android-arm64.apk"
    };
    let update = tauri::async_runtime::spawn_blocking(move || find_update(&current, suffix))
        .await
        .map_err(|e| e.to_string())??;
    *state.available.lock().map_err(|e| e.to_string())? = update.clone();
    Ok(update)
}

#[tauri::command]
pub async fn update_install(
    window: WebviewWindow,
    state: State<'_, Updates>,
) -> Result<&'static str, String> {
    main_window(&window)?;
    let _operation = state.begin()?;
    let update = state
        .available
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("Сначала проверьте обновления")?;
    let app = window.app_handle().clone();
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join(CACHE);
    let file = tauri::async_runtime::spawn_blocking(move || download(&update, cache))
        .await
        .map_err(|e| e.to_string())??;
    main_window(&window)?;
    install(app, file)
}

#[cfg(windows)]
fn install(app: AppHandle, file: std::path::PathBuf) -> Result<&'static str, String> {
    app.state::<crate::hubsvc::Hub>()
        .flush(&app.state::<crate::store::Store>())
        .map_err(|e| format!("Хаб не смог сохранить состояние перед обновлением: {e}"))?;
    // NSIS обновляет установленную копию на месте и заново открывает Хаб.
    std::process::Command::new(file)
        .args(["/S", "/UPDATE", "/R"])
        .spawn()
        .map_err(|e| format!("Не удалось открыть установщик: {e}"))?;
    app.exit(0);
    Ok("started")
}

#[cfg(target_os = "android")]
pub fn android_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("hub-updates")
        .setup(|app, api| {
            let installer = api.register_android_plugin("local.hub.mobile", "UpdateInstaller")?;
            app.manage(installer);
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
fn install(app: AppHandle, file: std::path::PathBuf) -> Result<&'static str, String> {
    #[derive(Deserialize)]
    struct ResultStatus {
        permission: bool,
    }

    app.state::<crate::hubsvc::Hub>()
        .flush(&app.state::<crate::store::Store>())
        .map_err(|e| format!("Хаб не смог сохранить состояние перед обновлением: {e}"))?;
    let filename = file
        .file_name()
        .and_then(|p| p.to_str())
        .ok_or("Не удалось прочитать имя APK")?;
    let result: ResultStatus = app
        .state::<tauri::plugin::PluginHandle<tauri::Wry>>()
        .run_mobile_plugin("install", serde_json::json!({ "filename": filename }))
        .map_err(|e| format!("Android не открыл установщик: {e}"))?;
    Ok(if result.permission {
        "permission"
    } else {
        "started"
    })
}

#[cfg(not(any(windows, target_os = "android")))]
fn install(_: AppHandle, _: std::path::PathBuf) -> Result<&'static str, String> {
    Err("Обновления из хаба доступны на Windows и Android".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};

    fn release() -> serde_json::Value {
        json!({
            "tag_name": "v0.1.10", "draft": false, "prerelease": false, "assets": [{
                "name": "Hub-0.1.10-windows-x64-setup.exe", "state": "uploaded", "size": 3,
                "browser_download_url": format!("{DOWNLOADS}/v0.1.10/Hub-0.1.10-windows-x64-setup.exe"),
                "digest": format!("sha256:{:x}", Sha256::digest(b"abc"))
            }]
        })
    }

    const WIN: &str = "windows-x64-setup.exe";
    fn parse(value: serde_json::Value) -> Release {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn only_newer_stable_release_from_hub_with_digest() {
        assert!(select_update(parse(release()), "0.1.2", WIN)
            .unwrap()
            .is_some());
        assert!(select_update(parse(release()), "0.1.10", WIN)
            .unwrap()
            .is_none());
        assert!(select_update(parse(release()), "0.2.0", WIN)
            .unwrap()
            .is_none());
        let mut preview = release();
        preview["prerelease"] = true.into();
        assert!(select_update(parse(preview), "0.1.2", WIN)
            .unwrap()
            .is_none());
        let mut bad = release();
        bad["assets"][0]["browser_download_url"] = "https://example.test/installer.exe".into();
        assert!(select_update(parse(bad), "0.1.2", WIN).is_err());
        let mut unsigned = release();
        unsigned["assets"][0]["digest"] = serde_json::Value::Null;
        assert!(select_update(parse(unsigned), "0.1.2", WIN).is_err());
    }

    #[test]
    fn checksum_and_size_are_verified() {
        let update = select_update(parse(release()), "0.1.2", WIN)
            .unwrap()
            .unwrap();
        let mut file = Vec::new();
        verify_and_copy(&b"abc"[..], &mut file, &update).unwrap();
        assert_eq!(file, b"abc");
        for bad in [&b"abd"[..], &b"ab"[..], &b"abcd"[..]] {
            assert!(verify_and_copy(bad, std::io::sink(), &update).is_err());
        }
    }
}
