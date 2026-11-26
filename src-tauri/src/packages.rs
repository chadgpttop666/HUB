//! Пакеты: приложения и темы из папки или zip (этап 3).
//!
//! Установленное хранится в данных хаба, а не отдельной папкой:
//!   hub/apps/<id>/manifest            манифест (JSON)
//!   hub/apps/<id>/files/<путь>        файлы приложения (двоичные значения)
//!   hub/themes/<id>                   theme.json
//!   hub/themes/<id>/photo             фото темы
//! Поэтому приложения и темы шифруются и уезжают на телефон той же синхронизацией, что и данные.
//! Страницы установленных приложений отдаёт протокол hubapp:// (см. lib.rs) — прямо из хранилища.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path};

use crate::store::{valid_ns, Store};

pub const MAX_TOTAL: u64 = 64 * 1024 * 1024;
pub const MAX_FILES: usize = 3000;
const NS: &str = "hub";

#[derive(Debug, Clone)]
pub struct Package {
    pub kind: Kind,
    pub manifest: Value,
    pub files: BTreeMap<String, Vec<u8>>,
    pub source: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    App,
    Theme,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub kind: Kind,
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub icon: String,
    pub accepts: Vec<String>,
    pub network: Vec<String>,
    pub card: bool,
    pub files: usize,
    pub size: u64,
    pub source: String,
    /// уже установлено: версия
    pub installed: Option<String>,
    /// почему нельзя ставить (пусто — можно)
    pub errors: Vec<String>,
    /// что нарушает правила APP_SPEC.md, но не мешает работе
    pub warnings: Vec<String>,
}

fn safe_rel(p: &str) -> Option<String> {
    let p = p.replace('\\', "/");
    let p = p.trim_start_matches("./");
    if p.is_empty() || p.contains('\0') {
        return None;
    }
    let path = Path::new(p);
    if !path.components().all(|c| matches!(c, Component::Normal(_))) {
        return None;
    }
    Some(p.to_string())
}

fn skip(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    rel.split('/').any(|s| s == "__MACOSX" || s == ".git" || s == "node_modules") || name == ".DS_Store" || name == "Thumbs.db"
}

/// Отличить установочный ZIP от выгрузки приложения по оглавлению архива.
pub fn is_package_zip(path: &Path) -> bool {
    let Ok(file) = fs::File::open(path) else { return false };
    let Ok(archive) = zip::ZipArchive::new(file) else { return false };
    if archive.len() > MAX_FILES {
        return false;
    }
    let mut root = None;
    let mut nested_manifest = false;
    let mut single_root = true;
    for name in archive.file_names().filter(|name| !name.ends_with('/') && !skip(name)) {
        let Some(name) = safe_rel(name) else { continue };
        if matches!(name.as_str(), "manifest.json" | "theme.json") {
            return true;
        }
        if let Some((folder, relative)) = name.split_once('/') {
            let first = root.get_or_insert_with(|| folder.to_string());
            single_root &= *first == folder;
            nested_manifest |= matches!(relative, "manifest.json" | "theme.json");
        } else {
            single_root = false;
        }
    }
    single_root && nested_manifest
}

