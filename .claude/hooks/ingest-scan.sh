#!/usr/bin/env bash
# Second Brain — авто-скан raw/ при старте сессии.
# Находит необработанные источники (нет соответствующих страниц в wiki/)
# и выводит в stdout задачу на автономный ingest (CLAUDE.md, режим «полностью сам»).
set -euo pipefail

REPO="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
RAW="$REPO/raw"
WIKI="$REPO/wiki"

[ -d "$RAW" ] || exit 0

seen=" "        # POSIX-совместимый «set» обработанных stem (bash 3.2 без declare -A)
new=()
while IFS= read -r f; do
  base="$(basename "$f")"
  case "$base" in
    .gitkeep|.DS_Store|inbox.md) continue ;;
  esac
  # принимаем любой формат: текст, pdf, html, картинки/скрины, видео, аудио
  case "$base" in
    *.md|*.markdown|*.txt|*.rtf|*.pdf|*.html|*.htm|*.epub) ;;
    *.png|*.jpg|*.jpeg|*.webp|*.gif|*.heic|*.tiff|*.bmp) ;;
    *.mp4|*.mov|*.m4v|*.webm|*.mkv|*.mp3|*.m4a|*.wav) ;;
    *) continue ;;
  esac
  stem="${base%.*}"
  # macOS хранит имена в Unicode NFD (й = и + ◌̆); нормализуем в NFC, иначе
  # grep по кириллическому имени не совпадёт с NFC-текстом вики-страниц.
  stem_nfc=$(printf '%s' "$stem" | perl -CS -MUnicode::Normalize -e 'local $/; print NFC(<STDIN>)' 2>/dev/null)
  [ -n "$stem_nfc" ] || stem_nfc="$stem"
  # уже обработан, если stem источника упоминается где-то в wiki/ (sources/ссылки)
  if grep -rqlF -- "$stem_nfc" "$WIKI" 2>/dev/null; then
    continue
  fi
  # не дублировать один источник, лежащий в нескольких форматах (pdf + md)
  case "$seen" in *" $stem_nfc "*) continue ;; esac
  seen="$seen$stem_nfc "
  new+=("${f#"$REPO"/}")
done < <(find "$RAW" -type f 2>/dev/null | sort)

if [ "${#new[@]}" -eq 0 ]; then
  echo "Second Brain: новых источников в raw/ нет."
  echo "Проактивно (если Кристина не дала задачу): предложи STATE-AWARE двухконтурный дайджест"
  echo "(CLAUDE.md → операция Digest). Кратко:"
  echo "  1) Проба состояния: mcp__health-kb__kb_search за ~3–7 дней (сон/recovery/strain/настроение + 05_decisions), состояние + ТРЕНД."
  echo "  2) Якоря рамки: wiki/«Обо мне» (Фокус/цели/ценности) + страницы с тегом «рамка»."
  echo "  3) Детектор улик: конкретное расхождение поведения с рамкой/правилом/целью. Нет улики → тихо."
  echo "  4) Вывод: Состояние · Тактика(single-loop, помечено) · РАМКА(только по улике: расхождение→вопрос→[[рефрейм]]→выбор) · Scout(источник под рамку) · Поднять забытое."
  echo "Правила: double-loop только по уликам и прямо; корреляции — НЕ payload. Приватность: health-контент не писать в wiki/, не коммитить. Не навязывай — предложи."
  exit 0
fi

echo "Second Brain — обнаружены НЕОБРАБОТАННЫЕ источники в raw/ (нет страниц в wiki/):"
for f in "${new[@]}"; do
  echo "  • $f"
done
echo ""
echo "ЗАДАЧА — ingest-конвейер с валидацией (CLAUDE.md, «Три операции»). Для КАЖДОГО файла:"
echo "0) ТРИАЖ: прочитай профиль wiki/«Обо мне», оцени пользу для Кристины → вердикт keep/skim/reject."
echo "   Явный шлак (reject) НЕ тащи в вики — занеси строкой в wiki/_отклонено.md. Пограничное — спроси."
echo "1) КРИТИКА: прочитай источник целиком, пометь спорное (> [!warning] Спорно + раздел «Под вопросом»)."
echo "2) ЗАПИСЬ: создай страницы (keep: 5–15, skim: конспект+ключевое) с frontmatter priority/benefit/verdict/disputed."
echo "3) Обнови wiki/index.md и wiki/log.md, проставь [[ссылки]]. Файлы в raw/ НЕ изменяй. В конце предложи git-коммит."
