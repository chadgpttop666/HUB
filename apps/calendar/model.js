"use strict";

const pad = n => String(n).padStart(2, "0");
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseIso = s => new Date(s + "T12:00:00");
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const today = () => iso(new Date());
const monday = d => addDays(d, -(d.getDay() + 6) % 7);
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const validDate = d => typeof d === "string" && /^[2][0-9]{3}-[0-9]{2}-[0-9]{2}$/.test(d) && Number.isFinite(+parseIso(d)) && iso(parseIso(d)) === d;
const validTime = t => typeof t === "string" && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(t);
const mins = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const stamp = (d, t) => {
  const instant = new Date(d + "T" + t + ":00");
  return iso(instant) === d && hm(instant) === t ? +instant : NaN;
};
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const levels = { silent: "Тихое", normal: "Обычное", alarm: "Будильник" };
const colors = { study: "Учёба", work: "Работа", personal: "Личное" };

const MONTHS = ["январ", "феврал", "март", "апрел", "ма", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"];
const WEEK = { "понедельник": 1, "вторник": 2, "сред": 3, "четверг": 4, "пятниц": 5, "суббот": 6, "воскресень": 0 };
function parseText(text, base = new Date()) {
  let t = " " + text.replace(/(^|\s)#[\p{L}\p{N}_-]+/gu, " ") + " ", date = null, time = "";
  const take = re => { const m = t.match(re); if (m) t = t.replace(m[0], " "); return m; };
  let m;
  // время: «16:00», «в 16.30», «в 9»; «12.01» без «в» — это дата
  if ((m = take(/\s(?:в\s)?(\d{1,2}):(\d{2})(?=\s)/)) || (m = take(/\sв\s(\d{1,2})\.(\d{2})(?=\s)/))) time = `${pad(+m[1])}:${m[2]}`;
  else if ((m = take(/\sв\s(\d{1,2})(?:\s?ч(?:ас(?:а|ов)?)?)?(?=\s)/))) time = `${pad(+m[1])}:00`;
  if (take(/\sпослезавтра(?=\s)/i)) date = addDays(base, 2);
  else if (take(/\sзавтра(?=\s)/i)) date = addDays(base, 1);
  else if (take(/\sсегодня(?=\s)/i)) date = new Date(base);
  else if ((m = take(/\s(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?=\s)/))) {
    date = new Date(m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : base.getFullYear(), +m[2] - 1, +m[1]);
    if (!m[3] && date < addDays(base, -1)) date.setFullYear(date.getFullYear() + 1);   // «12.01» в ноябре — следующий январь
  }
  else if ((m = take(/\s(\d{1,2})\s([а-яё]+)(?=\s)/i)) && MONTHS.some(x => m[2].toLowerCase().startsWith(x))) {
    const mon = MONTHS.findIndex(x => m[2].toLowerCase().startsWith(x));
    date = new Date(base.getFullYear(), mon, +m[1]);
    if (date < addDays(base, -1)) date.setFullYear(date.getFullYear() + 1);
  } else if (m) { t = t + " " + m[0]; }   // «5 яблок» — не дата, вернуть в текст
  if (!date) for (const [w, n] of Object.entries(WEEK)) {
    const re = new RegExp(`\\s(?:в|во)\\s${w}[а-яё]*(?=\\s)`, "i");
    if (take(re)) { const d = new Date(base); d.setDate(d.getDate() + ((n - d.getDay() + 7) % 7 || 7)); date = d; break; }
  }
  const title = t.replace(/\s+/g, " ").trim().replace(/^[,.—-]\s*/, "");
  return { title: title ? cap(title) : "Событие", date: date ? iso(date) : null, time };
}


function normalize(raw) {
  const e = {
    title: typeof raw.title === "string" ? raw.title.trim() : "",
    date: raw.date ?? "",
    time: raw.time ?? "",
    endTime: raw.endTime ?? "",
    note: typeof raw.note === "string" ? raw.note.trim() : "",
    category: raw.category ?? "personal",
  };
  if (!e.title || e.title.length > 180 || e.note.length > 4000) throw Error("Укажите название до 180 знаков и заметку до 4000 знаков");
  if (e.date && !validDate(e.date)) throw Error("Уточните дату");
  if (e.time && !validTime(e.time)) throw Error("Уточните время начала");
  if (e.date && e.time && !Number.isFinite(stamp(e.date, e.time))) throw Error("Это время отсутствует в часовом поясе");
  if (e.endTime && (!validTime(e.endTime) || !e.time || e.endTime <= e.time || (e.date && !Number.isFinite(stamp(e.date, e.endTime))))) {
    throw Error("Укажите время окончания позже начала в тот же день");
  }
  if (!Object.hasOwn(colors, e.category)) throw Error("Укажите категорию study, work или personal");
  if (raw.reminder != null) {
    const { kind, minutes } = raw.reminder;
    if (!Object.hasOwn(levels, kind) || !Number.isInteger(minutes) || minutes < 0 || minutes > 10080) throw Error("Проверьте уровень и время напоминания");
    if (!e.date || !e.time) throw Error("Для напоминания нужны дата и время");
    e.reminder = { kind, minutes, at: stamp(e.date, e.time) - minutes * 60000 };
  }
  return e;
}

function interval(e) {
  if (!validTime(e.time)) return null;
  const start = mins(e.time);
  return [start, validTime(e.endTime) ? mins(e.endTime) : Math.min(1440, start + 30)];
}

function layoutIntervals(events) {
  const blocks = events.map(event => {
    const [start, end] = interval(event);
    return { event, start, end };
  }).sort((a, b) => a.start - b.start || b.end - a.end);
  let group = [], lanes = [], groupEnd = 0;
  const finish = () => { for (const block of group) block.lanes = lanes.length; };
  for (const block of blocks) {
    if (block.start >= groupEnd) {
      finish();
      group = [];
      lanes = [];
    }
    const open = lanes.findIndex(end => end <= block.start);
    block.lane = open < 0 ? lanes.length : open;
    lanes[block.lane] = block.end;
    groupEnd = group.length ? Math.max(groupEnd, block.end) : block.end;
    group.push(block);
  }
  finish();
  return blocks;
}

const signature = e => JSON.stringify([e.date || "", e.time || "", e.title.trim().toLocaleLowerCase("ru")]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function previewImport(text, events, allowedUpdates) {
  const trimmed = text.trim();
  if (trimmed.length > 1024 * 1024) throw Error("Максимальный размер ответа — 1 МБ");
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  let payload;
  try { payload = JSON.parse(fence ? fence[1] : trimmed); }
  catch { throw Error("Вставьте весь JSON из ответа нейросети"); }
  if (!payload || payload.version !== 1 || !Array.isArray(payload.events) || payload.events.length > 500) throw Error("Нужен ответ для Хаба формата 1, до 500 событий");
  if (payload.timeZone !== zone) throw Error(`В ответе нужен часовой пояс ${zone}. Скопируйте запрос снова`);
  const signatures = new Map([...events.values()].map(e => [signature(e), e.id]));
  const available = new Map(events);
  const updated = new Set();
  return payload.events.map((raw, index) => {
    const title = typeof raw?.title === "string" ? raw.title.slice(0, 180) : `Строка ${index + 1}`;
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("Ожидалось событие");
      const event = normalize(raw);
      if (!event.date) throw Error("Уточните дату перед добавлением");
      const id = raw.id ?? "";
      if (typeof id !== "string" || id && (!allowedUpdates.has(id) || !events.has(id) || updated.has(id))) throw Error("Выберите исходную запись для обновления");
      const before = id ? events.get(id) : null;
      const sig = signature(event);
      if (signatures.has(sig) && signatures.get(sig) !== id) return { title, event, error: "Такое событие уже есть" };
      const time = interval(event);
      const overlaps = time && [...available.values()].some(other => {
        const overlap = interval(other);
        return other.id !== id && other.date === event.date && overlap && time[0] < overlap[1] && time[1] > overlap[0];
      });
      if (id) {
        updated.add(id);
        signatures.delete(signature(before));
      }
      signatures.set(sig, id || `import-${index}`);
      available.set(id || `import-${index}`, { ...event, id: id || `import-${index}` });
      const past = event.reminder?.at <= Date.now();
      return { title, event, before, warning: [overlaps && "Пересечение по времени", past && "Время напоминания прошло"].filter(Boolean).join(" · ") };
    } catch (err) { return { title, error: err.message }; }
  });
}
