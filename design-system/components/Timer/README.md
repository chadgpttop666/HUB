# Таймер

Обратный отсчёт с кольцом: учебные блоки, ограничение времени на карточку.

```html
<div class="hub-timer" data-state="running" style="--p:0.35" role="timer" aria-label="Осталось 16 минут">
  <svg class="hub-timer__ring" viewBox="0 0 100 100">
    <circle class="hub-timer__track" cx="50" cy="50" r="48"/>
    <circle class="hub-timer__value" cx="50" cy="50" r="48" pathLength="100"/>
  </svg>
  <div class="hub-timer__inner"><div class="hub-timer__time">16:12</div><div class="hub-timer__label">блок 2 из 4 · идёт</div></div>
</div>
```

Приложение передаёт: `--p` — долю прошедшего времени (0…1), текст времени, подпись и `data-state`:

- `running` — кольцо `accent`, цифры `text`;
- `paused` — кольцо и цифры `text-muted`, подпись «пауза»;
- `done` — кольцо полное, подпись «блок закончен», следующее действие — кнопкой;
- `idle` — `--p:0`, кнопка «Начать».

Цифры — Jost thin `font-size-5xl`, моноширинные. `hub-timer--sm` — 120px для боковой колонки. Управление под таймером: основная «Пауза / Продолжить» с клавишей Пробел и тихая «Сбросить». Обновляйте цифры раз в секунду, а `aria-label` — раз в минуту, чтобы не засыпать чтение с экрана.
