/* themes.js — своя тема из фото, по правилам design-system/01-themes.md.
   1. Фото размывается как фон хаба (blur-backdrop) и укладывается в окно 1440×900.
   2. Основа: медиана яркости ≥ 0.4 — светлая (тёмный текст), иначе тёмная.
   3. Вуали: для шапки, середины, низа и колонки входа — худший пиксель зоны (99-й процентиль яркости
      для тёмной основы, 1-й для светлой) и наименьшая непрозрачность вуали, при которой text-muted
      даёт 4.5:1 (часы на входе — text, 3:1).
   4. Акцент — один из проверенных наборов; text на нём и он на стекле — с проверкой контраста.
   Значения цветов здесь — данные темы (как в theme.json), а не стили интерфейса. */
import { core } from "./core.js";

const H = window.HubUI;
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const BASE = {
  dark: { veil: [6, 12, 9], text: [245, 239, 228], muted: [212, 204, 191], surface: [14, 22, 18] },
  light: { veil: [247, 243, 236], text: [24, 34, 28], muted: [69, 81, 74], surface: [250, 248, 243] },
};
export const ACCENTS = {
  dark: [
    { id: "dawn", name: "рассвет", accent: "#f0b46a", hover: "#f6c78d", on: "#24180b" },
    { id: "moss", name: "мох", accent: "#a8d5a2", hover: "#bfe2ba", on: "#13240f" },
    { id: "sea", name: "море", accent: "#8fc8e8", hover: "#acd8f0", on: "#0b1d28" },
    { id: "rose", name: "шиповник", accent: "#f2a7b8", hover: "#f6c0cc", on: "#2a0f16" },
  ],
  light: [
    { id: "dawn", name: "рассвет", accent: "#934a14", hover: "#7c3d0f", on: "#fff8ef" },
    { id: "moss", name: "мох", accent: "#2f6b3d", hover: "#255732", on: "#f4fff5" },
    { id: "sea", name: "море", accent: "#1d5f8a", hover: "#174d70", on: "#f2f9ff" },
    { id: "rose", name: "шиповник", accent: "#9c2f4f", hover: "#842640", on: "#fff4f6" },
  ],
};

const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
export const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const mix = (veil, px, a) => px.map((c, i) => Math.round(a * veil[i] + (1 - a) * c));

/* наименьшая вуаль, при которой цвет текста читается на пикселе */
export function minVeil(veil, textColor, px, target) {
  for (let a = 0; a <= 0.95; a += 0.01) if (contrast(textColor, mix(veil, px, a)) >= target) return Math.round(a * 100) / 100;
  return 0.95;
}

/* разбор фото: пиксели размытого фото в окне 1440×900 (в масштабе ¼) */
async function analyse(bitmap, posY) {
  const W = 360, Hh = 225, scale = 4;
  const c = document.createElement("canvas"); c.width = W; c.height = Hh;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const blur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--blur-backdrop")) || 32;
  const k = Math.max(W / bitmap.width, Hh / bitmap.height) * 1.06; // фото чуть больше окна, как у фона хаба
  const w = bitmap.width * k, h = bitmap.height * k;
  ctx.filter = `blur(${blur / scale}px)`;
  ctx.drawImage(bitmap, (W - w) / 2, (Hh - h) * posY, w, h);
  const data = ctx.getImageData(0, 0, W, Hh).data;
  const px = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
  const zone = (x0, y0, x1, y1) => {
    const out = [];
    for (let y = Math.floor(y0 / scale); y < Math.ceil(y1 / scale); y += 1) for (let x = Math.floor(x0 / scale); x < Math.ceil(x1 / scale); x += 1) out.push(px(x, y));
    return out.map(p => ({ p, l: luminance(p) })).sort((a, b) => a.l - b.l);
  };
  const all = zone(0, 0, 1440, 900);
  return {
    median: all[Math.floor(all.length / 2)].l,
    zones: { top: zone(0, 0, 1440, 120), mid: zone(0, 120, 1440, 600), bottom: zone(0, 600, 1440, 900), lock: zone(520, 180, 920, 560) },
  };
}

