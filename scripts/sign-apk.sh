#!/usr/bin/env bash
# Подписать APK постоянным ключом. Ключ один и тот же от сборки к сборке — иначе Android
# не даст поставить обновление поверх и придётся удалять приложение вместе с его данными.
# Ключ берётся из секрета ANDROID_KEYSTORE_BASE64 (пароль — ANDROID_KEYSTORE_PASSWORD),
# а если секрета нет — из $KEYSTORE (кэш CI); если нет и его — создаётся новый.
set -euo pipefail
IN=$1; OUT=$2
KEYSTORE=${KEYSTORE:-$HOME/.hub-keystore/hub.jks}
PASS=${ANDROID_KEYSTORE_PASSWORD:-hub-local-key}
mkdir -p "$(dirname "$KEYSTORE")"
if [ -n "${ANDROID_KEYSTORE_BASE64:-}" ]; then
  echo "$ANDROID_KEYSTORE_BASE64" | base64 -d > "$KEYSTORE"
elif [ ! -f "$KEYSTORE" ]; then
  echo "::warning::Секрета ANDROID_KEYSTORE_BASE64 нет — создан новый ключ подписи. Обновления встанут поверх, только пока жив кэш CI; см. docs/stage-2.md"
  keytool -genkeypair -keystore "$KEYSTORE" -storepass "$PASS" -keypass "$PASS" -alias hub -keyalg RSA -keysize 3072 -validity 20000 -dname "CN=Hub"
fi
BT=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)
"$BT/zipalign" -f -p 4 "$IN" "$OUT.aligned"
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass "pass:$PASS" --ks-key-alias hub --out "$OUT" "$OUT.aligned"
rm -f "$OUT.aligned"
"$BT/apksigner" verify --print-certs "$OUT" | head -3
