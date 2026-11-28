/* host.js — песочницы приложений и сторона хаба в Hub API.
   Каждое приложение — iframe с sandbox="allow-scripts …" без allow-same-origin: у страницы «пустое»
   происхождение, она не видит ни хаб, ни другие приложения, ни их данные. Говорит только сообщениями.
   Страница собирается в srcdoc: хаб читает index.html приложения и вставляет в <head> политику CSP
   (сеть закрыта), <base> на папку приложения, токены темы, hub.css, данные приложения и hub-app.js. */
import { core } from "./core.js";

const SANDBOX = "allow-scripts allow-forms allow-downloads allow-modals allow-pointer-lock";
const DELIVERY_DELAY = 4500;   // столько живёт «Отменить» после переноса

const LS_CHARS = new RegExp("[" + String.fromCharCode(0x2028) + String.fromCharCode(0x2029) + "]", "g");
export const safeJson = v => JSON.stringify(v).replace(/</g, "\\u003c").replace(LS_CHARS, c => "\\u" + c.charCodeAt(0).toString(16));
const escAttr = s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function buildCsp(base, appBase, network) {
  const hub = base;                     // папка с hub.css, шрифтами и hub-app.js
  const own = appBase;                  // папка самого приложения
  const net = (network || []).filter(h => /^https:\/\/[a-z0-9.-]+(:\d+)?(\/.*)?$/i.test(h));
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${hub}_hub/ ${own}`,
    `style-src 'unsafe-inline' ${hub}_hub/ ${own}`,
    `font-src ${hub}_hub/ ${own} data:`,
    `img-src ${own} ${hub}_hub/ data: blob:`,
    `media-src ${own} data: blob:`,
    `connect-src ${own} data: blob: ${net.join(" ")}`.trim(),
    "worker-src blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    `base-uri ${own}`,
  ].join("; ");
}

export function injectPrelude(html, prelude) {
  const head = html.match(/<head(\s[^>]*)?>/i);
  if (head) return html.slice(0, head.index + head[0].length) + prelude + html.slice(head.index + head[0].length);
  const root = html.match(/<html(\s[^>]*)?>/i);
  if (root) return html.slice(0, root.index + root[0].length) + "<head>" + prelude + "</head>" + html.slice(root.index + root[0].length);
  return "<!doctype html><head>" + prelude + "</head>" + html;
}

export class AppHost {
  constructor({ state, container, getTheme, toast, onHotkey, onCard, onActivity }) {
    this.state = state;
    this.container = container;
    this.getTheme = getTheme;
    this.toast = toast;
    this.onHotkey = onHotkey;
    this.onCard = onCard;
    this.onActivity = onActivity || (() => {});
    this.apps = new Map();     // id → { id, manifest, source }
    this.frames = new Map();   // id → { iframe, loaded, inboxReady, sent:Set, queue:Promise }
    this.timers = new Map();
    this.active = null;
    window.addEventListener("message", e => this.onMessage(e));
  }

  setApps(list) {
    for (const a of list) if (a && a.id && a.manifest) this.apps.set(a.id, a);
  }
  list() { return [...this.apps.values()]; }
  name(id) { const a = this.apps.get(id); return a ? a.manifest.name || id : id; }

  /* все «куда перенести» из манифестов: [{ appId, type, label, name, icon }] */
  targets() {
    const out = [];
    for (const a of this.list()) {
      for (const acc of a.manifest.accepts || []) {
        if (!acc || !acc.type) continue;
        out.push({ appId: a.id, type: acc.type, label: acc.label || a.manifest.name, name: a.manifest.name || a.id, icon: a.manifest.icon || "package" });
      }
    }
    return out;
  }

  ensure(id) {
    if (this.frames.has(id)) return this.frames.get(id);
    const app = this.apps.get(id);
    if (!app) throw new Error(`нет приложения ${id}`);
    const iframe = document.createElement("iframe");
    iframe.className = "shell-frame";
    iframe.title = app.manifest.name || id;
    iframe.setAttribute("sandbox", SANDBOX);
    iframe.setAttribute("allow", "clipboard-write; autoplay; fullscreen");
    iframe.hidden = true;
    iframe.dataset.app = id;
    this.container.appendChild(iframe);
    const f = { iframe, loaded: false, inboxReady: false, sent: new Set(), queue: Promise.resolve() };
    this.frames.set(id, f);
    this.reload(id);
    return f;
  }

  reload(id) {
    const f = this.frames.get(id);
    if (!f) return;
    return this.load(id, f).catch(e => {
      if (this.frames.get(id) !== f) return;
      console.error(e);
      this.toast(`«${this.name(id)}» не открылось: ${e.message || e}`, { tone: "danger", icon: "circle-alert", timeout: 8000 });
    });
  }

  async load(id, f) {
    const app = this.apps.get(id);
    const load = f.load = Symbol();
    f.loaded = false;
    const base = core.appBase();
    const appBase = `${base}${encodeURIComponent(id)}/`;
    const entry = app.manifest.entry || "index.html";
    const res = await fetch(appBase + entry);
    if (!res.ok) throw new Error(`нет файла ${entry} (${res.status})`);
    const html = await res.text();
    const current = () => this.frames.get(id) === f && f.load === load;
    if (!current()) return;
    const dump = await core.dump(id);
    if (!current()) return;
    const boot = { appId: id, platform: document.documentElement.dataset.platform || "pc", data: dump.json, blobs: dump.blobs, theme: this.getTheme(), visible: this.active === id };
    const network = (app.manifest.permissions && app.manifest.permissions.network) || [];
    const prelude =
      `<meta http-equiv="Content-Security-Policy" content="${escAttr(buildCsp(base, appBase, network))}">` +
      `<base href="${escAttr(appBase)}">` +
      `<link rel="stylesheet" href="${escAttr(base)}_hub/tokens.css">` +
      `<link rel="stylesheet" href="${escAttr(base)}_hub/hub.css">` +
      `<link rel="stylesheet" href="${escAttr(base)}_hub/app.css">` +
      `<script>window.__HUB_BOOT__=${safeJson(boot)};</script>` +
      `<script src="${escAttr(base)}_hub/hub-app.js"></script>` +
      `<script src="${escAttr(base)}_hub/hub-ui.js"></script>`;
    f.inboxReady = false; f.sent.clear();
    f.iframe.addEventListener("load", () => {
      if (!current()) return;
      f.loaded = true;
      this.post(id, "app.visibility", this.active === id);
      if (f.pendingFiles) {
        this.post(id, "app.files", f.pendingFiles);
        f.pendingFiles = null;
      }
      if (f.pendingAction) {
        this.post(id, "today.action", f.pendingAction);
        f.pendingAction = null;
      }
    }, { once: true });
    f.iframe.srcdoc = injectPrelude(html, prelude);
  }

  remove(id) {
    const f = this.frames.get(id);
    if (f) f.iframe.remove();
    this.frames.delete(id);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    if (this.active === id) this.active = null;
  }

  /* замок: страницы приложений держат расшифрованные данные в памяти — убрать их целиком */
  reset() {
    for (const id of this.frames.keys()) this.remove(id);
  }
  visible(id) { const f = this.frames.get(id); return !!(f && !f.iframe.hidden); }

  show(id, action) {
    const previous = this.frames.get(this.active);
    const changed = this.active !== id;
    if (previous && changed) {
      previous.iframe.hidden = true;
      if (previous.loaded) this.post(this.active, "app.visibility", false);
    }
    this.active = id;
    if (!id) return;
    const f = this.ensure(id);
    f.iframe.hidden = false;
    if (changed && f.loaded) this.post(id, "app.visibility", true);
    if (action) {
      if (f.loaded) this.post(id, "today.action", action);
      else f.pendingAction = action;
    }
  }
  importRepetition(files) {
    const f = this.frames.get("repetition");
    if (!f || this.apps.get("repetition")?.source !== "builtin") return;
    if (f.loaded) this.post("repetition", "app.files", files);
    else f.pendingFiles = (f.pendingFiles || []).concat(files);
  }
  focus(id) { const f = this.frames.get(id); if (f && this.active === id) f.iframe.focus(); }

  post(id, event, payload) {
    const f = this.frames.get(id);
    if (f && f.iframe.contentWindow) f.iframe.contentWindow.postMessage({ __hub: 1, event, payload }, "*");
  }
  broadcastTheme() { const t = this.getTheme(); for (const id of this.frames.keys()) this.post(id, "theme", t); }

  /* доставки в приложения */
  flushDeliveries(id) {
    const f = this.frames.get(id);
    clearTimeout(this.timers.get(id));
    const now = Date.now();
    const mine = this.state.deliveries.filter(d => d.appId === id);
    if (!mine.length) return;
    if (!f) { this.ensure(id); return; }
    if (!f.inboxReady) return;
    const due = mine.filter(d => Date.parse(d.notBefore) <= now && !f.sent.has(d.id));
    if (due.length) {
      due.forEach(d => f.sent.add(d.id));
      this.post(id, "inbox.items", due.map(d => ({ id: d.id, type: d.type, label: d.label, item: d.item })));
    }
    const later = mine.filter(d => Date.parse(d.notBefore) > now).map(d => Date.parse(d.notBefore));
    if (later.length) this.timers.set(id, setTimeout(() => this.flushDeliveries(id), Math.min(...later) - now + 50));
  }
  flushAll() { for (const id of new Set(this.state.deliveries.map(d => d.appId))) if (this.apps.has(id)) this.flushDeliveries(id); }

  transfer(item, target) {
    const d = this.state.deliver(item, target, DELIVERY_DELAY);
    this.ensure(target.appId);
    setTimeout(() => this.flushDeliveries(target.appId), DELIVERY_DELAY + 50);
    return d;
  }

  async onMessage(e) {
    let id = null, f = null;
    for (const [fid, fr] of this.frames) if (fr.iframe.contentWindow === e.source) { id = fid; f = fr; break; }
    if (!id) return;
    const m = e.data;
    if (!m || m.__hub !== 1 || typeof m.method !== "string") return;
    const reply = (result, error) => {
      if (!m.id) return;
      e.source.postMessage({ __hub: 1, reply: m.id, result, error: error ? String(error.message || error) : undefined }, "*");
    };
    const p = m.params || {};
    try {
      switch (m.method) {
        case "data.get": reply(await core.get(id, String(p.key))); break;
        case "data.set":
        case "data.remove": {
          const job = f.queue.then(() => m.method === "data.set" ? core.set(id, String(p.key), p.value) : core.remove(id, String(p.key)));
          f.queue = job.catch(() => {});
          try { await job; reply(true); }
          catch (err) {
            this.toast(`«${this.name(id)}»: не сохранилось — ${err.message || err}`, { tone: "danger", icon: "circle-alert", timeout: 8000 });
            reply(undefined, err);
          }
          break;
        }
        case "inbox.add": {
          const item = this.state.add(p.text, { tags: Array.isArray(p.tags) ? p.tags : [], source: id });
          reply(item ? { id: item.id } : null);
          break;
        }
        case "inbox.ready": f.inboxReady = true; this.flushDeliveries(id); break;
        case "inbox.ack": {
          const d = this.state.cancelDelivery(String(p.id));
          if (d && p.ok === false) {
            this.state.restore(d.item);
            this.toast(`«${this.name(id)}» не приняло элемент — он вернулся в корзину`, { tone: "warning", icon: "triangle-alert", timeout: 6000 });
          }
          break;
        }
        case "today.set": this.state.setCard(id, p.card && typeof p.card === "object" ? sanitizeCard(p.card) : null); if (this.onCard) this.onCard(id); reply(true); break;
        case "calendar.permissions": {
          if (id !== "calendar" || this.apps.get(id)?.source !== "builtin") throw new Error("Доступно встроенному календарю");
          const request = this.active === id && ["notifications", "exact"].includes(p.request) ? p.request : "";
          reply(await core.calendarPermissions(request));
          break;
        }
        case "notify": {
          const text = String(p.text || ""), title = String(p.title || "");
          const visible = document.visibilityState === "visible" && await core.windowFocused();
          if (visible) this.toast(title ? `${title}: ${text}` : text, { icon: "bell", tone: p.tone || "" });
          else await core.notify(title || this.name(id), text);
          reply(true);
          break;
        }
        case "hotkey": this.onHotkey(String(p.key || "")); break;
        case "activity": this.onActivity(); break;
        default: reply(undefined, new Error(`нет такой функции: ${m.method}`));
      }
    } catch (err) {
      console.error(err);
      reply(undefined, err);
    }
  }
}

/* карточка — только данные, без разметки: хаб рисует её сам */
function sanitizeCard(c) {
  const str = (v, n) => (v == null ? undefined : String(v).slice(0, n));
  const out = { main: str(c.main, 200) || "", note: str(c.note, 300), done: !!c.done };
  if (c.action && c.action.label) out.action = { label: str(c.action.label, 40), open: str(c.action.open, 100) };
  if (Array.isArray(c.list)) out.list = c.list.slice(0, 12).map(x => ({ text: str(x && x.text, 120) || "", done: !!(x && x.done) }));
  return out;
}
