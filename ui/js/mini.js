/* mini.js — мини-окно «мысль в корзину» поверх других программ (Ctrl+Alt+Пробел).
   Enter — в корзину и закрыть; Esc — закрыть, текст остаётся до следующего открытия.
   Хаб заперт — мысль запирается ключом этого устройства и попадёт в корзину после входа (src-tauri/src/quick.rs). */
import { core, inTauri } from "./core.js";
import { tagsOf } from "./state.js";

const H = window.HubUI;
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const UNSORTED = ["неразобранная", "неразобранные", "неразобранных"];
const IDLE = "Enter — в корзину · Esc — закрыть";
const form = $("#mini"), input = $("#mini-input"), send = form.querySelector(".hub-capture__send"), note = $("#mini-note");
let doneTimer = null, busy = false;

/* тема — та же, что у хаба (до входа своя тема недоступна: встроенная той же основы) */
async function applyTheme() {
  const get = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const id = get("hub:theme"), base = get("hub:theme-base") || "dark";
  document.documentElement.setAttribute("data-theme", base);
  for (const tid of [id, "forest", "mist", "solid"]) {
    if (!tid || !/^[a-z0-9-]+$/.test(tid)) continue;
    try {
      const t = await (await fetch(`hub/themes/${tid}/theme.json`)).json();
      if (t.base !== base) continue;
      for (const [k, v] of Object.entries(t.tokens || {})) document.documentElement.style.setProperty(`--${k}`, v);
      return;
    } catch { /* нет такой встроенной темы */ }
  }
}

function idle() {
  note.classList.remove("is-ok");
  const tags = tagsOf(input.value);
  if (tags.length) note.innerHTML = `<span>метки:</span>${tags.map(t => `<span class="hub-tag">#${esc(t)}</span>`).join("")}`;
  else note.textContent = IDLE;
}

function hide() {
  if (inTauri) core.miniHide();
}

function shown() {
  if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; input.value = ""; }
  applyTheme();
  send.disabled = !input.value.trim();
  idle();
  input.focus();
  input.select();
}

input.addEventListener("input", () => { send.disabled = !input.value.trim(); idle(); });
form.addEventListener("submit", async e => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) { note.textContent = "Напишите мысль и нажмите Enter"; return; }
  if (busy) return;
  busy = true;
  try {
    const r = await core.quickCapture(text);
    input.value = ""; send.disabled = true;
    note.classList.add("is-ok");
    note.innerHTML = r.status === "sealed"
      ? `${H.icon("lock")}<span>Сохранено — появится в корзине после входа</span>`
      : `${H.icon("check")}<span>В корзине — ${esc(H.plural(r.count || 1, UNSORTED))}</span>`;
    doneTimer = setTimeout(() => { doneTimer = null; idle(); hide(); }, 1500);
  } catch (err) {
    note.classList.remove("is-ok");
    note.textContent = String(err && err.message || err);
  } finally { busy = false; }
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { e.preventDefault(); hide(); }
});

if (inTauri) window.__TAURI__.event.listen("mini://shown", shown);
H.init(document);
shown();