/// Прочитать папку или zip. В архиве допускается одна общая папка верхнего уровня.
pub fn read(path: &Path) -> Result<Package, String> {
    let mut files = BTreeMap::new();
    let mut total = 0u64;
    let mut add = |rel: String, bytes: Vec<u8>| -> Result<(), String> {
        total += bytes.len() as u64;
        if total > MAX_TOTAL {
            return Err(format!("пакет больше {} МБ", MAX_TOTAL / 1024 / 1024));
        }
        if files.len() >= MAX_FILES {
            return Err(format!("в пакете больше {MAX_FILES} файлов"));
        }
        files.insert(rel, bytes);
        Ok(())
    };
    if path.is_dir() {
        let mut stack = vec![path.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).map_err(|e| format!("{}: {e}", d.display()))?.flatten() {
                let p = e.path();
                let rel = p.strip_prefix(path).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
                if skip(&rel) {
                    continue;
                }
                if p.is_dir() {
                    stack.push(p);
                } else if let Some(rel) = safe_rel(&rel) {
                    add(rel, fs::read(&p).map_err(|e| format!("{}: {e}", p.display()))?)?;
                }
            }
        }
    } else {
        let f = fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut z = zip::ZipArchive::new(f).map_err(|e| format!("это не zip-архив: {e}"))?;
        for i in 0..z.len() {
            let mut entry = z.by_index(i).map_err(|e| e.to_string())?;
            if entry.is_dir() {
                continue;
            }
            let Some(name) = entry.enclosed_name().map(|p| p.to_string_lossy().replace('\\', "/")) else { continue };
            if skip(&name) {
                continue;
            }
            let Some(rel) = safe_rel(&name) else { continue };
            if entry.size() > MAX_TOTAL {
                return Err("файл в архиве слишком большой".into());
            }
            let mut buf = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            add(rel, buf)?;
        }
    }
    // одна общая папка верхнего уровня (calendar/manifest.json) — снять её
    let roots: std::collections::BTreeSet<&str> = files.keys().map(|k| k.split('/').next().unwrap_or("")).collect();
    let has_top_manifest = files.contains_key("manifest.json") || files.contains_key("theme.json");
    if !has_top_manifest && roots.len() == 1 && files.keys().all(|k| k.contains('/')) {
        let root = format!("{}/", roots.iter().next().unwrap());
        files = files.into_iter().map(|(k, v)| (k[root.len()..].to_string(), v)).collect();
    }
    let source = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let (kind, mfile) = if files.contains_key("manifest.json") {
        (Kind::App, "manifest.json")
    } else if files.contains_key("theme.json") {
        (Kind::Theme, "theme.json")
    } else {
        return Err("в пакете нет manifest.json (приложение) или theme.json (тема)".into());
    };
    let manifest: Value = serde_json::from_slice(&files[mfile]).map_err(|e| format!("{mfile} не читается: {e}"))?;
    Ok(Package { kind, manifest, files, source })
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

/// Проверка по APP_SPEC.md: ошибки — ставить нельзя, предупреждения — можно, но стоит поправить.
pub fn check(pkg: &Package, store: &Store) -> Preview {
    let m = &pkg.manifest;
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let id = s(m, "id");
    let name = s(m, "name");
    if id.is_empty() {
        errors.push("в манифесте нет поля «id»".to_string());
    } else if !valid_ns(&id) || id == "hub" {
        errors.push(format!("«id» = «{id}»: только строчные латинские буквы, цифры и - _ . (до 64 знаков), не «hub»"));
    }
    if name.trim().is_empty() {
        errors.push("в манифесте нет поля «name»".to_string());
    }
    let mut accepts = Vec::new();
    let mut network = Vec::new();
    let mut card = false;
    let installed;
    match pkg.kind {
        Kind::App => {
            let entry = m.get("entry").and_then(Value::as_str).unwrap_or("index.html");
            if !pkg.files.contains_key(entry) {
                errors.push(format!("нет файла страницы «{entry}»"));
            }
            if let Some(a) = m.get("accepts") {
                match a.as_array() {
                    Some(list) => {
                        for x in list {
                            if s(x, "type").is_empty() {
                                errors.push("в «accepts» у элемента нет «type»".to_string());
                            } else {
                                accepts.push(if s(x, "label").is_empty() { s(x, "type") } else { s(x, "label") });
                            }
                        }
                    }
                    None => errors.push("«accepts» должен быть списком".to_string()),
                }
            }
            if let Some(list) = m.pointer("/permissions/network").and_then(Value::as_array) {
                for h in list {
                    let h = h.as_str().unwrap_or("").to_string();
                    if !h.starts_with("https://") {
                        errors.push(format!("адрес сети «{h}» — только https://…"));
                    } else {
                        network.push(h);
                    }
                }
            }
            card = m.get("card").and_then(Value::as_bool).unwrap_or(false);
            installed = store.get_json(NS, &format!("apps/{id}/manifest")).ok().flatten().map(|v| s(&v, "version"));
            lint(pkg, &network, &mut warnings);
        }
        Kind::Theme => {
            let base = s(m, "base");
            if !["dark", "light", "solid"].contains(&base.as_str()) {
                errors.push("«base» — dark, light или solid".to_string());
            }
            let photo = s(m, "photo");
            if !photo.is_empty() && !pkg.files.contains_key(&photo) {
                errors.push(format!("нет файла фото «{photo}»"));
            }
            if let Some(t) = m.get("tokens").and_then(Value::as_object) {
                for (k, v) in t {
                    if !v.is_string() || !k.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
                        errors.push(format!("токен «{k}»: имя из строчных букв и дефисов, значение — строка"));
                    }
                }
            }
            installed = store.get_json(NS, &format!("themes/{id}")).ok().flatten().map(|v| s(&v, "version"));
        }
    }
    Preview {
        kind: pkg.kind,
        id,
        name,
        version: s(m, "version"),
        description: s(m, "description"),
        icon: s(m, "icon"),
        accepts,
        network,
        card,
        files: pkg.files.len(),
        size: pkg.files.values().map(|v| v.len() as u64).sum(),
        source: pkg.source.clone(),
        installed,
        errors,
        warnings,
    }
}

