/* lock.js — первая настройка (пароль, ключ восстановления, Google Drive) и экран входа.
   До ввода пароля ядро не читает ни одного файла данных: всё, что здесь видно, — фото темы, часы и дата. */
import { core, inTauri } from "./core.js";
import { greetingText } from "./themes.js";
import { driveGuide } from "./help.js";

const H = window.HubUI;
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtLong = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" });
const hm = d => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;

function scene(name) { document.querySelector(".hub-backdrop").setAttribute("data-scene", name); }
function screen() {
  let el = $("#screen-lock");
  if (!el) { el = document.createElement("div"); el.id = "screen-lock"; el.className = "shell-lock"; document.body.appendChild(el); }
  el.hidden = false;
  for (const id of ["#screen-today", "#screen-triage", "#screen-shell", "#screen-apps"]) { const s = $(id); if (s) s.hidden = true; }
  return el;
}
function close() { const el = $("#screen-lock"); if (el) { el.hidden = true; el.innerHTML = ""; } }
const name = () => { try { return localStorage.getItem("hub:name") || ""; } catch { return ""; } };
const greet = () => { let g = ""; try { g = localStorage.getItem("hub:greeting") || ""; } catch { /* нет */ } return greetingText(g, name()); };

/* ───────── первая настройка ───────── */

const STEPS = ["Имя", "Пароль", "Ключ", "Google Drive"];
function stepper(cur) {
  return `<ol class="hub-stepper" aria-label="Шаги">${STEPS.map((s, i) =>
    `<li${i < cur ? ' class="is-done"' : ""}${i === cur ? ' aria-current="step"' : ""}>${s}</li>`).join("")}</ol>`;
}
function card(inner) {
  return `<div class="shell-center"><div class="hub-glass hub-glass--strong shell-setup">${inner}</div></div>`;
}
function bar(back, next, nextDisabled) {
  return `<div class="hub-btn-row shell-setup__bar">
    ${back ? `<button class="hub-btn hub-btn--quiet" type="button" data-step="back"><i data-icon="arrow-left"></i>Назад</button>` : "<span></span>"}
    ${next ? `<button class="hub-btn hub-btn--primary" type="submit"${nextDisabled ? " disabled" : ""}>${next} <kbd class="hub-kbd">Enter</kbd></button>` : ""}
  </div>`;
}

/* Сам выбор «новый хаб / подключить к существующему» и шаги. Возвращает промис, который
   разрешается, когда хаб настроен и открыт. */
