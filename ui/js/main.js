/* main.js — оболочка хаба: «Сегодня», строка ввода, разбор корзины, панель приложений, настройки, клавиши. */
import { core, inTauri } from "./core.js";
import { HubState, tagsOf, setDevice, DEVICE } from "./state.js";
import { AppHost } from "./host.js";
import { runSetup, runLock } from "./lock.js";
import { renderSyncSettings, setSyncStatus, syncPill, syncStatus, updateSyncSettingsStatus } from "./syncui.js";
import { watchSecrets } from "./secret.js";
import { pickAndInstall, uninstall, watchDrops } from "./install.js";
import { themeEditor, greetingText } from "./themes.js";
import { openCommand } from "./command.js";
import { aiGuide, showAiPrompt } from "./help.js";

const H = window.HubUI;
const $ = sel => document.querySelector(sel);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const plural = (n, forms) => H.plural(n, forms);
const UNSORTED = ["неразобранная", "неразобранные", "неразобранных"];
const html = document.documentElement;

const state = new HubState();
let host = null;
let themes = [];
let view = { name: "today", app: null };

/* ───────── даты ───────── */
const fmtLong = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" });
const fmtDayMonth = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });
const hm = d => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
const dayStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
function whenText(iso) {
  const d = new Date(iso), now = new Date();
  const days = Math.round((dayStart(now) - dayStart(d)) / 864e5);
  if (days === 0) return `сегодня, ${hm(d)}`;
  if (days === 1) return `вчера, ${hm(d)}`;
  if (days === -1) return `завтра, ${hm(d)}`;
  const dm = fmtDayMonth.format(d) + (d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : "");
  return `${dm}, ${hm(d)}`;
}
function ms(token) {
  if (H.reducedMotion()) return 0;
  const v = getComputedStyle(html).getPropertyValue(token).trim();
  return v.endsWith("ms") ? parseFloat(v) : v.endsWith("s") ? parseFloat(v) * 1000 : 0;
}
const wait = t => new Promise(r => setTimeout(r, t));

/* ───────── уведомления ───────── */
function toast(text, opts) { return H.toast(text, opts); }
state.onError = e => toast(`Не сохранилось: ${e.message || e}`, { tone: "danger", icon: "circle-alert", timeout: 8000 });

/* ───────── темы ───────── */
const THEME_IDS = ["forest", "mist", "solid"];
async function loadThemes() {
  themes = [];
  for (const id of THEME_IDS) {
    try { themes.push(await (await fetch(`hub/themes/${id}/theme.json`)).json()); }
    catch (e) { console.warn("тема не загрузилась", id, e); }
  }
  if (!themes.length) themes.push({ id: "forest", name: "Лес", base: "dark", photo: null, tokens: {} });
}
const cached = k => { try { return localStorage.getItem(k); } catch { return null; } };
const allThemes = () => (unlocked ? themes.concat(state.themes || []) : themes);
function currentTheme() {
  const id = unlocked ? state.settings.theme : cached("hub:theme");
  const t = allThemes().find(x => x.id === id);
  if (t) return t;
  // своя тема до входа недоступна (её фото зашифровано) — встроенная той же основы
  const base = cached("hub:theme-base");
  return themes.find(x => x.base === base && x.photo) || themes[0];
}
let unlocked = false;
const customPhotos = new Map();   // id своей темы → blob: URL её фото
async function loadCustomPhotos() {
  for (const t of state.themes || []) {
    if (customPhotos.has(t.id) || !t.photo) continue;
    try { const b = await core.get("hub", `themes/${t.id}/photo`); if (b instanceof Blob) customPhotos.set(t.id, URL.createObjectURL(b)); }
    catch (e) { console.warn("фото темы не открылось", t.id, e); }
  }
}
// url() внутри переменной разрешается относительно hub.css, где она используется, поэтому адрес — абсолютный
const themePhoto = t => {
  if (t.custom) return customPhotos.has(t.id) ? `url('${customPhotos.get(t.id)}')` : "none";
  return t.photo ? `url('${new URL(`hub/themes/${t.id}/${t.photo}`, location.href).href}')` : "none";
};
function themePayload() { const t = currentTheme(); return { id: t.id, name: t.name, base: t.base, tokens: t.tokens || {} }; }
let appliedTokens = {}, appliedTheme;
function applyTheme() {
  const t = currentTheme();
  const photo = themePhoto(t), position = t.photoPosition || "50% 38%";
  const next = JSON.stringify([t.id, t.base, t.name, t.tokens, photo, position]);
  if (appliedTheme !== next) {
    appliedTheme = next;
    html.dataset.theme = t.base || "dark";
    const tokens = t.tokens || {};
    for (const k of Object.keys(appliedTokens)) if (!(k in tokens)) html.style.removeProperty(`--${k}`);
    for (const [k, v] of Object.entries(tokens)) if (appliedTokens[k] !== v) html.style.setProperty(`--${k}`, v);
    appliedTokens = tokens;
    html.style.setProperty("--hub-photo", photo);
    html.style.setProperty("--hub-photo-pos", position);
    if (host) host.broadcastTheme();
  }
  try {
    if (unlocked) {
      localStorage.setItem("hub:theme", t.id); localStorage.setItem("hub:theme-base", t.base);
      localStorage.setItem("hub:greeting", t.greeting || "auto");
      if (typeof state.settings.name === "string") localStorage.setItem("hub:name", state.settings.name);
    }
  } catch { /* ничего */ }
}

