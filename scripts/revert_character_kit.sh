#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

restore_files=(
  "frontend/src/ChatPage.tsx"
  "frontend/src/ChatModules.tsx"
  "frontend/src/index.css"
  "frontend/src/components/Avatar.tsx"
  "app/static/dist/index.html"
  "app/static/dist/assets/index-RBcE9eHc.js"
  "app/static/dist/assets/index-BvpJ2KKL.css"
  "app/static/dist/avatar/idle.mp4"
  "app/static/dist/avatar/talking.mp4"
)

for path in "${restore_files[@]}"; do
  source="backup_before_kit/$path"
  if [[ ! -f "$source" ]]; then
    printf 'Missing backup file: %s\n' "$source" >&2
    exit 1
  fi
  cp "$source" "$path"
done

rm -f \
  frontend/src/speechPlan.ts \
  frontend/src/useSpeechController.ts \
  frontend/public/avatar/character.webp \
  frontend/public/avatar/character.png \
  frontend/public/avatar/avatar.json
if [[ -d frontend/public/avatar/mouths ]]; then
  rm -r frontend/public/avatar/mouths
fi

printf 'Restored %d files; removed the character-kit avatar assets.\n' "${#restore_files[@]}"
cd frontend
npm run build