export function runSetup(status) {
  return new Promise(resolve => {
    const el = screen();
    scene("pass");
    const s = { step: -1, name: name(), password: "", recovery: "", mode: "new" };

    function draw() {
      if (s.step === -1) {
        el.innerHTML = card(`
          <h1 class="t-display" style="margin:0">Хаб на этом устройстве</h1>
          <p class="hub-muted" style="margin:var(--space-2) 0 var(--space-5)">${status.hasOldData
            ? "Здесь уже есть данные хаба. Придумайте пароль — они зашифруются и будут открываться только после него."
            : "Новый хаб — с паролем и ключом восстановления. Если хаб уже есть на другом устройстве и подключён к Google Drive, подключите это устройство к нему."}</p>
          <div class="shell-choice">
            <button class="hub-target" type="button" data-choose="new"><i data-icon="key-round"></i><span class="hub-target__name">Новый хаб</span><span class="hub-target__what">пароль и ключ восстановления</span></button>
            <button class="hub-target" type="button" data-choose="join"${status.hasOldData ? " disabled" : ""}><i data-icon="monitor-smartphone"></i><span class="hub-target__name">Подключить к существующему</span><span class="hub-target__what">${status.hasOldData ? "здесь уже есть данные" : "ключи придут с Google Drive"}</span></button>
          </div>`);
      } else if (s.mode === "join") drawJoin();
      else if (s.step === 0) {
        el.innerHTML = card(`<form>${stepper(0)}<div class="shell-setup__body">
          <h1 class="t-display" style="margin:0">Как к вам обращаться?</h1>
          <p class="hub-muted" style="margin:var(--space-2) 0 var(--space-5)">Так хаб будет здороваться на экране входа. Можно оставить пустым.</p>
          <input class="hub-input hub-input--lg" id="su-name" value="${esc(s.name)}" aria-label="Имя" maxlength="40" autocomplete="off">
          ${bar(true, "Дальше")}</div></form>`);
      } else if (s.step === 1) {
        el.innerHTML = card(`<form>${stepper(1)}<div class="shell-setup__body">
          <h1 class="t-display" style="margin:0">Придумайте пароль</h1>
          <p class="hub-muted" style="margin:var(--space-2) 0 var(--space-5)">Лучше длинная фраза, чем «цифра и символ»: «лес на рассвете у реки». Пароль нигде не хранится и не восстанавливается — только ключом с бумаги, который будет на следующем шаге.</p>
          <div style="display:grid;gap:var(--space-4)">
            <label class="hub-field"><span class="hub-label">Пароль</span><input class="hub-input hub-input--lg hub-input--secret" type="password" id="su-p1" autocomplete="new-password"></label>
            <label class="hub-field"><span class="hub-label">Ещё раз</span><input class="hub-input hub-input--lg hub-input--secret" type="password" id="su-p2" autocomplete="new-password"><span class="hub-hint" id="su-hint"></span></label>
          </div>
          ${bar(true, "Дальше", true)}</div></form>`);
      } else if (s.step === 2) {
        el.innerHTML = card(`<form>${stepper(2)}<div class="shell-setup__body">
          <h1 class="t-display" style="margin:0">Запишите ключ восстановления</h1>
          <p class="hub-muted" style="margin:var(--space-2) 0 var(--space-5)">Единственный способ вернуть данные, если забудете пароль. Храните на бумаге — не в телефоне и не в облаке. Без пароля и без этого ключа данные не вернуть никак.</p>
          <div class="hub-key" aria-label="Ключ восстановления">${s.recovery.split("-").map(g => `<span>${esc(g)}</span>`).join("")}</div>
          <div class="hub-btn-row" style="margin-top:var(--space-4)"><button class="hub-btn" type="button" data-step="print"><i data-icon="printer"></i>Распечатать</button></div>
          <label class="hub-check" style="margin-top:var(--space-5)"><input type="checkbox" id="su-saved"><span>Я записал ключ и убрал бумагу</span></label>
          ${bar(false, "Дальше", true)}</div></form>`);
      } else if (s.step === 3) {
        el.innerHTML = card(`<form>${stepper(3)}<div class="shell-setup__body">
          <h1 class="t-display" style="margin:0">Google Drive</h1>
          <p class="hub-muted" style="margin:var(--space-2) 0 var(--space-5)">Чтобы данные были одинаковыми на ПК и телефоне.</p>
          <ul class="hub-list hub-list--divided">
            <li><div class="hub-row"><span class="hub-row__lead"><i data-icon="shield-check"></i></span><span class="hub-row__body"><span class="hub-row__title">Хаб видит только свою папку «Hub»</span><span class="hub-row__meta">остальной Drive ему недоступен</span></span></div></li>
            <li><div class="hub-row"><span class="hub-row__lead"><i data-icon="lock"></i></span><span class="hub-row__body"><span class="hub-row__title">Всё уходит зашифрованным</span><span class="hub-row__meta">Google видит число файлов и их размер, но не имена и не содержимое</span></span></div></li>
            <li><div class="hub-row"><span class="hub-row__lead"><i data-icon="cloud-off"></i></span><span class="hub-row__body"><span class="hub-row__title">Без интернета всё работает</span><span class="hub-row__meta">Drive догонит, когда появится связь</span></span></div></li>
          </ul>
          ${driveClientFields(s)}
          <p class="hub-hint" id="su-drive-msg" style="margin-top:var(--space-4)" role="status"></p>
          <div class="hub-btn-row shell-setup__bar">
            <button class="hub-btn hub-btn--quiet" type="button" data-step="skip">Позже — только на этом устройстве</button>
            <button class="hub-btn hub-btn--primary" type="button" data-step="drive" disabled><i data-icon="external-link"></i>Подключить Google Drive</button>
          </div></div></form>`);
      }
      H.icons(el);
      const first = el.querySelector("input:not([type=checkbox])");
      if (first) first.focus();
      wire();
    }

    function drawJoin(msg) {
      el.innerHTML = card(`<form>
        <h1 class="t-display" style="margin:0">Подключить к существующему хабу</h1>
        <p class="hub-muted" style="margin:var(--space-2) 0 var(--space-5)">Используйте тот же Google-аккаунт и OAuth-клиент, что на первом устройстве, затем введите пароль хаба.</p>
        ${driveClientFields(s)}
        <div class="hub-btn-row" style="margin-top:var(--space-4)"><button class="hub-btn" type="button" data-step="google" disabled><i data-icon="external-link"></i>${s.token ? "Google подключён" : "Войти в Google"}</button></div>
        <label class="hub-field" style="margin-top:var(--space-5)"><span class="hub-label">Пароль хаба</span><input class="hub-input hub-input--lg hub-input--secret" type="password" id="su-jp" autocomplete="current-password"></label>
        <p class="hub-hint${msg ? " hub-hint--error" : ""}" id="su-jmsg">${msg ? `${H.icon("circle-alert")}${esc(msg)}` : ""}</p>
        ${bar(true, "Подключить", !s.token)}</form>`);
      H.icons(el);
      wire();
    }

    function wire() {
      const form = el.querySelector("form");
      el.querySelectorAll("[data-choose]").forEach(b => b.addEventListener("click", () => { s.mode = b.dataset.choose; s.step = 0; draw(); }));
      el.querySelectorAll("[data-step]").forEach(b => b.addEventListener("click", () => act(b.dataset.step, b)));
      if (s.step === 1 && s.mode === "new") {
        const p1 = $("#su-p1"), p2 = $("#su-p2"), hint = $("#su-hint"), next = form.querySelector("[type=submit]");
        const check = () => {
          const short = p1.value.length > 0 && [...p1.value].length < 8;
          const differ = p2.value && p1.value !== p2.value;
          p2.setAttribute("aria-invalid", differ ? "true" : "false");
          hint.className = "hub-hint" + (differ || short ? " hub-hint--error" : "");
          hint.innerHTML = differ ? `${H.icon("circle-alert")}Пароли не совпадают` : short ? `${H.icon("circle-alert")}Не короче 8 знаков` : "";
          next.disabled = !p1.value || p1.value !== p2.value || [...p1.value].length < 8;
        };
        p1.addEventListener("input", check); p2.addEventListener("input", check);
      }
      if (s.step === 2) {
        const cb = $("#su-saved"), next = form.querySelector("[type=submit]");
        cb.addEventListener("change", () => { next.disabled = !cb.checked; });
      }
      const driveButton = el.querySelector('[data-step="drive"], [data-step="google"]');
      if (driveButton && !s.token) bindDriveClient(el, driveButton);
      if (form) form.addEventListener("submit", e => { e.preventDefault(); act("next"); });
    }

    async function act(what, btn) {
      if (what === "back") {
        if (s.mode === "join" || s.step === 0) { s.step = -1; s.mode = "new"; s.token = ""; }
        else s.step--;
        return draw();
      }
      if (what === "print") return printKey(s.recovery);
      if (s.mode === "join") {
        if (what === "google") {
          const msg = $("#su-jmsg");
          const back = el.querySelector('[data-step="back"]');
          back.disabled = true;
          try {
            await withDriveClient(el, btn, msg, (client, token) => {
              Object.assign(s, client, { token });
              drawJoin();
            });
          } finally { back.disabled = false; }
          return;
        }
        if (what === "next") {
          const pw = $("#su-jp").value;
          const next = el.querySelector("[type=submit]");
          if (!s.token || !pw || next.disabled) return;
          const back = el.querySelector('[data-step="back"]');
          back.disabled = true;
          next.setAttribute("aria-busy", "true"); next.disabled = true;
          try {
            await core.setupJoin(targetOf(s), pw);
            try { localStorage.setItem("hub:name", ""); } catch { /* ничего */ }
            close(); resolve({ joined: true });
          } catch (e) { drawJoin(String(e.message || e)); }
          finally { next.removeAttribute("aria-busy"); next.disabled = false; back.disabled = false; }
        }
        return;
      }
      if (s.step === 0 && what === "next") {
        s.name = $("#su-name").value.trim();
        try { localStorage.setItem("hub:name", s.name); } catch { /* ничего */ }
        s.step = 1; return draw();
      }
      if (s.step === 1 && what === "next") {
        const p1 = $("#su-p1").value;
        if (p1 !== $("#su-p2").value || [...p1].length < 8) return;
        const next = el.querySelector("[type=submit]");
        next.setAttribute("aria-busy", "true"); next.disabled = true;
        try { s.recovery = await core.setupCreate(p1); s.step = 2; draw(); }
        catch (e) { next.removeAttribute("aria-busy"); $("#su-hint").className = "hub-hint hub-hint--error"; $("#su-hint").innerHTML = `${H.icon("circle-alert")}${esc(e.message || e)}`; }
        return;
      }
      if (s.step === 2 && what === "next") { if (!$("#su-saved").checked) return; s.recovery = ""; s.step = 3; return draw(); }
      if (s.step === 3) {
        if (what === "skip") { close(); return resolve({ name: s.name }); }
        if (what === "drive") {
          const skip = el.querySelector('[data-step="skip"]');
          skip.disabled = true;
          try {
            await withDriveClient(el, btn, $("#su-drive-msg"), async (client, token) => {
              Object.assign(s, client);
              $("#su-drive-msg").textContent = "Проверяем доступ к папке «Hub»…";
              await core.syncConnect({ kind: "drive", token, ...client });
              close(); resolve({ name: s.name, drive: true });
            });
          } finally { skip.disabled = false; }
        }
      }
    }
    draw();
  });
}

