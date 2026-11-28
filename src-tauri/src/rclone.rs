//! Запуск rclone. Настроек rclone на диске нет: удалённые хранилища задаются переменными окружения
//! процесса, пароли crypt выводятся из ключа данных и живут только в памяти.
//!
//! Раскладка на Drive (папка «Hub» в корне, права drive.file — хаб видит только свои файлы):
//!   Hub/keys.json        запертый ключ данных (без него второе устройство не откроет данные)
//!   Hub/crypt/…          всё остальное, через rclone crypt: имена — AES-EME, содержимое — XSalsa20-Poly1305
//!     hub/changes-<устройство>/<номер>.json   журналы изменений данных хаба
//!     hub/blobs/<sha256>                         двоичные значения
//!     folders/<id>/…                             помеченные папки
//!     snapshots/<id>/<дата>/…                    ежедневные снимки
//! Достать данные без хаба: rclone с теми же двумя паролями (Настройки → Синхронизация → «Пароли для rclone»).

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use crate::crypto::DataKey;

pub const BASE: &str = "hubdrive";
pub const CRYPT: &str = "hubcrypt";
const NETWORK_FLAGS: &[&str] = &["--retries", "1", "--low-level-retries", "2", "--contimeout", "15s", "--timeout", "30s"];
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const AUTHORIZE_TIMEOUT: Duration = Duration::from_secs(180);

fn drive_client<'a>(id: &'a str, secret: &'a str) -> Result<(&'a str, &'a str), String> {
    let (id, secret) = (id.trim(), secret.trim());
    if id.is_empty() || secret.is_empty() || id.starts_with("202264815644") {
        return Err("Введите собственные Client ID и Client Secret из Google Cloud и подключите Google Drive заново".into());
    }
    Ok((id, secret))
}

/// Как достучаться до хранилища: Google Drive или (для проверок) обычная папка.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// "drive" или "local"
    pub kind: String,
    /// токен OAuth от `rclone authorize` (JSON-строка)
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub client_secret: String,
    /// для kind = "local": папка, которая изображает Drive
    #[serde(default)]
    pub path: String,
}

#[derive(Clone)]
pub struct Rclone {
    pub bin: PathBuf,
    env: Vec<(String, String)>,
}

/// Где лежит rclone: рядом с хабом (Windows), среди библиотек приложения (Android), HUB_RCLONE или PATH.
pub fn locate() -> PathBuf {
    if let Ok(p) = std::env::var("HUB_RCLONE") {
        return PathBuf::from(p);
    }
    let exe_name = if cfg!(windows) { "rclone.exe" } else { "rclone" };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join(exe_name);
            if p.is_file() {
                return p;
            }
        }
    }
    #[cfg(target_os = "android")]
    if let Some(p) = android_lib_dir().map(|d| d.join("librclone.so")) {
        if p.is_file() {
            return p;
        }
    }
    PathBuf::from(exe_name)
}

/// Папка, из которой загружена наша библиотека, — nativeLibraryDir приложения:
/// только оттуда Android разрешает запускать исполняемые файлы.
#[cfg(target_os = "android")]
fn android_lib_dir() -> Option<PathBuf> {
    let maps = std::fs::read_to_string("/proc/self/maps").ok()?;
    maps.lines()
        .filter_map(|l| l.split_whitespace().last())
        .find(|p| p.ends_with("/libhub_lib.so"))
        .and_then(|p| std::path::Path::new(p).parent().map(|d| d.to_path_buf()))
}

fn quiet(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: без мелькающего окна консоли
    }
    cmd
}

