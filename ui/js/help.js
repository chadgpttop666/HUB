import { core, inTauri } from "./core.js";

const APP_PROMPT = `Сделай приложение для Хаба по приложенному APP_SPEC.md.
Задача: [опиши, что должно делать приложение и какие экраны нужны].
Верни ZIP с готовыми файлами. В корне архива или в одной общей папке должны лежать manifest.json и index.html. Используй Hub API для хранения данных, а для оформления — токены и компоненты из APP_SPEC.md.`;

const THEME_PROMPT = `Собери тему для Хаба.
Стиль, фон и цвета: [опиши тему или приложи фото].
Верни ZIP с theme.json и, если есть фон, файлом photo.jpg. Положи их в корень архива или в одну общую папку.
В theme.json укажи id (строчные латинские буквы, цифры и дефисы), name, base ("dark", "light" или "solid"), photo ("photo.jpg" или null), photoPosition (например "50% 38%"), greeting ("auto" или текст с {name}) и tokens — объект со строковыми значениями CSS-токенов без префикса --.
Для акцента используй accent, accent-hover, on-accent и accent-soft. Если есть фото, подбери scrim-top, scrim-mid, scrim-bottom и scrim-lock, чтобы текст был контрастным. Без фото задай bg. Не добавляй HTML или JavaScript.`;

export function driveGuide() {
  return `<details class="shell-guide">
    <summary>Как получить Client ID и Client Secret</summary>
    <ol>
      <li>Откройте <a href="https://console.cloud.google.com/" target="_blank" rel="noopener" data-external>Google Cloud Console</a> и создайте проект или выберите существующий.</li>
      <li>В этом проекте откройте <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener" data-external>Google Drive API</a> и нажмите «Включить».</li>
      <li>В Google Auth Platform нажмите «Начать» и укажите название приложения и контактный email в разделе Branding («Брендинг»). Если в Audience («Аудитория») выбран внешний доступ в режиме тестирования, добавьте свой Google-аккаунт в список тестовых пользователей.</li>
      <li>Откройте <a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noopener" data-external>Clients («Клиенты»)</a>, нажмите «Создать клиент» и выберите тип «Приложение для ПК» (Desktop app).</li>
      <li>Скопируйте Client ID и Client Secret. Если скачали JSON, нужные поля называются <code>client_id</code> и <code>client_secret</code> внутри <code>installed</code>.</li>
      <li>Вставьте значения в Хаб, нажмите кнопку входа в Google и подтвердите доступ в браузере. На втором устройстве используйте тот же аккаунт Google и ту же пару ключей.</li>
    </ol>
  </details>`;
}

export function aiGuide(kind) {
  const theme = kind === "theme";
  return `<details class="shell-guide">
    <summary>${theme ? "Как создать тему с нейросетью" : "Как создать приложение с нейросетью"}</summary>
    <ol>
      <li>${theme ? "Скопируйте запрос. Опишите цвет, фон, акцент и настроение. Можно приложить своё фото." : "Скачайте APP_SPEC.md и приложите его к чату с нейросетью. Скопируйте запрос и опишите задачу приложения."}</li>
      <li>Скачайте ZIP из ответа. Внутри должен быть ${theme ? "<code>theme.json</code> и файл фона, если он указан" : "<code>manifest.json</code> и <code>index.html</code>"}.</li>
      <li>На компьютере откройте «Настройки» Хаба, перетащите туда ZIP и подтвердите установку.</li>
    </ol>
    <div class="hub-btn-row">
      <button class="hub-btn hub-btn--sm" type="button" data-act="ai-${kind}">Показать и скопировать запрос</button>
      ${theme ? "" : '<a class="hub-btn hub-btn--sm" href="APP_SPEC.md" download="APP_SPEC.md">Скачать APP_SPEC.md</a>'}
    </div>
  </details>`;
}

export function showAiPrompt(kind, toast) {
  const theme = kind === "theme";
  const dlg = document.createElement("dialog");
  dlg.className = "hub-dialog";
  dlg.innerHTML = `<form method="dialog">
    <h2 class="hub-dialog__title">${theme ? "Запрос для темы" : "Запрос для приложения"}</h2>
    <textarea class="hub-textarea shell-prompt" aria-label="Текст запроса" rows="8" readonly></textarea>
    <div class="hub-dialog__actions"><button class="hub-btn hub-btn--quiet">Закрыть</button>
      <button class="hub-btn hub-btn--primary" type="button" id="copy-prompt">Скопировать запрос</button></div>
    </form>`;
  document.body.appendChild(dlg);
  const field = dlg.querySelector("textarea");
  field.value = theme ? THEME_PROMPT : APP_PROMPT;
  dlg.querySelector("#copy-prompt").addEventListener("click", async () => {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(field.value);
      else {
        field.select();
        if (!document.execCommand("copy")) throw new Error();
      }
      toast("Запрос скопирован", { icon: "check" });
    } catch {
      field.select();
      if (document.execCommand("copy")) toast("Запрос скопирован", { icon: "check" });
      else toast("Запрос выделен. Нажмите Ctrl+C или выберите «Копировать»", { icon: "info" });
    }
  });
  dlg.addEventListener("close", () => dlg.remove(), { once: true });
  dlg.showModal();
}

// В нативном окне Google Cloud открывается в системном браузере.
document.addEventListener("click", e => {
  const link = e.target.closest("a[data-external]");
  if (!inTauri || !link) return;
  e.preventDefault();
  core.openUrl(link.href).catch(() => window.open(link.href, "_blank", "noopener"));
});
