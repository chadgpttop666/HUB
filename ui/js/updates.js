import { core } from "./core.js";

let panel;
let available = null;
let busy = false;
let message = "";
let failed = false;

function refresh() {
  if (!panel?.isConnected) return;
  const check = panel.querySelector("[data-update=check]");
  const install = panel.querySelector("[data-update=install]");
  const status = panel.querySelector("[role=status]");
  if (check) check.disabled = busy;
  if (install) {
    install.disabled = busy;
    install.hidden = !available;
    install.textContent = available ? `Установить ${available.version}` : "";
  }
  const apply = panel.querySelector("[data-update=apply]");
  if (apply) {
    apply.disabled = busy;
    if (busy) apply.setAttribute("aria-busy", "true");
    else apply.removeAttribute("aria-busy");
  }
  status.textContent = message;
  status.classList.toggle("hub-hint--error", failed);
}

export function renderUpdates(el, currentVersion, mode) {
  const windows = mode === "windows";
  panel = el;
  panel.hidden = false;
  panel.innerHTML = `<h2 class="hub-section-title">Обновления Хаба</h2>
    <p class="hub-muted">Установленная версия <span data-current-version></span>. Новые версии скачиваются из GitHub Releases.</p>
    <div class="hub-btn-row">
      ${windows ? '<button class="hub-btn hub-btn--primary" type="button" data-update="apply">Обновить Хаб</button>' : `
        <button class="hub-btn" type="button" data-update="check">Проверить обновления</button>
        <button class="hub-btn hub-btn--primary" type="button" data-update="install" hidden></button>`}
    </div>
    <p class="hub-hint" role="status"></p>`;
  panel.querySelector("[data-current-version]").textContent = currentVersion;
  panel.addEventListener("click", async e => {
    const button = e.target.closest("[data-update]");
    if (!button || busy) return;
    const apply = button.dataset.update === "apply";
    const checking = apply || button.dataset.update === "check";
    if (!checking && !available) return;
    busy = true;
    failed = false;
    if (checking) available = null;
    message = checking ? "Проверяем GitHub…" : "Скачиваем и проверяем установщик…";
    refresh();
    try {
      if (checking) {
        available = await core.updateCheck();
        message = available
          ? `Доступна версия ${available.version} · ${Math.max(1, Math.round(available.size / 1048576))} МБ`
          : "Установлена актуальная версия";
      }
      if (!checking || (apply && available)) {
        if (apply) {
          message = `Скачиваем и проверяем версию ${available.version}. После обновления Хаб откроется снова.`;
          refresh();
        }
        const result = await core.updateInstall();
        message = apply ? "Устанавливаем обновление. Хаб откроется снова."
          : result === "permission"
            ? "Разрешите Хабу устанавливать приложения, вернитесь сюда и снова нажмите «Установить»"
            : "Открылся системный установщик. Подтвердите обновление";
      }
    } catch (err) {
      message = String(err.message || err);
      failed = true;
    } finally {
      busy = false;
      refresh();
    }
  });
  refresh();
}