pub struct Output {
    pub ok: bool,
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl Output {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).to_string()
    }
    pub fn err(&self) -> String {
        let s = self.stderr.trim();
        match self.problem() {
            "quota" => return "Google Drive ограничил запросы или исчерпал квоту. Проверьте лимиты Google Drive API в своём проекте Google Cloud.".into(),
            "authorization" => return "Google отклонил вход. Подключите Drive заново с прежними Client ID и Client Secret и тем же аккаунтом.".into(),
            "access" => return "Google Drive запретил доступ. Проверьте аккаунт, права и включён ли Google Drive API в вашем проекте.".into(),
            "network" => return "Нет связи с Google Drive. Проверьте подключение к интернету.".into(),
            "timeout" => return "Google Drive не ответил вовремя. Попробуйте ещё раз при устойчивом подключении.".into(),
            "space" => return "Закончилось место на диске устройства или в Google Drive.".into(),
            "local-access" => return "Хабу не хватает прав доступа к файлам на этом устройстве. Проверьте разрешения и путь к папке.".into(),
            _ => {}
        }
        let last = s.lines().filter(|l| l.contains("ERROR") || l.contains("Failed") || l.contains("error")).last().unwrap_or(s.lines().last().unwrap_or(""));
        if last.is_empty() { format!("rclone завершился с кодом {}", self.code) } else { last.to_string() }
    }
    pub fn not_found(&self) -> bool {
        matches!(self.code, 3 | 4)
    }

    pub fn problem(&self) -> &'static str {
        classify_error(&self.stderr)
    }

    /// Похоже на сетевую ошибку.
    pub fn offline(&self) -> bool {
        self.problem() == "network"
    }
}

pub fn classify_error(message: &str) -> &'static str {
    let s = message.to_ascii_lowercase();
    let has = |parts: &[&str]| parts.iter().any(|part| s.contains(part));
    if has(&["storagequotaexceeded", "storage quota", "no space left", "disk full", "недостаточно места"]) {
        "space"
    } else if has(&["quota exceeded", "ratelimitexceeded", "rate limit exceeded", "userratelimitexceeded", "dailylimitexceeded", "too many requests", "error 429", "квоту"]) {
        "quota"
    } else if has(&["invalid_grant", "invalid_client", "unauthorized_client", "invalid credentials", "token expired", "token has been expired", "error 401", "неверный oauth"]) {
        "authorization"
    } else if has(&["error 403", "insufficientpermissions", "accessnotconfigured", "accessdenied", "insufficient authentication scopes"]) {
        "access"
    } else if has(&["permission denied", "operation not permitted", "access is denied", "отказано в доступе"]) {
        "local-access"
    } else if has(&["timeout", "deadline exceeded", "timed out", "время ожидания истекло"]) {
        "timeout"
    } else if has(&["no such host", "network is unreachable", "connection refused", "connection reset", "temporary failure in name resolution", "нет связи с"]) {
        "network"
    } else if has(&["не запустился", "rclone завершился"]) {
        "rclone"
    } else if s.starts_with("журнал") {
        "journal"
    } else {
        "unknown"
    }
}

/// Дренируем оба канала параллельно, чтобы rclone не заблокировался на заполненном буфере.
fn run_command(
    cmd: &mut Command,
    stdin: Option<&[u8]>,
    timeout: Duration,
    on_log: impl FnMut(&str) + Send + 'static,
    cancelled: impl Fn() -> bool,
) -> Result<Output, String> {
    quiet(cmd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() });
    let bin = cmd.get_program().to_string_lossy().into_owned();
    let mut child = cmd.spawn().map_err(|e| format!("rclone не запустился ({bin}): {e}"))?;
    let mut stdout = child.stdout.take().expect("stdout настроен");
    let stderr = child.stderr.take().expect("stderr настроен");
    let read_out = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).map(|_| bytes)
    });
    let read_err = std::thread::spawn(move || -> std::io::Result<String> {
        let mut on_log = on_log;
        let mut log = String::new();
        for line in BufReader::new(stderr).lines() {
            let line = line?;
            on_log(&line);
            log.push_str(&line);
            log.push('\n');
        }
        Ok(log)
    });
    if let (Some(data), Some(mut pipe)) = (stdin, child.stdin.take()) {
        let data = data.to_vec();
        std::thread::spawn(move || pipe.write_all(&data));
    }
    let status = wait_for_child(&mut child, timeout, cancelled)?;
    let stdout = read_out.join().map_err(|_| "Не удалось прочитать вывод rclone")?.map_err(|e| e.to_string())?;
    let stderr = read_err.join().map_err(|_| "Не удалось прочитать журнал rclone")?.map_err(|e| e.to_string())?;
    Ok(Output { ok: status.success(), code: status.code().unwrap_or(-1), stdout, stderr })
}

fn wait_for_child(child: &mut Child, timeout: Duration, cancelled: impl Fn() -> bool) -> Result<ExitStatus, String> {
    let start = Instant::now();
    let error = loop {
        if cancelled() {
            break "Вход в Google отменён".into();
        }
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(25)),
            Ok(None) => break format!("rclone: время ожидания истекло ({} с)", timeout.as_secs()),
            Err(e) => break format!("Не удалось дождаться rclone: {e}"),
        }
    };
    let _ = child.kill();
    let _ = child.wait();
    Err(error)
}

