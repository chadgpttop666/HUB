# Фон и стекло

Фото темы на весь экран, вуаль и полупрозрачное стекло — основа всех экранов; рисует их только сам хаб.

```html
<div class="hub-backdrop" data-scene="open">
  <div class="hub-backdrop__photo"></div>
  <div class="hub-backdrop__veil"></div>
</div>
```

- `data-scene="lock"` — заставка: фото чёткое, мягкое пятно `scrim-lock` за часами и низ `scrim-bottom`.
- `data-scene="pass"` — ввод пароля: размытие `blur-lock`.
- `data-scene="open"` — после входа: размытие `blur-backdrop` и вуаль `scrim-top` → `scrim-mid` → `scrim-bottom`.
- Фото задаёт хаб: `--hub-photo: url(…)` на `<html>`. Нет фото — виден `bg`.
- `.hub-glass` — панель: `surface`, край `line-soft`, размытие `blur-glass`, скругление `radius`. `.hub-glass--strong` — `surface-strong` и тень `shadow-float`, только для того, что парит (диалог, меню, мини-окно).

Приложения фон не рисуют: их страница прозрачная, фото и вуаль уже под ними. Текст никогда не лежит прямо на фото — только на вуали нужной силы или на стекле.
