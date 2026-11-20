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
  async openDataDir() { return T.core.invoke("open_data_dir"); },
  onHotkey(cb) { T.event.listen("hub://capture", () => cb("capture")); },
  async windowFocused() { try { return await T.core.invoke("window_focused"); } catch { return true; } },
};

/* Заглушка для браузера */
const LSP = "hubdev:";
const blobs = new Map();
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
    const json = {}, blobMeta = {}, pre = `${LSP}${ns}:`;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith(pre)) json[k.slice(pre.length)] = JSON.parse(localStorage.getItem(k));
    }
    for (const [k, b] of blobs) if (k.startsWith(pre)) blobMeta[k.slice(pre.length)] = { type: b.type, size: b.size };
    return { json, blobs: blobMeta };
  },
  async get(ns, key) {
    if (blobs.has(`${LSP}${ns}:${key}`)) return blobs.get(`${LSP}${ns}:${key}`);
    const v = localStorage.getItem(`${LSP}${ns}:${key}`);
    return v === null ? undefined : JSON.parse(v);
  },
  async set(ns, key, value) {
    const k = `${LSP}${ns}:${key}`;
    if (value instanceof Blob) { localStorage.removeItem(k); blobs.set(k, value); return; }
    blobs.delete(k);
    localStorage.setItem(k, JSON.stringify(value));
  },
  async remove(ns, key) { const k = `${LSP}${ns}:${key}`; localStorage.removeItem(k); blobs.delete(k); },
  appBase() { return new URL("hubapp/", location.href).href; },
  async notify(title, body) { console.info("[уведомление]", title, body); },
  async info() { return { dataDir: "(браузер: localStorage этой страницы)", version: "dev" }; },
  async openDataDir() {},
  onHotkey() {},
  async windowFocused() { return document.hasFocus(); },
};

export const core = inTauri ? tauriCore : devCore;
