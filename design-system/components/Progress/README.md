# Прогресс

Сколько сделано из известного целого: полоса для непрерывного, шаги — для счётных частей вроде учебных блоков.

```html
<div class="hub-meter">
  <div class="hub-meter__head"><span>Сессия повторения</span><b>3 из 12</b></div>
  <progress class="hub-progress" max="12" value="3"></progress>
</div>
<div class="hub-steps" role="img" aria-label="1 из 4"><i class="is-done"></i><i class="is-current" style="--p:35%"></i><i></i><i></i></div>
```

- Полоса 6px: дорожка `surface-sunken`, заполнение `accent`, скругления `radius-pill`. Без `value` — бегущий блик (неизвестно, сколько ждать).
- Шаги `hub-steps`: сделанный — `accent`, текущий — заполнен на `--p`, будущий — пустой с контуром `line-soft`. До 8 шагов.
- Число всегда рядом словами («3 из 12»), не только полосой. Проценты — только для байтов и файлов.
