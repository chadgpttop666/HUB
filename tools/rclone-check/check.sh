#!/usr/bin/env bash
# Этап 0 диздока: ведёт ли себя rclone как ожидается — двусторонняя синхронизация через crypt,
# конфликт, удаление, стоп-кран против массового удаления.
# Вместо Google Drive — локальная папка: логика bisync и crypt от вида хранилища не зависит
# (особенности самого Drive — время изменения, квоты — проверяются отдельно на живом диске).
#
# Запуск: tools/rclone-check/check.sh [путь к rclone]
# Настроек rclone на диске нет: всё задаётся переменными окружения, как это будет делать хаб.
set -u
RCLONE=${1:-rclone}
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
mkdir -p "$W/drive" "$W/pc" "$W/phone" "$W/state-pc" "$W/state-phone"

export RCLONE_CONFIG=/dev/null
export RCLONE_CONFIG_FAKEDRIVE_TYPE=local
export RCLONE_CONFIG_HUBCRYPT_TYPE=crypt
export RCLONE_CONFIG_HUBCRYPT_REMOTE="fakedrive:$W/drive"
export RCLONE_CONFIG_HUBCRYPT_PASSWORD=$("$RCLONE" obscure "пароль-для-проверки")
export RCLONE_CONFIG_HUBCRYPT_PASSWORD2=$("$RCLONE" obscure "соль-для-проверки")

ok=0; bad=0
pass() { echo "  ✓ $1"; ok=$((ok+1)); }
fail() { echo "  ✗ $1"; bad=$((bad+1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }
bisync() { # устройство, доп. флаги
  local dev=$1; shift
  "$RCLONE" bisync "$W/$dev" hubcrypt:folders/vault --workdir "$W/state-$dev" \
    --compare size,modtime,checksum --create-empty-src-dirs --resilient --recover \
    --conflict-resolve none --conflict-loser num --conflict-suffix sync-conflict \
    -q "$@" 2>"$W/log-$dev"
}

echo "rclone: $("$RCLONE" version | head -1)"

echo "1. Первая синхронизация ПК (пробный прогон, потом настоящий)"
for i in $(seq 1 10); do echo "заметка $i" > "$W/pc/note-$i.md"; done
mkdir -p "$W/pc/.obsidian"; echo '{}' > "$W/pc/.obsidian/app.json"
"$RCLONE" mkdir hubcrypt:folders/vault   # bisync требует, чтобы обе стороны существовали
bisync pc --resync --dry-run; check "пробный прогон ничего не отправил" '[ -z "$(find "$W/drive" -type f)" ]'
bisync pc --resync; code=$?; check "первая синхронизация прошла" '[ $code -eq 0 ]'
check "на «диске» нет ни одного открытого имени" '! find "$W/drive" -name "*note*" | grep -q .'
check "на «диске» нет открытого текста" '! grep -rq "заметка" "$W/drive"'
check "rclone читает обратно через crypt" '[ "$("$RCLONE" cat hubcrypt:folders/vault/note-3.md)" = "заметка 3" ]'

echo "2. Телефон подключается и получает всё"
bisync phone --resync
check "телефон получил 10 заметок" '[ "$(ls "$W/phone" | wc -l)" -eq 10 ]'

echo "3. Правки на разных устройствах в разных файлах сливаются сами"
sleep 1
echo "правка с ПК" >> "$W/pc/note-1.md"
echo "правка с телефона" >> "$W/phone/note-2.md"
echo "новая с телефона" > "$W/phone/new.md"
bisync pc; bisync phone; bisync pc
check "ПК видит правку телефона" 'grep -q "правка с телефона" "$W/pc/note-2.md"'
check "телефон видит правку ПК" 'grep -q "правка с ПК" "$W/phone/note-1.md"'
check "новый файл дошёл до ПК" '[ -f "$W/pc/new.md" ]'

echo "4. Один файл правят на обоих — сохраняются обе версии"
sleep 1
echo "версия ПК" > "$W/pc/note-5.md"
echo "версия телефона" > "$W/phone/note-5.md"
bisync pc; bisync phone; bisync pc
conflicts_pc=$(ls "$W/pc" | grep -c sync-conflict)
check "на ПК обе версии (найдено файлов-конфликтов: $conflicts_pc)" '[ "$conflicts_pc" -eq 2 ] && grep -rlq "версия ПК" "$W/pc" && grep -rlq "версия телефона" "$W/pc"'
check "исходное имя занято не молча (note-5.md нет, есть две копии)" '[ ! -f "$W/pc/note-5.md" ]'
ls "$W/pc" | grep sync-conflict | sed 's/^/      /'

echo "5. Удаление одного файла доходит до другого устройства"
rm "$W/pc/note-7.md"; bisync pc; bisync phone
check "на телефоне note-7 удалён" '[ ! -f "$W/phone/note-7.md" ]'

echo "6. Стоп-кран: массовое удаление"
total=$(find "$W/phone" -type f | wc -l)
rm "$W/phone"/note-*.md
gone=$(( total - $(find "$W/phone" -type f | wc -l) ))
bisync phone; code=$?
check "bisync отказался (код $code) — удалено $gone из $total файлов" '[ $code -ne 0 ]'
check "на «диске» файлы целы" '"$RCLONE" lsf hubcrypt:folders/vault | grep -q note-1'
grep -o 'Safety abort.*\|too many deletes.*' "$W/log-phone" | head -1 | sed 's/^/      /'
bisync phone --resync >/dev/null 2>&1   # «восстановить» телефон с диска: resync — объединение без удалений
check "resync вернул файлы телефону" '[ -f "$W/phone/note-1.md" ]'

echo "7. Порог стоп-крана (--max-delete, проценты)"
for pct in 10 50; do
  rm -rf "$W/t"; mkdir -p "$W/t/a" "$W/t/st"; for i in $(seq 1 20); do echo $i > "$W/t/a/f$i"; done
  "$RCLONE" mkdir "hubcrypt:t$pct"; "$RCLONE" bisync "$W/t/a" "hubcrypt:t$pct" --workdir "$W/t/st" --resync -q
  for i in $(seq 1 $((20*pct/100 + 1))); do rm "$W/t/a/f$i"; done
  "$RCLONE" bisync "$W/t/a" "hubcrypt:t$pct" --workdir "$W/t/st" --max-delete $pct -q 2>/dev/null; c1=$?
  check "--max-delete $pct: удаление $((20*pct/100 + 1)) из 20 остановлено" '[ $c1 -ne 0 ]'
done

echo
echo "Итог: $ok в порядке, $bad не в порядке"
[ $bad -eq 0 ]
