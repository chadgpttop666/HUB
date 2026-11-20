# Диалог

Окно поверх экрана для одного решения: подтвердить необратимое или ввести одно-два значения.

```html
<dialog class="hub-dialog" aria-labelledby="d-title">
  <h2 class="hub-dialog__title" id="d-title">Удалить приложение «Чтение»?</h2>
  <p class="hub-dialog__body">Его данные останутся в архиве ещё 30 дней.</p>
  <div class="hub-dialog__actions">
    <button class="hub-btn hub-btn--quiet" value="cancel" formmethod="dialog">Отмена</button>
    <button class="hub-btn hub-btn--danger">Удалить</button>
  </div>
</dialog>
```

- Родной `<dialog>` и `showModal()`: фокус заперт внутри, Esc закрывает. Под ним — `::backdrop` с вуалью `scrim-mid` и размытием `blur-overlay`.
- Плотное стекло `surface-strong`, скругление `radius-xl`, тень `shadow-float`; появляется подъёмом за `duration-base`.
- Заголовок — вопрос или название действия. Текст — последствия. Кнопки справа: тихая «Отмена» слева от главной; главная называет действие («Удалить», а не «Да»).
- Для удаления одного элемента (запись, элемент корзины) диалог не нужен — удаляйте сразу и предлагайте «Отменить» в уведомлении.