/* ───────── экраны ───────── */
function showScreen(name) {
  if (name !== "shell" && host) host.show(null);
  $("#screen-today").hidden = name !== "today";
  $("#screen-triage").hidden = name !== "triage";
  $("#screen-shell").hidden = name !== "shell";
  $("#screen-apps").hidden = name !== "apps";
}
/* история — для системной кнопки «назад» на Android (и кнопок мыши) */
let fromHistory = false;
function remember() {
  html.dataset.view = view.name;
  renderNavbar();
  renderTitlebar();
  if (fromHistory) return;
  const s = { v: view.name, app: view.app || null };
  const cur = history.state;
  if (cur && cur.v === s.v && cur.app === s.app) return;
  history.pushState(s, "");
}
window.addEventListener("popstate", e => {
  if (!unlocked) return;
  const s = e.state || { v: "today" };
  fromHistory = true;
  try { if (s.v === "app" && s.app) openApp(s.app); else go(s.v === "app" ? "today" : s.v); }
  finally { fromHistory = false; }
});
/* заголовок окна: где мы, кнопки панелей, окно */
function renderTitlebar() {
  const place = view.name === "app" ? host.name(view.app) : view.name === "settings" ? "Настройки" : view.name === "triage" ? "Разбор корзины" : view.name === "apps" ? "Приложения" : "";
  $("#titlebar-place").textContent = place ? ` · ${place}` : "";
  const local = state.local || {};
  html.dataset.rail = local.rail ? "on" : "off";
  html.dataset.top = local.top ? "on" : "off";
  document.querySelectorAll("[data-panel]").forEach(b => b.setAttribute("aria-pressed", String(!!local[b.dataset.panel])));
}
function renderNavbar() {
  const nav = $("#navbar");
  if (!nav || !unlocked) { if (nav) nav.innerHTML = ""; return; }
  const n = state.visibleItems().length;
  const item = (go, icon, label, badge) => `<button class="hub-navbar__item" type="button" data-go="${go}"${view.name === go ? ' aria-current="page"' : ""}>
    <span class="hub-navbar__icon"><i data-icon="${icon}"></i>${badge ? `<span class="hub-navbar__badge">${badge > 99 ? "99+" : badge}</span>` : ""}</span>${label}</button>`;
  nav.innerHTML = item("today", "house", "Сегодня") + item("triage", "inbox", "Корзина", n) + item("apps", "layout-grid", "Приложения") + item("settings", "settings", "Настройки");
  H.icons(nav);
}
function renderApps() {
  const grid = $("#apps-grid");
  grid.innerHTML = appsInOrder().map(a => `<button class="shell-app-tile" type="button" data-open="${esc(a.id)}">
    <span class="hub-app-icon">${iconHTML(a.manifest.icon)}</span><span>${esc(a.manifest.name || a.id)}</span></button>`).join("")
    || `<p class="hub-muted">Приложений нет.</p>`;
  H.icons(grid);
}
function go(name) {
  closeSnoozeMenu();
  if (name === "back") { history.length > 1 ? history.back() : go("today"); return; }
  if (name === "apps") { view = { name: "apps", app: null }; showScreen("apps"); renderApps(); remember(); return; }
  if (name === "today") { view = { name: "today", app: null }; showScreen("today"); renderToday(); remember(); if (!isPhone()) focusCapture(); }
  else if (name === "triage") startTriage();
  else if (name === "sync") { go("settings"); $("#sync")?.scrollIntoView({ block: "start" }); }
  else if (name === "lock") lockNow();
  else if (name === "settings") {
    view = { name: "settings", app: null };
    showScreen("shell"); host.show(null);
    $("#settings").hidden = false;
    $("#appbar-title").textContent = "Настройки";
    renderRail(); renderSettings(); remember();
  }
}
const phoneMQ = window.matchMedia("(max-width: 600px)");
const isPhone = () => phoneMQ.matches;
function phoneCapture() {
  const f = $("#capture-main");
  f.classList.toggle("hub-capture--phone", isPhone());
  const send = f.querySelector(".hub-capture__send");
  if (isPhone()) { send.innerHTML = H.icon("arrow-up", { label: "В корзину" }); }
  else if (!send.textContent.trim()) send.textContent = "В корзину";
  document.querySelectorAll(".hub-card").forEach(c => c.classList.toggle("hub-card--compact", isPhone()));
}
phoneMQ.addEventListener("change", () => { phoneCapture(); if (unlocked && view.name === "today") renderToday(); });
function openApp(id, action) {
  if (!host.apps.has(id)) return;
  recentApps.splice(0, recentApps.length, id, ...recentApps.filter(x => x !== id).slice(0, 5));
  closeSnoozeMenu();
  view = { name: "app", app: id };
  showScreen("shell"); $("#settings").hidden = true;
  host.show(id, action);
  $("#appbar-title").textContent = host.name(id);
  renderRail(); remember();
  requestAnimationFrame(() => host.focus(id));
}
/* порядок в меню — свой (настройки → приложения, ↑↓); он же задаёт Alt+1…9 */
function appsInOrder() {
  const order = Array.isArray(state.settings.appOrder) ? state.settings.appOrder : [];
  const list = host.list();
  const pos = (a, i) => { const k = order.indexOf(a.id); return k < 0 ? order.length + i : k; };
  return list.map((a, i) => [a, pos(a, i)]).sort((x, y) => x[1] - y[1]).map(x => x[0]);
}
function moveApp(id, d) {
  const ids = appsInOrder().map(a => a.id);
  const i = ids.indexOf(id), j = i + d;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  state.setSetting("appOrder", ids);
  renderRail();
  if (view.name === "settings") renderSettings();
}
const recentApps = [];

function iconHTML(icon, cls) {
  icon = icon || "package";
  if (/\.svg$/i.test(icon)) return `<i data-icon="package"${cls ? ` class="${cls}"` : ""}></i>`;
  return `<i data-icon="${esc(icon)}"${cls ? ` class="${cls}"` : ""}></i>`;
}

/* ───────── «Сегодня» ───────── */
/* имя — в общих настройках (синхронизируется); копия в localStorage нужна экрану входа */
function userName() {
  if (unlocked && typeof state.settings.name === "string") return state.settings.name;
  try { return localStorage.getItem("hub:name") || ""; } catch { return ""; }
}
function renderHello() {
  const now = new Date(), name = userName();
  for (const id of ["today", "triage"]) {
    $(`#${id}-hello`).textContent = greetingText(currentTheme().greeting, name, now);
    $(`#${id}-date`).textContent = fmtLong.format(now);
  }
  renderSyncPills();
}
function renderSyncPills() {
  const conflicts = (state.conflicts || []).length;
  for (const [sel, compact] of [["#today-sync", isPhone()], ["#shell-sync", true], ["#appbar-sync", true], ["#titlebar-sync", true]]) {
    const el = $(sel);
    if (!el) continue;
    el.innerHTML = syncPill(conflicts, compact);
    H.icons(el);
  }
}
function cardHTML(c) {
  const list = c.list || null;
  const action = c.action && !c.done ? c.action : null;
  return `<article class="hub-card shell-open-card${isPhone() ? " hub-card--compact" : ""}${c.done ? " hub-card--done" : ""}" data-card="${esc(c.key)}">
    <div class="hub-card__app">${iconHTML(c.icon)}<span>${esc(c.name)}</span></div>
    ${c.loading
      ? `<div class="shell-card-skeleton"><div class="hub-skeleton hub-skeleton--title"></div><div class="hub-skeleton hub-skeleton--text"></div></div>`
      : `<div class="hub-card__main">${esc(c.main)}</div>`}
    ${c.note ? `<p class="hub-card__note">${esc(c.note)}</p>` : ""}
    ${list ? `<ul class="hub-card__list">${list.slice(0, 4).map(x =>
      `<li><label class="hub-check${x.done ? " hub-check--done" : ""}"><input type="checkbox" tabindex="-1" ${x.done ? "checked" : ""} onclick="return false"><span>${esc(x.text)}</span></label></li>`).join("")}</ul>
      ${list.length > 4 ? `<p class="hub-card__more">ещё ${list.length - 4}</p>` : ""}` : ""}
    <div class="${action ? "hub-card__action" : ""}"><button class="${action ? "hub-btn hub-btn--sm" : "shell-card__action--hidden"} shell-card__action" type="button" data-card-action="${esc(c.key)}" aria-label="${esc(action ? `${action.label} — ${c.name}` : `Открыть «${c.name}»`)}">${action ? esc(action.label) : ""}</button></div>
  </article>`;
}
function inboxCard() {
  const items = state.visibleItems(), snoozed = state.items.length - items.length;
  const last = items[items.length - 1];
  const short = s => (s.length > 42 ? s.slice(0, 41).trimEnd() + "…" : s);
  if (!items.length) {
    return { key: "inbox", icon: "inbox", name: "Корзина", main: "Пусто", done: true,
             note: snoozed === 1 ? "1 отложена — вернётся сама" : snoozed ? `${plural(snoozed, ["отложена", "отложены", "отложено"])} — вернутся сами` : "всё разобрано" };
  }
  return { key: "inbox", icon: "inbox", name: "Корзина", main: plural(items.length, UNSORTED),
           note: `последнее: «${short(last.text)}»${snoozed ? ` · ещё ${snoozed} отложено` : ""}`,
           action: { label: "Разобрать" } };
}
function appCard(a) {
  const card = state.cards[a.id];
  const base = { key: a.id, icon: a.manifest.icon, name: a.manifest.name || a.id };
  if (card) return Object.assign(base, card, { action: card.action || (card.done ? null : { label: "Открыть" }) });
  if (a.manifest.card) return Object.assign(base, { loading: true, action: { label: "Открыть" } });
  return Object.assign(base, { main: a.manifest.description || "Открыть приложение", action: { label: "Открыть" } });
}
const cardMarkup = new WeakMap();
function renderToday() {
  renderHello();
  const cards = [inboxCard(), ...appsInOrder().map(appCard)];
  const box = $("#today-cards");
  const existing = new Map([...box.children].map(el => [el.dataset.card, el]));
  const template = document.createElement("template");
  let next = box.firstElementChild;
  for (const card of cards) {
    const markup = cardHTML(card);
    const old = existing.get(card.key);
    existing.delete(card.key);
    let el = old;
    if (!el || cardMarkup.get(el) !== markup) {
      template.innerHTML = markup;
      el = template.content.firstElementChild;
      cardMarkup.set(el, markup);
      H.icons(el);
      if (old === next && old) { old.replaceWith(el); next = el; }
      else old?.remove();
    }
    if (el !== next) box.insertBefore(el, next);
    next = el.nextElementSibling;
  }
  existing.forEach(el => el.remove());
  const note = $("#today-note");
  const allDone = cards.every(c => c.done);
  note.hidden = !allDone;
  if (allDone) note.textContent = "На сегодня всё.";
}

