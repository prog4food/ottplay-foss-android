# Вики документации OTT-play

[English](Home.md) · [Русское руководство](../../README.ru.md) · [Все языки интерфейса](../readme/README.md)

Это версионируемый индекс документации в репозитории исходного кода. GitHub
показывает эти Markdown-файлы напрямую; инструкции, схемы и код проходят один
review. Отдельная [GitHub Wiki](https://github.com/open-ott-play/ottplay-foss/wiki)
публикуется из этих исходников; внизу каждой страницы указана ревизия.
[Как обновить публикацию](../wiki-publishing.md).

## Начало работы и установка

- [Полное практическое руководство RU](../../README.ru.md) и [EN](../../README.md).
- [Краткие инструкции для всех 88 языков](../readme/README.md): переведённые
  подписи интерфейса и шаги навигации. Это не 88 переводов инженерных руководств;
  подробные инструкции поддерживаются на английском и русском.
- [Android Full/API 22 и обновления](../android-distributions.md),
  [сборка Android](../../android/README.md), [Capacitor iOS/Android](../capacitor-mobile.md).
- [Локальная доставка macOS](../macos-local-delivery.md),
  [подпись и обновление Tauri](../tauri-updater-notarize.md),
  [локальные HTTP-инстансы](../local-http-deployment.md).

## Процесс и результат

- [Браузерная приёмка и проверка кандидата](../browser-compatibility.ru.md)
  ([English](../browser-compatibility.md)): цели проверок, цветные схемы,
  проверка точного пакета и отдельные локальные результаты.

- [Отчёт с цветными диаграммами](../implementation-report.ru.md)
  ([English](../implementation-report.md)): ход работы, исправленные ошибки,
  измерения и оставшиеся условия выпуска.

## Новые возможности

- [Реализованные функции и границы платформ](../roadmap-delivery.ru.md)
  ([English](../roadmap-delivery.md)).
- [Пределы качества, резервные потоки и восстановление эфира](../playback-stream-policy.ru.md)
  ([English](../playback-stream-policy.md)).
- [Ручная XMLTV-привязка и доступность классического интерфейса](../guide-binding-accessibility.ru.md)
  ([English](../guide-binding-accessibility.md)).
- [Проверка изображения и звука с here.now](../audio-video-check.ru.md)
  ([English](../audio-video-check.md)): **Информация → Звук → Воспроизвести**,
  ожидаемые тоны, схема хостинга и возврат к эфиру. Ролик загружается по запросу,
  требует интернета и отсутствует в пакетах плеера. Отдельное онлайн-демо
  с движущейся таблицей беззвучно.
- [Каталог фильмов и сериалов Xtream](../xtream-media.ru.md) ([English](../xtream-media.md)).
- [Handoff между плеерами одного источника](../remote-handoff.ru.md) ([English](../remote-handoff.md)).
- [Журнал настроек и восстановление](../settings-recovery.ru.md) ([English](../settings-recovery.md)).
- [Надёжное управление, возобновление профилей и handoff](https://github.com/open-ott-play/ottplay-control-server/blob/9b28c08eefca3948c78336e7e16a45e6fc492e31/docs/reliable-control.ru.md)
  ([English](https://github.com/open-ott-play/ottplay-control-server/blob/9b28c08eefca3948c78336e7e16a45e6fc492e31/docs/reliable-control.md)).
  Нужны согласованная версия контроллера/CLI и настроенные разрешения.
- [Сохранение языка и роли аудио/субтитров в нативном Android](https://github.com/open-ott-play/ottplay-android/blob/be0d8008c75b0badede7022dbb9096e11914227f/docs/TRACK-PREFERENCES.ru.md)
  ([English](https://github.com/open-ott-play/ottplay-android/blob/be0d8008c75b0badede7022dbb9096e11914227f/docs/TRACK-PREFERENCES.md)).
  Kotlin-приложение устанавливается отдельно от Capacitor APK этого репозитория.

## Источники, настройка и диагностика

- [Plex](../plex-provider.md), [серверная медиатека](../synology-library.md),
  [архитектура программы передач](../guide-architecture.md),
  [диагностика hosted EPG](../hosted-epg-diagnostics.md).
- [Оформление интерфейса](../interface-settings.md),
  [история и авторы тем](../interface-history.md), [локализация и клавиатуры](../localization.md).
- [Удалённая рабочая панель](../remote-workbench.md),
  [диагностика исполнения](../runtime-debug.md), [разрешения и очистка логов](../diagnostic-security.md).
- [Проверки нативных устройств](../mode-b-device-smoke.md),
  [Tauri](../mode-b-tauri-smoke.md), [оконные кнопки браузера](../browser-window-controls.md).

- [Измеренный объём новых функций](../roadmap-size.ru.md), исходные данные и SVG-график.

## Разработка и выпуски

- [Архитектура и владение ресурсами](../architecture.md),
  [сеансы воспроизведения](../playback-session-architecture.md),
  [сборка ES5](../build-pipeline.md), [имена ресурсов](../asset-layout.md).
- [Политика релизов](../../RELEASING.md), [инструкция оператора](../release-workflow.md),
  [фаззинг RC](../../FUZZING.md), [приватность](../privacy-policy.md), [лицензия MIT](../../LICENSE).

Если поменялись подписи интерфейса или общий шаблон краткого запуска, выполните
`npm run docs:generate`, затем `npm run check:docs`. Обновляйте EN/RU-руководства
парой. Ограничения платформ должны стоять рядом с описанием функции; локальные
тесты не заменяют проверки реального устройства. Схемы хранятся в репозитории:
[пример SVG привязки XMLTV](../images/guide-binding.svg). Проверка ссылок
подтверждает наличие локальных файлов, но не доступность внешних сайтов и не
все якоря заголовков Markdown.
