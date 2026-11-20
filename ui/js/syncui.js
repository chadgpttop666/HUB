/* syncui.js — статус синхронизации в шапке и разделы настроек: синхронизация, папки, конфликты, безопасность. */
import { core, inTauri } from "./core.js";
import { driveOwnClientFields } from "./lock.js";

const H = window.HubUI;
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hm = d => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
const fmtDay = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });
function when(ms) {
  if (!ms) return "";
  const d = new Date(ms), now = new Date();
  return d.toDateString() === now.toDateString() ? hm(d) : `${fmtDay.format(d)}, ${hm(d)}`;
}

export let syncStatus = { configured: false, state: "off", folders: [] };
export function setSyncStatus(s) { if (s) syncStatus = s; }

export function folderConflicts(st = syncStatus) { return (st.folders || []).reduce((n, f) => n + (f.conflicts || []).length, 0); }
export function folderProblems(st = syncStatus) { return (st.folders || []).filter(f => !f.path || !f.started || (f.problem && !["offline", "error"].includes(f.problem.kind))).length; }

/* строка статуса в шапке (компонент «Статус синхронизации») */
export function syncPill(dataConflicts, compact) {
  const st = syncStatus;
  if (!st.configured) return "";
  const conflicts = dataConflicts + folderConflicts(st);
  const attention = folderProblems(st);
  let state = "ok", icon = "cloud-check", text = st.lastSync ? `синхронизировано · ${when(st.lastSync)}` : "синхронизировано";
  if (st.state === "running") { state = "busy"; icon = "refresh-cw"; text = "синхронизация…"; }
  else if (st.state === "offline") { state = "offline"; icon = "cloud-off"; text = "нет сети · всё сохранено здесь"; }
  if (st.state === "error") { state = "conflict"; icon = "triangle-alert"; text = "синхронизация не прошла"; }
  if (attention) { state = "conflict"; icon = "triangle-alert"; text = H.plural(attention, ["папка ждёт решения", "папки ждут решения", "папок ждут решения"]); }
  if (conflicts) { state = "conflict"; icon = "triangle-alert"; text = `${H.plural(conflicts, ["конфликт", "конфликта", "конфликтов"])}`; }
  const cls = `hub-sync${compact ? " hub-sync--icon" : ""}`;
  return `<button class="${cls}" type="button" data-state="${state}" data-go="sync" title="${esc(text)}"><i data-icon="${icon}"></i><span>${esc(text)}</span></button>`;
}

/* ───────── настройки ───────── */