function bumpInboxCard() {
  const el = document.querySelector('[data-card="inbox"]');
  if (!el) return;
  el.classList.remove("is-bumped"); void el.offsetWidth; el.classList.add("is-bumped");
  el.addEventListener("animationend", () => el.classList.remove("is-bumped"), { once: true });
}

/* ───────── строка ввода ───────── */
let lastAdded = null;
function setupCapture(form) {
  const input = form.querySelector(".hub-capture__input");
  const send = form.querySelector(".hub-capture__send");
  const note = form.querySelector(".hub-capture__note");
  const compact = form.classList.contains("hub-capture--compact");
  const idle = compact ? "" : "Enter — сохранить, разобрать можно потом";
  let okTimer = null;
  function showIdle() {
    note.classList.remove("is-ok");
    const tags = tagsOf(input.value);
    if (tags.length) note.innerHTML = `<span>метки:</span>${tags.map(t => `<span class="hub-tag">#${esc(t)}</span>`).join("")}`;
    else note.textContent = idle;
  }
  input.addEventListener("input", () => {
    send.disabled = !input.value.trim();
    if (okTimer) { clearTimeout(okTimer); okTimer = null; }
    showIdle();
  });
  form.addEventListener("submit", e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) { note.textContent = "Напишите мысль и нажмите Enter"; return; }
    const item = state.add(text);
    if (!item) return;
    lastAdded = item.id;
    input.value = ""; send.disabled = true;
    const n = state.visibleItems().length;
    if (compact) {
      toast(`В корзине — ${plural(n, UNSORTED)}`, { icon: "check", tone: "accent", action: "Отменить", onAction: undoCapture, timeout: 2600 });
      return;
    }
    clearTimeout(okTimer);
    note.classList.add("is-ok");
    note.innerHTML = `${H.icon("check")}<span>В корзине — ${esc(plural(n, UNSORTED))} · <kbd class="hub-kbd">Ctrl</kbd><kbd class="hub-kbd">Z</kbd> — отменить</span>`;
    okTimer = setTimeout(() => { okTimer = null; showIdle(); }, 2600);
    bumpInboxCard();
  });
  input.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ" && !input.value && lastAdded) {
      e.preventDefault();
      undoCapture();
      clearTimeout(okTimer); okTimer = null;
      note.classList.remove("is-ok"); note.textContent = "Убрано из корзины";
      okTimer = setTimeout(() => { okTimer = null; showIdle(); }, 2600);
    } else if (e.key === "Escape" && view.name === "app") {
      input.blur(); host.focus(view.app);
    }
  });
  showIdle();
}
function undoCapture() {
  if (!lastAdded) return;
  const item = state.take(lastAdded);
  lastAdded = null;
  return item;
}
function focusCapture() {
  if (view.name === "triage") { go("today"); return; }
  if (view.name !== "today" && !(state.local && state.local.top)) {
    // строка ввода спрятана — показать на время ввода
    html.dataset.topPeek = "1";
    const input = $("#capture-compact .hub-capture__input");
    input.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== input) delete html.dataset.topPeek; }, 150), { once: true });
  }
  const input = view.name === "today" ? $("#capture-main .hub-capture__input") : $("#capture-compact .hub-capture__input");
  const delay = view.name === "today" && !H.reducedMotion() ? 30 : 0;
  setTimeout(() => input.focus(), delay);
}

/* ───────── панель приложений ───────── */
function renderRail() {
  const n = state.visibleItems().length;
  const cur = (name, app) => (view.name === name && (!app || view.app === app) ? ' aria-current="page"' : "");
  $("#rail").innerHTML = `
    <button class="hub-rail__item" type="button" data-go="today" title="Сегодня" aria-label="Сегодня"><i data-icon="house"></i></button>
    <button class="hub-rail__item" type="button" data-go="triage" title="Корзина" aria-label="Корзина${n ? `, ${n}` : ""}"><i data-icon="inbox"></i>${n ? `<span class="hub-rail__badge">${n > 99 ? "99+" : n}</span>` : ""}</button>
    <div class="hub-rail__sep"></div>
    ${appsInOrder().map((a, i) => `<button class="hub-rail__item" type="button" data-open="${esc(a.id)}"
        title="${esc(a.manifest.name || a.id)}${i < 9 ? ` · Alt+${i + 1}` : ""}" aria-label="${esc(a.manifest.name || a.id)}"${cur("app", a.id)}>${iconHTML(a.manifest.icon)}</button>`).join("")}
    <div class="hub-rail__end"><button class="hub-rail__item" type="button" data-go="settings" title="Настройки" aria-label="Настройки"${cur("settings")}><i data-icon="settings"></i></button></div>`;
  H.icons($("#rail"));
}

