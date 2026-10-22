# Publishing the documentation wiki / Публикация вики

The source of truth is this repository: `docs/wiki` contains navigation, and
feature guides live under `docs`. Edit these sources in the same pull request as
the implementation. The export rewrites relative links, copies linked SVG images,
and pins other repository links to the selected source commit. It reads the committed
snapshot (HEAD by default), so uncommitted edits cannot be mislabeled as published code. It does not push
or delete anything, and it leaves other wiki pages untouched.

Источники находятся в этом репозитории: навигация — `docs/wiki`, руководства —
`docs`. Обновляйте их вместе с кодом. Экспорт исправляет относительные ссылки,
копирует SVG и привязывает остальные ссылки к выбранному коммиту. Сам экспорт
ничего не публикует и не удаляет; чужие страницы вики сохраняются.

From a clean, committed source checkout / Из чистого закоммиченного дерева:

```sh
npm run check:docs
git clone git@github.com:open-ott-play/ottplay-foss.wiki.git ../ottplay-wiki
node scripts/export-wiki.cjs ../ottplay-wiki
git -C ../ottplay-wiki diff --check
git -C ../ottplay-wiki diff --stat
# Review the changed pages, then publish / Проверьте изменения перед публикацией:
git -C ../ottplay-wiki add --all
git -C ../ottplay-wiki commit -m 'Update documentation from reviewed source'
git -C ../ottplay-wiki push
```

For an existing wiki checkout, fetch and fast-forward it before exporting.
The wiki must have its first page created through GitHub once, before cloning.
Check both the English and Russian home pages and the rendered SVG chart after
publishing. A published guide is not a claim that a beta or physical-device test
has completed; each feature guide documents its limits.

Существующий клон вики сначала обновите через fetch и fast-forward. До первого
клонирования создайте стартовую страницу в интерфейсе GitHub. После публикации
проверьте главные страницы EN/RU и отображение SVG. Публикация инструкции не
означает выпуск беты или успешную проверку на физическом устройстве: ограничения
указаны в руководствах.