/// `rclone obscure -`: пароль приходит через stdin.
pub fn obscure(bin: &PathBuf, secret: &str) -> Result<String, String> {
    let out = run_command(Command::new(bin).args(["obscure", "-"]), Some(secret.as_bytes()), Duration::from_secs(15), |_| {}, || false)?;
    if !out.ok {
        return Err(out.err());
    }
    Ok(out.text().trim().to_string())
}

pub fn authorize(
    id: &str,
    secret: &str,
    open_url: impl FnMut(&str) + Send + 'static,
    cancelled: impl Fn() -> bool,
) -> Result<String, String> {
    use base64::Engine;
    let (id, secret) = drive_client(id, secret)?;
    let cfg = serde_json::json!({ "scope": "drive.file", "client_id": id, "client_secret": secret });
    let blob = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(cfg.to_string());
    let mut cmd = Command::new(locate());
    cmd.args(["authorize", "drive", &blob, "--auth-no-open-browser", "--config", ""]).args(NETWORK_FLAGS);
    // Страница в браузере после авторизации.
    let page = std::env::temp_dir().join("hub-auth-page.html");
    if std::fs::write(&page, include_str!("auth_page.html")).is_ok() {
        cmd.arg("--template").arg(&page);
    }
    let mut open_url = open_url;
    let mut opened = false;
    let out = run_command(&mut cmd, None, AUTHORIZE_TIMEOUT, move |line| {
        if let Some(url) = line.split_whitespace().find(|s| s.starts_with("http://127.0.0.1:53682/auth?")) {
            if !opened {
                opened = true;
                open_url(url);
            }
        }
    }, &cancelled).map_err(|e| {
        if cancelled() { e } else { format!("Вход в Google не завершён. Попробуйте снова. {e}") }
    })?;
    if !out.ok {
        let log = out.stderr.to_ascii_lowercase();
        let message = if log.contains("access_denied") {
            "Доступ к Google Drive отклонён. Повторите вход и разрешите доступ"
        } else if log.contains("invalid_client") {
            "Google отклонил OAuth-клиент. Проверьте Client ID и Client Secret"
        } else if log.contains("address already in use") {
            "Порт для входа в Google занят. Закройте другое окно входа и повторите попытку"
        } else {
            "Google не завершил авторизацию. Проверьте настройки клиента OAuth и повторите вход"
        };
        return Err(message.into());
    }
    parse_authorize_token(&out.text()).or_else(|| parse_authorize_token(&out.stderr))
        .ok_or_else(|| "Google не вернул токен доступа. Повторите вход и разрешите доступ к Drive".into())
}

impl Rclone {
    /// Только базовое хранилище (до ключа данных): авторизация, keys.json.
    pub fn base(target: &Target) -> Result<Self, String> {
        let bin = locate();
        let mut env: Vec<(String, String)> = Vec::new();
        let b = format!("RCLONE_CONFIG_{}_", BASE.to_uppercase());
        match target.kind.as_str() {
            "local" => {
                env.push((format!("{b}TYPE"), "local".into()));
            }
            "drive" => {
                env.push((format!("{b}TYPE"), "drive".into()));
                env.push((format!("{b}SCOPE"), "drive.file".into()));
                env.push((format!("{b}TOKEN"), target.token.clone()));
                let (id, secret) = drive_client(&target.client_id, &target.client_secret)?;
                env.push((format!("{b}CLIENT_ID"), id.into()));
                env.push((format!("{b}CLIENT_SECRET"), secret.into()));
            }
            k => return Err(format!("неизвестное хранилище: {k}")),
        }
        Ok(Rclone { bin, env })
    }

    /// С crypt поверх Hub/crypt: пароли выводятся из ключа данных.
    pub fn with_crypt(target: &Target, key: &DataKey) -> Result<Self, String> {
        let mut r = Self::base(target)?;
        let c = format!("RCLONE_CONFIG_{}_", CRYPT.to_uppercase());
        let (p1, p2) = crypt_passwords(key);
        let o1 = obscure(&r.bin, &p1)?;
        let o2 = obscure(&r.bin, &p2)?;
        r.env.push((format!("{c}TYPE"), "crypt".into()));
        r.env.push((format!("{c}REMOTE"), format!("{BASE}:{}", r_root(target, "crypt"))));
        r.env.push((format!("{c}PASSWORD"), o1));
        r.env.push((format!("{c}PASSWORD2"), o2));
        Ok(r)
    }