/* ───────── разбор корзины ───────── */
const tri = { pos: 0, busy: false, stats: { moved: 0, snoozed: 0, deleted: 0 }, menu: null };
function startTriage() {
  view = { name: "triage", app: null };
  tri.pos = 0; tri.busy = false; tri.stats = { moved: 0, snoozed: 0, deleted: 0 }; tri.menu = null;
  showScreen("triage");
  remember();
  renderHello();
  renderTriage();
}
function triageTargets() { return host.targets().slice(0, 9); }
function originHTML(item) {
  if (item.source) return `${iconHTML((host.apps.get(item.source) || { manifest: {} }).manifest.icon, "hub-icon--sm")}из «${esc(host.name(item.source))}»`;
  const phone = String(item.device || "").startsWith("phone");
  const here = item.device === DEVICE || (item.device === "pc" && DEVICE.startsWith("pc"));
  if (phone) return `${iconHTML("smartphone", "hub-icon--sm")}${here ? "с этого телефона" : "с телефона"}`;
  return `${iconHTML("monitor", "hub-icon--sm")}${here ? "с этого ПК" : "с другого ПК"}`;
}
function renderTriage() {
  const el = $("#triage");
  const items = state.visibleItems();
  if (!items.length) {
    const s = tri.stats, parts = [];
    if (s.moved) parts.push(`${s.moved} перенесено`);
    if (s.snoozed) parts.push(`${s.snoozed} отложено`);
    if (s.deleted) parts.push(`${s.deleted} удалено`);
    const waiting = state.items.length;
    el.innerHTML = `<div class="hub-glass" style="margin-top:8vh"><div class="hub-empty" style="padding:var(--space-12) var(--space-6)">
      <i data-icon="inbox" class="hub-empty__icon"></i>
      <h2 class="hub-empty__title">Корзина пуста</h2>
      <p class="hub-empty__text">Всё разобрано${parts.length ? `: ${parts.join(", ")}` : ""}.${waiting ? ` Отложенные вернутся сами.` : ""}
        Новая мысль — <kbd class="hub-kbd">Ctrl</kbd><kbd class="hub-kbd">Alt</kbd><kbd class="hub-kbd">Пробел</kbd> из любой программы.</p>
      <div class="hub-empty__action"><button class="hub-btn hub-btn--primary" type="button" data-go="today">На «Сегодня» <kbd class="hub-kbd">Esc</kbd></button></div>
    </div></div>`;
    H.icons(el);
    return;
  }
  tri.pos = Math.min(Math.max(tri.pos, 0), items.length - 1);
  const item = items[tri.pos], targets = triageTargets();
  el.innerHTML = `
    <div class="hub-triage__head">
      <h1 class="hub-triage__title">Разбор корзины</h1>
      <div class="hub-meter" style="width:240px"><div class="hub-meter__head"><span>элемент</span><b>${tri.pos + 1} из ${items.length}</b></div>
        <progress class="hub-progress" max="${items.length}" value="${tri.pos + 1}"></progress></div>
    </div>
    <article class="hub-glass hub-triage__item" id="triage-item" data-id="${esc(item.id)}">
      <p class="hub-triage__text">${esc(item.text)}</p>
      <div class="hub-triage__meta"><span class="shell-row">${originHTML(item)}</span><span>${esc(whenText(item.created))}</span>${(item.tags || []).map(t => `<span class="hub-tag">#${esc(t)}</span>`).join("")}</div>
    </article>
    <div>
      <div class="hub-triage__label" style="margin-bottom:var(--space-3)">Куда перенести</div>
      ${targets.length ? `<div class="hub-targets">${targets.map((t, i) => `<button class="hub-target" type="button" data-target="${i}">
          ${iconHTML(t.icon)}<span class="hub-target__name">${esc(t.name)}</span><span class="hub-target__what">${esc(t.label)}</span><kbd class="hub-kbd">${i + 1}</kbd></button>`).join("")}</div>`
        : `<p class="hub-muted" style="margin:0">Пока ни одно приложение не принимает элементы корзины.</p>`}
    </div>
    <div class="hub-triage__actions">
      <button class="hub-btn" type="button" data-tri="snooze" aria-haspopup="listbox" aria-expanded="false"><i data-icon="alarm-clock"></i>Отложить <kbd class="hub-kbd">S</kbd></button>
      <button class="hub-btn hub-btn--danger" type="button" data-tri="delete"><i data-icon="trash-2"></i>Удалить <kbd class="hub-kbd">Del</kbd></button>
      <button class="hub-btn hub-btn--quiet" type="button" data-tri="skip">Пропустить <kbd class="hub-kbd">→</kbd></button>
    </div>
    <p class="hub-hint" style="justify-content:center">${targets.length > 1 ? `1–${targets.length} перенести · ` : targets.length ? "1 перенести · " : ""}S отложить · Del удалить · ← → листать · Esc выйти</p>`;
  H.icons(el);
}
function currentItem() { const items = state.visibleItems(); return items[Math.min(tri.pos, items.length - 1)] || null; }

async function leave(kind, targetEl) {
  const el = $("#triage-item");
  if (!el) return;
  if (kind === "move" && targetEl) {
    const a = el.getBoundingClientRect(), b = targetEl.getBoundingClientRect();
    el.style.setProperty("--dx", `${(b.left + b.width / 2) - (a.left + a.width / 2)}px`);
    el.style.setProperty("--dy", `${(b.top + b.height / 2) - (a.top + a.height / 2)}px`);
  } else el.style.setProperty("--dy", "8px");
  el.classList.add("is-leaving");
  await wait(kind === "move" ? ms("--duration-slow") : ms("--duration-base"));
}
async function moveTo(i) {
  const t = triageTargets()[i], item = currentItem();
  if (!t || !item || tri.busy) return;
  tri.busy = true;
  const tile = document.querySelector(`[data-target="${i}"]`);
  if (tile) tile.classList.add("is-chosen");
  await leave("move", tile);
  state.take(item.id);
  const d = host.transfer(item, t);
  tri.stats.moved++;
  tri.busy = false;
  renderTriage();
  toast(`Перенесено в «${t.name}»`, { tone: "accent", icon: "check", action: "Отменить", timeout: 4000, onAction: () => {
    if (state.cancelDelivery(d.id)) { state.restore(item); tri.stats.moved--; if (view.name === "triage") renderTriage(); }
    else toast(`«${t.name}» уже приняло элемент — отменить там`, { icon: "info" });
  } });
}
async function deleteCurrent() {
  const item = currentItem();
  if (!item || tri.busy) return;
  tri.busy = true;
  await leave("delete");
  state.take(item.id);
  tri.stats.deleted++;
  tri.busy = false;
  renderTriage();
  toast("Удалено", { icon: "trash-2", action: "Отменить", timeout: 4000, onAction: () => {
    state.restore(item); tri.stats.deleted--; if (view.name === "triage") renderTriage();
  } });
}
async function snoozeCurrent(until) {
  const item = currentItem();
  if (!item || tri.busy) return;
  closeSnoozeMenu();
  tri.busy = true;
  await leave("snooze");
  const before = state.snooze(item.id, until);
  tri.stats.snoozed++;
  tri.busy = false;
  renderTriage();
  toast(`Отложено до ${whenText(until.toISOString()).replace(/^сегодня, /, "")}`, { icon: "alarm-clock", action: "Отменить", timeout: 4000, onAction: () => {
    state.unsnooze(item.id, before); tri.stats.snoozed--; if (view.name === "triage") renderTriage();
  } });
}
function step(delta) {
  const n = state.visibleItems().length;
  if (!n || tri.busy) return;
  tri.pos = (tri.pos + delta + n) % n;
  renderTriage();
}

/* меню «Отложить до» */
function snoozeOptions(now = new Date()) {
  const at = (days, h) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(h, 0, 0, 0); return d; };
  const out = [];
  const evening = at(0, 19);
  if (evening - now > 30 * 60e3) out.push({ icon: "sunrise", label: "Сегодня вечером", meta: "19:00", at: evening });
  else out.push({ icon: "sunrise", label: "Завтра вечером", meta: "19:00", at: at(1, 19) });
  out.push({ icon: "sun", label: "Завтра утром", meta: "9:00", at: at(1, 9) });
  const week = at(7, 9);
  out.push({ icon: "calendar-days", label: "Через неделю", meta: fmtDayMonth.format(week), at: week });
  out.push({ icon: "calendar", label: "Выбрать дату…", pick: true });
  return out;
}
function openSnoozeMenu() {
  if (!currentItem() || tri.busy) return;
  const btn = document.querySelector('[data-tri="snooze"]');
  closeSnoozeMenu();
  tri.menu = { idx: 0, opts: snoozeOptions() };
  const ul = document.createElement("ul");
  ul.className = "hub-menu"; ul.id = "snooze-menu";
  ul.setAttribute("role", "listbox"); ul.setAttribute("aria-label", "Отложить до");
  ul.style.left = `${btn.offsetLeft}px`;
  btn.parentElement.appendChild(ul);
  btn.setAttribute("aria-expanded", "true");
  drawSnoozeMenu();
}
function drawSnoozeMenu() {
  const ul = $("#snooze-menu");
  if (!ul || !tri.menu) return;
  const { idx, opts } = tri.menu;
  ul.innerHTML = `<li class="hub-menu__label">Отложить до</li>` + opts.map((o, i) =>
    `${o.pick ? `<li class="hub-menu__sep" role="separator"></li>` : ""}<li class="hub-menu__item${i === idx ? " is-active" : ""}" role="option" aria-selected="${i === idx}" data-snooze="${i}">${iconHTML(o.icon)}${esc(o.label)}${o.meta ? `<span class="hub-menu__meta">${esc(o.meta)}</span>` : ""}</li>`).join("");
  H.icons(ul);
}
function closeSnoozeMenu() {
  const ul = $("#snooze-menu");
  if (ul) ul.remove();
  const btn = document.querySelector('[data-tri="snooze"]');
  if (btn) btn.setAttribute("aria-expanded", "false");
  tri.menu = null;
}
function chooseSnooze(i) {
  const o = tri.menu && tri.menu.opts[i];
  if (!o) return;
  if (o.pick) { closeSnoozeMenu(); pickDate(); return; }
  snoozeCurrent(o.at);
}
function pickDate() {
  const dlg = document.createElement("dialog");
  dlg.className = "hub-dialog";
  dlg.setAttribute("aria-labelledby", "pick-title");
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  dlg.innerHTML = `<form method="dialog">
    <h2 class="hub-dialog__title" id="pick-title">Отложить до</h2>
    <p class="hub-dialog__body">Элемент вернётся в корзину в этот день в 9:00.</p>
    <div class="hub-field" style="margin-top:var(--space-4)"><label class="hub-label" for="pick-date">Дата</label>
      <input class="hub-input" type="date" id="pick-date" required min="${iso(new Date())}" value="${iso(tomorrow)}"></div>
    <div class="hub-dialog__actions">
      <button class="hub-btn hub-btn--quiet" type="button" value="cancel">Отмена</button>
      <button class="hub-btn hub-btn--primary" type="submit" value="ok">Отложить</button>
    </div></form>`;
  document.body.appendChild(dlg);
  dlg.querySelector('[value="cancel"]').addEventListener("click", () => dlg.close("cancel"));
  dlg.addEventListener("close", () => {
    const v = dlg.querySelector("#pick-date").value, ok = dlg.returnValue === "ok";
    dlg.remove();
    if (!ok || !v) return;
    const [y, m, d] = v.split("-").map(Number);
    const at = new Date(y, m - 1, d, 9, 0, 0, 0);
    if (at <= new Date()) { toast("Это время уже прошло — выберите дату позже", { icon: "info" }); return; }
    snoozeCurrent(at);
  });
  dlg.showModal();
}

function triageKey(e) {
  if (e.target.closest && e.target.closest("dialog")) return;
  if (tri.menu) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = tri.menu.opts.length;
      tri.menu.idx = (tri.menu.idx + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      drawSnoozeMenu();
    } else if (e.key === "Enter") { e.preventDefault(); chooseSnooze(tri.menu.idx); }
    else if (e.key === "Escape") { e.preventDefault(); closeSnoozeMenu(); }
    return;
  }
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.key === "Escape") { e.preventDefault(); go("today"); return; }
  if (!state.visibleItems().length) return;
  if (/^Digit[1-9]$/.test(e.code) || /^Numpad[1-9]$/.test(e.code)) { e.preventDefault(); moveTo(Number(e.code.slice(-1)) - 1); }
  else if (e.code === "KeyS") { e.preventDefault(); openSnoozeMenu(); }
  else if (e.key === "Delete") { e.preventDefault(); deleteCurrent(); }
  else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
}

/* ───────── настройки ───────── */
function renderSettings() {
  const el = $("#settings");
  const syncPanel = $("#settings-sync");
  const keepConnection = !syncStatus.configured && !!syncPanel?.querySelector("#gc-id");
  const cur = currentTheme();
  const apps = appsInOrder();
  const keys = [
    [["Ctrl", "Alt", "Пробел"], "мысль в корзину из любой программы"],
    [["Ctrl", "Пробел"], "к строке ввода (или /, на «Сегодня»)"],
    [["Alt", "1…9"], "приложение по номеру"],
    [["Enter"], "в строке ввода — сохранить; Ctrl Z — отменить"],
    [["1…9", "S", "Del", "← →", "Esc"], "разбор корзины: перенести, отложить, удалить, листать, выйти"],
    [["Ctrl", "K"], "командная строка: приложение, команда или запись"],
    [["Ctrl", "L"], "заблокировать хаб"],
  ];
  el.innerHTML = `
    <div><h1 class="hub-page-title">Настройки</h1>
      <p class="hub-muted" style="margin:var(--space-1) 0 0">${syncStatus.configured ? "данные зашифрованы · синхронизация с Google Drive" : "данные зашифрованы · только на этом устройстве"}</p></div>
    <section class="shell-section"><h2 class="hub-section-title">Вы</h2>
      <label class="hub-field" style="max-width:360px"><span class="hub-label">Как к вам обращаться</span>
        <input class="hub-input" id="set-name" maxlength="40" value="${esc(userName())}" placeholder="Имя для приветствия"></label>
      <p class="hub-hint" style="margin-top:var(--space-3)">Видно в приветствии на «Сегодня» и на экране входа. Своё приветствие можно задать в теме.</p>
    </section>
    <section class="shell-section" id="settings-themes"><h2 class="hub-section-title">Тема</h2>
      <div class="hub-themes" role="radiogroup" aria-label="Тема">${allThemes().map(t => `
        <button class="hub-theme" type="button" role="radio" aria-checked="${t.id === cur.id}" data-theme-id="${esc(t.id)}">
          <div class="hub-theme__shot shell-theme-shot" data-theme="${esc(t.base)}"
            style="--hub-photo:${esc(themePhoto(t))};--hub-photo-pos:${esc(t.photoPosition || "50% 38%")}">
            <span class="shell-theme-preview__label">${iconHTML("lightbulb")}Мысль в корзину…</span>
          </div>
          <span class="hub-theme__name">${esc(t.name)}${t.id === cur.id ? `<i data-icon="check"></i>` : ""}</span>
          <span class="hub-theme__meta">${t.base === "light" ? "светлая" : t.base === "solid" ? "сплошной цвет" : "тёмная"}${t.custom ? " · своя" : ""}</span>
        </button>`).join("")}
        <button class="hub-theme hub-theme--new" type="button" data-act="theme-new"><i data-icon="image-plus" class="hub-icon--lg"></i><span>Новая тема</span><span class="hub-theme__meta">фото или сплошной цвет</span></button>
      </div>
      <button class="hub-btn hub-btn--sm" type="button" data-act="theme-copy"><i data-icon="copy"></i>Настроить копию выбранной темы</button>
      ${(state.themes || []).length ? `<div class="hub-btn-row" style="margin-top:var(--space-3)">${state.themes.map(t => `<button class="hub-btn hub-btn--sm" type="button" data-theme-edit="${esc(t.id)}"><i data-icon="pencil"></i>Изменить «${esc(t.name)}»</button><button class="hub-btn hub-btn--sm hub-btn--quiet" type="button" data-theme-remove="${esc(t.id)}"><i data-icon="trash-2"></i>Удалить</button>`).join("")}</div>` : ""}
      ${aiGuide("theme")}
    </section>
    <div id="settings-sync"></div>
    <section class="shell-section"><h2 class="hub-section-title">Приложения</h2>
      ${aiGuide("app")}
      <ul class="hub-list hub-list--divided hub-glass" style="padding:var(--space-1) var(--space-2)">${apps.map((a, i) => `
        <li><div class="hub-row">
          <span class="hub-row__lead">${iconHTML(a.manifest.icon)}</span>
          <button class="hub-row__body shell-row-open" type="button" data-open="${esc(a.id)}"><span class="hub-row__title">${esc(a.manifest.name || a.id)}</span>
            <span class="hub-row__meta">${esc([a.manifest.version ? `версия ${a.manifest.version}` : "", { user: "из папки приложений", installed: "установлено" }[a.source] || "встроено",
              (a.manifest.accepts || []).length ? `принимает: ${(a.manifest.accepts || []).map(x => x.label).join(", ")}` : "",
              (a.manifest.permissions && (a.manifest.permissions.network || []).length) ? "сеть" : ""].filter(Boolean).join(" · "))}</span></button>
          <span class="hub-row__trail">${i < 9 ? `<kbd class="hub-kbd">Alt</kbd><kbd class="hub-kbd">${i + 1}</kbd>` : ""}
            <button class="hub-btn hub-btn--sm hub-btn--quiet hub-btn--icon" type="button" data-app-move="${esc(a.id)}" data-d="-1" aria-label="Выше" title="Выше"${i === 0 ? " disabled" : ""}><i data-icon="arrow-up"></i></button>
            <button class="hub-btn hub-btn--sm hub-btn--quiet hub-btn--icon" type="button" data-app-move="${esc(a.id)}" data-d="1" aria-label="Ниже" title="Ниже"${i === apps.length - 1 ? " disabled" : ""}><i data-icon="arrow-down"></i></button>
            ${a.source === "installed" ? `<button class="hub-btn hub-btn--sm hub-btn--quiet hub-btn--icon" type="button" data-app-remove="${esc(a.id)}" aria-label="Удалить ${esc(a.manifest.name || a.id)}" title="Удалить"><i data-icon="trash-2"></i></button>` : ""}</span>
        </div></li>`).join("") || `<li class="hub-muted" style="padding:var(--space-3)">Приложений нет.</li>`}
      </ul>
      ${inTauri && platform !== "phone" ? `<div class="hub-btn-row" style="margin-top:var(--space-4)">
        <button class="hub-btn" type="button" data-act="install-folder"><i data-icon="folder-plus"></i>Установить из папки</button>
        <button class="hub-btn" type="button" data-act="install-zip"><i data-icon="file-archive"></i>Из zip</button></div>` : ""}
      <p class="hub-hint" style="margin-top:var(--space-3)">${platform === "phone" ? "Приложения ставятся на ПК и приезжают сюда с синхронизацией." : "Перетащите папку или ZIP в «Настройки», чтобы установить приложение."}</p>
    </section>
    <section class="shell-section" id="settings-pc" hidden></section>
    <section class="shell-section"><h2 class="hub-section-title">Данные</h2>
      <dl class="shell-kv">
        <dt>Папка данных</dt><dd data-info="dataDir">—</dd>
        <dt>Папка приложений</dt><dd data-info="appsDir">—</dd>
        <dt>Версия хаба</dt><dd data-info="version">—</dd>
      </dl>
      <p class="hub-hint" style="margin-top:var(--space-3)">Каждая запись — отдельный файл, зашифрованный ключом данных. Ключ открывается паролем или ключом восстановления.</p>
      ${inTauri ? `<div class="hub-btn-row" style="margin-top:var(--space-4)"><button class="hub-btn" type="button" data-act="open-data"><i data-icon="folder"></i>Открыть папку</button></div>` : ""}
    </section>
    <section class="shell-section"><h2 class="hub-section-title">Клавиши</h2>
      <dl class="shell-keys">${keys.map(([ks, what]) => `<dt>${ks.map(k => `<kbd class="hub-kbd">${esc(k)}</kbd>`).join(" ")}</dt><dd>${esc(what)}</dd>`).join("")}</dl>
    </section>`;
  H.icons(el);
  const nm = $("#set-name");
  nm.addEventListener("change", () => { if (nm.value.trim() === userName()) return; state.setSetting("name", nm.value.trim()); applyTheme(); renderHello(); toast("Сохранено", { icon: "check" }); });
  const syncSlot = $("#settings-sync");
  if (keepConnection) syncSlot.replaceWith(syncPanel);
  else renderSyncSettings(syncSlot, syncCtx());
  const infoFields = [...el.querySelectorAll("[data-info]")];
  core.info().then(info => {
    for (const field of infoFields) field.textContent = info[field.dataset.info] || "—";
  }).catch(() => {});
  if (inTauri && platform !== "phone") {
    const pc = $("#settings-pc");
    core.desktopPrefs().then(desk => {
      if (pc.isConnected) renderDesktopPrefs(pc, desk);
    }).catch(() => {});
  }
}
function renderDesktopPrefs(el, desk) {
  el.hidden = false;
  el.innerHTML = `<h2 class="hub-section-title">Этот компьютер</h2>
      <div style="display:grid;gap:var(--space-4)">
        <label class="hub-switch"><input type="checkbox" role="switch" id="pc-autostart"${desk.autostart ? " checked" : ""}><span>Открывать хаб при входе в Windows</span></label>
        <label class="hub-switch"><input type="checkbox" role="switch" id="pc-tray"${desk.closeToTray ? " checked" : ""}><span>Крестик прячет хаб в трей</span></label>
      </div>
      <p class="hub-hint" style="margin-top:var(--space-3)">${desk.closeToTray ? "Хаб остаётся в трее, и <kbd class=\"hub-kbd\">Ctrl</kbd><kbd class=\"hub-kbd\">Alt</kbd><kbd class=\"hub-kbd\">Пробел</kbd> открывает мини-окно поверх любой программы — даже когда хаб заперт: такая мысль запирается ключом этого компьютера и попадает в корзину после входа. Выйти — правой кнопкой по значку в трее." : "Крестик закрывает хаб совсем; Ctrl+Alt+Пробел работает, только пока хаб открыт."}</p>
`;
  for (const [sel, key] of [["#pc-autostart", "autostart"], ["#pc-tray", "closeToTray"]]) {
    const sw = el.querySelector(sel);
    sw.addEventListener("change", async () => {
      sw.disabled = true;
      try {
        await core.desktopSet({ [key]: sw.checked });
        desk[key] = sw.checked;
        toast("Сохранено", { icon: "check" });
        if (key === "closeToTray") renderDesktopPrefs(el, desk);
      } catch (err) {
        sw.checked = desk[key];
        toast(String(err.message || err), { tone: "danger", icon: "circle-alert" });
      } finally { sw.disabled = false; }
    });
  }
}

function syncCtx() {
  return {
    state, toast, platform,
    appName: ns => (ns === "hub" ? "Хаб" : host && host.apps.has(ns) ? host.name(ns) : ns),
    refresh: async () => { setSyncStatus(await core.syncStatus().catch(() => null)); await state.load(); if (view.name === "settings") renderSettings(); renderSyncPills(); },
    lockNow,
    afterRestore: c => { if (c && c.ns !== "hub" && host) host.reload(c.ns); state.load().then(() => { if (view.name === "settings") renderSettings(); }); },
  };
}

/* ───────── клавиши ───────── */
function hotkeyOf(e) {
  if (e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "Space") return "capture";
  if (e.ctrlKey && !e.altKey && e.code === "KeyK") return "command";
  if (e.ctrlKey && !e.altKey && e.code === "KeyL") return "lock";
  if (e.altKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code)) return "app:" + e.code.slice(5);
  return null;
}
function handleHotkey(k) {
  if (!unlocked) return;
  if (k === "capture") focusCapture();
  else if (k === "lock") lockNow();
  else if (k.startsWith("app:")) { const a = appsInOrder()[Number(k.slice(4)) - 1]; if (a) openApp(a.id); }
  else if (k === "command") openPalette();
}
function openPalette() {
  openCommand({
    apps: () => appsInOrder().map(a => ({ id: a.id, name: a.manifest.name || a.id, icon: a.manifest.icon })),
    items: () => state.visibleItems(),
    recent: () => recentApps,
    iconHTML: icon => iconHTML(icon),
    openApp: id => openApp(id),
    openItem: id => { startTriage(); const i = state.visibleItems().findIndex(x => x.id === id); if (i >= 0) { tri.pos = i; renderTriage(); } },
    capture: text => { const item = state.add(text); if (item) { lastAdded = item.id; toast(`В корзине — ${plural(state.visibleItems().length, UNSORTED)}`, { icon: "check", tone: "accent", action: "Отменить", onAction: undoCapture, timeout: 2600 }); } },
    commands: [
      { id: "capture", label: "Новая мысль", icon: "lightbulb", keys: ["Ctrl", "Пробел"], words: "корзина ввод", run: () => focusCapture() },
      { id: "today", label: "Сегодня", icon: "house", words: "главная", run: () => go("today") },
      { id: "triage", label: "Разобрать корзину", icon: "inbox", meta: plural(state.visibleItems().length, ["элемент", "элемента", "элементов"]), words: "разбор", run: () => go("triage") },
      ...(syncStatus.configured ? [{ id: "sync", label: "Синхронизировать сейчас", icon: "refresh-cw", words: "drive google", run: () => { core.syncNow(); toast("Синхронизация запущена", { icon: "refresh-cw" }); } }] : []),
      { id: "theme", label: "Сменить тему…", icon: "palette", words: "фон фото", run: () => { go("settings"); setTimeout(() => { const s = $("#settings-themes"); if (s) s.scrollIntoView({ block: "start" }); }, 80); } },
      ...(inTauri && platform !== "phone" ? [{ id: "install", label: "Установить приложение…", icon: "package", words: "zip папка", run: () => pickAndInstall("folder", installCtx()) }] : []),
      { id: "settings", label: "Настройки", icon: "settings", run: () => go("settings") },
      { id: "lock", label: "Заблокировать", icon: "lock", keys: ["Ctrl", "L"], words: "запереть", run: () => lockNow() },
    ],
  });
}
const isTyping = t => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
document.addEventListener("keydown", e => {
  if (!unlocked) return;
  const k = hotkeyOf(e);
  if (k) { e.preventDefault(); handleHotkey(k); return; }
  if (view.name === "triage") { triageKey(e); return; }
  if (view.name === "today" && e.key === "/" && !isTyping(e.target)) { e.preventDefault(); focusCapture(); return; }
  if (view.name === "settings" && e.key === "Escape" && !isTyping(e.target)) { go("today"); }
});

/* ───────── клики ───────── */
document.addEventListener("click", e => {
  const t = e.target.closest("[data-go],[data-open],[data-card-action],[data-target],[data-tri],[data-snooze],[data-theme-id],[data-act]");
  if (!t) { if (tri.menu && !e.target.closest("#snooze-menu")) closeSnoozeMenu(); return; }
  const d = t.dataset;
  if (d.go) go(d.go);
  else if (d.open) openApp(d.open);
  else if (d.cardAction) {
    if (d.cardAction === "inbox") go("triage");
    else { const c = state.cards[d.cardAction]; openApp(d.cardAction, c?.action); }
  }
  else if (d.target) moveTo(Number(d.target));
  else if (d.tri === "snooze") { tri.menu ? closeSnoozeMenu() : openSnoozeMenu(); }
  else if (d.tri === "delete") deleteCurrent();
  else if (d.tri === "skip") step(1);
  else if (d.snooze) chooseSnooze(Number(d.snooze));
  else if (d.themeId) { state.setSetting("theme", d.themeId); }
  else if (d.act === "open-data") core.openDataDir().catch(err => toast(`Не открылась: ${err.message || err}`, { tone: "danger" }));
  else if (d.act === "install-folder") pickAndInstall("folder", installCtx());
  else if (d.act === "install-zip") pickAndInstall("zip", installCtx());
  else if (d.act === "theme-new") themeEditor(themeCtx());
  else if (d.act === "theme-copy") editTheme(currentTheme(), true);
  else if (d.act === "ai-app" || d.act === "ai-theme") showAiPrompt(d.act.slice(3), toast);
});
document.addEventListener("click", async e => {
  const t = e.target.closest("[data-app-remove],[data-theme-remove],[data-theme-edit],[data-app-move]");
  if (!t || !unlocked) return;
  if (t.dataset.appMove) moveApp(t.dataset.appMove, Number(t.dataset.d));
  else if (t.dataset.themeEdit) editTheme(state.themes.find(x => x.id === t.dataset.themeEdit));
  else if (t.dataset.appRemove) { const a = host.apps.get(t.dataset.appRemove); if (a) uninstall(a, installCtx()); }
  else {
    const id = t.dataset.themeRemove;
    if (state.settings.theme === id) state.setSetting("theme", "forest");
    await core.removeTheme(id);
    if (customPhotos.has(id)) { URL.revokeObjectURL(customPhotos.get(id)); customPhotos.delete(id); }
    await state.load();
    if (view.name === "settings") renderSettings();
    toast("Тема удалена", { icon: "trash-2" });
  }
});
async function editTheme(theme, copy = false) {
  if (!theme) return;
  let photo;
  try {
    if (theme.photo) {
      if (theme.custom) photo = await core.get("hub", `themes/${theme.id}/photo`);
      else {
        const res = await fetch(`hub/themes/${theme.id}/${theme.photo}`);
        if (res.ok) photo = await res.blob();
      }
      if (!(photo instanceof Blob)) throw new Error("Фото ещё не загрузилось");
    }
    if (unlocked) themeEditor(themeCtx(), { theme, photo, copy });
  } catch (err) { toast(String(err.message || err), { tone: "warning", icon: "triangle-alert" }); }
}
function themeCtx() {
  return {
    toast, name: userName,
    afterSave: async id => {
      if (customPhotos.has(id)) { URL.revokeObjectURL(customPhotos.get(id)); customPhotos.delete(id); }
      await state.load(); await loadCustomPhotos();
      if (state.settings.theme === id) applyTheme(); else state.setSetting("theme", id);
      if (view.name === "settings") renderSettings();
      renderHello();
      toast("Тема сохранена", { tone: "success", icon: "circle-check" });
    },
  };
}
function installCtx() {
  return {
    toast,
    unlocked: () => unlocked,
    openApp: id => openApp(id),
    repetitionAt: pos => {
      if (!pos || view.app !== "repetition" || host.apps.get("repetition")?.source !== "builtin") return false;
      const el = document.elementFromPoint(pos.x / window.devicePixelRatio, pos.y / window.devicePixelRatio);
      return el?.matches('iframe[data-app="repetition"]') ? el : null;
    },
    importRepetition: (target, files) => {
      if (unlocked && host.frames.get("repetition")?.iframe === target) host.importRepetition(files);
    },
    afterInstall: async p => { await state.load(); await loadCustomPhotos(); await reloadApps(p?.kind === "app" ? p.id : null); },
  };
}
/* список приложений поменялся: установка, удаление, синхронизация с другого устройства */
async function reloadApps(updatedId) {
  if (!host) return;
  let list = [];
  try { list = await core.apps(); } catch (e) { console.error(e); return; }
  if (!unlocked) return;
  const ids = new Set(list.map(a => a.id));
  for (const id of host.frames.keys()) if (!ids.has(id)) host.remove(id);
  const changed = list.filter(a => {
    const old = host.apps.get(a.id);
    return a.id === updatedId || (old && (old.source !== a.source || JSON.stringify(old.manifest) !== JSON.stringify(a.manifest)));
  });
  host.apps.clear();
  host.setApps(list);
  for (const a of changed) host.reload(a.id);
  for (const a of host.list()) if (a.manifest.card || (a.manifest.accepts || []).length) host.ensure(a.id);
  host.flushAll();
  if (view.name === "app" && !host.apps.has(view.app)) go("today");
  else if (view.name === "today") renderToday();
  else if (view.name === "settings") renderSettings();
  else if (view.name === "apps") renderApps();
  renderRail();
}
/* кнопки заголовка: панели и окно */
document.addEventListener("click", e => {
  const p = e.target.closest("[data-panel]");
  if (p && unlocked) { state.setLocal(p.dataset.panel, !(state.local && state.local[p.dataset.panel])); renderTitlebar(); return; }
  const w = e.target.closest("[data-win]");
  if (w) core.windowAction(w.dataset.win);
});
document.addEventListener("mouseover", e => {
  const li = e.target.closest && e.target.closest("[data-snooze]");
  if (li && tri.menu && tri.menu.idx !== Number(li.dataset.snooze)) { tri.menu.idx = Number(li.dataset.snooze); drawSnoozeMenu(); }
});

/* ───────── изменения данных ───────── */
state.addEventListener("change", e => {
  const what = e.detail;
  if (what === "inbox") {
    renderNavbar();
    if (view.name === "today") renderToday();
    if (view.name === "triage" && !tri.busy && !tri.menu) renderTriage();
    if (view.name === "app" || view.name === "settings") renderRail();
  } else if (what === "cards") {
    if (view.name === "today") renderToday();
  } else if (what === "settings") {
    applyTheme();
    if (view.name === "settings") renderSettings();
  } else if (what === "conflicts") {
    renderSyncPills();
    if (view.name === "settings") renderSettings();
  }
});

/* отложенные возвращаются, приветствие и дата меняются */
let lastSnoozeCheck = Date.now();
setInterval(() => {
  const now = Date.now();
  const back = state.items.some(i => i.snoozeUntil && Date.parse(i.snoozeUntil) > lastSnoozeCheck && Date.parse(i.snoozeUntil) <= now);
  lastSnoozeCheck = now;
  if (!unlocked) return;
  if (back) state.changed("inbox");
  else if (view.name === "today") renderToday();
  else renderHello();
}, 30e3);

/* ───────── замок ───────── */
let lastActivity = Date.now(), locking = false;
const touch = () => { lastActivity = Date.now(); };
["keydown", "pointerdown", "wheel", "touchstart"].forEach(ev => document.addEventListener(ev, touch, { capture: true, passive: true }));
setInterval(() => {
  const min = Number(state.local && state.local.autolock);
  if (unlocked && min > 0 && Date.now() - lastActivity > min * 60e3) lockNow();
}, 15e3);

async function lockNow() {
  if (!unlocked || locking) return;
  locking = true;
  unlocked = false;
  html.dataset.view = "none"; renderNavbar();
  closeSnoozeMenu();
  document.querySelectorAll("dialog").forEach(d => d.close());
  if (host) host.reset();
  core.driveCancel().catch(() => {});
  try { await core.lock(); } catch (e) { console.error(e); }
  state.items = []; state.cards = {}; state.deliveries = []; state.conflicts = [];
  for (const sel of ["#today-cards", "#triage", "#settings"]) { const el = $(sel); if (el) el.innerHTML = ""; }
  applyTheme();
  await runLock();
  locking = false;
  await enterHub();
}

/* синхронизация: статус и чужие правки */
core.onSync(st => {
  setSyncStatus(st);
  if (!unlocked) return;
  renderSyncPills();
  updateSyncSettingsStatus($("#settings-sync"));
});
core.onDataChanged(async ({ namespaces = [] } = {}) => {
  if (!unlocked) return;
  if (namespaces.includes("hub")) {
    await state.load();
    await loadCustomPhotos();
    applyTheme();
    await reloadApps();
    if (view.name === "today") renderToday();
    else if (view.name === "triage" && !tri.busy && !tri.menu) renderTriage();
    renderRail(); renderSyncPills();
    host.flushAll();
  }
  for (const ns of namespaces) {
    if (ns === "hub" || !host.frames.has(ns)) continue;
    const shown = view.name === "app" && view.app === ns;
    host.reload(ns);
    if (shown) toast(`Пришли изменения с другого устройства — «${host.name(ns)}» обновлено`, { icon: "refresh-cw" });
  }
});

/* ───────── запуск ───────── */
let platform = "pc", wired = false;
async function start() {
  watchSecrets();
  await loadThemes();
  applyTheme();
  const st = await core.status();
  platform = st.platform || "pc";
  html.dataset.platform = platform;
  html.dataset.view = "none";
  if (core.nativeWindow) html.dataset.nativeWindow = "";
  H.icons($("#titlebar"));
  window.__hubShell = { state, core, go, openApp, lockNow, get host() { return host; }, get unlocked() { return unlocked; } };   // для тестов и отладки
  if (!st.setupDone) await runSetup(st);
  else if (!st.unlocked) await runLock();
  await enterHub();
}

/* после пароля: данные, приложения, «Сегодня» */
async function enterHub() {
  await state.load();
  unlocked = true; lastActivity = Date.now();
  // имя, введённое при настройке (до того, как появились данные), переезжает в общие настройки
  if (typeof state.settings.name !== "string") { let n = ""; try { n = localStorage.getItem("hub:name") || ""; } catch { /* нет */ } state.setSetting("name", n); }
  await loadCustomPhotos();
  setSyncStatus(await core.syncStatus().catch(() => null));
  setDevice(syncStatus.device || (platform === "phone" ? "phone" : "pc"));
  applyTheme();
  if (!host) {
    host = new AppHost({
      state,
      container: $("#frames"),
      getTheme: themePayload,
      toast,
      onHotkey: handleHotkey,
      onCard: () => {},
      onActivity: touch,
    });
  }
  host.reset();
  host.apps.clear();
  try { host.setApps(await core.apps()); }
  catch (e) { console.error(e); toast(`Список приложений не прочитался: ${e.message || e}`, { tone: "danger", icon: "circle-alert" }); }
  // приложения с карточкой на «Сегодня» и получатели корзины запускаются сразу, в фоне
  for (const a of host.list()) if (a.manifest.card || (a.manifest.accepts || []).length) host.ensure(a.id);
  host.flushAll();
  if (!wired) {
    wired = true;
    setupCapture($("#capture-main"));
    setupCapture($("#capture-compact"));
    core.onHotkey(k => handleHotkey(k));
    core.onLockRequest(() => lockNow());
    watchDrops(installCtx());
    history.replaceState({ v: "today", app: null }, "");
  }
  phoneCapture();
  document.querySelector(".hub-backdrop").setAttribute("data-scene", "open");
  go("today");
}
start().catch(e => {
  console.error(e);
  document.body.insertAdjacentHTML("beforeend", `<div class="hub-overlay"><div class="hub-dialog"><h2 class="hub-dialog__title">Хаб не запустился</h2><p class="hub-dialog__body">${esc(e.message || e)}</p></div></div>`);
});