export async function renderSyncSettings(el, ctx) {
  const { state, toast, rerender, platform } = ctx;
  const st = syncStatus;
  const phone = platform === "phone";
  const folders = (state.folders || []).map(def => Object.assign({}, def, (st.folders || []).find(f => f.id === def.id) || {}));
  const conflicts = state.conflicts || [];

  el.innerHTML = `
    <section class="shell-section" id="sync"><h2 class="hub-section-title">Синхронизация</h2>
      ${!inTauri ? `<p class="hub-muted">В браузере синхронизации нет — только в приложении хаба.</p>` : !st.configured ? `
        <p class="hub-muted" style="margin:0 0 var(--space-4)">Данные хаба и помеченные папки — одинаковые на ПК и телефоне, через вашу папку «Hub» на Google Drive. Всё уходит зашифрованным, Google видит только число файлов и их размер.</p>
        ${driveOwnClientFields({})}
        <div class="hub-btn-row" style="margin-top:var(--space-4)"><button class="hub-btn hub-btn--primary" type="button" data-sync="connect"><i data-icon="external-link"></i>Подключить Google Drive</button></div>
        <p class="hub-hint" id="sync-msg" style="margin-top:var(--space-3)"></p>` : `
        <dl class="shell-kv">
          <dt>Состояние</dt><dd>${esc({ idle: "синхронизировано", running: "идёт синхронизация", offline: "нет сети — всё сохранено здесь, уйдёт позже", error: "не прошла" }[st.state] || st.state)}${st.message ? ` · ${esc(st.message)}` : ""}</dd>
          <dt>Последний раз</dt><dd>${esc(when(st.lastSync) || "ещё не было")}</dd>
          <dt>Хранилище</dt><dd>${st.kind === "local" ? "папка (проверка)" : "Google Drive, папка «Hub»"}</dd>
          <dt>Это устройство</dt><dd>${esc(st.device)}</dd>
        </dl>
        <div class="hub-btn-row" style="margin-top:var(--space-4)">
          <button class="hub-btn" type="button" data-sync="now"${st.state === "running" ? ' aria-busy="true" disabled' : ""}><i data-icon="refresh-cw"></i>Синхронизировать</button>
          <button class="hub-btn hub-btn--quiet" type="button" data-sync="rclone"><i data-icon="key-round"></i>Пароли для rclone</button>
          <button class="hub-btn hub-btn--quiet" type="button" data-sync="disconnect">Отключить на этом устройстве</button>
        </div>
        <p class="hub-hint" style="margin-top:var(--space-3)">Страховка: ежедневный снимок данных и каждой папки на Drive (хранятся 30 последних); стоп-кран останавливает синхронизацию папки, если удаляется больше половины файлов.</p>`}
    </section>

    ${conflicts.length ? `<section class="shell-section"><h2 class="hub-section-title">Конфликты данных</h2>
      <p class="hub-muted" style="margin:0 0 var(--space-3)">Одно и то же правили на двух устройствах. Осталась более поздняя правка; другая сохранена здесь.</p>
      <ul class="hub-list hub-list--divided hub-glass" style="padding:var(--space-1) var(--space-2)">${conflicts.map(c => `
        <li><div class="hub-row"><span class="hub-row__lead"><i data-icon="git-compare-arrows"></i></span>
          <span class="hub-row__body"><span class="hub-row__title">${esc(ctx.appName(c.ns))} · ${esc(c.key)}</span>
          <span class="hub-row__meta">${esc(c.note || "")}${c.ts ? ` · ${esc(when(c.ts))}` : ""}${c.dev ? ` · ${esc(c.dev)}` : ""}</span></span>
          <span class="hub-row__trail"><button class="hub-btn hub-btn--sm" type="button" data-conflict-restore="${esc(c.id)}">Вернуть эту</button>
          <button class="hub-btn hub-btn--sm hub-btn--quiet" type="button" data-conflict-drop="${esc(c.id)}">Убрать</button></span></div></li>`).join("")}</ul>
    </section>` : ""}

    ${inTauri && st.configured ? `<section class="shell-section" id="folders"><h2 class="hub-section-title">Помеченные папки</h2>
      <p class="hub-muted" style="margin:0 0 var(--space-3)">Например, хранилище Obsidian. Файлы лежат на диске открытыми — их читают другие программы; на Drive — зашифрованными.</p>
      ${folders.length ? `<ul class="hub-list hub-list--divided hub-glass" style="padding:var(--space-1) var(--space-2)">${folders.map(f => folderRow(f)).join("")}</ul>` : ""}
      <div class="hub-btn-row" style="margin-top:var(--space-4)"><button class="hub-btn" type="button" data-folder-add="1"><i data-icon="folder-plus"></i>Синхронизировать папку</button></div>
      ${phone ? `<p class="hub-hint" style="margin-top:var(--space-3)">На телефоне папку указывают полным путём, например /storage/emulated/0/Documents/Obsidian. Хабу нужен «Доступ ко всем файлам»: Настройки Android → Приложения → Хаб.</p>` : ""}
    </section>` : ""}

    <section class="shell-section" id="security"><h2 class="hub-section-title">Безопасность</h2>
      <div class="shell-form-row">
        <label class="hub-field"><span class="hub-label">Запирать хаб без дела через</span>
          <span class="hub-select"><select id="sec-autolock">${[[5, "5 минут"], [15, "15 минут"], [60, "час"], [0, "не запирать"]].map(([v, l]) =>
            `<option value="${v}"${Number(state.local.autolock) === v ? " selected" : ""}>${l}</option>`).join("")}</select></span></label>
        <button class="hub-btn" type="button" data-sec="lock"><i data-icon="lock"></i>Заблокировать <kbd class="hub-kbd">Ctrl</kbd><kbd class="hub-kbd">L</kbd></button>
      </div>
      <details class="shell-details" style="margin-top:var(--space-5)"><summary>Сменить пароль</summary>
        <form id="sec-pw" style="display:grid;gap:var(--space-3);max-width:420px;margin-top:var(--space-3)">
          <input class="hub-input hub-input--secret" type="password" id="sec-old" placeholder="Нынешний пароль" autocomplete="current-password">
          <input class="hub-input hub-input--secret" type="password" id="sec-new1" placeholder="Новый пароль" autocomplete="new-password">
          <input class="hub-input hub-input--secret" type="password" id="sec-new2" placeholder="Новый пароль ещё раз" autocomplete="new-password">
          <p class="hub-hint" id="sec-msg"></p>
          <div class="hub-btn-row"><button class="hub-btn hub-btn--primary" type="submit">Сменить</button></div>
        </form></details>
      <p class="hub-hint" style="margin-top:var(--space-3)">Данные хаба на диске зашифрованы и открываются только после пароля. Ключ восстановления остаётся прежним и после смены пароля.</p>
    </section>`;
  H.icons(el);
  wire(el, ctx);
}