export function computeTokens(an, base, accent) {
  const B = BASE[base];
  const pick = list => (base === "dark" ? list[Math.floor(list.length * 0.99)] : list[Math.floor(list.length * 0.01)]).p;
  const rgba = a => `rgba(${B.veil.join(",")},${a.toFixed(2)})`;
  const scr = {
    top: minVeil(B.veil, B.muted, pick(an.zones.top), 4.5),
    mid: minVeil(B.veil, B.muted, pick(an.zones.mid), 4.5),
    bottom: minVeil(B.veil, B.muted, pick(an.zones.bottom), 4.5),
    lock: minVeil(B.veil, B.text, pick(an.zones.lock), 3),
  };
  const a = hex(accent.accent);
  const soft = base === "dark" ? 0.18 : 0.13;
  const tokens = {
    "scrim-top": rgba(scr.top), "scrim-mid": rgba(scr.mid), "scrim-bottom": rgba(scr.bottom), "scrim-lock": rgba(scr.lock),
    accent: accent.accent, "accent-hover": accent.hover, "on-accent": accent.on,
    "accent-soft": `rgba(${a.join(",")},${soft})`, selection: `rgba(${a.join(",")},${base === "dark" ? 0.34 : 0.22})`,
  };
  const checks = {
    accentOnGlass: contrast(a, B.surface),
    onAccent: contrast(hex(accent.on), a),
    heavy: Math.max(scr.top, scr.mid, scr.bottom) > 0.8,
  };
  return { tokens, scr, checks };
}

async function encodePhoto(bitmap) {
  const k = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bitmap.width * k); c.height = Math.round(bitmap.height * k);
  c.getContext("2d").drawImage(bitmap, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, "image/jpeg", 0.86));
}

const slug = s => (String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "theme").slice(0, 20);

