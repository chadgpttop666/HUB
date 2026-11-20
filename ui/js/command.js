/* command.js — командная строка Ctrl+K: приложение, команда или запись из корзины, не трогая мышь.
   ↑/↓ — выбор, Enter — открыть, Tab — к следующей группе, Esc — закрыть, Ctrl+Enter — в корзину как мысль.
   Набрано не в той раскладке — хаб предлагает исправленный запрос («ktdbfafy» → «левиафан»).

   ctx: {
     apps(): [{ id, name, icon }]          — в порядке меню
     items(): [{ id, text, tags }]         — корзина
     commands: [{ id, label, icon, keys?, meta?, run() }]
     recent(): [id приложения]             — последние открытые
     openApp(id), openItem(id), capture(text)
     iconHTML(icon)
   } */
const H = window.HubUI;
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LIMIT = 8;

/* раскладка: латиница ↔ кириллица по клавишам */
const EN = "`qwertyuiop[]asdfghjkl;'zxcvbnm,.";
const RU = "ёйцукенгшщзхъфывапролджэячсмитьбю";
export function switchLayout(s) {
  let out = "";
  for (const ch of String(s)) {
    const low = ch.toLowerCase(), up = ch !== low;
    let i = EN.indexOf(low), r = null;
    if (i >= 0) r = RU[i];
    else if ((i = RU.indexOf(low)) >= 0) r = EN[i];
    out += r == null ? ch : up ? r.toUpperCase() : r;
  }
  return out;
}

const norm = s => String(s).toLowerCase().replace(/ё/g, "е");
/* совпадение: по началу слова лучше, чем в середине; ничего — -1 */
function score(text, q) {
  const t = norm(text), i = t.indexOf(q);
  if (i < 0) return -1;
  return (i === 0 ? 3 : /[\s«"(#-]/.test(t[i - 1]) ? 2 : 1) * 1000 - Math.min(i, 999);
}
function mark(text, q) {
  const i = norm(text).indexOf(q);
  if (!q || i < 0) return esc(text);
  return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length));
}
const short = (s, n = 90) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function search(ctx, raw) {
  const q = norm(raw.trim());
  const groups = [];
  if (!q) {
    const recent = ctx.recent().map(id => ctx.apps().find(a => a.id === id)).filter(Boolean).slice(0, 4);
    if (recent.length) groups.push({ title: "Недавнее", rows: recent.map(a => ({ icon: a.icon, html: esc(a.name), meta: "приложение", run: () => ctx.openApp(a.id) })) });
    groups.push({ title: "Команды", rows: ctx.commands.map(c => ({ icon: c.icon, html: esc(c.label), meta: c.meta, keys: c.keys, run: c.run })) });
    return groups;
  }
  const pick = (list, text) => list.map(x => ({ x, s: score(text(x), q) })).filter(r => r.s >= 0).sort((a, b) => b.s - a.s).map(r => r.x);
  const apps = pick(ctx.apps(), a => a.name);
  if (apps.length) groups.push({ title: "Приложения", rows: apps.map(a => ({ icon: a.icon, html: mark(a.name, q), meta: "приложение", run: () => ctx.openApp(a.id) })) });
  const items = pick(ctx.items(), i => i.text + " " + (i.tags || []).map(t => "#" + t).join(" "));
  if (items.length) groups.push({ title: "Записи", rows: items.map(i => ({ icon: "inbox", html: mark(short(i.text), q), meta: "Корзина", run: () => ctx.openItem(i.id) })) });
  const cmds = pick(ctx.commands, c => c.label + " " + (c.words || ""));
  if (cmds.length) groups.push({ title: "Команды", rows: cmds.map(c => ({ icon: c.icon, html: mark(c.label, q), meta: c.meta, keys: c.keys, run: c.run })) });
  return groups;
}

const kbd = keys => (keys || []).map(k => `<kbd class="hub-kbd">${esc(k)}</kbd>`).join("");

