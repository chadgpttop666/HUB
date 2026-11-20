/* secret.js — кнопка «показать / скрыть» у каждого поля пароля.
   Встроенный глазок WebView2 (Edge) пропадает после первого использования, пока поле не перерисуется, —
   поэтому он скрыт в shell.css, а вместо него своя кнопка, которая работает всегда. */
const H = window.HubUI;

function enhance(input) {
  if (input.dataset.secretReady) return;
  input.dataset.secretReady = "1";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "hub-btn hub-btn--quiet hub-btn--icon hub-btn--sm shell-reveal";
  btn.setAttribute("aria-pressed", "false");
  const draw = shown => {
    btn.innerHTML = H.icon(shown ? "eye-off" : "eye", { label: shown ? "Скрыть пароль" : "Показать пароль" });
    btn.title = shown ? "Скрыть пароль" : "Показать пароль";
    btn.setAttribute("aria-pressed", String(shown));
  };
  draw(false);
  // нажатие не уводит фокус из поля: курсор остаётся на месте
  btn.addEventListener("pointerdown", e => e.preventDefault());
  btn.addEventListener("click", () => {
    const shown = input.type === "password";
    input.type = shown ? "text" : "password";
    draw(shown);
  });
  // перенос поля в обёртку снимает с него фокус — вернуть фокус и курсор на место
  const focused = document.activeElement === input;
  const [a, b] = [input.selectionStart, input.selectionEnd];
  const wrap = document.createElement("span");
  wrap.className = "shell-secret" + (input.classList.contains("hub-input--line") ? " shell-secret--line" : "");
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  wrap.appendChild(btn);
  if (focused) { input.focus(); try { input.setSelectionRange(a, b); } catch { /* ничего */ } }
}

export function watchSecrets() {
  const scan = root => (root.querySelectorAll ? root.querySelectorAll('input[type="password"]') : []).forEach(enhance);
  scan(document);
  new MutationObserver(list => {
    for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.matches('input[type="password"]')) enhance(n); else scan(n); }
  }).observe(document.body, { childList: true, subtree: true });
}