/* Диалог «Новая тема из фото». ctx: { toast, afterSave(id), name } */
export function themeEditor(ctx) {
  const dlg = document.createElement("dialog");
  dlg.className = "hub-dialog";
  dlg.style.width = "min(620px, calc(100vw - 32px))";
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => { if (st.url) URL.revokeObjectURL(st.url); dlg.remove(); });
  const st = { bitmap: null, url: null, an: null, base: "auto", accent: "dawn", posY: 0.38, name: "", greeting: "" };

  function result() {
    if (!st.an) return null;
    const base = st.base === "auto" ? (st.an.median >= 0.4 ? "light" : "dark") : st.base;
    const accent = ACCENTS[base].find(x => x.id === st.accent) || ACCENTS[base][0];
    return Object.assign({ base, accent }, computeTokens(st.an, base, accent));
  }

  function draw() {
    const r = result();
    dlg.innerHTML = `<form method="dialog">
      <h2 class="hub-dialog__title">Новая тема из фото</h2>
      <p class="hub-dialog__body">Хаб сам подберёт основу и силу вуали, чтобы текст читался на любом месте фото.</p>
      <div style="display:grid;gap:var(--space-4);margin-top:var(--space-5)">
        <div class="hub-field"><span class="hub-label">Фото</span>
          <div class="hub-btn-row"><button class="hub-btn" type="button" id="te-pick"><i data-icon="image-plus"></i>${st.bitmap ? "Другое фото" : "Выбрать фото"}</button>
            <span class="hub-muted" style="font-size:var(--font-size-sm)">${st.bitmap ? `${st.bitmap.width}×${st.bitmap.height}` : "JPEG, PNG или WebP; лучше от 1920 по длинной стороне"}</span></div>
          <input type="file" id="te-file" accept="image/jpeg,image/png,image/webp" hidden></div>
        ${r ? `<div class="hub-theme__shot" data-theme="${r.base}" style="height:180px;--hub-photo:url('${st.url}');--hub-photo-pos:50% ${Math.round(st.posY * 100)}%;${Object.entries(r.tokens).map(([k, v]) => `--${k}:${v}`).join(";")};color:var(--text);background:var(--bg)">
            <div class="hub-backdrop" data-scene="open" style="position:absolute"><div class="hub-backdrop__photo" style="background-position:50% ${Math.round(st.posY * 100)}%"></div><div class="hub-backdrop__veil"></div></div>
            <div style="position:relative;padding:var(--space-4);display:grid;gap:var(--space-2)">
              <span style="font-size:var(--font-size-sm)">${esc(H.greeting(new Date()))}</span>
              <div class="hub-capture__bar" style="padding:var(--space-1) var(--space-3)"><i data-icon="lightbulb" class="hub-capture__icon"></i><span class="hub-muted" style="font-size:var(--font-size-sm);padding:var(--space-1) 0">Мысль в корзину…</span></div>
              <div style="display:flex;gap:var(--space-2)"><span class="hub-btn hub-btn--sm hub-btn--primary">Начать</span><span class="hub-tag hub-tag--accent">акцент</span></div>
            </div></div>
          <p class="hub-hint" style="margin:0">${H.icon(r.checks.heavy ? "triangle-alert" : "info")}основа: ${r.base === "dark" ? "тёмная" : "светлая"} (яркость ${Math.round(st.an.median * 100)}%) · вуаль сверху ${Math.round(r.scr.top * 100)}%, в середине ${Math.round(r.scr.mid * 100)}%, внизу ${Math.round(r.scr.bottom * 100)}%${r.checks.heavy ? " · фото пёстрое, вуаль сильная — можно сдвинуть фото или взять другое" : ""}</p>
          <div class="shell-form-row">
            <label class="hub-field"><span class="hub-label">Основа</span><span class="hub-select"><select id="te-base">
              ${[["auto", "сама по фото"], ["dark", "тёмная"], ["light", "светлая"]].map(([v, l]) => `<option value="${v}"${st.base === v ? " selected" : ""}>${l}</option>`).join("")}</select></span></label>
            <label class="hub-field" style="flex:1"><span class="hub-label">Положение фото по высоте</span>
              <input type="range" id="te-pos" min="0" max="100" value="${Math.round(st.posY * 100)}" style="width:100%"></label>
          </div>
          <div><span class="hub-label">Акцент</span><div class="hub-swatches" role="radiogroup" style="margin-top:var(--space-2)">${ACCENTS[r.base].map(a => `
            <button class="hub-swatch" type="button" role="radio" aria-checked="${a.id === r.accent.id}" aria-label="${a.name}" title="${a.name}" data-accent="${a.id}" style="--_c:${a.accent};background:${a.accent}"></button>`).join("")}</div>
            ${r.checks.accentOnGlass < 4.5 || r.checks.onAccent < 4.5 ? `<p class="hub-hint hub-hint--warning">${H.icon("triangle-alert")}акцент читается хуже 4.5:1</p>` : ""}</div>` : ""}
        <label class="hub-field"><span class="hub-label">Название</span><input class="hub-input" id="te-name" maxlength="30" value="${esc(st.name)}" placeholder="Например, Горы"></label>
        <label class="hub-field"><span class="hub-label">Приветствие</span><input class="hub-input" id="te-greet" maxlength="60" value="${esc(st.greeting)}" placeholder="по времени суток; можно своё, {name} — имя"></label>
      </div>
      <div class="hub-dialog__actions"><button class="hub-btn hub-btn--quiet" value="cancel">Отмена</button>
        <button class="hub-btn hub-btn--primary" type="button" id="te-save"${r ? "" : " disabled"}>Сохранить тему</button></div></form>`;
    H.icons(dlg);
    dlg.querySelector("#te-pick").addEventListener("click", () => dlg.querySelector("#te-file").click());
    dlg.querySelector("#te-file").addEventListener("change", async e => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        st.bitmap = await createImageBitmap(f);
        if (st.url) URL.revokeObjectURL(st.url);
        st.url = URL.createObjectURL(f);
        if (!st.name) st.name = f.name.replace(/\.[^.]+$/, "").slice(0, 30);
        st.an = await analyse(st.bitmap, st.posY);
        draw();
      } catch (err) { ctx.toast(`Фото не открылось: ${err.message || err}`, { tone: "danger", icon: "circle-alert" }); }
    });
    const keep = () => { st.name = dlg.querySelector("#te-name").value; st.greeting = dlg.querySelector("#te-greet").value; };
    const base = dlg.querySelector("#te-base");
    if (base) base.addEventListener("change", () => { keep(); st.base = base.value; draw(); });
    const pos = dlg.querySelector("#te-pos");
    if (pos) pos.addEventListener("change", async () => { keep(); st.posY = Number(pos.value) / 100; st.an = await analyse(st.bitmap, st.posY); draw(); });
    dlg.querySelectorAll("[data-accent]").forEach(b => b.addEventListener("click", () => { keep(); st.accent = b.dataset.accent; draw(); }));
    dlg.querySelector("#te-save").addEventListener("click", async () => {
      keep();
      const r = result();
      if (!r) return;
      const id = `${slug(st.name)}-${Math.random().toString(36).slice(2, 6)}`;
      const theme = {
        id, name: st.name.trim() || "Своя тема", base: r.base, photo: "photo.jpg",
        photoPosition: `50% ${Math.round(st.posY * 100)}%`, photoSource: "своё фото",
        greeting: st.greeting.trim() || "auto", tokens: r.tokens, custom: true, version: "1",
      };
      try {
        await core.set("hub", `themes/${id}/photo`, await encodePhoto(st.bitmap));
        await core.set("hub", `themes/${id}`, theme);
        dlg.close();
        await ctx.afterSave(id);
      } catch (err) { ctx.toast(`Тема не сохранилась: ${err.message || err}`, { tone: "danger", icon: "circle-alert" }); }
    });
  }
  draw();
  dlg.showModal();
}
