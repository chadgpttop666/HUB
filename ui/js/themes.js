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
function analyse(bitmap, posX, posY, blur) {
  const W = 360, Hh = 225, scale = 4;
  const c = document.createElement("canvas"); c.width = W; c.height = Hh;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const k = Math.max(W / bitmap.width, Hh / bitmap.height) * 1.06; // фото чуть больше окна, как у фона хаба
  const w = bitmap.width * k, h = bitmap.height * k;
  ctx.filter = `blur(${blur / scale}px)`;
  ctx.drawImage(bitmap, (W - w) * posX, (Hh - h) * posY, w, h);
  const data = ctx.getImageData(0, 0, W, Hh).data;
  const px = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
  const zone = (x0, y0, x1, y1) => {
    const out = [];
    for (let y = Math.floor(y0 / scale); y < Math.ceil(y1 / scale); y += 2) for (let x = Math.floor(x0 / scale); x < Math.ceil(x1 / scale); x += 2) out.push(px(x, y));
    return out.map(p => ({ p, l: luminance(p) })).sort((a, b) => a.l - b.l);
  };
  const all = zone(0, 0, 1440, 900);
  return {
    median: all[Math.floor(all.length / 2)].l,
    zones: { top: zone(0, 0, 1440, 120), mid: zone(0, 120, 1440, 600), bottom: zone(0, 600, 1440, 900), lock: zone(520, 180, 920, 560) },
  };
}