export function driveClientFields({ clientId = "", clientSecret = "", token } = {}) {
  return `<div class="shell-drive-fields">
    <p class="hub-hint">Вставьте данные своего OAuth-клиента из Google Cloud.</p>
    ${driveGuide()}
    <label class="hub-field"><span class="hub-label">Client ID</span>
      <input class="hub-input" id="gc-id" value="${esc(clientId)}" autocomplete="off" spellcheck="false" required${token ? " readonly" : ""}></label>
    <label class="hub-field"><span class="hub-label">Client Secret</span>
      <input class="hub-input hub-input--secret" type="password" id="gc-secret" value="${esc(clientSecret)}" autocomplete="off" required${token ? " readonly" : ""}></label>
    </div>`;
}
function readDriveClient(el) {
  return { clientId: el.querySelector("#gc-id").value.trim(), clientSecret: el.querySelector("#gc-secret").value.trim() };
}
const hasDriveClient = ({ clientId, clientSecret }) => !!clientId && !!clientSecret;
export function bindDriveClient(el, button) {
  const update = () => { button.disabled = button.hasAttribute("aria-busy") || !hasDriveClient(readDriveClient(el)); };
  el.querySelector(".shell-drive-fields").addEventListener("input", update);
  update();
}
export async function withDriveClient(el, button, msg, connect) {
  const client = readDriveClient(el);
  if (button.disabled || !hasDriveClient(client)) return;
  const inputs = [...el.querySelectorAll(".shell-drive-fields input")];
  inputs.forEach(input => { input.readOnly = true; });
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  msg.className = "hub-hint";
  msg.textContent = "Завершите вход в Google в браузере…";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "hub-btn hub-btn--sm hub-btn--quiet";
  cancel.textContent = "Отменить вход";
  cancel.addEventListener("click", () => {
    cancel.disabled = true;
    core.driveCancel().catch(() => { cancel.disabled = false; });
  });
  msg.after(cancel);
  try {
    const token = await core.driveAuthorize(client);
    cancel.remove();
    if (msg.isConnected) await connect(client, token);
  } catch (err) {
    msg.className = "hub-hint hub-hint--error";
    msg.innerHTML = `${H.icon("circle-alert")}${esc(err.message || err)}`;
  } finally {
    cancel.remove();
    inputs.forEach(input => { input.readOnly = false; });
    button.removeAttribute("aria-busy");
    button.disabled = false;
  }
}
function targetOf({ token, clientId, clientSecret }) { return { kind: "drive", token, clientId, clientSecret }; }

