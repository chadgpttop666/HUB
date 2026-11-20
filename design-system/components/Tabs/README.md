# Вкладки и сегменты

Вкладки делят экран приложения на разделы; сегменты переключают вид одного и того же (период, сортировку).

```html
<div role="tablist" class="hub-tabs" data-hub-tabs aria-label="Повторение">
  <button class="hub-tab" role="tab" aria-selected="true" aria-controls="p-session">Сессия <span class="hub-tab__count">12</span></button>
  <button class="hub-tab" role="tab" aria-selected="false" aria-controls="p-stats" tabindex="-1">Статистика</button>
</div>
<section id="p-session" role="tabpanel">…</section>
```

- Выбранная вкладка — текст `text` и полоска `accent` 2px снизу, она переезжает `duration-base`. Остальные — `text-muted`.
- `data-hub-tabs` — hub-ui.js сам переключает `aria-selected`, прячет панели и даёт стрелки ←/→, Home, End.
- Число в вкладке — `hub-tab__count`, только если оно помогает выбрать.
- Сегменты `hub-segmented` — кнопки с `aria-pressed`, 2–4 коротких слова.
- До 5 вкладок. Больше — значит, это отдельные экраны или приложения.