/// Правила оформления из APP_SPEC.md — по тексту файлов, без запуска.
fn lint(pkg: &Package, network: &[String], warnings: &mut Vec<String>) {
    let mut colors = Vec::new();
    let mut fonts = Vec::new();
    let mut external = Vec::new();
    for (rel, bytes) in &pkg.files {
        let ext = rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        if !["html", "htm", "css", "js", "mjs"].contains(&ext.as_str()) {
            continue;
        }
        let text = String::from_utf8_lossy(bytes);
        for (i, line) in text.lines().enumerate() {
            let low = line.to_ascii_lowercase();
            let hex = hex_color(line);
            if hex || low.contains("rgb(") || low.contains("rgba(") || low.contains("hsl(") {
                if colors.len() < 3 {
                    colors.push(format!("{rel}:{}", i + 1));
                }
            }
            if let Some(p) = low.find("font-family") {
                let rest = &low[p..];
                if !rest.contains("var(--") && !rest.contains("inherit") && fonts.len() < 3 {
                    fonts.push(format!("{rel}:{}", i + 1));
                }
            }
            for marker in ["src=\"http", "src='http", "href=\"http", "href='http", "@import url(http", "@import \"http"] {
                if let Some(p) = low.find(marker) {
                    let url: String = line[p..].split(['"', '\'', '(']).nth(1).unwrap_or("").chars().take(80).collect();
                    let is_link_tag = low.contains("<a ") && marker.starts_with("href");
                    if !is_link_tag && !network.iter().any(|h| url.starts_with(h.as_str())) && external.len() < 3 {
                        external.push(format!("{rel}:{} ({url})", i + 1));
                    }
                }
            }
        }
    }
    if !colors.is_empty() {
        warnings.push(format!("свои цвета вместо токенов темы: {}", colors.join(", ")));
    }
    if !fonts.is_empty() {
        warnings.push(format!("свои шрифты вместо var(--font-…): {}", fonts.join(", ")));
    }
    if !external.is_empty() {
        warnings.push(format!("загрузка из интернета без заявки в манифесте (хаб её заблокирует): {}", external.join(", ")));
    }
}

fn hex_color(line: &str) -> bool {
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'#' && (i == 0 || !(b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'&')) {
            let n = b[i + 1..].iter().take_while(|c| c.is_ascii_hexdigit()).count();
            let after = b.get(i + 1 + n).copied().unwrap_or(b' ');
            if matches!(n, 3 | 4 | 6 | 8) && !after.is_ascii_alphanumeric() && after != b'-' && after != b'_' {
                // #fff, #f0b46a — но не #id в селекторе вида #abc { … } и не якорь «#top»
                let tail = line[i + 1 + n..].trim_start();
                if !tail.starts_with('{') && !tail.starts_with(',') && !tail.starts_with('.') && !tail.starts_with(':') {
                    return true;
                }
            }
        }
        i += 1;
    }
    false
}

fn mime_of(rel: &str) -> &'static str {
    match rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