function folderRow(f) {
  const p = f.problem;
  let meta = [f.mode === "backup" ? "только копия в облако" : "в обе стороны", "зашифровано"];
  let tag = "", actions = "";
  if (!f.path) {
    meta.push("есть на Drive, но не на этом устройстве");
    actions = `<button class="hub-btn hub-btn--sm hub-btn--primary" type="button" data-folder-place="${esc(f.id)}">Выбрать, куда положить</button>`;
  } else if (!f.started) {
    meta.push(f.path);
    actions = `<button class="hub-btn hub-btn--sm hub-btn--primary" type="button" data-folder-preview="${esc(f.id)}">Пробный прогон</button>`;
  } else if (p && p.kind === "safety-abort") {
    meta.push(f.path);
    tag = `<span class="hub-tag hub-tag--warning"><i data-icon="triangle-alert"></i>стоп-кран</span>`;
    actions = `<button class="hub-btn hub-btn--sm" type="button" data-folder-action="start" data-id="${esc(f.id)}">Вернуть файлы</button>
      <button class="hub-btn hub-btn--sm hub-btn--danger" type="button" data-folder-action="force" data-id="${esc(f.id)}">Удалить везде</button>`;
  } else if (p && p.kind === "needs-resync") {
    meta.push(f.path);
    tag = `<span class="hub-tag hub-tag--warning"><i data-icon="triangle-alert"></i>нужна сверка</span>`;
    actions = `<button class="hub-btn hub-btn--sm" type="button" data-folder-preview="${esc(f.id)}">Пробный прогон</button>`;
  } else {
    meta.push(f.path);
    if (f.lastSync) meta.push(`синхронизирована ${when(f.lastSync)}`);
    if (p) tag = `<span class="hub-tag"><i data-icon="${p.kind === "offline" ? "cloud-off" : "circle-alert"}"></i>${p.kind === "offline" ? "нет сети" : "ошибка"}</span>`;
    actions = `<button class="hub-btn hub-btn--sm hub-btn--quiet" type="button" data-folder-action="sync" data-id="${esc(f.id)}">Сейчас</button>`;
  }
  const conflicts = (f.conflicts || []);
  return `<li><div class="hub-row"><span class="hub-row__lead"><i data-icon="folder-sync"></i></span>
    <span class="hub-row__body"><span class="hub-row__title">${esc(f.name)} ${tag}</span><span class="hub-row__meta">${esc(meta.join(" · "))}</span>
    ${p && p.message && p.kind !== "offline" ? `<span class="hub-row__meta">${esc(p.message)}</span>` : ""}</span>
    <span class="hub-row__trail">${actions}</span></div>
    ${conflicts.length ? `<ul class="hub-list" style="margin:0 0 var(--space-3) var(--space-10)">${conflicts.map(c => `<li><div class="hub-row">
      <span class="hub-row__body"><span class="hub-row__title">${esc(c)}</span><span class="hub-row__meta">конфликт: файл правили на двух устройствах</span></span>
      <span class="hub-row__trail"><button class="hub-btn hub-btn--sm" type="button" data-folder-keep="${esc(c)}" data-id="${esc(f.id)}">Оставить эту</button></span></div></li>`).join("")}</ul>` : ""}
  </li>`;
}

