/* install.js — установка приложений и тем из папки или zip (этап 3).
   Перетащил в окно → хаб показывает, что приложение просит, и что в нём не по правилам → «Установить». */
import { core, inTauri } from "./core.js";

const H = window.HubUI;
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const size = n => (n > 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);

function dialog(html, wide) {
  const dlg = document.createElement("dialog");
  dlg.className = "hub-dialog";
  if (wide) dlg.style.width = "min(560px, calc(100vw - 32px))";
  dlg.innerHTML = html;
  document.body.appendChild(dlg);
  H.icons(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  return dlg;
}

const row = (icon, title, meta, tag) => `<li><div class="hub-row"><span class="hub-row__lead">${H.icon(icon)}</span>
  <span class="hub-row__body"><span class="hub-row__title">${esc(title)}${tag || ""}</span>${meta ? `<span class="hub-row__meta">${esc(meta)}</span>` : ""}</span></div></li>`;

/* Показать, что в пакете, и поставить по согласию. ctx: { toast, afterInstall(preview), openApp(id) } */
export async function installFromPath(path, ctx) {
  let p;
  try { p = await core.inspectPackage(path); }
  catch (e) { ctx.toast(`Не получилось прочитать: ${e.message || e}`, { tone: "danger", icon: "circle-alert", timeout: 8000 }); return; }
  const app = p.kind === "app";
  const what = app ? "приложение" : "тема";
  const verb = p.installed !== null && p.installed !== undefined ? "Обновить" : "Установить";
  const asks = app ? [
    row("database", "Свои данные", "видит только их; чужие данные и файлы на диске — нет"),
    ...p.accepts.map(a => row("inbox", "Приём из корзины", `«${a}»`)),
    ...(p.card ? [row("layout-grid", "Карточка на «Сегодня»", "запускается в фоне вместе с хабом")] : []),
    ...p.network.map(h => row("globe", "Доступ в сеть", h, ` <span class="hub-tag hub-tag--warning">${H.icon("triangle-alert")}сеть</span>`)),
  ] : [row("palette", "Фото и цвета", "для хаба и всех приложений сразу")];
  const dlg = dialog(`<form method="dialog">
    <div style="display:flex;gap:var(--space-4);align-items:flex-start">
      <span class="hub-app-icon">${H.icon(app ? (H.iconNames.includes(p.icon) ? p.icon : "package") : "palette")}</span>
      <div style="min-width:0"><h2 class="hub-dialog__title" style="margin:0">${esc(p.name || p.id || "Без названия")}</h2>
        <p class="hub-dialog__body">${esc([what, p.version ? (p.installed ? `было ${p.installed || "?"} → станет ${p.version}` : `версия ${p.version}`) : "", p.source, `${p.files} файлов, ${size(p.size)}`].filter(Boolean).join(" · "))}</p>
        ${p.description ? `<p class="hub-dialog__body" style="margin-top:var(--space-2)">${esc(p.description)}</p>` : ""}</div>
    </div>
    ${p.errors.length ? `<div style="margin-top:var(--space-5);display:grid;gap:var(--space-2)">${p.errors.map(e => `<p class="hub-hint hub-hint--error" style="margin:0">${H.icon("circle-alert")}${esc(e)}</p>`).join("")}
      <p class="hub-hint" style="margin:0">Хаб ничего не поставил. Поправьте по APP_SPEC.md и перетащите ещё раз.</p></div>` : `
    <p class="hub-label" style="margin:var(--space-5) 0 var(--space-1)">${app ? "Что просит" : "Что это"}</p>
    <ul class="hub-list hub-list--divided">${asks.join("")}</ul>
    ${app ? `<p class="hub-hint" style="margin-top:var(--space-3)">Никогда не получит: пароль и ключи хаба, Google Drive, другие приложения, файлы на диске${p.network.length ? "" : ", интернет"}.</p>` : ""}
    ${p.warnings.length ? `<div style="margin-top:var(--space-4);display:grid;gap:var(--space-2)">${p.warnings.map(w => `<p class="hub-hint hub-hint--warning" style="margin:0">${H.icon("triangle-alert")}${esc(w)}</p>`).join("")}
      <p class="hub-hint" style="margin:0">Работать будет, но выглядеть может не как хаб — стоит поправить по APP_SPEC.md.</p></div>` : ""}`}
    <div class="hub-dialog__actions"><button class="hub-btn hub-btn--quiet" value="cancel">${p.errors.length ? "Закрыть" : "Отмена"}</button>
      ${p.errors.length ? "" : `<button class="hub-btn hub-btn--primary" value="ok">${verb} <kbd class="hub-kbd">Enter</kbd></button>`}</div>
  </form>`, true);
  dlg.addEventListener("close", async () => {
    if (dlg.returnValue !== "ok") return;
    try {
      const id = await core.installPackage(path);
      await ctx.afterInstall(p);
      if (!app) { ctx.toast(`Тема «${p.name}» добавлена — выберите её в «Настройках»`, { tone: "success", icon: "circle-check" }); return; }
      const done = dialog(`<form method="dialog">
        <div style="display:flex;gap:var(--space-4);align-items:flex-start">${H.icon("circle-check", { className: "hub-icon--lg" })}
          <div><h2 class="hub-dialog__title" style="margin:0">«${esc(p.name)}» ${verb === "Обновить" ? "обновлено" : "установлено"}</h2>
          <p class="hub-dialog__body">Уже в меню приложений${p.accepts.length ? " и в разборе корзины" : ""}. С синхронизацией приедет на телефон.</p></div></div>
        <div class="hub-dialog__actions"><button class="hub-btn hub-btn--quiet" value="done">Готово</button><button class="hub-btn hub-btn--primary" value="open">Открыть</button></div></form>`);
      done.addEventListener("close", () => { if (done.returnValue === "open") ctx.openApp(id); });
    } catch (e) { ctx.toast(`Не установилось: ${e.message || e}`, { tone: "danger", icon: "circle-alert", timeout: 8000 }); }
  });
}

export async function pickAndInstall(kind, ctx) {
  const path = await core.pickPackage(kind);
  if (path) installFromPath(path, ctx);
}

export async function uninstall(app, ctx) {
  const dlg = dialog(`<form method="dialog">
    <h2 class="hub-dialog__title">Удалить «${esc(app.manifest.name || app.id)}»?</h2>
    <p class="hub-dialog__body">Приложение исчезнет из меню и разбора корзины — здесь и, после синхронизации, на телефоне.</p>
    <label class="hub-check" style="margin-top:var(--space-4)"><input type="checkbox" id="un-data"><span>Удалить и его данные</span></label>
    <div class="hub-dialog__actions"><button class="hub-btn hub-btn--quiet" value="cancel">Отмена</button><button class="hub-btn hub-btn--danger" value="ok">Удалить</button></div></form>`);
  dlg.addEventListener("close", async () => {
    if (dlg.returnValue !== "ok") return;
    try {
      await core.uninstallApp(app.id, dlg.querySelector("#un-data").checked);
      await ctx.afterInstall(null);
      ctx.toast(`«${app.manifest.name || app.id}» удалено`, { icon: "trash-2" });
    } catch (e) { ctx.toast(`Не удалилось: ${e.message || e}`, { tone: "danger", icon: "circle-alert" }); }
  });
}

/* Нативный WebView перехватывает системное перетаскивание до DOM-событий iframe. */
const repertoire = /\.(zip|json|md|markdown|txt|jpe?g|png|gif|webp|bmp|svg|avif|mp4|m4v|webm|mov|mkv|mp3|m4a|ogg|opus|wav|flac|aac)$/i;
const fileName = path => path.split(/[\\/]/).pop();
export function watchDrops(ctx) {
  if (!inTauri) return;
  let overlay, paths = [], destination;
  const show = ({ position } = {}) => {
    if (!ctx.unlocked() || !paths.length) return;
    const forRepetition = paths.every(path => repertoire.test(path)) && !!ctx.repetitionAt(position);
    if (overlay && destination === forRepetition) return;
    destination = forRepetition;
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "shell-drop";
      document.body.appendChild(overlay);
    }
    const name = paths.length === 1 ? fileName(paths[0]) : `Файлов: ${paths.length}`;
    overlay.innerHTML = `<div class="hub-drop"><i data-icon="${forRepetition ? "import" : "package"}"></i><h2 class="hub-drop__title">${forRepetition ? "Импортировать в «Повторение»" : "Установить приложение или тему"}</h2>
      <p class="hub-drop__text">${esc(name)}</p></div>`;
    H.icons(overlay);
  };
  const hide = () => { overlay?.remove(); overlay = null; paths = []; };
  core.onDragDrop({
    enter: payload => { paths = payload?.paths || []; show(payload); },
    over: show,
    leave: hide,
    async drop(payload) {
      hide();
      const dropped = payload?.paths || [];
      if (!ctx.unlocked() || !dropped.length) return;
      const target = dropped.every(path => repertoire.test(path)) && ctx.repetitionAt(payload.position);
      if (!target) {
        if (dropped.every(path => repertoire.test(path) && !/\.zip$/i.test(path))) {
          ctx.toast("Откройте «Повторение» и перетащите файл в область приложения", { icon: "info" });
        } else if (dropped.length === 1) await installFromPath(dropped[0], ctx);
        else ctx.toast("Для установки перетащите одну папку или ZIP", { icon: "info" });
        return;
      }
      try {
        if (dropped.length === 1 && /\.zip$/i.test(dropped[0]) && await core.droppedPackage(dropped[0])) {
          if (ctx.unlocked()) await installFromPath(dropped[0], ctx);
          return;
        }
        const files = [];
        let total = 0;
        for (const path of dropped) {
          const bytes = await core.readDroppedFile(path);
          const file = new File([bytes], fileName(path));
          total += file.size;
          if (total > 64 * 1024 * 1024) throw new Error("Файлы занимают больше 64 МБ. Откройте их через выбор файла в приложении");
          files.push(file);
        }
        ctx.importRepetition(target, files);
      } catch (err) {
        ctx.toast(String(err.message || err), { tone: "danger", icon: "circle-alert", timeout: 8000 });
      }
    },
  });
}