/// Поставить (или обновить) проверенный пакет. Старые файлы приложения убираются, данные приложения остаются.
pub fn install(pkg: &Package, store: &Store) -> Result<String, String> {
    let p = check(pkg, store);
    if !p.errors.is_empty() {
        return Err(p.errors.join("; "));
    }
    match pkg.kind {
        Kind::App => {
            remove_prefix(store, &format!("apps/{}/files/", p.id))?;
            for (rel, bytes) in &pkg.files {
                store.set_blob(NS, &format!("apps/{}/files/{rel}", p.id), "", bytes)?;
            }
            let mut m = pkg.manifest.clone();
            m["installedAt"] = json!(crate::store::now_ms());
            store.set_json(NS, &format!("apps/{}/manifest", p.id), &m)?;
        }
        Kind::Theme => {
            let mut m = pkg.manifest.clone();
            let photo = s(&m, "photo");
            if !photo.is_empty() {
                store.set_blob(NS, &format!("themes/{}/photo", p.id), mime_of(&photo), &pkg.files[&photo])?;
            }
            m["custom"] = json!(true);
            store.set_json(NS, &format!("themes/{}", p.id), &m)?;
        }
    }
    Ok(p.id)
}

pub fn remove_prefix(store: &Store, prefix: &str) -> Result<usize, String> {
    let keys: Vec<String> = store.keys(NS)?.into_iter().map(|(k, _)| k).filter(|k| k.starts_with(prefix)).collect();
    for k in &keys {
        store.remove(NS, k)?;
    }
    Ok(keys.len())
}

/// Удалить приложение; с data = true — и его данные (карточку, доставки оставляем разбирать хабу).
pub fn uninstall_app(store: &Store, id: &str, data: bool) -> Result<(), String> {
    remove_prefix(store, &format!("apps/{id}/"))?;
    let _ = store.remove(NS, &format!("cards/{id}"));
    if data && valid_ns(id) {
        for (k, _) in store.keys(id)? {
            store.remove(id, &k)?;
        }
    }
    Ok(())
}

pub fn remove_theme(store: &Store, id: &str) -> Result<(), String> {
    store.remove(NS, &format!("themes/{id}"))?;
    let _ = store.remove(NS, &format!("themes/{id}/photo"));
    Ok(())
}

/// Установленные приложения: (id, манифест)
pub fn installed_apps(store: &Store) -> Vec<(String, Value)> {
    let Ok(d) = store.dump(NS) else { return vec![] };
    d.json
        .into_iter()
        .filter_map(|(k, v)| {
            let id = k.strip_prefix("apps/")?.strip_suffix("/manifest")?.to_string();
            (!id.contains('/')).then_some((id, v))
        })
        .collect()
}

