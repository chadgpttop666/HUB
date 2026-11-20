/* state.js — собственные данные хаба: корзина, доставки в приложения, карточки «Сегодня», настройки.
   Всё лежит в пространстве имён "hub" — на диске это <папка данных>/hub/…: inbox.json, deliveries.json,
   settings.json, cards/<приложение>.json. Записи по одному ключу идут строго по очереди. */
import { core } from "./core.js";

const NS = "hub";
const queues = new Map();
function persist(key, value) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(() => (value === undefined ? core.remove(NS, key) : core.set(NS, key, value)));
  queues.set(key, next.catch(() => {}));
  return next;
}

export const DEVICE = "pc";
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const tagsOf = text => [...new Set((String(text).match(/(^|\s)#([\p{L}\p{N}_-]+)/gu) || []).map(t => t.trim().slice(1).toLowerCase()))];

export class HubState extends EventTarget {
  constructor() {
    super();
    this.items = [];        // корзина: { id, text, created, device, tags, source?, snoozeUntil? }
    this.deliveries = [];   // { id, appId, type, label, item, notBefore }
    this.cards = {};        // приложение → карточка на «Сегодня»
    this.settings = { theme: "forest" };
    this.onError = null;
  }
  async load() {
    const { json } = await core.dump(NS);
    this.items = Array.isArray(json.inbox) ? json.inbox : [];
    this.deliveries = Array.isArray(json.deliveries) ? json.deliveries : [];
    this.settings = Object.assign(this.settings, json.settings || {});
    for (const [k, v] of Object.entries(json)) if (k.startsWith("cards/") && v) this.cards[k.slice(6)] = v;
  }
  changed(what) { this.dispatchEvent(new CustomEvent("change", { detail: what })); }
  save(key, value) {
    return persist(key, value).catch(e => { if (this.onError) this.onError(e); throw e; });
  }
  saveInbox() { return this.save("inbox", this.items); }
  saveDeliveries() { return this.save("deliveries", this.deliveries); }

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
    this.saveInbox();
    this.changed("inbox");
    return item;
  }
  take(id) {
    const i = this.items.findIndex(x => x.id === id);
    if (i < 0) return null;
    const [item] = this.items.splice(i, 1);
    this.saveInbox();
    this.changed("inbox");
    return item;
  }
  restore(item) {
    if (!item || this.items.some(x => x.id === item.id)) return;
    this.items.push(item);
    this.saveInbox();
    this.changed("inbox");
  }
  snooze(id, until) {
    const item = this.items.find(x => x.id === id);
    if (!item) return null;
    const before = item.snoozeUntil || null;
    item.snoozeUntil = until.toISOString();
    this.saveInbox();
    this.changed("inbox");
    return before;
  }
  unsnooze(id, before) {
    const item = this.items.find(x => x.id === id);
    if (!item) return;
    if (before) item.snoozeUntil = before; else delete item.snoozeUntil;
    this.saveInbox();
    this.changed("inbox");
  }

  /* доставки: элемент ушёл из корзины, но приложение его ещё не забрало */
  deliver(item, target, delayMs) {
    const d = { id: uid(), appId: target.appId, type: target.type, label: target.label, item,
                notBefore: new Date(Date.now() + delayMs).toISOString() };
    this.deliveries.push(d);
    this.saveDeliveries();
    this.changed("deliveries");
    return d;
  }
  cancelDelivery(id) {
    const i = this.deliveries.findIndex(d => d.id === id);
    if (i < 0) return null;
    const [d] = this.deliveries.splice(i, 1);
    this.saveDeliveries();
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
}
