/* state.js — собственные данные хаба: корзина, доставки в приложения, карточки «Сегодня», настройки.
   Всё лежит в пространстве имён "hub": inbox/<id>, deliveries/<id>, cards/<приложение>, settings,
   settings-local (не синхронизируется). По ключу на элемент — чтобы правки с двух устройств
   сливались, а не затирали друг друга. Записи по одному ключу идут строго по очереди. */
import { core } from "./core.js";

const NS = "hub";
const queues = new Map();
function persist(key, value, revisions) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(async () => {
    const basis = revisions.get(key) || {};
    const saved = value === undefined ? await core.remove(NS, key, basis) : await core.set(NS, key, value, basis);
    if (saved && typeof saved === "object") revisions.set(key, saved);
  });
  queues.set(key, next.catch(() => {}));
  return next;
}

export let DEVICE = "pc";
export function setDevice(d) { DEVICE = d || "pc"; }
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const tagsOf = text => [...new Set((String(text).match(/(^|\s)#([\p{L}\p{N}_-]+)/gu) || []).map(t => t.trim().slice(1).toLowerCase()))];

export class HubState extends EventTarget {
  constructor() {
    super();
    this.items = [];        // корзина: { id, text, created, device, tags, source?, snoozeUntil? }
    this.deliveries = [];   // { id, appId, type, label, item, notBefore }
    this.cards = {};        // приложение → карточка на «Сегодня»
    this.settings = { theme: "forest" };
    this.local = { autolock: 15 };   // настройки только этого устройства
    this.conflicts = [];             // { id, ns, key, ts, dev, value, note }
    this.revisions = new Map();
    this.resolved = new Map();
    this.folders = [];               // описания помеченных папок (общие для устройств)
    this.themes = [];                // свои темы (themes/<id>)
    this.onError = null;
  }
  async load() {
    const { json, basis } = await core.dump(NS);
    this.revisions = new Map(Object.entries(basis || {}));
    this.items = []; this.deliveries = []; this.cards = {}; this.conflicts = []; this.folders = []; this.themes = [];
    for (const [k, v] of Object.entries(json)) {
      if (!v) continue;
      if (k.startsWith("inbox/")) this.items.push(v);
      else if (k.startsWith("deliveries/")) this.deliveries.push(v);
      else if (k.startsWith("cards/")) this.cards[k.slice(6)] = v;
      else if (k.startsWith("conflicts/")) {
        const id = k.slice(10);
        if (this.resolved.has(id)) {
          if (this.resolved.get(id) === JSON.stringify(v.basis)) continue;
          this.resolved.delete(id);
        }
        this.conflicts.push(Object.assign({ id }, v));
      }
      else if (k.startsWith("sync-folders/")) this.folders.push(v);
      else if (k.startsWith("themes/") && !k.slice(7).includes("/")) this.themes.push(Object.assign({}, v, { id: k.slice(7), custom: true }));
    }
    this.settings = Object.assign({ theme: "forest" }, json.settings || {});
    this.local = Object.assign({ autolock: 15 }, json["settings-local"] || {});
    // этап 1 хранил корзину и доставки одним списком — разложить по ключам
    for (const [old, prefix, list] of [["inbox", "inbox/", this.items], ["deliveries", "deliveries/", this.deliveries]]) {
      if (!Array.isArray(json[old])) continue;
      for (const x of json[old]) if (x && x.id && !list.some(y => y.id === x.id)) { list.push(x); await core.set(NS, prefix + x.id, x); }
      await core.remove(NS, old);
    }
    for (const id of this.resolved.keys()) if (!json[`conflicts/${id}`]) this.resolved.delete(id);
    this.conflicts.sort((a, b) => (b.at || 0) - (a.at || 0));
  }
  changed(what) { this.dispatchEvent(new CustomEvent("change", { detail: what })); }
  save(key, value) {
    return persist(key, value, this.revisions).catch(e => { if (this.onError) this.onError(e); throw e; });
  }
  saveItem(item) { return this.save(`inbox/${item.id}`, item); }
  dropItem(id) { return this.save(`inbox/${id}`, undefined); }

  /* корзина */
  visibleItems(now = Date.now()) {
    return this.items.filter(i => !i.snoozeUntil || Date.parse(i.snoozeUntil) <= now)
      .sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
  }
  nextSnoozeEnd(now = Date.now()) {
    const t = this.items.map(i => i.snoozeUntil && Date.parse(i.snoozeUntil)).filter(x => x && x > now);
    return t.length ? Math.min(...t) : null;
  }
  add(text, { tags = [], source = null } = {}) {
    text = String(text || "").trim();
    if (!text) return null;
    const item = { id: uid(), text, created: new Date().toISOString(), device: DEVICE,
                   tags: [...new Set([...tagsOf(text), ...tags.map(t => String(t).toLowerCase())])] };
    if (source) item.source = source;
    this.items.push(item);
    this.saveItem(item);
    this.changed("inbox");
    return item;
  }
  take(id) {
    const i = this.items.findIndex(x => x.id === id);
    if (i < 0) return null;
    const [item] = this.items.splice(i, 1);
    this.dropItem(id);
    this.changed("inbox");
    return item;
  }
  restore(item) {
    if (!item || this.items.some(x => x.id === item.id)) return;
    this.items.push(item);
    this.saveItem(item);
    this.changed("inbox");
  }
  snooze(id, until) {
    const item = this.items.find(x => x.id === id);
    if (!item) return null;
    const before = item.snoozeUntil || null;
    item.snoozeUntil = until.toISOString();
    this.saveItem(item);
    this.changed("inbox");
    return before;
  }
  unsnooze(id, before) {
    const item = this.items.find(x => x.id === id);
    if (!item) return;
    if (before) item.snoozeUntil = before; else delete item.snoozeUntil;
    this.saveItem(item);
    this.changed("inbox");
  }

  /* доставки: элемент ушёл из корзины, но приложение его ещё не забрало */
  deliver(item, target, delayMs) {
    const d = { id: uid(), appId: target.appId, type: target.type, label: target.label, item,
                notBefore: new Date(Date.now() + delayMs).toISOString() };
    this.deliveries.push(d);
    this.save(`deliveries/${d.id}`, d);
    this.changed("deliveries");
    return d;
  }
  cancelDelivery(id) {
    const i = this.deliveries.findIndex(d => d.id === id);
    if (i < 0) return null;
    const [d] = this.deliveries.splice(i, 1);
    this.save(`deliveries/${id}`, undefined);
    this.changed("deliveries");
    return d;
  }

  /* карточки «Сегодня» */
  setCard(appId, card) {
    if (card) this.cards[appId] = card; else delete this.cards[appId];
    this.save(`cards/${appId}`, card || undefined);
    this.changed("cards");
  }

  setSetting(key, value) {
    this.settings[key] = value;
    this.save("settings", this.settings);
    this.changed("settings");
  }
  setLocal(key, value) {
    this.local[key] = value;
    this.save("settings-local", this.local);
    this.changed("settings");
  }

  /* конфликты синхронизации: вернуть проигравшую версию или забыть о ней */
  async restoreConflict(id, stamp) {
    const c = this.conflicts.find(x => x.id === id);
    if (!c) throw new Error("Конфликт уже закрыт");
    if (c.variants) {
      const version = c.variants.find(v => JSON.stringify([v.ts, v.dev]) === stamp);
      if (!version) throw new Error("Конфликт изменился. Выберите версию снова.");
      if (version.del) await core.remove(c.ns, c.key, c.basis);
      else {
        const value = version.blob ? await core.conflictBlob(id, version.blob, version.mime) : version.json;
        await core.set(c.ns, c.key, value, c.basis);
      }
      this.resolved.set(id, JSON.stringify(c.basis));
      this.conflicts = this.conflicts.filter(x => x.id !== id);
      this.changed("conflicts");
      return c;
    }
    if (c.value === null || c.value === undefined) await core.remove(c.ns, c.key);
    else await core.set(c.ns, c.key, c.value);
    await this.dropConflict(id);
    return c;
  }
  async dropConflict(id) {
    this.conflicts = this.conflicts.filter(x => x.id !== id);
    await this.save(`conflicts/${id}`, undefined);
    this.changed("conflicts");
  }
}