/// Файл установленного приложения для hubapp://
pub fn app_file(store: &Store, id: &str, rel: &str) -> Option<Vec<u8>> {
    store.get_blob(NS, &format!("apps/{id}/files/{rel}")).ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::DataKey;
    use std::io::Write;

    fn store() -> (tempfile::TempDir, Store) {
        let d = tempfile::tempdir().unwrap();
        let s = Store::new(d.path().join("data"));
        s.set_key(Some(DataKey::random()));
        (d, s)
    }

    fn write_app(dir: &Path, html: &str, manifest: Value) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
        fs::write(dir.join("index.html"), html).unwrap();
    }

    #[test]
    fn folder_install_serve_update_uninstall() {
        let (d, st) = store();
        let app = d.path().join("cal");
        write_app(&app, "<h1 class=\"hub-page-title\">Календарь</h1>", json!({"id": "calendar", "name": "Календарь", "version": "0.1.0", "accepts": [{"type": "task", "label": "Событие"}]}));
        let pkg = read(&app).unwrap();
        let p = check(&pkg, &st);
        assert!(p.errors.is_empty() && p.warnings.is_empty(), "{p:?}");
        assert_eq!((p.kind, p.accepts.clone(), p.installed.clone()), (Kind::App, vec!["Событие".to_string()], None));
        install(&pkg, &st).unwrap();
        assert_eq!(installed_apps(&st)[0].0, "calendar");
        assert!(String::from_utf8(app_file(&st, "calendar", "index.html").unwrap()).unwrap().contains("Календарь"));
        // обновление: видна прежняя версия, лишние старые файлы уходят
        fs::write(app.join("old.js"), "1").unwrap();
        install(&read(&app).unwrap(), &st).unwrap();
        fs::remove_file(app.join("old.js")).unwrap();
        write_app(&app, "<h1>v2</h1>", json!({"id": "calendar", "name": "Календарь", "version": "0.2.0"}));
        let pkg2 = read(&app).unwrap();
        assert_eq!(check(&pkg2, &st).installed.as_deref(), Some("0.1.0"));
        install(&pkg2, &st).unwrap();
        assert!(app_file(&st, "calendar", "old.js").is_none());
        st.set_json("calendar", "events/1", &json!({"t": 1})).unwrap();
        uninstall_app(&st, "calendar", false).unwrap();
        assert!(installed_apps(&st).is_empty());
        assert!(st.get_json("calendar", "events/1").unwrap().is_some(), "данные остались");
    }

    #[test]
    fn zip_with_top_folder_and_checks() {
        let (d, st) = store();
        let zpath = d.path().join("cal.zip");
        let mut z = zip::ZipWriter::new(fs::File::create(&zpath).unwrap());
        let o = zip::write::SimpleFileOptions::default();
        z.start_file("calendar/manifest.json", o).unwrap();
        z.write_all(json!({"id": "Cal!", "name": ""}).to_string().as_bytes()).unwrap();
        z.start_file("calendar/index.html", o).unwrap();
        z.write_all(b"<style>body{color:#ff0000;font-family:Arial}</style><script src=\"https://cdn.example.com/x.js\"></script><a href=\"https://site\">ok</a>").unwrap();
        z.start_file("calendar/../evil.txt", o).unwrap();
        z.write_all(b"x").unwrap();
        z.start_file("__MACOSX/._x", o).unwrap();
        z.finish().unwrap();
        assert!(is_package_zip(&zpath));
        let backup = d.path().join("backup.zip");
        let mut z = zip::ZipWriter::new(fs::File::create(&backup).unwrap());
        z.start_file("theory-base.json", o).unwrap();
        z.write_all(b"{}").unwrap();
        z.finish().unwrap();
        assert!(!is_package_zip(&backup));
        let pkg = read(&zpath).unwrap();
        assert!(pkg.files.contains_key("index.html") && !pkg.files.keys().any(|k| k.contains("evil") || k.contains("MACOSX")), "{:?}", pkg.files.keys());
        let p = check(&pkg, &st);
        assert_eq!(p.errors.len(), 2, "{:?}", p.errors);
        assert_eq!(p.warnings.len(), 3, "{:?}", p.warnings);
        assert!(install(&pkg, &st).is_err());
    }

    #[test]
    fn theme_package() {
        let (d, st) = store();
        let t = d.path().join("dawn");
        fs::create_dir_all(&t).unwrap();
        fs::write(t.join("theme.json"), json!({"id": "dawn", "name": "Рассвет", "base": "dark", "photo": "photo.jpg", "tokens": {"scrim-top": "rgba(6,12,9,0.6)"}}).to_string()).unwrap();
        fs::write(t.join("photo.jpg"), b"\xff\xd8jpeg").unwrap();
        let pkg = read(&t).unwrap();
        assert_eq!(pkg.kind, Kind::Theme);
        assert!(check(&pkg, &st).errors.is_empty());
        install(&pkg, &st).unwrap();
        assert_eq!(st.get_json(NS, "themes/dawn").unwrap().unwrap()["custom"], json!(true));
        assert!(st.get_blob(NS, "themes/dawn/photo").unwrap().is_some());
        remove_theme(&st, "dawn").unwrap();
        assert!(st.get_json(NS, "themes/dawn").unwrap().is_none());
    }

    /// Шаблон и календарь — по правилам APP_SPEC.md: проверка установщика не находит ни одного нарушения.
    #[test]
    fn template_and_calendar_follow_spec() {
        let (_d, st) = store();
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        for dir in ["templates/app", "apps/calendar"] {
            let p = check(&read(&root.join(dir)).unwrap(), &st);
            assert!(p.errors.is_empty() && p.warnings.is_empty(), "{dir}: {:?} {:?}", p.errors, p.warnings);
        }
    }

    #[test]
    fn hex_detection() {
        assert!(hex_color("color: #fff;"));
        assert!(hex_color("background:#f0b46a"));
        assert!(!hex_color("#app { display: grid }"));
        assert!(!hex_color("<a href=\"#top\">"));
        assert!(!hex_color("&#123; entity"));
        assert!(!hex_color("color: var(--text)"));
    }
}
