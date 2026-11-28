/* core.js — связь оболочки с ядром.
   В Tauri всё идёт в Rust (src-tauri): файлы данных, список приложений, системные уведомления.
   В обычном браузере (npm run dev, тесты) — заглушка: данные в localStorage этой страницы, Blob — в памяти. */

const T = window.__TAURI__;
export const inTauri = !!(T && T.core);

/* Данные: пространство имён ns ("hub" — сам хаб, иначе id приложения), ключ — строка с «/». */
const tauriCore = {
  async apps() { return T.core.invoke("apps_list"); },
  async dump(ns) { return T.core.invoke("data_dump", { ns }); },
  async get(ns, key) {
    const st = await T.core.invoke("data_stat", { ns, key });
    if (!st) return undefined;
    if (st.kind === "json") return T.core.invoke("data_get", { ns, key });
    const buf = await T.core.invoke("blob_get", { ns, key });
    return new Blob([buf], { type: st.type || "application/octet-stream" });
  },
  async set(ns, key, value) {
    if (value instanceof Blob) {
      const bytes = new Uint8Array(await value.arrayBuffer());
      return T.core.invoke("blob_put", bytes, { headers: {
        "hub-ns": ns, "hub-key": encodeURIComponent(key), "hub-type": encodeURIComponent(value.type || "") } });
    }
    return T.core.invoke("data_set", { ns, key, value });
  },
  async remove(ns, key) { return T.core.invoke("data_remove", { ns, key }); },
  appBase() { return T.core.convertFileSrc("", "hubapp"); },
  async notify(title, body) { try { await T.core.invoke("notify", { title, body }); } catch (e) { console.warn(e); } },
  async info() { return T.core.invoke("hub_info"); },
  openDevTools: () => T.core.invoke("open_devtools"),
  updateCheck: () => T.core.invoke("update_check"),
  updateInstall: () => T.core.invoke("update_install"),
  async openDataDir() { return T.core.invoke("open_data_dir"); },
  onHotkey(cb) { T.event.listen("hub://capture", () => cb("capture")); },
  async windowFocused() { try { return await T.core.invoke("window_focused"); } catch { return true; } },

  /* пароль и замок */
  status: () => T.core.invoke("hub_status"),
  setupCreate: password => T.core.invoke("setup_create", { password }),
  setupJoin: (target, password) => T.core.invoke("setup_join", { target: Object.assign({ kind: "drive", token: "", clientId: "", clientSecret: "", path: "" }, target), password }),
  unlock: password => T.core.invoke("unlock", { password }),
  unlockWithRecovery: (code, newPassword) => T.core.invoke("unlock_with_recovery", { code, newPassword }),
  changePassword: (oldPassword, newPassword) => T.core.invoke("change_password", { oldPassword, newPassword }),
  lock: () => T.core.invoke("lock"),

  /* синхронизация */
  driveCancel: () => T.core.invoke("drive_cancel"),
  syncStatus: () => T.core.invoke("sync_status"),
  syncNow: () => T.core.invoke("sync_now"),
  driveAuthorize: ({ clientId = "", clientSecret = "" } = {}) => T.core.invoke("drive_authorize", { clientId, clientSecret }),
  syncConnect: target => T.core.invoke("sync_connect", { target: Object.assign({ kind: "drive", token: "", clientId: "", clientSecret: "", path: "" }, target) }),
  syncDisconnect: () => T.core.invoke("sync_disconnect"),
  savedDriveClient: password => T.core.invoke("sync_saved_drive_client", { password }),
  rclonePasswords: password => T.core.invoke("sync_rclone_passwords", { password }),
  folderAdd: (path, name, mode, exclude = []) => T.core.invoke("folder_add", { path, name, mode, exclude }),
  folderPlace: (id, path) => T.core.invoke("folder_place", { id, path }),
  folderPreview: id => T.core.invoke("folder_preview", { id }),
  folderSync: (id, action) => T.core.invoke("folder_sync", { id, action }),
  folderResolve: (id, keep) => T.core.invoke("folder_resolve", { id, keep }),
  folderForget: id => T.core.invoke("folder_forget", { id }),
  async pickFolder() {
    try { return await T.core.invoke("plugin:dialog|open", { options: { directory: true, multiple: false } }); }
    catch (e) { console.warn(e); return null; }
  },
  onSync(cb) { T.event.listen("hub://sync", e => cb(e.payload)); },
  onDataChanged(cb) { T.event.listen("hub://data-changed", e => cb(e.payload)); },
  /* пакеты: приложения и темы из папки или zip */
  inspectPackage: path => T.core.invoke("package_inspect", { path }),
  installPackage: path => T.core.invoke("package_install", { path }),
  uninstallApp: (id, data) => T.core.invoke("app_uninstall", { id, data }),
  removeTheme: id => T.core.invoke("theme_remove", { id }),
  async pickPackage(kind) {
    const options = kind === "folder" ? { directory: true, multiple: false } : { directory: false, multiple: false, filters: [{ name: "Архив приложения или темы", extensions: ["zip"] }] };
    try { return await T.core.invoke("plugin:dialog|open", { options }); } catch (e) { console.warn(e); return null; }
  },
  droppedPackage: path => T.core.invoke("dropped_package", { path }),
  readDroppedFile: path => T.core.invoke("read_dropped_file", { path }),
  async openUrl(url) { return T.core.invoke("plugin:opener|open_url", { url }); },
  onDragDrop({ enter, over, leave, drop }) {
    T.event.listen("tauri://drag-enter", e => enter(e.payload));
    T.event.listen("tauri://drag-over", e => over(e.payload));
    T.event.listen("tauri://drag-leave", () => leave());
    T.event.listen("tauri://drag-drop", e => drop(e.payload));
  },
  /* ПК: мини-окно, трей, автозапуск */
  quickCapture: text => T.core.invoke("quick_capture", { text }),
  miniHide: () => T.core.invoke("mini_hide"),
  desktopPrefs: () => T.core.invoke("desktop_prefs"),
  desktopSet: (prefs) => T.core.invoke("desktop_set", prefs),
  onLockRequest(cb) { T.event.listen("hub://lock-request", () => cb()); },
  /* своё окно без системной рамки: свернуть, развернуть, закрыть */
  get nativeWindow() { return !!(T.window && !/Android/i.test(navigator.userAgent)); },
  windowAction(kind) {
    const w = T.window.getCurrentWindow();
    if (kind === "min") return w.minimize();
    if (kind === "max") return w.toggleMaximize();
    if (kind === "close") return w.close();
  },
};