export function openCommand(ctx) {
  const old = document.querySelector("dialog.hub-command");
  if (old && old.open) { old.querySelector("#cmd-q").focus(); return; }
  if (old) old.remove();   // закрывается прямо сейчас
  const dlg = document.createElement("dialog");
  dlg.className = "hub-dialog hub-command";
  dlg.setAttribute("aria-label", "Команды");
  dlg.style.marginTop = "12vh";
  dlg.innerHTML = `<label class="hub-command__search"><i data-icon="search"></i>
      <input id="cmd-q" placeholder="Приложение, команда или запись…" aria-label="Поиск" autocomplete="off" spellcheck="false"><kbd class="hub-kbd">Esc</kbd></label>
    <div class="hub-command__list" role="listbox" id="cmd-list"></div>
    <div class="hub-command__foot"><span>${kbd(["↑", "↓"])} выбрать</span><span>${kbd(["Enter"])} открыть</span><span>${kbd(["Tab"])} к следующей группе</span><span>${kbd(["Esc"])} закрыть</span></div>`;
  document.body.appendChild(dlg);
  H.icons(dlg);
  const input = dlg.querySelector("#cmd-q"), list = dlg.querySelector("#cmd-list");
  let rows = [], active = 0, groupStarts = [], alt = null;

  const done = fn => { dlg.close(); if (fn) setTimeout(fn, 0); };
  const toInbox = () => { const t = input.value.trim(); if (t) done(() => ctx.capture(t)); };

  function render() {
    const q = input.value;
    const groups = search(ctx, q);
    rows = []; groupStarts = []; alt = null;
    if (!groups.length) {
      const fixed = switchLayout(q.trim());
      alt = fixed && search(ctx, fixed).length ? fixed : null;
      list.innerHTML = `<div class="hub-empty"><i data-icon="search" class="hub-empty__icon"></i><h2 class="hub-empty__title" style="font-size:var(--font-size-2xl)">Ничего не нашлось</h2>
        <p class="hub-empty__text">${alt ? "Похоже, запрос набран в другой раскладке." : "Можно положить набранное в корзину, чтобы не пропало."}</p>
        <div class="hub-btn-row" style="justify-content:center;margin-top:var(--space-3)">
          ${alt ? `<button class="hub-btn hub-btn--primary" type="button" data-cmd="alt">Искать «${esc(alt)}» ${kbd(["Enter"])}</button>` : ""}
          <button class="hub-btn ${alt ? "hub-btn--quiet" : "hub-btn--primary"}" type="button" data-cmd="inbox">В корзину как мысль ${kbd(["Ctrl", "Enter"])}</button></div></div>`;
      H.icons(list);
      return;
    }
    let html = "";
    for (const g of groups) {
      html += `<div class="hub-menu__label">${esc(g.title)}</div>`;
      groupStarts.push(rows.length);
      for (const r of g.rows.slice(0, LIMIT)) {
        html += `<div class="hub-menu__item" role="option" data-row="${rows.length}">${ctx.iconHTML(r.icon)}<span>${r.html}</span>${r.keys ? `<span class="hub-menu__meta">${kbd(r.keys)}</span>` : r.meta ? `<span class="hub-menu__meta">${esc(r.meta)}</span>` : ""}</div>`;
        rows.push(r);
      }
      if (g.rows.length > LIMIT) html += `<div class="hub-menu__label" style="text-transform:none">ещё ${g.rows.length - LIMIT}</div>`;
    }
    if (q.trim()) {
      html += `<div class="hub-menu__label">Корзина</div><div class="hub-menu__item" role="option" data-row="${rows.length}"><i data-icon="lightbulb"></i><span>Положить «${esc(short(q.trim(), 40))}» в корзину как мысль</span><span class="hub-menu__meta">${kbd(["Ctrl", "Enter"])}</span></div>`;
      groupStarts.push(rows.length);
      rows.push({ run: () => ctx.capture(q.trim()) });
    }
    list.innerHTML = html;
    H.icons(list);
    active = Math.min(active, rows.length - 1);
    highlight();
  }
  function highlight() {
    list.querySelectorAll("[data-row]").forEach(el => {
      const on = Number(el.dataset.row) === active;
      el.classList.toggle("is-active", on);
      el.setAttribute("aria-selected", on ? "true" : "false");
      if (on) el.scrollIntoView({ block: "nearest" });
    });
  }
  input.addEventListener("input", () => { active = 0; render(); });
  dlg.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.preventDefault(); dlg.close(); return; }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); toInbox(); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (alt) { input.value = alt; active = 0; render(); return; }
      const r = rows[active];
      if (r) done(r.run);
      return;
    }
    if (!rows.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % rows.length; highlight(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + rows.length) % rows.length; highlight(); }
    else if (e.key === "Tab") {
      e.preventDefault();
      const dir = e.shiftKey ? -1 : 1;
      let gi = groupStarts.findLastIndex(s => s <= active);
      gi = (gi + dir + groupStarts.length) % groupStarts.length;
      active = groupStarts[gi]; highlight();
    }
  });
  list.addEventListener("click", e => {
    const b = e.target.closest("[data-cmd]");
    if (b) { if (b.dataset.cmd === "alt") { input.value = alt; active = 0; render(); input.focus(); } else toInbox(); return; }
    const row = e.target.closest("[data-row]");
    if (row && rows[Number(row.dataset.row)]) done(rows[Number(row.dataset.row)].run);
  });
  list.addEventListener("pointermove", e => {
    const row = e.target.closest("[data-row]");
    if (row && Number(row.dataset.row) !== active) { active = Number(row.dataset.row); highlight(); }
  });
  dlg.addEventListener("close", () => dlg.remove());
  dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });
  render();
  dlg.showModal();
  input.focus();
}