    pub fn run(&self, args: &[&str], stdin: Option<&[u8]>) -> Output {
        let mut cmd = Command::new(&self.bin);
        cmd.args(args).args(["--config", ""]).args(NETWORK_FLAGS).envs(self.env.iter().cloned());
        run_command(&mut cmd, stdin, COMMAND_TIMEOUT, |_| {}, || false).unwrap_or_else(|stderr| Output {
            ok: false, code: -1, stdout: vec![], stderr,
        })
    }
}

/// Путь внутри базового хранилища: Drive — «Hub/…», папка — «<папка>/…».
pub fn r_root(target: &Target, sub: &str) -> String {
    if target.kind == "local" {
        format!("{}/{sub}", target.path.trim_end_matches(['/', '\\']))
    } else {
        format!("Hub/{sub}")
    }
}

pub fn base_path(target: &Target, file: &str) -> String {
    format!("{BASE}:{}", r_root(target, file))
}

pub fn crypt_passwords(key: &DataKey) -> (String, String) {
    (key.derive("rclone crypt password"), key.derive("rclone crypt salt"))
}

/// Из вывода `rclone authorize`: что стоит между стрелками «Paste the following…» и «End paste».
/// Старые версии печатают там JSON токена, новые (1.5x+ при вызове с base64-настройками) —
/// base64 от `{"token":"<JSON токена>"}`. Понимаем оба вида; возвращаем JSON токена.
pub fn parse_authorize_token(out: &str) -> Option<String> {
    use base64::Engine;
    let start = out.find("--->")? + 4;
    let end = out[start..].find("<---")? + start;
    let t: String = out[start..end].split_whitespace().collect();
    let is_token = |v: &serde_json::Value| v.get("access_token").is_some() || v.get("refresh_token").is_some();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
        if is_token(&v) {
            return Some(t);
        }
        if let Some(inner) = v.get("token").and_then(|x| x.as_str()) {
            return Some(inner.to_string());
        }
    }
    let engines = [
        base64::engine::general_purpose::URL_SAFE_NO_PAD,
        base64::engine::general_purpose::URL_SAFE,
        base64::engine::general_purpose::STANDARD,
        base64::engine::general_purpose::STANDARD_NO_PAD,
    ];
    for e in engines {
        let Ok(bytes) = e.decode(t.as_bytes()) else { continue };
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) else { continue };
        if let Some(inner) = v.get("token").and_then(|x| x.as_str()) {
            return Some(inner.to_string());
        }
        if is_token(&v) {
            return Some(String::from_utf8_lossy(&bytes).to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_from_authorize_output() {
        let out = "NOTICE: Got code\nPaste the following into your remote machine --->\n{\"access_token\":\"x\",\"expiry\":\"2026\"}\n<---End paste\n";
        assert_eq!(parse_authorize_token(out).unwrap(), "{\"access_token\":\"x\",\"expiry\":\"2026\"}");
        assert!(parse_authorize_token("ничего").is_none());
        // новый вид: base64 от {"token": "<JSON>"}
        use base64::Engine;
        let tok = r#"{"access_token":"ya29","token_type":"Bearer","refresh_token":"1//x","expiry":"2026-11-20T18:00:00Z"}"#;
        let blob = serde_json::json!({ "token": tok }).to_string();
        for enc in [base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&blob), base64::engine::general_purpose::STANDARD.encode(&blob)] {
            let out = format!("NOTICE: Got code\nPaste the following into your remote machine --->\n{enc}\n<---End paste\n");
            assert_eq!(parse_authorize_token(&out).as_deref(), Some(tok));
        }
    }

    #[test]
    fn roots() {
        let d = Target { kind: "drive".into(), ..Default::default() };
        assert_eq!(base_path(&d, "keys.json"), "hubdrive:Hub/keys.json");
        let l = Target { kind: "local".into(), path: "/tmp/fake/".into(), ..Default::default() };
        assert_eq!(base_path(&l, "keys.json"), "hubdrive:/tmp/fake/keys.json");
    }
}