function dialog(html) {
  const dlg = document.createElement("dialog");
  dlg.className = "hub-dialog";
  dlg.innerHTML = html;
  document.body.appendChild(dlg);
  H.icons(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  return dlg;
}

function confirmDialog(title, body, action) {
  return new Promise(res => {
    const dlg = dialog(`<form method="dialog"><h2 class="hub-dialog__title">${esc(title)}</h2><p class="hub-dialog__body">${esc(body)}</p>
      <div class="hub-dialog__actions"><button class="hub-btn hub-btn--quiet" value="cancel">Отмена</button><button class="hub-btn hub-btn--danger" value="ok">${esc(action)}</button></div></form>`);
    dlg.addEventListener("close", () => res(dlg.returnValue === "ok"));
  });
}

function listPreview(title, items) {
  if (!items.length) return "";
  return `<p style="margin:var(--space-3) 0 var(--space-1)"><b>${esc(title)}</b> — ${items.length}</p>
    <p class="hub-hint" style="margin:0">${items.slice(0, 8).map(esc).join(", ")}${items.length > 8 ? ` и ещё ${items.length - 8}` : ""}</p>`;
}

async function preview(id, ctx) {
  const { toast, refresh } = ctx;
  let p;
  try { p = await core.folderPreview(id); }
  catch (e) { toast(`Пробный прогон не прошёл: ${e.message || e}`, { tone: "danger", icon: "circle-alert", timeout: 8000 }); return; }
  const dlg = dialog(`<form method="dialog">
    <h2 class="hub-dialog__title">Пробный прогон</h2>
    <p class="hub-dialog__body">Так пройдёт первая синхронизация. Пока не нажата «Начать», ничего не меняется; удалений при первой синхронизации не бывает.</p>
    ${listPreview("Уйдёт на Drive", p.upload)}${listPreview("Придёт с Drive", p.download)}
    ${listPreview("Есть в обоих местах и различается — останется более новая", p.differ)}
    ${p.same ? `<p class="hub-hint" style="margin-top:var(--space-3)">Совпадают: ${p.same}</p>` : ""}
    <div class="hub-dialog__actions"><button class="hub-btn hub-btn--quiet" value="cancel">Отмена</button>
      <button class="hub-btn hub-btn--primary" value="start">Начать синхронизацию</button></div></form>`);
  dlg.addEventListener("close", async () => {
    if (dlg.returnValue !== "start") return;
    toast("Синхронизация папки пошла", { icon: "refresh-cw" });
    try { const c = await core.folderSync(id, "start"); toast(c.length ? `Готово, конфликтов: ${c.length}` : "Папка синхронизирована", { tone: "success", icon: "circle-check" }); }
    catch (e) { toast(`Не прошло: ${e.message || e}`, { tone: "danger", icon: "circle-alert", timeout: 8000 }); }
    refresh();
  });
}

async function askPath(title, text, ctx) {
  if (ctx.platform !== "phone") {
    const p = await core.pickFolder();
    if (p) return p;
  }
  return new Promise(res => {
    const dlg = dialog(`<form method="dialog">
      <h2 class="hub-dialog__title">${esc(title)}</h2><p class="hub-dialog__body">${esc(text)}</p>
      <input class="hub-input" id="ask-path" style="margin-top:var(--space-4);width:100%" placeholder="${ctx.platform === "phone" ? "/storage/emulated/0/Documents/Obsidian" : "C:\\Users\\…\\Obsidian"}" autocomplete="off">
      <div class="hub-dialog__actions"><button class="hub-btn hub-btn--quiet" value="cancel">Отмена</button><button class="hub-btn hub-btn--primary" value="ok">Выбрать</button></div></form>`);
    dlg.addEventListener("close", () => res(dlg.returnValue === "ok" ? dlg.querySelector("#ask-path").value.trim() || null : null));
  });
}

function wire(el, ctx) {
  const { state, toast, refresh, lockNow } = ctx;
  el.addEventListener("click", async e => {
    const b = e.target.closest("button");
    if (!b) return;
    const d = b.dataset;
    try {
      if (d.sync === "connect") {
        const msg = el.querySelector("#sync-msg");
        b.setAttribute("aria-busy", "true"); b.disabled = true;
        msg.className = "hub-hint"; msg.textContent = "Окно входа Google открыто в браузере…";
        try {
          const id = el.querySelector("#gc-id"), sec = el.querySelector("#gc-secret");
          const client = { clientId: id ? id.value.trim() : "", clientSecret: sec ? sec.value.trim() : "" };
          const token = await core.driveAuthorize(client);
          const r = await core.syncConnect(Object.assign({ kind: "drive", token }, client));
          toast(r === "first" ? "Google Drive подключён — первая синхронизация через пару секунд" : "Хаб снова подключён к Drive", { tone: "success", icon: "circle-check" });
          refresh();
        } catch (err) {
          b.removeAttribute("aria-busy"); b.disabled = false;
          msg.className = "hub-hint hub-hint--error"; msg.innerHTML = `${H.icon("circle-alert")}${esc(err.message || err)}`;
        }
      } else if (d.sync === "now") { await core.syncNow(); toast("Синхронизация пошла", { icon: "refresh-cw" }); }
      else if (d.sync === "disconnect") { await core.syncDisconnect(); toast("Синхронизация на этом устройстве выключена. Данные на Drive остались", { icon: "cloud-off" }); refresh(); }
      else if (d.sync === "rclone") {
        const dlg = dialog(`<form method="dialog"><h2 class="hub-dialog__title">Пароли для rclone</h2>
          <p class="hub-dialog__body">Чтобы достать данные без хаба: rclone, хранилище типа crypt поверх «Hub/crypt» на вашем Drive, с этими двумя паролями. Показываются после пароля хаба.</p>
          <input class="hub-input hub-input--secret" type="password" id="rp-pw" style="margin-top:var(--space-4);width:100%" placeholder="Пароль хаба" autocomplete="current-password">
          <pre class="shell-pre" id="rp-out" hidden></pre>
          <div class="hub-dialog__actions"><button class="hub-btn hub-btn--quiet" value="cancel">Закрыть</button><button class="hub-btn hub-btn--primary" type="button" id="rp-go">Показать</button></div></form>`);
        dlg.querySelector("#rp-go").addEventListener("click", async () => {
          try {
            const r = await core.rclonePasswords(dlg.querySelector("#rp-pw").value);
            const out = dlg.querySelector("#rp-out");
            out.hidden = false;
            out.textContent = `remote   = <ваш drive>:${r.remote}\npassword = ${r.password}\npassword2 = ${r.password2}\n\n(в rclone config — «Yes type in my own password» для обоих)`;
          } catch (err) { toast(String(err.message || err), { tone: "danger", icon: "circle-alert" }); }
        });
      } else if (d.conflictRestore) { const c = await state.restoreConflict(d.conflictRestore); toast("Версия возвращена", { icon: "undo-2" }); ctx.afterRestore(c); }
      else if (d.conflictDrop) { await state.dropConflict(d.conflictDrop); }
      else if (d.folderAdd) {
        const path = await askPath("Какую папку синхронизировать", "Полный путь к папке. В неё ляжет файл-метка .hubsync.", ctx);
        if (!path) return;
        const id = await core.folderAdd(path, "", "two-way", [".obsidian/workspace*.json", ".trash/**"]);
        await refresh();
        preview(id, ctx);
      } else if (d.folderPlace) {
        const path = await askPath("Куда положить папку", "Пустая или новая папка на этом устройстве — туда придут файлы с Drive.", ctx);
        if (!path) return;
        await core.folderPlace(d.folderPlace, path);
        await refresh();
        preview(d.folderPlace, ctx);
      } else if (d.folderPreview) preview(d.folderPreview, ctx);
      else if (d.folderAction) {
        if (d.folderAction === "force" && !(await confirmDialog("Удалить эти файлы везде?", "Они исчезнут и на Drive, и на других устройствах. Копии останутся в ежедневных снимках на Drive.", "Удалить везде"))) return;
        b.setAttribute("aria-busy", "true");
        const c = await core.folderSync(d.id, d.folderAction);
        toast(d.folderAction === "start" ? "Файлы возвращены" : c.length ? `Готово, конфликтов: ${c.length}` : "Папка синхронизирована", { tone: "success", icon: "circle-check" });
        refresh();
      } else if (d.folderKeep) {
        const name = await core.folderResolve(d.id, d.folderKeep);
        toast(`Оставлена эта версия: ${name}`, { icon: "check" });
        refresh();
      } else if (d.sec === "lock") lockNow();
    } catch (err) {
      b.removeAttribute("aria-busy");
      toast(String(err.message || err), { tone: "danger", icon: "circle-alert", timeout: 8000 });
      refresh();
    }
  });
  const al = el.querySelector("#sec-autolock");
  if (al) al.addEventListener("change", () => { state.setLocal("autolock", Number(al.value)); toast("Сохранено", { icon: "check" }); });
  const pw = el.querySelector("#sec-pw");
  if (pw) pw.addEventListener("submit", async e => {
    e.preventDefault();
    const msg = el.querySelector("#sec-msg");
    const o = el.querySelector("#sec-old").value, n1 = el.querySelector("#sec-new1").value, n2 = el.querySelector("#sec-new2").value;
    if (n1 !== n2) { msg.className = "hub-hint hub-hint--error"; msg.innerHTML = `${H.icon("circle-alert")}Новые пароли не совпадают`; return; }
    try { await core.changePassword(o, n1); pw.reset(); msg.className = "hub-hint"; toast("Пароль сменён", { tone: "success", icon: "circle-check" }); }
    catch (err) { msg.className = "hub-hint hub-hint--error"; msg.innerHTML = `${H.icon("circle-alert")}${esc(err.message || err)}`; }
  });
}