export function computeTokens(an, base, accent, extraVeil = 0) {
  const B = BASE[base];
  const pick = list => (base === "dark" ? list[Math.floor(list.length * 0.99)] : list[Math.floor(list.length * 0.01)]).p;
  const rgba = a => `rgba(${B.veil.join(",")},${a.toFixed(2)})`;
  const strength = (zone, color, ratio) => {
    const minimum = minVeil(B.veil, color, pick(zone), ratio);
    return minimum + (1 - minimum) * extraVeil;
  };
  const scr = {
    top: strength(an.zones.top, B.muted, 4.5),
    mid: strength(an.zones.mid, B.muted, 4.5),
    bottom: strength(an.zones.bottom, B.muted, 4.5),
    lock: strength(an.zones.lock, B.text, 3),
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

/* шрифт крупного текста: Jost по умолчанию или Manrope, как основной текст */
export const FONTS = [["jost", "Jost — тонкий, как в хабе"], ["manrope", "Manrope — как основной текст"]];
const FONT_TOKEN = { manrope: "var(--font-body)" };

const BACKGROUND = { dark: "#0d1511", light: "#f4f1ea" };
const colorValue = h => typeof h === "string" && /^#[0-9a-f]{6}$/i.test(h) ? h : "";
const asHex = rgb => "#" + rgb.map(x => x.toString(16).padStart(2, "0")).join("");
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
function solidAnalysis(color) {
  const p = hex(color), l = luminance(p);
  const zone = [{ p, l }];
  return { median: l, zones: { top: zone, mid: zone, bottom: zone, lock: zone } };
}

export async function themeEditor(ctx, edit = null) {
  const dlg = document.createElement("dialog");
  dlg.className = "hub-dialog";
  dlg.style.width = "min(620px, calc(100vw - 32px))";
  const t = edit?.theme || {};
  const pos = String(t.photoPosition || "").match(/^(\d+)%\s+(\d+)%$/);
  const baseChoice = ["auto", "dark", "light"].includes(t.baseChoice) ? t.baseChoice : ({ dark: "dark", light: "light", solid: "dark" }[t.base] || "auto");
  const st = {
    bitmap: null, url: null, analysis: null, base: baseChoice,
    accent: t.accentId || "dawn", color: colorValue(t.accentColor || (!t.accentId && t.tokens?.accent)),
    posX: pos ? clamp(Number(pos[1]), 0, 100) : 50, posY: pos ? clamp(Number(pos[2]), 0, 100) : 38,
    blur: clamp(Number(t.blur ?? parseFloat(t.tokens?.["blur-backdrop"])) || 0, 0, 36),
    veil: clamp(Number(t.extraVeil) || 0, 0, 60),
    opacity: typeof t.surfaceOpacity === "number" ? clamp(t.surfaceOpacity, 20, 100) : null,
    background: colorValue(t.background || t.tokens?.bg), name: t.name || "",
    greeting: t.greeting && t.greeting !== "auto" ? t.greeting : "", font: t.font || "jost", photoChanged: false,
  };
  if (t.blur == null && !Number.isFinite(parseFloat(t.tokens?.["blur-backdrop"]))) st.blur = 22;
  const analysePhoto = () => {
    st.analysis = st.bitmap ? analyse(st.bitmap, st.posX / 100, st.posY / 100, st.blur) : null;
  };
  const removePhoto = () => {
    st.bitmap?.close();
    if (st.url) URL.revokeObjectURL(st.url);
    st.bitmap = st.url = st.analysis = null;
  };
  const loadPhoto = async photo => {
    const bitmap = await createImageBitmap(photo);
    removePhoto();
    st.bitmap = bitmap;
    st.url = URL.createObjectURL(photo);
    analysePhoto();
  };

  if (edit?.photo) {
    try { await loadPhoto(edit.photo); }
    catch (err) { ctx.toast(`Фото темы не открылось: ${err.message || err}`, { tone: "danger", icon: "circle-alert" }); return; }
  }
  if (edit?.copy) st.name = `${st.name} · своя`.slice(0, 30);

  function result() {
    const an = st.analysis || solidAnalysis(st.background || BACKGROUND[st.base] || BACKGROUND.dark);
    const base = st.base === "auto" ? (an.median >= 0.4 ? "light" : "dark") : st.base;
    const preset = ACCENTS[base].find(x => x.id === st.accent) || ACCENTS[base][0];
    const accent = st.color ? {
      id: "custom", accent: st.color,
      hover: asHex(mix(base === "light" ? [0, 0, 0] : [255, 255, 255], hex(st.color), 0.1)),
      on: contrast(hex(st.color), [0, 0, 0]) >= 4.5 ? "#000000" : "#ffffff",
    } : preset;
    const r = computeTokens(an, base, accent, st.veil / 100);
    const tokens = { ...(t.tokens || {}), ...r.tokens, "blur-backdrop": `${st.blur}px` };
    if (st.font === "jost") delete tokens["font-heading"];
    else if (FONT_TOKEN[st.font]) tokens["font-heading"] = FONT_TOKEN[st.font];
    if (st.background) tokens.bg = st.background;
    if (st.opacity !== null) {
      const rgb = BASE[base].surface.join(",");
      tokens.surface = `rgba(${rgb},${st.opacity / 100})`;
      tokens["surface-hover"] = `rgba(${rgb},${Math.min(1, (st.opacity + 12) / 100)})`;
    }
    return { ...r, tokens, base, accent };
  }

  const range = (id, label, value, max, min = 0) => `<label class="hub-field"><span class="hub-label">${label}</span>
    <input type="range" id="${id}" min="${min}" max="${max}" value="${value}"></label>`;
  function position() { return `${st.posX}% ${st.posY}%`; }

  function draw() {
    const r = result();
    dlg.innerHTML = `<form method="dialog">
      <h2 class="hub-dialog__title">${edit && !edit.copy ? `Тема «${esc(t.name)}»` : "Новая тема"}</h2>
      <div class="shell-theme-editor">
        <div class="hub-theme__shot shell-editor-preview" id="te-preview">
          <div class="hub-backdrop" data-scene="open"><div class="hub-backdrop__photo"></div><div class="hub-backdrop__veil"></div></div>
          <div class="shell-theme-preview__content">
            <span id="te-hello" class="t-display"></span>
            <div class="hub-glass shell-theme-preview__panel">Карточка приложения</div>
            <div><span class="hub-btn hub-btn--sm hub-btn--primary">Начать</span></div>
          </div>
        </div>
        <p class="hub-hint" id="te-report"></p>
        <div class="hub-btn-row">
          <button class="hub-btn" type="button" id="te-pick"><i data-icon="image-plus"></i>${st.bitmap ? "Заменить фото" : "Выбрать фото"}</button>
          ${st.bitmap ? '<button class="hub-btn hub-btn--quiet" type="button" id="te-remove-photo">Убрать фото</button>' : ""}
          <input type="file" id="te-file" accept="image/jpeg,image/png,image/webp" hidden>
        </div>
        <div class="shell-theme-controls">
          <label class="hub-field"><span class="hub-label">Основа</span><span class="hub-select"><select id="te-base">
            ${[["auto", "Автоматически"], ["dark", "Тёмная"], ["light", "Светлая"]].map(([v, l]) => `<option value="${v}"${st.base === v ? " selected" : ""}>${l}</option>`).join("")}</select></span></label>
          ${st.bitmap ? `${range("te-x", "Фото по ширине", st.posX, 100)}${range("te-pos", "Фото по высоте", st.posY, 100)}
            ${range("te-blur", "Размытие фото", st.blur, 36)}${range("te-veil", "Усиление вуали", st.veil, 60)}` :
            `<label class="hub-field"><span class="hub-label">Цвет фона</span><input type="color" id="te-bg" value="${st.background || BACKGROUND[r.base]}"></label>`}
          ${range("te-opacity", "Плотность карточек", st.opacity ?? (r.base === "light" ? 58 : 42), 100, 20)}
          <div><span class="hub-label">Готовые акценты</span><div class="hub-swatches" role="radiogroup" aria-label="Готовые акценты">${ACCENTS[r.base].map(a => `
            <button class="hub-swatch" type="button" role="radio" aria-checked="${a.id === r.accent.id}" aria-label="${a.name}" title="${a.name}" data-accent="${a.id}" style="--_c:${a.accent};background:${a.accent}"></button>`).join("")}</div></div>
          <label class="hub-field"><span class="hub-label">Свой акцент</span><input type="color" id="te-color" value="${r.accent.accent}"></label>
          <label class="hub-field"><span class="hub-label">Название</span><input class="hub-input" id="te-name" maxlength="30" value="${esc(st.name)}"></label>
          <label class="hub-field"><span class="hub-label">Приветствие</span><input class="hub-input" id="te-greet" maxlength="60" value="${esc(st.greeting)}" placeholder="По времени суток, {name} — имя"></label>
          <label class="hub-field"><span class="hub-label">Шрифт заголовков</span><span class="hub-select"><select id="te-font">
            ${FONTS.map(([v, l]) => `<option value="${v}"${st.font === v ? " selected" : ""}>${l}</option>`).join("")}</select></span></label>
        </div>
      </div>
      <div class="hub-dialog__actions"><button class="hub-btn hub-btn--quiet" value="cancel">Отмена</button>
        <button class="hub-btn hub-btn--primary" type="button" id="te-save">Сохранить тему</button></div></form>`;
    H.icons(dlg);
    const find = id => dlg.querySelector(`#${id}`);
    const preview = find("te-preview");
    function updatePreview() {
      const current = result();
      preview.dataset.theme = current.base;
      preview.removeAttribute("style");
      preview.style.setProperty("--hub-photo", st.url ? `url('${st.url}')` : "none");
      preview.style.setProperty("--hub-photo-pos", position());
      for (const [key, value] of Object.entries(current.tokens)) preview.style.setProperty(`--${key}`, value);
      find("te-hello").textContent = greetingText(st.greeting, ctx.name?.() || "");
      const report = find("te-report");
      const contrastWarning = current.checks.accentOnGlass < 4.5;
      report.textContent = `основа: ${current.base === "dark" ? "тёмная" : "светлая"}${contrastWarning ? " · для мелкого текста лучше выбрать более контрастный акцент" : ""}`;
      report.classList.toggle("hub-hint--warning", contrastWarning);
    }
    updatePreview();
    find("te-pick").addEventListener("click", () => find("te-file").click());
    find("te-file").addEventListener("change", async e => {
      const file = e.target.files[0];
      if (!file) return;
      const save = find("te-save");
      save.disabled = true;
      try {
        await loadPhoto(file);
        if (!dlg.open) { removePhoto(); return; }
        if (!st.name) st.name = file.name.replace(/\.[^.]+$/, "").slice(0, 30);
        st.photoChanged = true;
        draw();
      } catch (err) { ctx.toast(`Фото не открылось: ${err.message || err}`, { tone: "danger", icon: "circle-alert" }); }
      finally { save.disabled = false; }
    });
    find("te-remove-photo")?.addEventListener("click", () => { removePhoto(); st.photoChanged = true; draw(); });
    find("te-name").addEventListener("input", e => { st.name = e.target.value; });
    find("te-greet").addEventListener("input", e => { st.greeting = e.target.value; updatePreview(); });
    find("te-font").addEventListener("change", e => { st.font = e.target.value; updatePreview(); });
    find("te-base").addEventListener("change", e => { st.base = e.target.value; draw(); });
    for (const [id, key, analyseAgain] of [
      ["te-x", "posX", true], ["te-pos", "posY", true], ["te-blur", "blur", true],
      ["te-veil", "veil", false], ["te-opacity", "opacity", false],
    ]) {
      const input = find(id);
      input?.addEventListener("input", () => { st[key] = Number(input.value); updatePreview(); });
      if (analyseAgain) input?.addEventListener("change", () => { analysePhoto(); updatePreview(); });
    }
    find("te-bg")?.addEventListener("input", e => { st.background = e.target.value; updatePreview(); });
    find("te-bg")?.addEventListener("change", draw);
    find("te-color").addEventListener("input", e => {
      st.color = e.target.value;
      dlg.querySelectorAll("[data-accent]").forEach(b => b.setAttribute("aria-checked", "false"));
      updatePreview();
    });
    dlg.querySelectorAll("[data-accent]").forEach(b => b.addEventListener("click", () => { st.accent = b.dataset.accent; st.color = ""; draw(); }));
    const save = find("te-save");
    save.addEventListener("click", async () => {
      save.disabled = true;
      const r = result(), copy = !edit || edit.copy;
      const id = copy ? `${slug(st.name)}-${Math.random().toString(36).slice(2, 6)}` : t.id;
      const photoKey = `themes/${id}/photo`;
      const theme = {
        ...t, id, name: st.name.trim() || "Своя тема", base: r.base, photo: st.bitmap ? "photo.jpg" : null,
        photoPosition: position(), photoSource: st.bitmap ? (st.photoChanged ? "своё фото" : t.photoSource || "своё фото") : "",
        greeting: st.greeting.trim() || "auto", tokens: r.tokens, custom: true, version: t.version || "1",
        baseChoice: st.base, accentId: r.accent.id, accentColor: st.color,
        font: st.font, background: st.background, blur: st.blur, extraVeil: st.veil, surfaceOpacity: st.opacity,
      };
      try {
        if (st.bitmap && (copy || st.photoChanged)) {
          const photo = await encodePhoto(st.bitmap);
          if (!photo) throw new Error("Не удалось сохранить изображение");
          await core.set("hub", photoKey, photo);
        }
        await core.set("hub", `themes/${id}`, theme);
        if (!st.bitmap && st.photoChanged && !copy) await core.remove("hub", photoKey);
        dlg.close();
        await ctx.afterSave(id);
      } catch (err) { ctx.toast(`Тема не сохранилась: ${err.message || err}`, { tone: "danger", icon: "circle-alert" }); }
      finally { save.disabled = false; }
    });
  }
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => { removePhoto(); dlg.remove(); }, { once: true });
  draw();
  dlg.showModal();
}

/* Приветствие темы: "auto" или пусто — по времени суток; {name} — имя, без имени лишняя запятая убирается */
export function greetingText(greeting, name, now = new Date()) {
  const g = String(greeting || "").trim();
  if (!g || g === "auto") return H.greeting(now) + (name ? `, ${name}` : "");
  return g.replace(/\{name\}/g, name || "").replace(/\s*,\s*([!?.…]|$)/u, "$1").replace(/\s{2,}/g, " ").trim();
}
