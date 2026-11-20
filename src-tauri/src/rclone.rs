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
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use crate::crypto::DataKey;

pub const BASE: &str = "hubdrive";
pub const CRYPT: &str = "hubcrypt";

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
        let last = s.lines().filter(|l| l.contains("ERROR") || l.contains("Failed") || l.contains("error")).last().unwrap_or(s.lines().last().unwrap_or(""));
        if last.is_empty() { format!("rclone завершился с кодом {}", self.code) } else { last.to_string() }
    }
    /// Похоже на «нет интернета», а не на ошибку
    pub fn offline(&self) -> bool {
        let s = self.stderr.to_lowercase();
        ["no such host", "dial tcp", "network is unreachable", "i/o timeout", "connection refused", "temporary failure in name resolution", "tls handshake timeout"]
            .iter()
            .any(|m| s.contains(m))
    }
}

/// `rclone obscure -`: пароль приходит через stdin, а не в аргументах (их видно в списке процессов).
pub fn obscure(bin: &PathBuf, secret: &str) -> Result<String, String> {
    let mut child = quiet(Command::new(bin).args(["obscure", "-"]))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("rclone не запустился ({}): {e}", bin.display()))?;
    child.stdin.take().ok_or("нет stdin")?.write_all(secret.as_bytes()).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
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
                if !target.client_id.is_empty() {
                    env.push((format!("{b}CLIENT_ID"), target.client_id.clone()));
                    env.push((format!("{b}CLIENT_SECRET"), target.client_secret.clone()));
                }
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
        quiet(&mut cmd).args(args).args(["--config", ""]);
        for (k, v) in &self.env {
            cmd.env(k, v);
        }
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() });
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return Output { ok: false, code: -1, stdout: vec![], stderr: format!("rclone не запустился ({}): {e}", self.bin.display()) },
        };
        if let (Some(data), Some(mut sin)) = (stdin, child.stdin.take()) {
            let data = data.to_vec();
            std::thread::spawn(move || {
                let _ = sin.write_all(&data);
            });
        }
        match child.wait_with_output() {
            Ok(o) => Output { ok: o.status.success(), code: o.status.code().unwrap_or(-1), stdout: o.stdout, stderr: String::from_utf8_lossy(&o.stderr).to_string() },
            Err(e) => Output { ok: false, code: -1, stdout: vec![], stderr: e.to_string() },
        }
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