/* Заглушка для браузера: пароль хранится открыто в localStorage — только для разработки и тестов */
const LSP = "hubdev:";
const blobs = new Map();
let devOpen = false;
const devKeys = () => localStorage.getItem("hubdev-keys");
function devGuard() { if (!devOpen) throw new Error("Хаб заперт"); }
/* мини-окно в браузере — отдельная страница, она всегда «заперта»: мысли ждут входа в hubdev-pending */
function devDrain() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem("hubdev-pending") || "[]"); } catch { /* пусто */ }
  for (const item of list) localStorage.setItem(`${LSP}hub:inbox/${item.id}`, JSON.stringify(item));
  localStorage.removeItem("hubdev-pending");
}
const devCore = {
  async apps() {
    const ids = await (await fetch("apps/index.json")).json();
    const out = [];
    for (const id of ids) {
      try { out.push({ id, source: "builtin", manifest: await (await fetch(`apps/${id}/manifest.json`)).json() }); }
      catch (e) { console.warn("нет манифеста", id, e); }
    }
    return out;
  },
  async dump(ns) {
    devGuard();
    const json = {}, blobMeta = {}, pre = `${LSP}${ns}:`;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith(pre)) json[k.slice(pre.length)] = JSON.parse(localStorage.getItem(k));
    }
    for (const [k, b] of blobs) if (k.startsWith(pre)) blobMeta[k.slice(pre.length)] = { type: b.type, size: b.size };
    return { json, blobs: blobMeta };
  },
  async get(ns, key) {
    devGuard();
    if (blobs.has(`${LSP}${ns}:${key}`)) return blobs.get(`${LSP}${ns}:${key}`);
    const v = localStorage.getItem(`${LSP}${ns}:${key}`);
    return v === null ? undefined : JSON.parse(v);
  },
  async set(ns, key, value) {
    devGuard();
    const k = `${LSP}${ns}:${key}`;
    if (value instanceof Blob) { localStorage.removeItem(k); blobs.set(k, value); return; }
    blobs.delete(k);
    localStorage.setItem(k, JSON.stringify(value));
  },
  async remove(ns, key) { devGuard(); const k = `${LSP}${ns}:${key}`; localStorage.removeItem(k); blobs.delete(k); },
  appBase() { return new URL("hubapp/", location.href).href; },
  async notify(title, body) { console.info("[уведомление]", title, body); },
  async info() { return { dataDir: "(браузер: localStorage этой страницы)", version: "dev" }; },
  async openDataDir() {},
  onHotkey() {},
  async windowFocused() { return document.hasFocus(); },

  async status() {
    const old = Object.keys(localStorage).some(k => k.startsWith(LSP));
    return { setupDone: !!devKeys(), unlocked: devOpen, hasOldData: old, platform: "pc" };
  },
  async setupCreate(password) {
    if (devKeys()) throw new Error("Хаб уже настроен");
    if ([...password].length < 8) throw new Error("Пароль — не короче 8 знаков");
    localStorage.setItem("hubdev-keys", password); devOpen = true; devDrain();
    return "7KQ2-M9XD-R4TW-HC8P-3VNJ-6YBF-Q2MS-W9EA";
  },
  async setupJoin() { throw new Error("В браузере синхронизации нет — только в приложении хаба"); },
  async unlock(password) { if (password !== devKeys()) throw new Error("Неверный пароль"); devOpen = true; devDrain(); },
  async unlockWithRecovery(code, p) {
    if (code.replace(/[^0-9a-z]/gi, "").toUpperCase() !== "7KQ2M9XDR4TWHC8P3VNJ6YBFQ2MSW9EA") throw new Error("Ключ восстановления не подходит");
    if ([...p].length < 8) throw new Error("Пароль — не короче 8 знаков");
    localStorage.setItem("hubdev-keys", p); devOpen = true; devDrain();
  },
  async changePassword(o, n) {
    if (o !== devKeys()) throw new Error("Старый пароль неверный");
    if ([...n].length < 8) throw new Error("Пароль — не короче 8 знаков");
    localStorage.setItem("hubdev-keys", n);
  },
  async lock() { devOpen = false; },
  async syncStatus() { return { configured: false, kind: "", state: "off", message: "", lastSync: null, device: "browser", folders: [] }; },
  async syncNow() {},
  async driveCancel() {},
  async driveAuthorize() { throw new Error("В браузере синхронизации нет — только в приложении хаба"); },
  async syncConnect() { throw new Error("В браузере синхронизации нет — только в приложении хаба"); },
  async syncDisconnect() {},
  async rclonePasswords() { throw new Error("В браузере синхронизации нет"); },
  async folderAdd() { throw new Error("В браузере синхронизации нет"); },
  async folderPlace() {},
  async folderPreview() { return { upload: [], download: [], differ: [], same: 0 }; },
  async folderSync() { return []; },
  async folderResolve() {},
  async folderForget() {},
  async pickFolder() { return null; },
  onSync() {},
  onDataChanged() {},
  nativeWindow: false,
  windowAction() {},
  async inspectPackage() { throw new Error("Установка — только в приложении хаба"); },
  async installPackage() { throw new Error("Установка — только в приложении хаба"); },
  async uninstallApp() { throw new Error("Удаление — только в приложении хаба"); },
  async removeTheme(id) { await devCore.remove("hub", `themes/${id}`); await devCore.remove("hub", `themes/${id}/photo`); },
  async pickPackage() { return null; },
  onDragDrop() {},
  async quickCapture(text) {
    text = String(text).trim();
    if (!text) throw new Error("Напишите мысль и нажмите Enter");
    if (!devKeys()) throw new Error("Хаб ещё не настроен — войдите в него хотя бы раз");
    const tags = [...new Set((text.match(/(^|\s)#([\p{L}\p{N}_-]+)/gu) || []).map(t => t.trim().slice(1).toLowerCase()))];
    const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), text, created: new Date().toISOString(), device: "pc", tags };
    if (devOpen) { localStorage.setItem(`${LSP}hub:inbox/${item.id}`, JSON.stringify(item)); return { status: "saved", count: Object.keys(localStorage).filter(k => k.startsWith(`${LSP}hub:inbox/`)).length }; }
    let list = [];
    try { list = JSON.parse(localStorage.getItem("hubdev-pending") || "[]"); } catch { /* пусто */ }
    list.push(item); localStorage.setItem("hubdev-pending", JSON.stringify(list));
    return { status: "sealed", count: null };
  },
  async miniHide() {},
  async desktopPrefs() { return { closeToTray: true, autostart: false, pending: 0, dev: true }; },
  async desktopSet() {},
  onLockRequest() {},
};

export const core = inTauri ? tauriCore : devCore;