function printKey(code) {
  const w = window.open("", "_blank", "width=600,height=400");
  if (!w) { H.toast("Печать недоступна — перепишите ключ вручную", { icon: "info" }); return; }
  w.document.write(`<!doctype html><meta charset="utf-8"><title>Ключ восстановления хаба</title>
    <body style="font:16px system-ui;padding:40px"><h1 style="font-weight:400">Ключ восстановления хаба</h1>
    <p style="font:28px monospace;letter-spacing:.12em">${esc(code)}</p>
    <p>Создан ${esc(fmtLong.format(new Date()))}. Нужен, если забыт пароль. Храните на бумаге.</p></body>`);
  w.document.close(); w.focus(); w.print();
}

/* ───────── экран входа ───────── */

export function runLock() {
  return new Promise(resolve => {
    const el = screen();
    scene("lock");
    let mode = "lock", idleTimer = null, clockTimer = null;

    function draw(msg, tone) {
      const now = new Date();
      if (mode === "recover") {
        scene("pass");
        el.innerHTML = card(`<form>
          <h1 class="t-display" style="margin:0">Вход ключом восстановления</h1>
          <p class="hub-muted" style="margin:var(--space-2) 0 var(--space-5)">32 знака с бумаги, которую вы записали при настройке. Потом придумайте новый пароль.</p>
          <div style="display:grid;gap:var(--space-4)">
            <label class="hub-field"><span class="hub-label">Ключ восстановления</span><input class="hub-input hub-input--lg" id="rc-code" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-…"></label>
            <label class="hub-field"><span class="hub-label">Новый пароль</span><input class="hub-input hub-input--lg hub-input--secret" type="password" id="rc-p1" autocomplete="new-password"></label>
            <label class="hub-field"><span class="hub-label">Ещё раз</span><input class="hub-input hub-input--lg hub-input--secret" type="password" id="rc-p2" autocomplete="new-password"></label>
          </div>
          <p class="hub-hint${msg ? " hub-hint--error" : ""}" style="margin-top:var(--space-3)">${msg ? H.icon("circle-alert") + esc(msg) : ""}</p>
          <div class="hub-btn-row shell-setup__bar"><button class="hub-btn hub-btn--quiet" type="button" data-act="back"><i data-icon="arrow-left"></i>Назад</button>
            <button class="hub-btn hub-btn--primary" type="submit">Войти <kbd class="hub-kbd">Enter</kbd></button></div></form>`);
        H.icons(el);
        el.querySelector("[data-act=back]").addEventListener("click", () => { mode = "pass"; draw(); });
        el.querySelector("form").addEventListener("submit", async e => {
          e.preventDefault();
          const code = $("#rc-code").value, p1 = $("#rc-p1").value, p2 = $("#rc-p2").value;
          if (p1 !== p2) return draw("Новые пароли не совпадают");
          try { await core.unlockWithRecovery(code, p1); finish(); }
          catch (err) { draw(String(err.message || err)); }
        });
        $("#rc-code").focus();
        return;
      }
      const phone = window.matchMedia("(max-width: 600px)").matches;
      el.innerHTML = `<main class="hub-lock${phone ? " hub-lock--phone" : ""}" aria-label="Вход в хаб">
          <div class="hub-lock__clock">${hm(now)}</div>
          <div class="hub-lock__date">${esc(fmtLong.format(now))}</div>
          <h1 class="hub-lock__greet"><span>${phone ? '<img class="shell-brand" src="favicon.svg" alt="" width="24" height="24">' : ""}${esc(greet())}</span></h1>
          <form class="hub-lock__form"${mode === "lock" ? " hidden" : ""}>
            <div class="hub-lock__row">
              <input class="hub-input hub-input--line hub-input--secret" type="password" placeholder="Пароль" aria-label="Пароль" autocomplete="current-password"${msg && tone === "danger" ? ' aria-invalid="true"' : ""}>
              <button class="hub-btn hub-btn--quiet hub-btn--icon hub-lock__go" type="submit" aria-label="Войти"><i data-icon="arrow-right"></i></button>
            </div>
            <p class="hub-lock__caps hub-hint hub-hint--warning" id="lock-caps" aria-live="polite" hidden></p>
            <p class="hub-lock__msg" data-tone="${tone || ""}" aria-live="polite">${msg ? H.icon(tone === "danger" ? "circle-alert" : "triangle-alert") + esc(msg) : ""}</p>
            ${tone === "danger" ? `<button class="hub-btn hub-btn--quiet hub-btn--sm" type="button" data-act="recover">Войти ключом восстановления</button>` : ""}
          </form>
        </main>
        <p class="hub-lock__hint">${mode === "lock" ? "Нажмите любую клавишу" : "Enter — войти · Esc — назад"}</p>`;
      H.icons(el);
      const form = el.querySelector("form"), input = form.querySelector("input");
      form.addEventListener("submit", async e => {
        e.preventDefault();
        const pw = input.value;
        if (!pw) return;
        form.querySelector(".hub-lock__go").setAttribute("aria-busy", "true");
        try { await core.unlock(pw); finish(); }
        catch (err) {
          const latin = /[a-z]/i.test(pw) && !/[а-яё]/i.test(pw);
          draw(String(err.message || err) + (latin ? ": похоже, включена английская раскладка" : ""), "danger");
          const inp = el.querySelector(".hub-lock__form input");
          inp.value = pw; inp.select();
          const row = el.querySelector(".hub-lock__row");
          row.classList.add("hub-shake"); setTimeout(() => row.classList.remove("hub-shake"), 450);
        }
      });
      const caps = form.querySelector("#lock-caps");
      caps.innerHTML = H.icon("triangle-alert") + "Включён Caps Lock";
      const updateCaps = e => { caps.hidden = !e.getModifierState("CapsLock"); };
      input.addEventListener("keydown", updateCaps);
      input.addEventListener("keyup", updateCaps);
      const rec = el.querySelector("[data-act=recover]");
      if (rec) rec.addEventListener("click", () => { mode = "recover"; draw(); });
      if (mode === "pass") { input.focus(); armIdle(); }
    }

    function toPass(firstChar) {
      if (mode !== "lock") return;
      mode = "pass"; scene("pass"); draw();
      const input = el.querySelector(".hub-lock__form input");
      if (firstChar) input.value = firstChar;
    }
    function armIdle() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { if (mode === "pass") { mode = "lock"; scene("lock"); draw(); } }, 30e3);
    }
    function onKey(e) {
      if (mode === "lock") {
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        e.preventDefault();
        toPass(e.key.length === 1 ? e.key : "");
      } else if (mode === "pass") {
        armIdle();
        if (e.key === "Escape") { mode = "lock"; scene("lock"); draw(); }
      }
    }
    function onClick() { if (mode === "lock") toPass(""); }
    function finish() {
      clearTimeout(idleTimer); clearInterval(clockTimer);
      document.removeEventListener("keydown", onKey, true);
      el.removeEventListener("click", onClick);
      scene("open");
      close();
      resolve();
    }
    document.addEventListener("keydown", onKey, true);
    el.addEventListener("click", onClick);
    clockTimer = setInterval(() => { const c = el.querySelector(".hub-lock__clock"); if (c) c.textContent = hm(new Date()); }, 15e3);
    draw();
    if (!inTauri && new URLSearchParams(location.search).has("pass")) toPass("");
  });
}
