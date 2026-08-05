/* Shared EN/RU localization foundation for the Lak Corpus Explorer.
 *
 * Design
 *   - A single centrally-maintained dictionary (DICT) keyed by string id.
 *     Each key maps to { en, ru }. English is the fallback for any missing
 *     Russian string.
 *   - window.I18n exposes:
 *       t(key, vars)              → translated string with {var} interpolation
 *       plural(key, count, vars)  → correct plural form using Intl.PluralRules
 *       getLanguage() / setLanguage(lang)
 *       apply(root)               → translate a DOM subtree
 *       onChange(fn)              → subscribe to language changes
 *   - Language resolution order:
 *       1. explicit stored selection (localStorage "lang")
 *       2. browser navigator.language (only when no stored selection)
 *       3. default "en"
 *   - Selecting a language persists it and updates <html lang>.
 *   - In development, missing keys are reported with console.warn.
 *
 * DOM translation attributes (applied by apply() / on load):
 *   data-i18n="key"              → element textContent
 *   data-i18n-html="key"         → element innerHTML (for markup-bearing copy)
 *   data-i18n-placeholder="key"  → input/textarea placeholder
 *   data-i18n-aria="key"         → aria-label
 *   data-i18n-title="key"        → title attribute
 *
 * Never translate: original resource/source titles, Lak examples, quotes,
 * bibliographic titles, corpus content, IDs, URLs, canonical option values.
 * Those are left as literal markup with no data-i18n attributes.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'lang';
  var SUPPORTED = ['en', 'ru'];
  var DEFAULT_LANG = 'en';

  // Development detection for missing-key warnings.
  var IS_DEV = (function () {
    try {
      var h = location.hostname;
      return h === 'localhost' || h === '127.0.0.1' || h === '' ||
        /\.repl\.co$/.test(h) || /\.replit\.dev$/.test(h) ||
        /\.riker\.replit\.dev$/.test(h) || /\.picard\.replit\.dev$/.test(h);
    } catch (e) {
      return false;
    }
  })();

  /* ── Centralized dictionary ──────────────────────────────────── */
  var DICT = {
    /* Shared navigation */
    'nav.brand.name': { en: 'Lak Corpus', ru: 'Лакский корпус' },
    'nav.brand.explorer': { en: 'Explorer', ru: 'Обозреватель' },
    'nav.search': { en: 'Search', ru: 'Поиск' },
    'nav.sourceLibrary': { en: 'Sources', ru: 'Источники' },
    // "Ресурсы" (outside resources) against "Источники" (our own holdings) —
    // the same distinction the English labels draw, and short enough that both
    // fit the desktop nav in Russian.
    'nav.observatory': { en: 'Resource guide', ru: 'Ресурсы' },
    'nav.research': { en: "What's new", ru: 'Что нового' },
    'nav.lab': { en: 'Workspace', ru: 'Работа с переводами' },
    'nav.lab.short': { en: 'Workspace', ru: 'Переводы' },
    'nav.validate': { en: 'Check translations', ru: 'Проверить переводы' },
    'nav.leaderboard': { en: 'Leaderboard', ru: 'Рейтинг' },
    // Kept short on purpose: the desktop nav has no room for the longer
    // "О проекте и исследованиях" now that the Source Library sits in it.
    'nav.about': { en: 'About', ru: 'О проекте' },
    'nav.queue': { en: 'Reviewed', ru: 'Проверенные' },
    'nav.login': { en: 'Log in', ru: 'Войти' },
    'nav.primaryLabel': { en: 'Primary navigation', ru: 'Основная навигация' },
    'nav.openMenu': { en: 'Open menu', ru: 'Открыть меню' },
    'nav.closeMenu': { en: 'Close menu', ru: 'Закрыть меню' },
    'nav.menu': { en: 'Menu', ru: 'Меню' },
    'nav.close': { en: 'Close', ru: 'Закрыть' },

    /* Language toggle */
    'lang.label': { en: 'Language', ru: 'Язык' },
    'lang.en': { en: 'English', ru: 'Английский' },
    'lang.ru': { en: 'Russian', ru: 'Русский' },
    'lang.en.short': { en: 'EN', ru: 'EN' },
    'lang.ru.short': { en: 'RU', ru: 'RU' },
    'lang.switchTo.en': { en: 'Switch to English', ru: 'Переключить на английский' },
    'lang.switchTo.ru': { en: 'Switch to Russian', ru: 'Переключить на русский' },

    /* Auth link states */
    'auth.myProfile': { en: 'My profile', ru: 'Мой профиль' },
    'auth.loginSignup': { en: 'Log in / Sign up', ru: 'Войти / Регистрация' },
    'auth.reviewerPrefix': { en: 'Reviewer', ru: 'Рецензент' },
    'auth.yourProfile': { en: 'Your contributor profile', ru: 'Ваш профиль участника' },
    'auth.manageReviewer': { en: 'Manage reviewer session', ru: 'Управление сеансом рецензента' },
    'auth.loggedInContributor': {
      en: 'You are logged in as contributor <b>{name}</b> ({role}).',
      ru: 'Вы вошли как участник <b>{name}</b> ({role}).'
    },
    'auth.alsoReviewer': {
      en: ' You also hold a reviewer session as <b>{name}</b>.',
      ru: ' Вы также вошли как рецензент <b>{name}</b>.'
    },
    'auth.loggedInReviewer': {
      en: 'You are logged in as reviewer <b>{name}</b>. Your reviews will be attributed and marked as verified.',
      ru: 'Вы вошли как рецензент <b>{name}</b>. Ваши проверки будут подписаны и отмечены как подтверждённые.'
    },
    'auth.loginFailed': { en: 'Login failed', ru: 'Не удалось войти' },
    'auth.registrationFailed': { en: 'Registration failed', ru: 'Не удалось зарегистрироваться' },

    /* ── index.html (Search) ─────────────────────────────────── */
    'index.title': { en: 'Lak Corpus Explorer', ru: 'Обозреватель лакского корпуса' },
    'index.h1': { en: 'Lak Language Corpus', ru: 'Корпус лакского языка' },
    'index.subtitle': {
      en: 'Search Russian or Lak · every result shows its source and whether it has been checked',
      ru: 'Поиск по-русски или по-лакски · у каждого результата виден источник и проверен ли он'
    },
    'index.searchLabel': { en: 'Search (Russian or Lak)', ru: 'Поиск (по-русски или по-лакски)' },
    'index.searchPlaceholder': {
      en: 'e.g. луна, земля, спасибо, с днем рождения…',
      ru: 'напр. луна, земля, спасибо, с днем рождения…'
    },
    'index.recordType': { en: 'Record type', ru: 'Тип записи' },
    'index.type.both': { en: 'Texts + lexicon', ru: 'Тексты + лексикон' },
    'index.type.text': { en: 'Texts only', ru: 'Только тексты' },
    'index.type.lexicon': { en: 'Lexicon only', ru: 'Только лексикон' },
    'index.source': { en: 'Source', ru: 'Источник' },
    'index.source.all': { en: 'All sources', ru: 'Все источники' },
    'index.variety': { en: 'Lak variety', ru: 'Вариант лакского' },
    'index.variety.all': { en: 'All Lak varieties', ru: 'Все варианты лакского' },
    'variety.standard': { en: 'Standard', ru: 'Литературный' },
    'variety.arakul': { en: 'Arakul', ru: 'Аракульский' },
    'variety.balkhar': { en: 'Balkhar', ru: 'Балхарский' },
    'variety.shali': { en: 'Shali', ru: 'Шалинский' },
    'variety.historical': { en: 'Historical', ru: 'Исторический' },
    'variety.unspecified': { en: 'Unspecified', ru: 'Не указано' },
    'index.prev': { en: '← Previous', ru: '← Назад' },
    'index.next': { en: 'Next →', ru: 'Вперёд →' },
    'index.col.type': { en: 'Type / Quality', ru: 'Тип / Качество' },
    'index.col.lak': { en: 'Lak text / form', ru: 'Лакский текст / форма' },
    'index.col.meaning': { en: 'Meaning / document', ru: 'Значение / документ' },
    'index.col.source': { en: 'Source', ru: 'Источник' },
    'index.col.variety': { en: 'Lak variety', ru: 'Вариант лакского' },
    'index.col.review': { en: 'Check translation', ru: 'Проверить перевод' },
    'index.col.evidence': { en: 'Evidence', ru: 'Основания' },
    'index.research.kicker': { en: 'Research update', ru: 'Ход исследования' },
    'index.research.title': {
      en: 'A new batch of sources was audited — and none of it was added to this corpus',
      ru: 'Новая партия источников прошла проверку — и ничего из неё не добавлено в корпус'
    },
    'index.research.body': {
      en: 'See what the audit counted, how parallel Lak and Russian versions of the same work are found, and what has to happen before any of it can become public.',
      ru: 'Посмотрите, что подсчитал аудит, как находят параллельные лакские и русские версии одного произведения и что должно произойти, прежде чем это станет публичным.'
    },
    'index.research.cta': { en: 'Read the research update →', ru: 'Читать обновление исследования →' },

    /* ── observatory.html ────────────────────────────────────── */
    'obs.meta.title': {
      en: 'Lak Resource Observatory · Lak Corpus Explorer',
      ru: 'Обсерватория лакских ресурсов · Обозреватель лакского корпуса'
    },
    'obs.kicker': {
      en: 'Public catalogue of materials · 29 July 2026',
      ru: 'Публичный каталог материалов · 29 июля 2026'
    },
    'obs.h1': { en: 'Lak resource guide', ru: 'Каталог лакских материалов' },
    'obs.intro': {
      en: 'A guide to <strong>68 non-Bible materials</strong> for the Lak language: what exists, who holds it, what may be used, and the next careful step.',
      ru: 'Каталог <strong>68 небиблейских материалов</strong> по лакскому языку: что есть, у кого хранится, что можно использовать и каков следующий осторожный шаг.'
    },
    'obs.statsLabel': { en: 'Registry summary', ru: 'Сводка реестра' },
    'obs.method': {
      en: '<strong>How to read this register.</strong> Evidence status describes what has been confirmed: a held or processed item is locally accounted for; verified means the source was directly checked; a verified, contact, institutional, or local lead still requires follow-up; catalog-only records and discovery portals establish existence or point onward; a confirmed gap records an evidenced absence. Public access means discoverable, not automatically reusable. Rights text is preserved from the source ledger, while “permission-sensitive” is an operational flag for acquisition work requiring explicit permission, agreement, consent, or careful copying/reproduction review—not a legal conclusion. Public viewability never implies redistribution or model-training permission. Local provenance references are deliberately not published as web links. Bible-derived materials are excluded from the registry, acquisition guidance, corpus, and model recommendations.',
      ru: '<strong>Как читать этот реестр.</strong> Статус подтверждения описывает то, что уже установлено: имеющийся или обработанный материал учтён локально; «проверено» означает, что источник был проверен напрямую; проверенная, контактная, институциональная или локальная наводка всё ещё требует дальнейшей работы; записи только по каталогу и поисковые порталы подтверждают существование или указывают путь дальше; подтверждённый пробел фиксирует доказанное отсутствие. Публичный доступ означает обнаружимость, а не автоматическую возможность повторного использования. Текст о правах сохранён из исходного реестра, а «требует разрешения» — это рабочая пометка для работы по приобретению, требующей явного разрешения, соглашения, согласия либо тщательной проверки копирования/воспроизведения, а не юридический вывод. Публичная доступность для просмотра никогда не подразумевает разрешение на распространение или обучение моделей. Локальные ссылки о происхождении намеренно не публикуются в виде веб-ссылок. Материалы, производные от Библии, исключены из реестра, рекомендаций по приобретению, корпуса и рекомендаций для моделей.'
    },
    /* Private research layer (audited v1.2 sources) */
    'obs.private.sectionLabel': { en: 'Private research layer', ru: 'Закрытый исследовательский слой' },
    'obs.private.h2': { en: 'Private research layer', ru: 'Закрытый исследовательский слой' },
    'obs.private.intro': {
      en: 'Audited materials that are <strong>not part of the public corpus</strong>. Each one is held as a private research lead: it is not searchable here, not published, and not available for model training. This panel shows only what has been counted and checked — never the material itself.',
      ru: 'Проверенные материалы, которые <strong>не входят в публичный корпус</strong>. Каждый хранится как закрытая исследовательская наводка: он не участвует в поиске, не публикуется и не используется для обучения моделей. Здесь показано только то, что подсчитано и проверено, — но не сам материал.'
    },
    'obs.private.method': {
      en: '<strong>How to read this panel.</strong> “Expected” is the count recorded in the source audit; “staged” is how much has actually been imported after a machine-checked manifest passed verification. When no verified manifest is present in the workspace, nothing is imported and the expected count stays a claim about the source, not data we hold. Every staged item starts as private research, permission pending, unreviewed import and not training-ready; rights, access, review and training are four separate human decisions. Page-level OCR stays outside ordinary search until a person has checked it and rights are cleared. Audio is described only as a collection-level inventory — no file URLs, and no claim about alignment, speakers, dialect, consent or redistribution. Duplicates are linked as corroboration and never merged into corpus records. Bible-derived material is excluded throughout.',
      ru: '<strong>Как читать эту панель.</strong> «Ожидается» — это количество, зафиксированное при аудите источника; «подготовлено» — сколько действительно импортировано после того, как машинно проверяемый манифест прошёл проверку. Если проверенного манифеста в рабочей области нет, ничего не импортируется, а ожидаемое количество остаётся утверждением об источнике, а не данными, которыми мы располагаем. Каждая подготовленная запись начинается со статусов «закрытое исследование», «разрешение ожидается», «импорт не проверен» и «не готово к обучению»; права, доступ, проверка и обучение — четыре отдельных человеческих решения. Постраничный OCR остаётся вне обычного поиска, пока его не проверит человек и не будут урегулированы права. Аудио описано только как опись на уровне коллекции — без ссылок на файлы и без утверждений о выравнивании, дикторах, диалекте, согласии или распространении. Дубликаты связываются как подтверждение и никогда не сливаются с записями корпуса. Материалы, производные от Библии, исключены полностью.'
    },
    'obs.private.stat.sources': { en: 'Audited sources', ru: 'Проверенные источники' },
    'obs.private.stat.expected': { en: 'Expected records', ru: 'Ожидается записей' },
    'obs.private.stat.staged': { en: 'Staged privately', ru: 'Подготовлено закрыто' },
    'obs.private.stat.publicOrTraining': { en: 'Public or training-ready', ru: 'Публично или готово к обучению' },
    'obs.private.stat.corroborated': { en: 'Corroborating spellings', ru: 'Совпадающих написаний' },
    'obs.private.status.verified': { en: 'Source package verified', ru: 'Пакет источника проверен' },
    'obs.private.status.awaiting_manifest': { en: 'Awaiting verified package', ru: 'Ожидает проверенного пакета' },
    'obs.private.status.rejected': { en: 'Source package rejected', ru: 'Пакет источника отклонён' },
    'obs.private.layer.lexical_candidate': { en: 'Lexical candidates', ru: 'Лексические кандидаты' },
    'obs.private.layer.ocr_candidate': { en: 'Page-level OCR candidates', ru: 'Постраничные OCR-кандидаты' },
    'obs.private.layer.audio_inventory': { en: 'Audio inventory (metadata only)', ru: 'Опись аудио (только метаданные)' },
    'obs.private.layer.reference_metadata': { en: 'Linguistic reference metadata', ru: 'Метаданные лингвистического источника' },
    'obs.private.granularity.row': { en: 'Row-level provenance', ru: 'Происхождение на уровне строки' },
    'obs.private.granularity.page': { en: 'Page-level provenance', ru: 'Происхождение на уровне страницы' },
    'obs.private.granularity.collection': { en: 'Collection-level provenance', ru: 'Происхождение на уровне коллекции' },
    'obs.private.granularity.work': { en: 'Work-level provenance', ru: 'Происхождение на уровне издания' },
    'obs.private.fact.expected': { en: 'Expected from audit', ru: 'Ожидается по аудиту' },
    'obs.private.fact.staged': { en: 'Staged privately', ru: 'Подготовлено закрыто' },
    'obs.private.fact.reviewed': { en: 'Human-reviewed', ru: 'Проверено человеком' },
    'obs.private.fact.audio': { en: 'Audio inventory', ru: 'Опись аудио' },
    'obs.private.audioSummary': {
      en: '{files} WAV files · {seconds} seconds total · no file URLs published',
      ru: '{files} файлов WAV · {seconds} секунд всего · ссылки на файлы не публикуются'
    },
    'obs.private.badge.privateResearch': { en: 'Private research', ru: 'Закрытое исследование' },
    'obs.private.badge.permissionPending': { en: 'Permission pending', ru: 'Разрешение ожидается' },
    'obs.private.badge.unreviewed': { en: 'Import unreviewed', ru: 'Импорт не проверен' },
    'obs.private.badge.notTrainingReady': { en: 'Not training-ready', ru: 'Не готово к обучению' },
    'obs.private.badge.consentUnknown': { en: 'Consent unknown', ru: 'Согласие неизвестно' },
    'obs.private.badge.noBinaries': { en: 'No binaries served', ru: 'Файлы не выдаются' },
    'obs.private.badge.excludedFromSearch': { en: 'Excluded from search and exports', ru: 'Исключено из поиска и выгрузок' },
    'obs.private.blockedLabel': { en: 'Why nothing was imported', ru: 'Почему ничего не импортировано' },
    'obs.private.notImported': {
      en: 'The verified processed package for this source is not present or did not pass its integrity checks, so the audited count is shown as an expectation and no candidate was ingested.',
      ru: 'Проверенного обработанного пакета для этого источника нет или он не прошёл проверку целостности, поэтому подсчитанное при аудите число показано как ожидание, и ни один кандидат не был загружен.'
    },
    'obs.private.blocked.package_not_present': {
      en: 'The processed package for this source is not present in the workspace, so nothing was ingested and the audited count is shown as an expectation only.',
      ru: 'Обработанного пакета этого источника нет в рабочей области, поэтому ничего не загружено, а подсчитанное при аудите число показано только как ожидание.'
    },
    'obs.private.blocked.verification_failed': {
      en: 'The package for this source did not pass its integrity checks, so ingestion was stopped and the audited count is shown as an expectation only.',
      ru: 'Пакет этого источника не прошёл проверку целостности, поэтому загрузка остановлена, а подсчитанное при аудите число показано только как ожидание.'
    },
    'obs.private.corroboration': {
      en: '{forms} spellings occur in both lexical sources ({pairs} candidate pairs). They are linked as corroboration so a reviewer can compare them; the records stay separate and are never merged automatically. An identical spelling is not proof of an identical sense.',
      ru: '{forms} написаний встречаются в обоих лексических источниках ({pairs} пар кандидатов). Они связаны как взаимное подтверждение, чтобы проверяющий мог их сравнить; записи остаются раздельными и никогда не сливаются автоматически. Одинаковое написание не доказывает одинаковое значение.'
    },
    'obs.private.title.khaydakov_1962': {
      en: 'Khaydakov 1962 — Lak-Russian dictionary', ru: 'Хайдаков 1962 — Лакско-русский словарь'
    },
    'obs.private.title.lexcauc': {
      en: 'LexCauc Lak — structured lexical records', ru: 'LexCauc Lak — структурированные лексические записи'
    },
    'obs.private.title.dzhidalaev_1993': {
      en: 'Dzhidalaev 1993 — page-level OCR (Russian-Lak dictionary)',
      ru: 'Джидалаев 1993 — постраничный OCR (Русско-лакский словарь)'
    },
    'obs.private.title.lexcauc_audio': {
      en: 'LexCauc Lak — recording inventory', ru: 'LexCauc Lak — опись аудиозаписей'
    },
    'obs.private.title.reference_documents': {
      en: 'Reference documents — Anderson 1996, Kazenin 2013 and related',
      ru: 'Справочные издания — Anderson 1996, Казенин 2013 и связанные'
    },
    'obs.private.source.khaydakov_1962': {
      en: 'Lak-to-Russian dictionary entries held as private candidates for later human review. Senses and grammatical markup are kept as source entry text and have not been segmented.',
      ru: 'Записи лакско-русского словаря, хранящиеся как закрытые кандидаты для последующей проверки человеком. Значения и грамматическая разметка сохранены как исходный текст записи и не разделены.'
    },
    'obs.private.source.lexcauc': {
      en: 'Structured lexical candidates with Russian and English concepts, orthographic and phonemic forms, and row-level provenance. Kept out of the public corpus.',
      ru: 'Структурированные лексические кандидаты с русскими и английскими понятиями, орфографическими и фонемными формами и происхождением на уровне строки. Не входят в публичный корпус.'
    },
    'obs.private.source.dzhidalaev_1993': {
      en: 'Page-level OCR candidates. Line wrapping and recognition errors make automatic entry segmentation unsafe, so OCR stays outside ordinary search until a person has read it and rights are cleared.',
      ru: 'Постраничные OCR-кандидаты. Переносы строк и ошибки распознавания делают автоматическое разделение записей небезопасным, поэтому OCR остаётся вне обычного поиска, пока его не прочитает человек и не будут урегулированы права.'
    },
    'obs.private.source.lexcauc_audio': {
      en: 'Collection-level inventory of recordings. Metadata only: no audio is served, and nothing is claimed about alignment, speakers, dialect, consent or redistribution.',
      ru: 'Опись записей на уровне коллекции. Только метаданные: аудио не выдаётся, и ничего не утверждается о выравнивании, дикторах, диалекте, согласии или распространении.'
    },
    'obs.private.source.reference_documents': {
      en: 'Reference works — including Anderson 1996 and Kazenin 2013 — held as bibliographic metadata with file checksums, not as copied protected content.',
      ru: 'Справочные издания, включая Anderson 1996 и Казенина 2013, хранятся как библиографические метаданные с контрольными суммами файлов, а не как скопированный охраняемый текст.'
    },
    'obs.private.error.title': { en: 'The private layer summary is unavailable', ru: 'Сводка закрытого слоя недоступна' },
    'obs.private.error.body': {
      en: 'We could not load the private research summary. The material itself remains private either way.',
      ru: 'Не удалось загрузить сводку закрытого исследовательского слоя. Сами материалы в любом случае остаются закрытыми.'
    },
    'obs.registerLabel': { en: 'Resource register', ru: 'Реестр ресурсов' },
    'obs.searchLabel': { en: 'Search resources', ru: 'Поиск по ресурсам' },
    'obs.searchPlaceholder': {
      en: 'Title, creator, rights, action…',
      ru: 'Название, автор, права, действие…'
    },
    'obs.category': { en: 'Category', ru: 'Категория' },
    'obs.category.all': { en: 'All categories', ru: 'Все категории' },
    'obs.status': { en: 'Review status', ru: 'Статус проверки' },
    'obs.status.all': { en: 'All statuses', ru: 'Все статусы' },
    'obs.priority': { en: 'Priority', ru: 'Приоритет' },
    'obs.priority.all': { en: 'All priorities', ru: 'Все приоритеты' },
    'obs.viewsLabel': { en: 'Resource views', ru: 'Виды отображения ресурсов' },
    'obs.view.all': { en: 'All resources', ru: 'Все ресурсы' },
    'obs.view.acquisition': { en: 'Acquisition leads', ru: 'Наводки по приобретению' },
    'obs.view.contact': { en: 'Contact priorities', ru: 'Приоритеты для контакта' },
    'obs.loading': { en: 'Loading resources', ru: 'Загрузка ресурсов' },

    /* ── research.html (public research update) ──────────────── */
    'research.meta.title': { en: 'Research update · Lak Corpus Explorer', ru: 'Ход исследования · Обозреватель лакского корпуса' },
    'research.kicker': { en: 'Research update · what changed', ru: 'Ход исследования · что изменилось' },
    'research.h1': { en: 'What changed in this research round', ru: 'Что изменилось в этом этапе исследования' },
    'research.intro': {
      en: 'A new batch of source materials was audited, extracted and routed into a <strong>private research layer</strong>. Nothing on this page was added to the public corpus: these are counted candidates awaiting rights clearance and expert review.',
      ru: 'Новая партия исходных материалов прошла проверку, извлечение и была направлена в <strong>закрытый исследовательский слой</strong>. Ничего с этой страницы не добавлено в публичный корпус: это подсчитанные кандидаты, ожидающие урегулирования прав и экспертной проверки.'
    },
    'research.method': {
      en: '<strong>How to read these numbers.</strong> “Audited” is what the source audit recorded. “Staged” is what actually passed machine verification and was imported into the private layer. They are shown separately, and a number is only ever a count — no passage, filename or extracted line is published here.',
      ru: '<strong>Как читать эти числа.</strong> «По аудиту» — то, что зафиксировала проверка источников. «Загружено» — то, что действительно прошло машинную верификацию и попало в закрытый слой. Они показаны отдельно, и число остаётся только числом: ни отрывок, ни имя файла, ни извлечённая строка здесь не публикуются.'
    },
    'research.statsLabel': { en: 'Audited research aggregates', ru: 'Сводные показатели аудита' },
    'research.publicLabel': { en: 'Public corpus unchanged', ru: 'Публичный корпус без изменений' },
    'research.workflowLabel': { en: 'Discovery and review workflow', ru: 'Порядок поиска и проверки' },
    'research.familiesLabel': { en: 'Source families', ru: 'Группы источников' },
    'research.gateLabel': { en: 'Before anything becomes public', ru: 'Прежде чем что-либо станет публичным' },
    'research.loading': { en: 'Loading the research update…', ru: 'Загрузка обновления исследования…' },
    'research.value.unknown': { en: 'not counted yet', ru: 'пока не подсчитано' },
    'research.stat.sourceRoutes': { en: 'Files audited', ru: 'Проверено файлов' },
    'research.stat.rightsReviews': { en: 'Substantive materials', ru: 'Содержательных материалов' },
    'research.stat.extractions': { en: 'Usable extractions', ru: 'Пригодных извлечений' },
    'research.whatsnew.aria': { en: 'What is new', ru: 'Что нового' },
    'research.whatsnew.h2': { en: 'What’s new: the Lak Materials collection, described in the open', ru: 'Новое: коллекция лакских материалов, описанная открыто' },
    'research.whatsnew.credit': {
      en: 'We thank <strong>Professor Victor Friedman</strong> for sharing his Lak research collection with the project. The files themselves stay private while their rights are unresolved; what is now public is the <strong>analysis and derived research metadata</strong> — what every source is, what language and script it uses, how well its text could be extracted, and how it can strengthen the corpus in the future.',
      ru: 'Мы благодарим <strong>профессора Виктора Фридмана</strong> за то, что он поделился с проектом своей исследовательской коллекцией по лакскому языку. Сами файлы остаются закрытыми, пока не урегулированы права; открыты теперь <strong>анализ и производные исследовательские метаданные</strong> — что представляет собой каждый источник, на каком он языке и письме, насколько удалось извлечь текст и как он сможет усилить корпус в будущем.'
    },
    'research.whatsnew.public': {
      en: 'All 320 audited items are accounted for: 293 substantive sources catalogued one by one, and 27 system metadata receipts. No scans, documents, audio, paths or unreviewed passages are published or downloadable. One already-public source has new clarity: the PCMLBE corpus is now confirmed under a <strong>CC BY-SA 4.0</strong> license, credited to Erwin Komen and Radboud University.',
      ru: 'Учтены все 320 аудированных единиц: 293 содержательных источника описаны по одному, плюс 27 служебных файлов-квитанций. Сканы, документы, аудио, пути и непроверенные фрагменты не публикуются и не выдаются. По одному уже публичному источнику появилась ясность: корпус PCMLBE теперь подтверждён под лицензией <strong>CC BY-SA 4.0</strong> — Эрвин Комен, Радбаудский университет.'
    },
    'research.whatsnew.libraryLink': { en: 'Open the Source Library →', ru: 'Открыть библиотеку источников →' },
    'research.whatsnew.formsLink': { en: 'Browse the Lak word-form index →', ru: 'Открыть указатель словоформ →' },
    'research.stat.lexiconLines': { en: 'Lexicon candidate lines', ru: 'Строк — кандидатов в словарь' },
    'research.stat.textBlocks': { en: 'Text blocks', ru: 'Текстовых блоков' },
    'research.stat.grammarExamples': { en: 'Grammar-example candidates', ru: 'Кандидатов в грамматические примеры' },
    'research.stat.referenceRecords': { en: 'Reference records', ru: 'Справочных записей' },
    'research.public.h2': { en: 'The public corpus did not change', ru: 'Публичный корпус не изменился' },
    'research.public.body': {
      en: 'Everything counted above lives in the private research layer. It is not searchable on this site, not exported, and not used for training.',
      ru: 'Всё, что подсчитано выше, находится в закрытом исследовательском слое. Это не ищется на сайте, не выгружается и не используется для обучения моделей.'
    },
    'research.public.corpusRecords': { en: 'Public corpus records', ru: 'Записей в публичном корпусе' },
    'research.public.corpusRecordsNote': { en: 'unchanged by this research round', ru: 'этот этап их не изменил' },
    'research.public.observatory': { en: 'Resource guide entries', ru: 'Записей в каталоге материалов' },
    'research.public.observatoryNote': { en: 'counted separately from the corpus', ru: 'считаются отдельно от корпуса' },
    'research.public.added': { en: 'Records added to the public corpus', ru: 'Записей добавлено в публичный корпус' },
    'research.public.addedNote': { en: 'every candidate stays private', ru: 'все кандидаты остаются закрытыми' },
    'research.public.searchable': { en: 'Private candidates searchable here', ru: 'Закрытых кандидатов доступно для поиска' },
    'research.public.searchableNote': { en: 'excluded from search and exports', ru: 'исключены из поиска и выгрузок' },
    'research.verify.verified': { en: 'Package verified', ru: 'Пакет проверен' },
    'research.verify.blocked': { en: 'Package blocked — nothing staged', ru: 'Пакет заблокирован — ничего не загружено' },
    'research.verify.preparing': { en: 'Verification in progress', ru: 'Идёт проверка' },
    'research.verify.importing': { en: 'Staging in progress', ru: 'Идёт загрузка' },
    'research.verify.progress': {
      en: 'Staged {staged} of {declared} records — {done} of {total} layers',
      ru: 'Загружено {staged} из {declared} записей — {done} из {total} слоёв',
    },
    'research.verify.countsMatch': { en: 'Staged counts match the audit', ru: 'Загруженные числа совпадают с аудитом' },
    'research.verify.countsUnconfirmed': { en: 'Staged counts not confirmed against the audit', ru: 'Загруженные числа не подтверждены аудитом' },
    'research.table.measure': { en: 'Measure', ru: 'Показатель' },
    'research.table.audited': { en: 'Audited', ru: 'По аудиту' },
    'research.table.staged': { en: 'Staged', ru: 'Загружено' },
    'research.table.none': {
      en: 'Nothing has been staged yet, so only the audited expectations are shown.',
      ru: 'Пока ничего не загружено, поэтому показаны только ожидаемые числа из аудита.'
    },
    'research.workflow.h2': { en: 'How parallel sources are found — and what happens next', ru: 'Как находят параллельные источники и что происходит дальше' },
    'research.workflow.intro': {
      en: 'Some of these materials appear to exist in more than one version: the same work in Lak and in Russian, in Cyrillic and in Latin script, or as a recording with a transcription. A pair of versions is a <strong>lead, not a translation</strong>: two files sitting next to each other is not proof that their sentences correspond.',
      ru: 'Часть этих материалов, судя по всему, существует в нескольких версиях: одно и то же произведение на лакском и на русском, кириллицей и латиницей, или запись вместе с расшифровкой. Пара версий — это <strong>наводка, а не перевод</strong>: соседство двух файлов не доказывает, что их предложения соответствуют друг другу.'
    },
    'research.step.discover.title': { en: 'Spot the versions', ru: 'Заметить версии' },
    'research.step.discover.body': {
      en: 'Audited files are grouped into families when the same work appears more than once — two languages, two scripts, two editions, or a recording with its transcription.',
      ru: 'Проверенные файлы объединяются в группы, когда одно произведение встречается несколько раз: два языка, две графики, два издания или запись вместе с расшифровкой.'
    },
    'research.step.route.title': { en: 'Route, never merge', ru: 'Направить, но не сливать' },
    'research.step.route.body': {
      en: 'Each file is routed to a private candidate layer with its rights state attached. Nothing is merged into the corpus, and a duplicate is only ever linked as corroboration.',
      ru: 'Каждый файл направляется в закрытый слой кандидатов вместе со статусом прав. Ничего не сливается с корпусом, а дубликат лишь связывается как подтверждение.'
    },
    'research.step.pair.title': { en: 'Human pairing', ru: 'Сопоставление человеком' },
    'research.step.pair.body': {
      en: 'A person decides which passages actually correspond. Proximity of filenames is not evidence of sentence equivalence, so no automatic alignment is trusted.',
      ru: 'Человек решает, какие отрывки действительно соответствуют друг другу. Похожие имена файлов не доказывают равенство предложений, поэтому автоматическому сопоставлению не доверяют.'
    },
    'research.step.review.title': { en: 'Expert review and rights', ru: 'Экспертная проверка и права' },
    'research.step.review.body': {
      en: 'A pair becomes usable only after an expert approves it and the rights holder has cleared the source. Only then can it reach a public surface.',
      ru: 'Пара становится пригодной только после утверждения экспертом и разрешения правообладателя. Лишь тогда она может попасть на публичные страницы.'
    },
    'research.families.h2': { en: 'Strongest alignment opportunities', ru: 'Наиболее перспективные группы для сопоставления' },
    'research.families.intro': {
      en: 'These are the source families most likely to yield aligned Lak–Russian material once permission and review are settled. Each card shows <strong>metadata only</strong> — how many files the family holds, how the versions were spotted, and what still has to happen. No passage, title page or extracted line from these materials appears on any public page.',
      ru: 'Это группы источников, которые скорее всего дадут сопоставленный лакско-русский материал, когда будут получены разрешения и пройдена проверка. Каждая карточка показывает <strong>только метаданные</strong>: сколько файлов в группе, как были замечены версии и что ещё предстоит сделать. Ни отрывок, ни титульный лист, ни извлечённая строка из этих материалов не публикуются.'
    },
    'research.families.empty.title': { en: 'No source families to show yet', ru: 'Пока нет групп источников' },
    'research.families.empty.body': { en: 'Families appear here once a package has been verified.', ru: 'Группы появятся здесь после проверки пакета.' },
    'research.family.lak_russian_epics': { en: 'Lak and Russian epic versions', ru: 'Эпос: лакские и русские версии' },
    'research.family.ttul_daghustan': { en: 'Gamzatov — Ttul Daghustan versions', ru: 'Гамзатов — версии «Ттул Дагъусттан»' },
    'research.family.authier_tales': { en: 'Authier — Lak tales in Cyrillic and Latin', ru: 'Отье — лакские сказки кириллицей и латиницей' },
    'research.family.tolstoy_versions': { en: 'Tolstoy in Lak — Cyrillic and Latin versions', ru: 'Толстой на лакском — версии кириллицей и латиницей' },
    'research.family.lorca': { en: 'García Lorca — Lak and Russian versions', ru: 'Гарсиа Лорка — лакская и русская версии' },
    'research.family.eleonora_materials': { en: 'Eleonora — transcription and translation material', ru: 'Материалы Элеоноры — расшифровки и переводы' },
    'research.family.war_pilot': { en: 'War — Russian/Lak pilot set', ru: '«Война» — пилотный русско-лакский набор' },
    'research.familyKind.parallel_language_versions': { en: 'Two languages, one work', ru: 'Два языка, одно произведение' },
    'research.familyKind.edition_versions': { en: 'Several editions of one work', ru: 'Несколько изданий одного произведения' },
    'research.familyKind.script_versions': { en: 'Two scripts, one text', ru: 'Две графики, один текст' },
    'research.familyKind.translated_work_versions': { en: 'Translated work in several versions', ru: 'Переводное произведение в нескольких версиях' },
    'research.familyKind.fieldwork_transcription': { en: 'Fieldwork material with transcription', ru: 'Полевой материал с расшифровкой' },
    'research.method.paired_language_files': { en: 'Spotted as paired language files', ru: 'Замечено как парные языковые файлы' },
    'research.method.multiple_editions_of_one_work': { en: 'Spotted as repeated editions', ru: 'Замечено как повторяющиеся издания' },
    'research.method.cyrillic_latin_script_pair': { en: 'Spotted as a Cyrillic/Latin pair', ru: 'Замечено как пара кириллица/латиница' },
    'research.method.translated_work_version_set': { en: 'Spotted as versions of a translated work', ru: 'Замечено как версии переводного произведения' },
    'research.method.transcription_translation_pair': { en: 'Spotted as transcription with translation', ru: 'Замечено как расшифровка с переводом' },
    'research.route.private_text_segments': { en: 'Held as private text candidates', ru: 'Хранится как закрытые текстовые кандидаты' },
    'research.status.unreviewed_alignment_candidate': { en: 'Alignment candidate — unreviewed', ru: 'Кандидат на сопоставление — не проверено' },
    'research.rights.permission_pending': { en: 'Permission pending', ru: 'Разрешение ожидается' },
    'research.access.private_research': { en: 'Private research', ru: 'Закрытое исследование' },
    'research.family.files': { en: '{count} files in this family', ru: '{count} файлов в этой группе' },
    'research.family.candidateFiles': { en: '{count} produced candidates', ru: '{count} дали кандидатов' },
    'research.family.countsPending': { en: 'File counts pending verification', ru: 'Подсчёт файлов ждёт проверки' },
    'research.family.before': { en: 'Before anything here becomes public', ru: 'Прежде чем это станет публичным' },
    'research.family.noContent': {
      en: 'Metadata only — no passage, page image or extracted line from this family is published.',
      ru: 'Только метаданные: ни отрывок, ни изображение страницы, ни извлечённая строка из этой группы не публикуются.'
    },
    'research.blocking.rights_clearance': { en: 'Rights clearance', ru: 'Урегулирование прав' },
    'research.blocking.human_pairing_map': { en: 'Human pairing map', ru: 'Сопоставление, сделанное человеком' },
    'research.blocking.expert_review': { en: 'Expert review', ru: 'Экспертная проверка' },
    'research.blockingBody.rights_clearance': {
      en: '— the rights holder has to agree, in writing, to publication and reuse.',
      ru: '— правообладатель должен письменно согласиться на публикацию и повторное использование.'
    },
    'research.blockingBody.human_pairing_map': {
      en: '— a person has to record which passages correspond, passage by passage.',
      ru: '— человек должен зафиксировать, какие отрывки соответствуют друг другу, отрывок за отрывком.'
    },
    'research.blockingBody.expert_review': {
      en: '— an expert has to approve each pair before it counts as evidence.',
      ru: '— эксперт должен утвердить каждую пару, прежде чем она станет доказательством.'
    },
    'research.gate.h2': { en: 'Before any of this could become public', ru: 'Прежде чем что-либо из этого станет публичным' },
    'research.gate.footer': {
      en: 'Until every step is complete for a given source, its material stays private: not searchable, not published, not exported, and not used for training. The public corpus grows only through material that is already clear to publish.',
      ru: 'Пока для источника не пройдены все шаги, его материал остаётся закрытым: не ищется, не публикуется, не выгружается и не используется для обучения. Публичный корпус пополняется только тем, что уже разрешено публиковать.'
    },
    'research.error.title': { en: 'The research summary could not be loaded', ru: 'Не удалось загрузить сводку исследования' },
    'research.error.body': {
      en: 'Nothing is missing from the corpus — only this summary is unavailable. Please try again later.',
      ru: 'С корпусом всё в порядке — недоступна только эта сводка. Пожалуйста, попробуйте позже.'
    },

    /* ── about.html ──────────────────────────────────────────── */
    'about.meta.title': { en: 'About & Research — Lak Corpus Explorer', ru: 'О проекте и исследованиях — Обозреватель лакского корпуса' },
    'about.h1': { en: 'About the Lak Corpus', ru: 'О лакском корпусе' },
    'about.hero.p': {
      en: 'A publicly accessible, source-aware research corpus of the Lak language (лакку маз), built for linguists, Lak speakers, and computational researchers. Every record is traceable to its original source and carries an explicit quality state.',
      ru: 'Общедоступный исследовательский корпус лакского языка (лакку маз) с учётом источников, созданный для лингвистов, носителей лакского языка и специалистов по компьютерной лингвистике. Каждая запись прослеживается до своего первоисточника и имеет явно указанный статус качества.'
    },
    'about.stats.h2': { en: 'Corpus statistics', ru: 'Статистика корпуса' },
    'about.stats.documents': { en: 'Documents', ru: 'Документы' },
    'about.stats.segments': { en: 'Segments', ru: 'Сегменты' },
    'about.stats.tokens': { en: 'Tokens', ru: 'Токены' },
    'about.stats.lexicon': { en: 'Lexicon entries', ru: 'Записи лексикона' },
    'about.stats.p1': {
      en: 'Tokens are counted as space-delimited, punctuation-stripped word forms. The lexicon includes all forms recorded across standard, Arakul, Balkhar, Shali, and historical varieties plus Uslar 1890 OCR material.',
      ru: 'Токены подсчитываются как разделённые пробелами словоформы без учёта пунктуации. Лексикон включает все формы, зафиксированные в литературной, аракульской, балхарской, шалинской и исторической разновидностях, а также материал Услара 1890 года, полученный с помощью OCR.'
    },
    'about.stats.p2': {
      en: '<strong>Corpus version:</strong> v1.0 — research preview, released 29 July 2026. Counts above are live from the running corpus.',
      ru: '<strong>Версия корпуса:</strong> v1.0 — исследовательская предварительная версия, выпущена 29 июля 2026 года. Приведённые выше показатели берутся в реальном времени из работающего корпуса.'
    },
    'about.sources.h2': { en: 'Sources', ru: 'Источники' },
    'about.sources.col.source': { en: 'Source', ru: 'Источник' },
    'about.sources.col.type': { en: 'Type', ru: 'Тип' },
    'about.sources.col.variety': { en: 'Variety / period', ru: 'Разновидность / период' },
    'about.sources.col.quality': { en: 'Quality', ru: 'Качество' },
    'about.sources.col.notes': { en: 'Notes', ru: 'Примечания' },
    'about.sources.pcmlbe.type': { en: 'Annotated text corpus', ru: 'Аннотированный текстовый корпус' },
    'about.sources.pcmlbe.variety': { en: 'Unspecified / mixed', ru: 'Не указано / смешанное' },
    'about.sources.pcmlbe.notes': {
      en: 'Parallel Corpus of Mountain Languages of the North-East Caucasus; 41 source files; primary prose and poetry texts. Imported in bulk; individual records have not been human-checked. Licensed CC BY-SA 4.0 — credit Erwin Komen, Radboud University; ShareAlike applies to reuse.',
      ru: 'Параллельный корпус горских языков Северо-Восточного Кавказа; 41 файл; в основном проза и поэзия. Загружен целиком; отдельные записи не проверены человеком. Лицензия CC BY-SA 4.0 — указывайте Эрвина Комена, Радбаудский университет; при повторном использовании действует ShareAlike.'
    },
    'about.sidebar.pcmlbeLink': { en: 'PCMLBE — Erwin Komen, Radboud University (CC BY-SA 4.0)', ru: 'PCMLBE — Эрвин Комен, Радбаудский университет (CC BY-SA 4.0)' },
    'about.sources.wiki.type': { en: 'Encyclopedic text', ru: 'Энциклопедический текст' },
    'about.sources.wiki.notes': {
      en: '1,068 Wikipedia articles, 3,606 sentences. Community-written; orthographic consistency varies.',
      ru: '1 068 статей Википедии, 3 606 предложений. Написаны сообществом; орфографическая согласованность варьируется.'
    },
    'about.sources.digiev.type': { en: 'Parallel phrasebook', ru: 'Параллельный разговорник' },
    'about.sources.digiev.variety': { en: 'Standard (colloquial)', ru: 'Литературный (разговорный)' },
    'about.sources.digiev.notes': {
      en: '5,383 Russian–Lak phrase pairs. Practical travel and everyday vocabulary.',
      ru: '5 383 русско-лакских пары фраз. Практическая лексика для путешествий и повседневного общения.'
    },
    'about.sources.ids.type': { en: 'Lexicon', ru: 'Лексикон' },
    'about.sources.ids.variety': { en: 'Standard + dialects', ru: 'Литературный + диалекты' },
    'about.sources.ids.notes': {
      en: 'Intercontinental Dictionary Series; four files; comparative Caucasian vocabulary organised by semantic field. Imported in bulk; individual records have not been human-checked.',
      ru: 'Intercontinental Dictionary Series; четыре файла; сравнительная кавказская лексика, организованная по семантическим полям. Импортирована массово; отдельные записи не проверялись человеком.'
    },
    'about.sources.uslar.type': { en: 'Historical grammar / lexicon', ru: 'Историческая грамматика / лексикон' },
    'about.sources.uslar.variety': { en: 'Historical (19th c.)', ru: 'Исторический (XIX в.)' },
    'about.sources.uslar.notes': {
      en: "Peter von Uslar's 1890 grammar of Lak, digitised via OCR. Archaic orthography, possible scan errors. <strong>Not silently modernised.</strong> All entries are preserved exactly as extracted and marked explicitly as OCR-sourced. Coverage is partial: roughly 1,469 records (≈6% of the corpus) from selected portions of the grammar — not a complete digitisation — and no entry has been individually verified against the scan.",
      ru: 'Грамматика лакского языка Петра фон Услара 1890 года, оцифрованная методом OCR. Архаичная орфография, возможны ошибки сканирования. <strong>Не подвергалась незаметной модернизации.</strong> Все записи сохранены точно в том виде, в каком были извлечены, и явно помечены как полученные с помощью OCR. Охват частичный: около 1 469 записей (≈6 % корпуса) из отдельных частей грамматики — это не полная оцифровка — и ни одна запись не была проверена по скану в отдельности.'
    },
    'about.method.h2': { en: 'Methodology', ru: 'Методология' },
    'about.method.p1': {
      en: '<strong>Translation-first search.</strong> When a Russian query term appears in the alias dictionary (built from the Digiev phrasebook and IDS lexicon), the system expands it to all known Lak equivalents and searches corpus text for those forms. This surfaces concordance examples even when the user doesn\'t know the Lak spelling. Direct substring search runs as a fallback for terms not in the alias dictionary.',
      ru: '<strong>Поиск «сначала перевод».</strong> Когда русский поисковый запрос присутствует в словаре соответствий (составленном по разговорнику Digiev и лексикону IDS), система расширяет его до всех известных лакских эквивалентов и ищет эти формы в текстах корпуса. Это позволяет находить конкордансные примеры, даже когда пользователь не знает лакского написания. Прямой поиск по подстроке используется как запасной вариант для терминов, отсутствующих в словаре соответствий.'
    },
    'about.method.p2': {
      en: '<strong>Script normalisation.</strong> All queries and corpus text are normalised with Unicode NFKC before matching. Cyrillic е and ё are treated as equivalent. Multiple codepoint representations of the Lak palochka (Ӏ U+04C0, Latin I, Ukrainian І U+0406, and modifier letter vertical line ӏ U+04CF) are all mapped to the canonical Ӏ (U+04C0) for search. This ensures that OCR artefacts and encoding inconsistencies in the source data do not produce false negatives.',
      ru: '<strong>Нормализация письма.</strong> Все запросы и текст корпуса нормализуются по Unicode NFKC перед сопоставлением. Кириллические е и ё считаются равнозначными. Различные кодовые представления лакской палочки (Ӏ U+04C0, латинская I, украинская І U+0406 и модификатор вертикальной черты ӏ U+04CF) отображаются в канонический символ Ӏ (U+04C0) для поиска. Это гарантирует, что артефакты OCR и несогласованности кодировки в исходных данных не приводят к ложным пропускам.'
    },
    'about.method.p3': {
      en: '<strong>Quality states.</strong> Each record carries an explicit quality label. The ladder below explains what each state means and what work remains.',
      ru: '<strong>Статусы качества.</strong> Каждая запись имеет явную пометку о качестве. Приведённая ниже лестница поясняет, что означает каждый статус и какая работа остаётся.'
    },
    'about.method.p4': {
      en: '<strong>No silent modernisation.</strong> The Uslar 1890 OCR material is preserved verbatim. We do not apply spelling normalisation, diacritic correction, or other post-processing that would alter the historical linguistic record. Errors visible in the data are genuine scan artefacts or orthographic conventions of the period.',
      ru: '<strong>Никакой незаметной модернизации.</strong> OCR-материал Услара 1890 года сохранён дословно. Мы не применяем нормализацию орфографии, исправление диакритики или иную постобработку, которая изменила бы исторический языковой памятник. Ошибки, видимые в данных, — это подлинные артефакты сканирования или орфографические нормы того времени.'
    },
    'about.ladder.h2': { en: 'Quality ladder', ru: 'Лестница качества' },
    'about.ladder.approved.badge': { en: 'Approved', ru: 'Утверждено' },
    'about.ladder.approved.title': { en: 'Human-verified', ru: 'Проверено человеком' },
    'about.ladder.approved.desc': {
      en: 'Lak text, translation, and metadata have been checked by a reviewer. Corrections and notes are recorded. This is the target state for all records.',
      ru: 'Лакский текст, перевод и метаданные проверены рецензентом. Исправления и примечания зафиксированы. Это целевой статус для всех записей.'
    },
    'about.ladder.flagged.badge': { en: 'Flagged', ru: 'Помечено' },
    'about.ladder.flagged.title': { en: 'Needs attention', ru: 'Требует внимания' },
    'about.ladder.flagged.desc': {
      en: 'A reviewer found a problem — OCR error, wrong variety label, missing translation, or suspected corrupt text — and left a note. Awaiting correction or specialist input.',
      ru: 'Рецензент обнаружил проблему — ошибку OCR, неверную пометку разновидности, отсутствующий перевод или предположительно испорченный текст — и оставил примечание. Ожидает исправления или заключения специалиста.'
    },
    'about.ladder.ocr.badge': { en: 'OCR — unreviewed', ru: 'OCR — не проверено' },
    'about.ladder.ocr.title': { en: 'Uslar 1890 OCR source', ru: 'Источник OCR: Услар 1890' },
    'about.ladder.ocr.desc': {
      en: 'Extracted from a scanned 19th-century document. Text is presented exactly as recognised; no modernisation applied. Expect scan artefacts and archaic forms. In search results, OCR-sourced material appears only in a clearly separated unverified section — never mixed into the primary translation answer.',
      ru: 'Извлечено из отсканированного документа XIX века. Текст представлен точно в том виде, в каком был распознан; модернизация не применялась. Возможны артефакты сканирования и архаичные формы. В результатах поиска материал OCR отображается только в чётко отделённом непроверенном разделе — он никогда не смешивается с основным переводческим ответом.'
    },
    'about.ladder.unreviewed.badge': { en: 'Source import — unreviewed', ru: 'Импорт из источника — не проверено' },
    'about.badge.unreviewed': { en: 'Unreviewed', ru: 'Не проверено' },
    'about.ladder.unreviewed.title': { en: 'Bulk-imported, not individually checked', ru: 'Импортировано массово, не проверено по отдельности' },
    'about.ladder.unreviewed.desc': {
      en: 'The default state for records imported from published sources (PCMLBE, IDS, Lak Wikipedia, Digiev phrasebook). The sources are reputable, but no record carries human verification until a logged-in reviewer approves it.',
      ru: 'Статус по умолчанию для записей, импортированных из опубликованных источников (PCMLBE, IDS, лакская Википедия, разговорник Digiev). Источники авторитетны, но ни одна запись не считается проверенной человеком, пока её не утвердит авторизованный рецензент.'
    },
    'about.varieties.h2': { en: 'Dialect varieties', ru: 'Диалектные разновидности' },
    'about.varieties.standard': {
      en: '<strong>Standard</strong> — the literary and administrative standard form of Lak, based on the Kumukh dialect. Used in education, publishing, and official contexts.',
      ru: '<strong>Литературный</strong> — литературная и административная стандартная форма лакского языка на основе кумухского диалекта. Используется в образовании, издательском деле и официальных контекстах.'
    },
    'about.varieties.arakul': {
      en: '<strong>Arakul</strong> — dialect spoken in the village of Arakul (Аракул) in the Lak district of Dagestan.',
      ru: '<strong>Аракульский</strong> — диалект, распространённый в селе Аракул (Аракул) в Лакском районе Дагестана.'
    },
    'about.varieties.balkhar': {
      en: '<strong>Balkhar</strong> — dialect of the pottery village of Balkhar (Балхъар), known for its distinct phonology.',
      ru: '<strong>Балхарский</strong> — диалект гончарного села Балхар (Балхъар), известного своей особой фонологией.'
    },
    'about.varieties.shali': {
      en: '<strong>Shali</strong> — dialect of the Shali (Шали) region.',
      ru: '<strong>Шалинский</strong> — диалект района Шали (Шали).'
    },
    'about.varieties.historical': {
      en: '<strong>Historical</strong> — forms attested in 19th-century sources that may differ from the modern standard.',
      ru: '<strong>Исторический</strong> — формы, засвидетельствованные в источниках XIX века, которые могут отличаться от современной нормы.'
    },
    'about.varieties.unspecified': {
      en: '<strong>Unspecified</strong> — variety not recorded in the source metadata.',
      ru: '<strong>Не указано</strong> — разновидность не зафиксирована в метаданных источника.'
    },
    'about.collab.h2': { en: 'Invitation for collaboration', ru: 'Приглашение к сотрудничеству' },
    'about.collab.p1': {
      en: 'This corpus is designed to grow through expert contribution. We are actively seeking:',
      ru: 'Этот корпус создан для роста за счёт вклада экспертов. Мы активно ищем:'
    },
    'about.collab.li1': {
      en: 'Native Lak speakers who can verify translations, correct OCR errors, and flag dialectal misattributions.',
      ru: 'Носителей лакского языка, которые могут проверять переводы, исправлять ошибки OCR и указывать на неверные диалектные атрибуции.'
    },
    'about.collab.li2': {
      en: 'Field linguists with access to unpublished wordlists, texts, or recordings that can be incorporated with proper attribution.',
      ru: 'Полевых лингвистов с доступом к неопубликованным словникам, текстам или записям, которые можно включить с надлежащим указанием авторства.'
    },
    'about.collab.li3': {
      en: 'Universities and research institutions interested in formal collaboration agreements for corpus expansion and annotation.',
      ru: 'Университеты и исследовательские учреждения, заинтересованные в официальных соглашениях о сотрудничестве по расширению и аннотированию корпуса.'
    },
    'about.collab.li4': {
      en: 'Computational linguists developing NLP resources for low-resource Caucasian languages who wish to co-develop evaluation benchmarks.',
      ru: 'Компьютерных лингвистов, разрабатывающих NLP-ресурсы для малоресурсных кавказских языков, кто хочет совместно разрабатывать оценочные эталоны.'
    },
    'about.collab.p2': {
      en: 'The review system on this site allows immediate contribution: any visitor can flag problems and submit corrections or notes as suggestions. Canonical <strong>Approved</strong> states can only be created by logged-in trusted reviewers, so every approved record carries verified attribution. Systematic contributions are welcome via the GitHub repository.',
      ru: 'Система проверки на этом сайте позволяет вносить вклад немедленно: любой посетитель может отмечать проблемы и предлагать исправления или примечания. Канонический статус <strong>«Утверждено»</strong> могут присваивать только авторизованные доверенные рецензенты, поэтому каждая утверждённая запись имеет проверенное авторство. Систематический вклад приветствуется через репозиторий GitHub.'
    },
    'about.sidebar.quickStats': { en: 'Quick statistics', ru: 'Краткая статистика' },
    'about.sidebar.wikiDocs': { en: 'Wiki docs', ru: 'Документы вики' },
    'about.sidebar.phrasePairs': { en: 'Phrasebook pairs', ru: 'Пары из разговорника' },
    'about.sidebar.lexicon': { en: 'Lexicon', ru: 'Лексикон' },
    'about.sidebar.lexByVariety': { en: 'Lexicon by variety', ru: 'Лексикон по разновидностям' },
    'about.sidebar.col.variety': { en: 'Variety', ru: 'Разновидность' },
    'about.sidebar.col.entries': { en: 'Entries', ru: 'Записи' },
    'about.sidebar.langInfo': { en: 'Language information', ru: 'Сведения о языке' },
    'about.sidebar.langInfo.p1': {
      en: 'Lak (лакку маз, ISO 639-3: <strong>lbe</strong>) is a Northeast Caucasian language spoken primarily in the Lak district of Dagestan, Russia. It belongs to the Lak–Dargwa branch and has approximately 150,000 speakers.',
      ru: 'Лакский язык (лакку маз, ISO 639-3: <strong>lbe</strong>) — нахско-дагестанский (северо-восточнокавказский) язык, распространённый преимущественно в Лакском районе Дагестана (Россия). Относится к лакско-даргинской ветви, число говорящих — около 150 000 человек.'
    },
    'about.sidebar.langInfo.p2': {
      en: 'The language uses a Cyrillic script with the palochka (Ӏ) for ejective consonants — a letterform unique to Caucasian languages.',
      ru: 'В языке используется кириллица с палочкой (Ӏ) для абруптивных согласных — начертание, характерное для кавказских языков.'
    },
    'about.sidebar.resources': { en: 'Resources', ru: 'Ресурсы' },
    'about.varietyHistoricalUslar': { en: 'Historical (Uslar)', ru: 'Исторический (Услар)' },
    'about.sidebar.searchCorpus': { en: '← Search the corpus', ru: '← Поиск по корпусу' },
    'about.sidebar.queueExport': { en: 'Review queue & export', ru: 'Очередь проверки и экспорт' },

    /* ── how-it-works.html ───────────────────────────────────── */
    'hiw.meta.title': { en: 'How validation works — Lak Corpus Explorer', ru: 'Как работает проверка — Обозреватель лакского корпуса' },
    'hiw.h1': { en: 'How validation works', ru: 'Как работает проверка' },
    'hiw.intro': {
      en: 'Lak is a living language with a small speaker community. Every validation here is an act of preservation: checking a translation, restoring a scanned word, confirming a sense. The system is designed so that <b>careful, knowledgeable work counts most</b> — and so that no single click can change the corpus on its own.',
      ru: 'Лакский — живой язык с небольшим сообществом носителей. Каждая проверка здесь — акт сохранения: проверка перевода, восстановление отсканированного слова, подтверждение значения. Система устроена так, чтобы <b>больше всего ценился внимательный и компетентный труд</b> — и чтобы ни один отдельный клик не мог сам по себе изменить корпус.'
    },
    'hiw.s1.h2': { en: 'One small task at a time', ru: 'По одной небольшой задаче за раз' },
    'hiw.s1.p1': {
      en: 'The validation workspace presents a single focused question — is this translation correct, does <i>барз</i> mean “moon” or “month” here, is this OCR text clean, which dialect is this form? You answer independently: <b>you never see other votes before submitting your own</b>. Only afterwards is the emerging community view shown. This keeps judgments honest and independent, which is what makes agreement meaningful.',
      ru: 'Рабочее пространство проверки задаёт один сфокусированный вопрос — верен ли этот перевод, означает ли <i>барз</i> здесь «луну» или «месяц», чист ли этот OCR-текст, к какому диалекту относится эта форма? Вы отвечаете самостоятельно: <b>вы никогда не видите чужие голоса до того, как отправите свой</b>. Складывающееся мнение сообщества показывается только после этого. Так суждения остаются честными и независимыми, что и придаёт согласию смысл.'
    },
    'hiw.s1.p2': {
      en: 'You can attach a correction, an evidence note, and a source reference. When the final outcome supports them, these earn extra recognition.',
      ru: 'Вы можете приложить исправление, примечание с доказательствами и ссылку на источник. Если итог их подтверждает, они приносят дополнительное признание.'
    },
    'hiw.s2.h2': { en: 'Roles and expertise', ru: 'Роли и экспертиза' },
    'hiw.s2.p1': {
      en: '<b>Contributor</b> — everyone who registers. Contributors validate, flag, and suggest.',
      ru: '<b>Участник</b> — каждый, кто зарегистрировался. Участники проверяют, отмечают проблемы и предлагают правки.'
    },
    'hiw.s2.p2': {
      en: '<b>Trusted validator</b> — granted by an administrator or by invitation, after relevant expertise is recorded: linguistic training, native-speaker knowledge, community standing, or academic work. Trusted validators help resolve disputed items.',
      ru: '<b>Доверенный проверяющий</b> — присваивается администратором или по приглашению после фиксации соответствующей экспертизы: лингвистической подготовки, знания как носителя, авторитета в сообществе или академической работы. Доверенные проверяющие помогают разрешать спорные записи.'
    },
    'hiw.s2.p3': {
      en: '<b>Verified expert</b> — the same, with a stronger documented basis. Only verified experts and administrators can mark an item <i>expert verified</i>.',
      ru: '<b>Подтверждённый эксперт</b> — то же самое, но с более весомым документально подтверждённым основанием. Только подтверждённые эксперты и администраторы могут пометить запись как <i>подтверждено экспертом</i>.'
    },
    'hiw.s2.p4': {
      en: '<b>Administrator</b> — stewards of the corpus: grant roles, create invitations, invalidate abusive points, and resolve appeals.',
      ru: '<b>Администратор</b> — кураторы корпуса: назначают роли, создают приглашения, аннулируют недобросовестные баллы и рассматривают апелляции.'
    },
    'hiw.s2.p5': {
      en: 'Registering never makes anyone an expert by itself. Expert status always leaves a written record of its basis in the audit trail.',
      ru: 'Сама по себе регистрация никого не делает экспертом. Статус эксперта всегда оставляет письменную запись о своём основании в журнале аудита.'
    },
    'hiw.s3.h2': { en: 'Consensus and verification — different things', ru: 'Консенсус и проверка — это разные вещи' },
    'hiw.s3.p1': {
      en: 'Items move through clear states: <span class="badge">pending</span> → <span class="badge">community consensus</span> or <span class="badge">disputed</span> → <span class="badge">expert verified</span> or <span class="badge">rejected</span>.',
      ru: 'Записи проходят через понятные статусы: <span class="badge">в ожидании</span> → <span class="badge">консенсус сообщества</span> или <span class="badge">спорно</span> → <span class="badge">подтверждено экспертом</span> или <span class="badge">отклонено</span>.'
    },
    'hiw.s3.p2': {
      en: 'When at least three independent contributors agree strongly (weighted by reliability), an item reaches <b>community consensus</b>. That is valuable — but it is <b>not</b> expert verification, and the interface always says so. When opinions diverge, the item becomes <b>disputed</b> and is routed to trusted validators and verified experts. Changes to the canonical corpus itself remain restricted to trusted reviewers, experts, and administrators — exactly as before.',
      ru: 'Когда не менее трёх независимых участников решительно сходятся во мнении (с учётом надёжности), запись достигает <b>консенсуса сообщества</b>. Это ценно — но это <b>не</b> экспертная проверка, и интерфейс всегда об этом сообщает. Когда мнения расходятся, запись становится <b>спорной</b> и направляется доверенным проверяющим и подтверждённым экспертам. Изменения самого канонического корпуса по-прежнему доступны только доверенным рецензентам, экспертам и администраторам — как и раньше.'
    },
    'hiw.s4.h2': { en: 'Points reward quality, not clicks', ru: 'Баллы вознаграждают качество, а не клики' },
    'hiw.s4.p1': {
      en: 'A completed validation earns <b>provisional</b> points. They become <b>confirmed</b> only when your answer later agrees with community consensus, a reference (gold-standard) answer, or expert adjudication. Extra points go to useful corrections, evidence-backed notes, resolving disputed items, and expert verification work. Spam, duplicates, and unsupported rapid-fire submissions earn nothing confirmed.',
      ru: 'Завершённая проверка приносит <b>предварительные</b> баллы. Они становятся <b>подтверждёнными</b>, только когда ваш ответ впоследствии совпадает с консенсусом сообщества, эталонным (золотым) ответом или экспертным решением. Дополнительные баллы начисляются за полезные исправления, подкреплённые доказательствами примечания, разрешение спорных записей и экспертную проверку. Спам, дубликаты и необоснованные быстрые ответы подряд не приносят подтверждённых баллов.'
    },
    'hiw.s4.p2': {
      en: 'To keep things healthy there are rate limits, a daily cap, and diminishing returns after many validations in one day. Administrators can invalidate abusive points — the records stay in the audit trail; nothing is silently erased.',
      ru: 'Для здоровой работы предусмотрены ограничения скорости, дневной лимит и убывающая отдача после множества проверок за один день. Администраторы могут аннулировать недобросовестные баллы — записи остаются в журнале аудита; ничто не удаляется незаметно.'
    },
    'hiw.s5.h2': { en: 'Reliability — tracked separately from points', ru: 'Надёжность — учитывается отдельно от баллов' },
    'hiw.s5.p1': {
      en: 'Points say how much you have contributed. <b>Reliability</b> says how often your judgments hold up: agreement on hidden calibration tasks, agreement with later consensus, reversals, and expert-confirmed work. Reliability weights your future votes in consensus — carefully and within narrow bounds, so newcomers still matter. Your current band (new, developing, established, high) and exactly what it is based on are always visible to you on the leaderboard page.',
      ru: 'Баллы показывают, сколько вы внесли. <b>Надёжность</b> показывает, как часто ваши суждения подтверждаются: совпадения на скрытых калибровочных задачах, совпадения с последующим консенсусом, пересмотры и работа, подтверждённая экспертами. Надёжность влияет на вес ваших будущих голосов при формировании консенсуса — осторожно и в узких пределах, чтобы новички всё равно имели значение. Ваш текущий уровень (новичок, развивающийся, устоявшийся, высокий) и то, на чём именно он основан, всегда видны вам на странице рейтинга.'
    },
    'hiw.s6.h2': { en: 'Leaderboard, streaks, quests, achievements', ru: 'Рейтинг, серии, задания, достижения' },
    'hiw.s6.p1': {
      en: 'The public leaderboard ranks by <b>confirmed quality points</b> — never raw activity — and shows verified validations, reliability band, contribution streak, and expert badges. Research on gamification warns that leaderboards can discourage newcomers, so your personal view emphasizes <b>your</b> rank, percentile, and nearest neighbors rather than unreachable all-time totals. Listing is strictly opt-in, pseudonyms are welcome, and email addresses are never shown.',
      ru: 'Публичный рейтинг ранжирует по <b>подтверждённым баллам качества</b> — никогда не по «сырой» активности — и показывает проверенные проверки, уровень надёжности, серию вклада и экспертные значки. Исследования геймификации предупреждают, что рейтинги могут обескураживать новичков, поэтому ваше личное представление подчёркивает <b>ваш</b> ранг, процентиль и ближайших соседей, а не недостижимые итоги за всё время. Включение в список строго добровольное, псевдонимы приветствуются, а адреса электронной почты никогда не показываются.'
    },
    'hiw.s6.p2': {
      en: 'A daily streak requires at least one genuine, substantive contribution — rejected spam never extends it. Small daily and weekly quests nudge toward diverse, high-value work (OCR restoration, dialect questions, evidence notes) instead of repeating the easiest task. Achievements mark real milestones: a first expert-confirmed correction, ten high-quality validations, dialect specialization, OCR restoration, source detective work, consensus building, and sustained contribution.',
      ru: 'Ежедневная серия требует хотя бы одного подлинного, содержательного вклада — отклонённый спам никогда её не продлевает. Небольшие ежедневные и еженедельные задания подталкивают к разнообразной и ценной работе (восстановление OCR, вопросы о диалектах, примечания с доказательствами) вместо повторения самой лёгкой задачи. Достижения отмечают настоящие вехи: первое подтверждённое экспертом исправление, десять качественных проверок, специализацию по диалектам, восстановление OCR, поиск источников, формирование консенсуса и устойчивый вклад.'
    },
    'hiw.s7.h2': { en: 'Privacy', ru: 'Конфиденциальность' },
    'hiw.s7.p1': {
      en: 'Your email is visible only to you. Your profile is private unless you explicitly make it public, and the leaderboard lists you only if you opt in. Votes are attributed for auditability, but public surfaces show display names and quality bands only.',
      ru: 'Ваш адрес электронной почты виден только вам. Ваш профиль остаётся приватным, пока вы явно не сделаете его публичным, а рейтинг включает вас только по вашему согласию. Голоса атрибутируются ради возможности аудита, но на публичных страницах показываются только отображаемые имена и уровни качества.'
    },
    'hiw.s8.h2': { en: 'Appeals', ru: 'Апелляции' },
    'hiw.s8.p1': {
      en: 'Disagree with a revoked point or an adjudication? Submit an appeal from your profile. An administrator reviews it and writes a resolution. Appeals, votes, status changes, and adjudications all live in a permanent audit trail with timestamps and contributors.',
      ru: 'Не согласны с аннулированным баллом или решением? Подайте апелляцию из своего профиля. Администратор рассмотрит её и запишет решение. Апелляции, голоса, изменения статуса и решения — всё хранится в постоянном журнале аудита с отметками времени и указанием участников.'
    },
    'hiw.outro': {
      en: 'Баркалла — thank you for helping keep Lak alive, accurate, and open to science. 💛',
      ru: 'Баркалла — спасибо, что помогаете сохранять лакский язык живым, точным и открытым для науки. 💛'
    },

    /* ── validate.html ───────────────────────────────────────── */
    'validate.meta.title': { en: 'Check translations — Lak Corpus Explorer', ru: 'Проверить переводы — Обозреватель лакского корпуса' },
    'validate.needLogin.h1': { en: 'Help check translations', ru: 'Помогите проверять переводы' },
    'validate.needLogin.p': {
      en: 'Checking is done by registered contributors so that every answer is signed to its author, can be reviewed later, and counts more when the person is often right. Accounts are free; searching never needs an account.',
      ru: 'Проверку выполняют зарегистрированные участники, чтобы каждый ответ был подписан автором, мог быть пересмотрен позже и весил больше, когда человек часто оказывается прав. Аккаунты бесплатны; для поиска аккаунт не нужен.'
    },
    'validate.createAccount': { en: 'Create a contributor account', ru: 'Создать аккаунт участника' },
    'validate.login': { en: 'Log in', ru: 'Войти' },
    'validate.howItWorks': { en: 'How checking works', ru: 'Как работает проверка' },
    'validate.optionsLabel': { en: 'Your answer', ru: 'Ваш ответ' },
    'validate.details.summary': {
      en: 'Add a correction or an explanation (optional, earns extra points when confirmed)',
      ru: 'Добавить исправление или пояснение (необязательно, приносит дополнительные баллы при подтверждении)'
    },
    'validate.correction.label': { en: 'Suggested correction', ru: 'Предлагаемое исправление' },
    'validate.correction.placeholder': {
      en: 'The corrected Lak text, meaning, or spelling',
      ru: 'Исправленный лакский текст, значение или написание'
    },
    'validate.evidence.label': { en: 'Why you chose this', ru: 'Почему вы так решили' },
    'validate.evidence.placeholder': {
      en: 'Why is this your answer? Context, dialect knowledge, comparison…',
      ru: 'Почему это ваш ответ? Контекст, знание диалекта, сравнение…'
    },
    'validate.source.label': { en: 'Where it comes from', ru: 'Откуда это взято' },
    'validate.source.placeholder': {
      en: 'e.g. Uslar 1890, p. 42; PCMLBE 2007; native-speaker knowledge',
      ru: 'напр. Услар 1890, с. 42; PCMLBE 2007; знание носителя языка'
    },
    'validate.submit': { en: 'Send answer', ru: 'Отправить ответ' },
    'validate.result.title': { en: 'What others said', ru: 'Что ответили другие' },
    'validate.next': { en: 'Next task', ru: 'Следующая задача' },
    'validate.empty.h2': { en: 'All caught up', ru: 'Всё сделано' },
    'validate.empty.p': {
      en: 'There are no open tasks for you right now. New material is added regularly — thank you for helping preserve Lak.',
      ru: 'Сейчас для вас нет открытых задач. Новый материал добавляется регулярно — спасибо, что помогаете сохранять лакский язык.'
    },

    /* ── queue.html ──────────────────────────────────────────── */
    'queue.meta.title': { en: 'Checked translations — Lak Corpus Explorer', ru: 'Проверенные переводы — Обозреватель лакского корпуса' },
    'queue.h1': { en: 'Checked translations', ru: 'Проверенные переводы' },
    'queue.subtitle': {
      en: 'Every check that people have submitted from search. Anyone can read or download this; no login is needed.',
      ru: 'Все проверки, отправленные людьми из поиска. Их может читать и скачивать любой; вход не нужен.'
    },
    'queue.approved': { en: 'Approved', ru: 'Утверждено' },
    'queue.flagged': { en: 'Flagged', ru: 'Помечено' },
    'queue.unreviewed': { en: 'Unreviewed (explicit)', ru: 'Не проверено (явно)' },
    'queue.exportAll': { en: 'Export all reviews:', ru: 'Экспортировать все проверки:' },
    'queue.jsonDownload': { en: '⬇ JSON', ru: '⬇ JSON' },
    'queue.csvDownload': { en: '⬇ CSV', ru: '⬇ CSV' },
    'queue.filter.all': { en: 'All states', ru: 'Все статусы' },
    'queue.loadMore': { en: 'Load more', ru: 'Загрузить ещё' },
    'queue.col.recordId': { en: 'Record ID', ru: 'ID записи' },
    'queue.col.state': { en: 'State', ru: 'Статус' },
    'queue.col.reviewer': { en: 'Reviewer', ru: 'Рецензент' },
    'queue.col.note': { en: 'Correction / Note', ru: 'Исправление / Примечание' },
    'queue.col.updated': { en: 'Updated', ru: 'Обновлено' },
    'queue.loading': { en: 'Loading…', ru: 'Загрузка…' },

    /* ── leaderboard.html ────────────────────────────────────── */
    'lb.meta.title': { en: 'Leaderboard — Lak Corpus Explorer', ru: 'Рейтинг — Обозреватель лакского корпуса' },
    'lb.h1': { en: 'Community leaderboard', ru: 'Рейтинг сообщества' },
    'lb.intro': {
      en: 'Ranked by <b>confirmed quality points</b> — points that held up against consensus, reference answers, or expert review. Listing is opt-in and uses display names only. What matters most is a preserved language, not the ranking itself.',
      ru: 'Ранжируется по <b>подтверждённым баллам качества</b> — баллам, которые устояли перед консенсусом, эталонными ответами или экспертной проверкой. Включение в список добровольное и использует только отображаемые имена. Важнее всего сохранённый язык, а не сам рейтинг.'
    },
    'lb.periodLabel': { en: 'Leaderboard period', ru: 'Период рейтинга' },
    'lb.week': { en: 'This week', ru: 'За неделю' },
    'lb.month': { en: 'This month', ru: 'За месяц' },
    'lb.all': { en: 'All time', ru: 'За всё время' },
    'lb.col.rank': { en: '#', ru: '#' },
    'lb.col.contributor': { en: 'Contributor', ru: 'Участник' },
    'lb.col.verified': { en: 'Verified validations', ru: 'Проверенные проверки' },
    'lb.col.reliability': { en: 'Reliability', ru: 'Надёжность' },
    'lb.col.streak': { en: 'Streak', ru: 'Серия' },
    'lb.col.points': { en: 'Confirmed points', ru: 'Подтверждённые баллы' },
    'lb.loading': { en: 'Loading…', ru: 'Загрузка…' },
    'lb.footer': {
      en: 'Contributors appear here only if they opted in on their profile. Pseudonymous display names are welcome; email addresses and private fields are never shown.',
      ru: 'Участники появляются здесь только если дали согласие в своём профиле. Псевдонимы приветствуются; адреса электронной почты и приватные поля никогда не показываются.'
    },

    /* ── login.html ──────────────────────────────────────────── */
    'login.meta.title': { en: 'Log in — Lak Corpus Explorer', ru: 'Вход — Обозреватель лакского корпуса' },
    'login.h1': { en: 'Log in', ru: 'Вход' },
    'login.intro': {
      en: 'Searching and reading the corpus is fully open — no login needed. Accounts are for validation, reviews, and stewardship.',
      ru: 'Поиск и чтение корпуса полностью открыты — вход не нужен. Аккаунты нужны для проверки, рецензирования и кураторства.'
    },
    'login.account.h2': { en: 'Contributor account', ru: 'Аккаунт участника' },
    'login.email': { en: 'Email', ru: 'Электронная почта' },
    'login.password': { en: 'Password', ru: 'Пароль' },
    'login.submit': { en: 'Log in', ru: 'Войти' },
    'login.noAccount': { en: 'No account yet?', ru: 'Ещё нет аккаунта?' },
    'login.createOne': { en: "Create one — it's free", ru: 'Создайте — это бесплатно' },
    'login.reviewer.h2': { en: 'Trusted reviewer passphrase', ru: 'Пароль доверенного рецензента' },
    'login.yourName': { en: 'Your name', ru: 'Ваше имя' },
    'login.yourName.placeholder': { en: 'e.g. M. Abdullaev', ru: 'напр. М. Абдуллаев' },
    'login.reviewerPass': { en: 'Reviewer passphrase', ru: 'Пароль рецензента' },
    'login.reviewerPass.placeholder': { en: 'Shared reviewer passphrase', ru: 'Общий пароль рецензента' },
    'login.reviewerSubmit': { en: 'Log in as reviewer', ru: 'Войти как рецензент' },
    'login.goValidation': { en: 'Go to validation', ru: 'Перейти к проверке' },
    'login.goSearch': { en: 'Go to search', ru: 'Перейти к поиску' },
    'login.logout': { en: 'Log out', ru: 'Выйти' },

    /* ── register.html ───────────────────────────────────────── */
    'register.meta.title': { en: 'Create account — Lak Corpus Explorer', ru: 'Создать аккаунт — Обозреватель лакского корпуса' },
    'register.h1': { en: 'Become a contributor', ru: 'Станьте участником' },
    'register.intro': {
      en: 'Accounts make validation attributable and auditable. Everyone starts as a <b>contributor</b> — trusted validator and verified expert status is granted by administrators after relevant expertise is recorded; it cannot be self-assigned.',
      ru: 'Аккаунты делают проверку атрибутируемой и проверяемой. Каждый начинает как <b>участник</b> — статусы доверенного проверяющего и подтверждённого эксперта присваиваются администраторами после фиксации соответствующей экспертизы; их нельзя присвоить себе самостоятельно.'
    },
    'register.name.label': { en: 'Display name (a pseudonym is fine)', ru: 'Отображаемое имя (псевдоним подойдёт)' },
    'register.name.placeholder': { en: 'e.g. Aisha M.', ru: 'напр. Аиша М.' },
    'register.email.label': { en: 'Email (never shown publicly)', ru: 'Электронная почта (никогда не показывается публично)' },
    'register.pass.label': { en: 'Password (at least 8 characters)', ru: 'Пароль (не менее 8 символов)' },
    'register.invite.label': {
      en: 'Invitation code (optional — for invited validators/experts)',
      ru: 'Код приглашения (необязательно — для приглашённых проверяющих/экспертов)'
    },
    'register.invite.placeholder': { en: "Leave empty if you don't have one", ru: 'Оставьте пустым, если у вас его нет' },
    'register.submit': { en: 'Create account', ru: 'Создать аккаунт' },
    'register.haveAccount': { en: 'Already have an account?', ru: 'Уже есть аккаунт?' },
    'register.login': { en: 'Log in', ru: 'Войти' },
    'register.howItWorks': { en: 'How validation works', ru: 'Как работает проверка' },

    /* ── profile.html ────────────────────────────────────────── */
    'profile.meta.title': { en: 'My profile — Lak Corpus Explorer', ru: 'Мой профиль — Обозреватель лакского корпуса' },
    'profile.needLogin.p': { en: 'You need a contributor account to view this page.', ru: 'Для просмотра этой страницы нужен аккаунт участника.' },
    'profile.login': { en: 'Log in', ru: 'Войти' },
    'profile.createAccount': { en: 'Create account', ru: 'Создать аккаунт' },
    'profile.h1': { en: 'My profile', ru: 'Мой профиль' },
    'profile.roleLabel': { en: 'Role:', ru: 'Роль:' },
    'profile.section.profile': { en: 'Profile', ru: 'Профиль' },
    'profile.name.label': { en: 'Display name (public, pseudonyms welcome)', ru: 'Отображаемое имя (публичное, псевдонимы приветствуются)' },
    'profile.affil.label': { en: 'Affiliation (optional)', ru: 'Аффилиация (необязательно)' },
    'profile.affil.placeholder': {
      en: 'e.g. independent researcher, village community, university',
      ru: 'напр. независимый исследователь, сельская община, университет'
    },
    'profile.langs.label': { en: 'Languages / dialects', ru: 'Языки / диалекты' },
    'profile.langs.placeholder': { en: 'e.g. Lak (Vitskhi), Russian, English', ru: 'напр. лакский (вихлинский), русский, английский' },
    'profile.exp.label': { en: 'Short expertise description', ru: 'Краткое описание экспертизы' },
    'profile.exp.placeholder': {
      en: 'e.g. native speaker of the Vikhli variety; fieldwork on Lak folklore',
      ru: 'напр. носитель вихлинской разновидности; полевая работа по лакскому фольклору'
    },
    'profile.privacy': { en: 'Privacy', ru: 'Конфиденциальность' },
    'profile.public.label': {
      en: 'Make my profile public (name, affiliation, languages, expertise, badges — never email)',
      ru: 'Сделать мой профиль публичным (имя, аффилиация, языки, экспертиза, значки — никогда не почта)'
    },
    'profile.lb.label': { en: 'List me on the public leaderboard', ru: 'Показывать меня в публичном рейтинге' },
    'profile.save': { en: 'Save', ru: 'Сохранить' },
    'profile.section.progress': { en: 'Progress', ru: 'Прогресс' },
    'profile.leaderboardLink': { en: 'Leaderboard & relative ranking', ru: 'Рейтинг и относительное положение' },
    'profile.howPointsLink': { en: 'How points & reliability work', ru: 'Как работают баллы и надёжность' },
    'profile.pairs.h2': { en: 'My translations', ru: 'Мои переводы' },
    'profile.pairs.p': {
      en: 'See the translations you sent from the translation workspace. They stay unconfirmed until others independently agree or an expert decides.',
      ru: 'Смотрите переводы, отправленные из раздела «Работа с переводами». Они остаются неподтверждёнными, пока другие независимо не согласятся или эксперт не примет решение.'
    },
    'profile.pairs.loading': { en: 'Loading translation work…', ru: 'Загрузка переводческой работы…' },
    'profile.openLab': { en: 'Open translation workspace', ru: 'Открыть работу с переводами' },
    'profile.appeal.h2': { en: 'Appeal a decision', ru: 'Обжаловать решение' },
    'profile.appeal.p': {
      en: 'If points were revoked or a judgment seems wrong, you can appeal. An administrator reviews every appeal; the audit trail is never deleted.',
      ru: 'Если баллы были аннулированы или решение кажется неверным, вы можете подать апелляцию. Администратор рассматривает каждую апелляцию; журнал аудита никогда не удаляется.'
    },
    'profile.appeal.label': { en: 'What happened, and why should it be reconsidered?', ru: 'Что произошло и почему это следует пересмотреть?' },
    'profile.appeal.submit': { en: 'Submit appeal', ru: 'Отправить апелляцию' },
    'profile.logout': { en: 'Log out', ru: 'Выйти' },

    /* ── dashboard.html ──────────────────────────────────────── */
    'dash.meta.title': { en: 'Steward dashboard — Lak Corpus Explorer', ru: 'Панель куратора — Обозреватель лакского корпуса' },
    'dash.h1': { en: 'Steward dashboard', ru: 'Панель куратора' },
    'dash.sub': {
      en: 'For trusted validators, verified experts, and administrators.',
      ru: 'Для доверенных проверяющих, подтверждённых экспертов и администраторов.'
    },
    'dash.denied.p': {
      en: 'This dashboard requires a trusted validator, verified expert, or administrator role.',
      ru: 'Для этой панели требуется роль доверенного проверяющего, подтверждённого эксперта или администратора.'
    },
    'dash.or': { en: 'or', ru: 'или' },
    'dash.denied.validate': { en: 'Validate tasks', ru: 'Проверять задачи' },
    'dash.denied.learn': { en: 'learn how roles are granted', ru: 'узнать, как присваиваются роли' },
    'dash.disputes.h2': { en: 'Disputed items', ru: 'Спорные записи' },
    'dash.disputes.note': { en: '— your expert decision resolves them', ru: '— их решает ваше экспертное решение' },
    'dash.highPriority.h2': { en: 'High-priority unresolved queries', ru: 'Неразрешённые запросы высокого приоритета' },
    'dash.goldPerf.h2': { en: 'Gold-task performance', ru: 'Результаты по эталонным задачам' },
    'dash.suspicion.h2': { en: 'Suspicious activity', ru: 'Подозрительная активность' },
    'dash.appeals.h2': { en: 'Open appeals', ru: 'Открытые апелляции' },
    'dash.labPairs.h2': { en: 'Translations awaiting review', ru: 'Переводы, ожидающие проверки' },
    'dash.grant.h2': { en: 'Grant a role', ru: 'Назначить роль' },
    'dash.grant.cid': { en: 'Contributor id (c_…)', ru: 'ID участника (c_…)' },
    'dash.grant.basis': { en: 'Basis of expertise (required for trusted/expert)', ru: 'Основание экспертизы (обязательно для доверенного/эксперта)' },
    'dash.grant.btn': { en: 'Grant', ru: 'Назначить' },
    'dash.invite.h2': { en: 'Create an invitation', ru: 'Создать приглашение' },
    'dash.invite.note': { en: "Invitee's expertise basis", ru: 'Основание экспертизы приглашаемого' },
    'dash.invite.btn': { en: 'Create invite', ru: 'Создать приглашение' },
    'dash.revoke.h2': { en: 'Invalidate abusive points', ru: 'Аннулировать недобросовестные баллы' },
    'dash.revoke.note': {
      en: 'Points are revoked, never deleted — the audit trail keeps everything.',
      ru: 'Баллы аннулируются, но не удаляются — журнал аудита сохраняет всё.'
    },
    'dash.revoke.cid': { en: 'Contributor id (c_…)', ru: 'ID участника (c_…)' },
    'dash.revoke.reason': { en: 'Reason (goes to audit trail)', ru: 'Причина (заносится в журнал аудита)' },
    'dash.revoke.includeConfirmed': { en: 'include confirmed', ru: 'включая подтверждённые' },
    'dash.revoke.btn': { en: 'Revoke', ru: 'Аннулировать' },
    'dash.addTask.h2': { en: 'Add a validation task', ru: 'Добавить задачу проверки' },
    'dash.addTask.id': { en: 'Task id (optional)', ru: 'ID задачи (необязательно)' },
    'dash.addTask.priority': { en: 'Priority 0–100', ru: 'Приоритет 0–100' },
    'dash.addTask.gold': { en: 'gold standard', ru: 'эталон' },
    'dash.addTask.ru': { en: 'Russian prompt (optional)', ru: 'Русская подсказка (необязательно)' },
    'dash.addTask.lak': { en: 'Lak text (optional)', ru: 'Лакский текст (необязательно)' },
    'dash.addTask.options': { en: 'Options, comma-separated (e.g. moon,month)', ru: 'Варианты через запятую (напр. moon,month)' },
    'dash.addTask.answer': { en: 'Gold answer (required for gold tasks)', ru: 'Эталонный ответ (обязательно для эталонных задач)' },
    'dash.addTask.btn': { en: 'Add task', ru: 'Добавить задачу' },
    'dash.benchmark.h2': { en: 'Benchmark import template', ru: 'Шаблон импорта эталонного набора' },
    'dash.benchmark.p': {
      en: 'Download a blank 500-item template. Test references remain server-only and are never included in training exports.',
      ru: 'Скачайте пустой шаблон на 500 позиций. Тестовые эталоны хранятся только на сервере и никогда не включаются в экспорт для обучения.'
    },
    'dash.benchmark.download': { en: 'Download 500-item TSV template', ru: 'Скачать TSV-шаблон на 500 позиций' },
    'dash.admin': { en: 'admin', ru: 'админ' },

    /* ── lab.html ────────────────────────────────────────────── */
    'lab.meta.title': { en: 'Translation workspace — Lak Corpus Explorer', ru: 'Работа с переводами — Обозреватель лакского корпуса' },
    'lab.authState.p': {
      en: 'You can look at the supporting material without an account.',
      ru: 'Вы можете просматривать подтверждающий материал без аккаунта.'
    },
    'lab.authState.link': { en: 'Log in or register', ru: 'Войти или зарегистрироваться' },
    'lab.authState.tail': {
      en: 'to save, review, or confirm a translation.',
      ru: 'чтобы сохранить, проверить или подтвердить перевод.'
    },
    'lab.h1': { en: 'Translation workspace', ru: 'Работа с переводами' },
    'lab.subtitle': {
      en: 'A workspace where the model suggests a translation and you confirm it against real examples.',
      ru: 'Рабочее место, где модель предлагает перевод, а вы подтверждаете его на реальных примерах.'
    },
    'lab.workbench': { en: 'Workbench', ru: 'Верстак' },
    'lab.myPairs': { en: 'My Pairs', ru: 'Мои пары' },
    'lab.sourceText.label': { en: 'Source text', ru: 'Исходный текст' },
    'lab.sourceText.placeholder': { en: 'Enter Russian or Lak text...', ru: 'Введите русский или лакский текст...' },
    'lab.direction.label': { en: 'Direction', ru: 'Направление' },
    'lab.direction.ru2lak': { en: 'Russian → Lak', ru: 'Русский → Лакский' },
    'lab.direction.lak2ru': { en: 'Lak → Russian', ru: 'Лакский → Русский' },
    'lab.retrieveEvidence': { en: 'Find supporting examples', ru: 'Найти подтверждающие примеры' },
    'lab.loading': { en: 'Finding dictionary meanings and text examples…', ru: 'Поиск словарных значений и примеров из текстов…' },
    'lab.banner': {
      en: '<strong>Model suggestion — not confirmed.</strong> Check it, correct it, and add supporting examples before saving.',
      ru: '<strong>Предложение модели — не подтверждено.</strong> Проверьте, исправьте и добавьте подтверждающие примеры перед сохранением.'
    },
    'lab.literalTarget.label': { en: 'Literal target (word-for-word)', ru: 'Дословный перевод (слово в слово)' },
    'lab.naturalTarget.label': { en: 'Natural target (fluent)', ru: 'Естественный перевод (беглый)' },
    'lab.context.h3': { en: 'Context & supporting examples', ru: 'Контекст и подтверждающие примеры' },
    'lab.variety.label': { en: 'Lak variety', ru: 'Вариант лакского' },
    'lab.orthography.label': { en: 'Orthography', ru: 'Письменность' },
    'lab.orthography.cyrillic': { en: 'Cyrillic', ru: 'Кириллица' },
    'lab.orthography.latin': { en: 'Latin', ru: 'Латиница' },
    'lab.orthography.arabic': { en: 'Arabic', ru: 'Арабская' },
    'lab.sourceType.label': { en: 'Source Type', ru: 'Тип источника' },
    'lab.sourceType.human': { en: 'Human', ru: 'Человек' },
    'lab.sourceType.humanEvidence': { en: 'Human from retrieved evidence', ru: 'Человек по найденным доказательствам' },
    'lab.provenance.label': { en: 'Source', ru: 'Источник' },
    'lab.provenance.placeholder': { en: 'e.g. Fieldwork, Book title', ru: 'напр. полевая работа, название книги' },
    'lab.rights.label': { en: 'Rights and access', ru: 'Права на использование' },
    'lab.rights.publicDomain': { en: 'Public Domain', ru: 'Общественное достояние' },
    'lab.rights.ccBy': { en: 'CC-BY', ru: 'CC-BY' },
    'lab.rights.restricted': { en: 'Copyrighted / restricted', ru: 'Защищено авторским правом / ограничено' },
    'lab.rights.unknown': { en: 'Unknown', ru: 'Неизвестно' },
    'lab.access.label': { en: 'Access Status', ru: 'Статус доступа' },
    'lab.access.public': { en: 'Public', ru: 'Публичный' },
    'lab.access.restricted': { en: 'Restricted', ru: 'Ограниченный' },
    'lab.access.permissionPending': { en: 'Permission pending', ru: 'Ожидается разрешение' },
    'lab.access.private': { en: 'Private', ru: 'Приватный' },
    'lab.evidenceIds.label': { en: 'Supporting example IDs (comma separated)', ru: 'ID подтверждающих примеров (через запятую)' },
    'lab.evidenceIds.placeholder': { en: 'e.g. 102, 405', ru: 'напр. 102, 405' },
    'lab.abstain': { en: 'Abstain / Uncertain', ru: 'Воздержаться / Не уверен' },
    'lab.errorCat.label': { en: 'Error Category (if correcting model)', ru: 'Категория ошибки (если исправляете модель)' },
    'lab.errorCat.none': { en: 'None', ru: 'Нет' },
    'lab.errorCat.noReliableTarget': { en: 'No reliable target', ru: 'Нет надёжного перевода' },
    'lab.errorCat.ambiguousSource': { en: 'Ambiguous source', ru: 'Неоднозначный источник' },
    'lab.errorCat.dialectalGap': { en: 'Dialectal gap', ru: 'Диалектный пробел' },
    'lab.errorCat.ocrUnreliable': { en: 'OCR evidence unreliable', ru: 'Ненадёжные доказательства OCR' },
    'lab.errorCat.insufficient': { en: 'Insufficient evidence', ru: 'Недостаточно доказательств' },
    'lab.errorCat.outOfScope': { en: 'Out of scope', ru: 'Вне области' },
    'lab.errorCat.other': { en: 'Other', ru: 'Другое' },
    'lab.clearWorkbench': { en: 'Clear Workbench', ru: 'Очистить верстак' },
    'lab.savePair': { en: 'Save translation pair', ru: 'Сохранить пару перевода' },
    'lab.history.col.direction': { en: 'Direction', ru: 'Направление' },
    'lab.history.col.source': { en: 'Source', ru: 'Источник' },
    'lab.history.col.literal': { en: 'Literal Target', ru: 'Дословный перевод' },
    'lab.history.col.natural': { en: 'Natural Target', ru: 'Естественный перевод' },
    'lab.history.col.status': { en: 'Status', ru: 'Статус' },
    'lab.history.loading': { en: 'Loading...', ru: 'Загрузка...' },
    'lab.history.empty': { en: 'No translated pairs saved yet.', ru: 'Пока не сохранено ни одной пары перевода.' },

    /* ── Dynamic keys referenced by page scripts ─────────────────── */

    /* auth.js */
    'auth.profileTooltip': { en: 'Your contributor profile', ru: 'Ваш профиль участника' },
    'auth.reviewerName': { en: 'Reviewer: {name}', ru: 'Рецензент: {name}' },
    'auth.reviewerTooltip': { en: 'Manage reviewer session', ru: 'Управление сеансом рецензента' },
    // Non-breaking space keeps "Sign up" together: with the Source Library in
    // the nav the label is tight enough to break into three lines otherwise.
    'auth.logInSignUp': { en: 'Log in / Sign\u00A0up', ru: 'Войти / Зарегистрироваться' },

    /* Shared review-state labels (search.js, queue.js) */
    'review.state.approved': { en: 'Approved', ru: 'Утверждено' },
    'review.state.flagged': { en: 'Flagged', ru: 'Помечено' },
    'review.state.unreviewed': { en: 'Unreviewed', ru: 'Не проверено' },

    /* search.js */
    'search.badge.ocrUnreviewed': { en: 'OCR — unreviewed', ru: 'OCR — не проверено' },
    'search.badge.ocrUnverified': { en: 'OCR — unverified', ru: 'OCR — не подтверждено' },
    'search.stats.documents': { en: 'Documents', ru: 'Документы' },
    'search.stats.segments': { en: 'Segments', ru: 'Сегменты' },
    'search.stats.tokens': { en: 'Tokens', ru: 'Токены' },
    'search.stats.lexicon': { en: 'Lexicon', ru: 'Лексикон' },
    'search.loading': { en: 'Searching…', ru: 'Поиск…' },
    'search.error.failed': { en: 'Search failed', ru: 'Ошибка поиска' },
    'search.error.title': { en: 'Search error', ru: 'Ошибка поиска' },
    'search.concept.russianQuery': { en: 'Russian query', ru: 'Русский запрос' },
    'search.concept.lakTranslation': { en: 'Lak translation', ru: 'Лакский перевод' },
    'search.concept.dictionarySenses': { en: 'Dictionary senses:', ru: 'Словарные значения:' },
    'search.concept.historicalSenses': { en: 'Historical senses from Uslar 1890 (unreviewed OCR):', ru: 'Исторические значения из Услар 1890 (непроверенное OCR):' },
    'search.count.corpusPrefix': { en: 'Corpus occurrences · ', ru: 'Вхождения в корпусе · ' },
    'search.count.records': {
      en: { one: '{prefix}{count} record', other: '{prefix}{count} records' },
      ru: { one: '{prefix}{count} запись', few: '{prefix}{count} записи', many: '{prefix}{count} записей', other: '{prefix}{count} записей' }
    },
    'search.page.of': { en: 'Page {page} of {pages}', ru: 'Страница {page} из {pages}' },
    'search.empty.title': { en: 'No records match', ru: 'Нет подходящих записей' },
    'search.empty.body': { en: 'Try a different query, or clear the filters above.', ru: 'Попробуйте другой запрос или очистите фильтры выше.' },
    'search.type.text': { en: 'Text', ru: 'Текст' },
    'search.type.lexicon': { en: 'Lexicon', ru: 'Лексикон' },
    'search.col.typeQuality': { en: 'Type / quality', ru: 'Тип / качество' },
    'search.col.lak': { en: 'Lak', ru: 'Лакский' },
    'search.col.meaningDocument': { en: 'Meaning / document', ru: 'Значение / документ' },
    'search.col.source': { en: 'Source', ru: 'Источник' },
    'search.col.variety': { en: 'Lak variety', ru: 'Вариант лакского' },
    'search.action.review': { en: 'Check translation', ru: 'Проверить перевод' },
    'search.col.evidence': { en: 'Evidence', ru: 'Основания' },
    /* Why a record appeared: the field the query actually matched. */
    'search.match.lak': { en: 'Matched in the Lak text', ru: 'Совпадение в лакском тексте' },
    'search.match.translation': { en: 'Matched in the translation', ru: 'Совпадение в переводе' },
    'search.match.translationOrDocument': { en: 'Matched in the translation or document title', ru: 'Совпадение в переводе или названии документа' },
    'search.match.source': { en: 'Matched in the source name', ru: 'Совпадение в названии источника' },
    'search.match.variety': { en: 'Matched in the Lak variety', ru: 'Совпадение в варианте лакского' },
    'search.match.record_id': { en: 'Matched in the record ID', ru: 'Совпадение в идентификаторе записи' },
    'search.match.alias': { en: 'Matched through a dictionary form', ru: 'Совпадение через словарную форму' },
    /* Public evidence shown on a result card. */
    'search.evidence.loading': { en: 'Checking evidence…', ru: 'Проверка оснований…' },
    'search.evidence.unavailable': { en: 'Evidence check unavailable', ru: 'Проверка оснований недоступна' },
    'search.evidence.none.title': { en: 'Not enough evidence', ru: 'Недостаточно оснований' },
    'search.evidence.none.body': {
      en: 'No dictionary entry, reviewed pair or public example backs this record yet.',
      ru: 'Пока нет ни словарной статьи, ни проверенной пары, ни публичного примера, подтверждающих эту запись.'
    },
    'search.evidence.confidence.high': { en: 'Reviewed evidence', ru: 'Проверенные основания' },
    'search.evidence.confidence.medium': { en: 'Published evidence', ru: 'Опубликованные основания' },
    'search.evidence.confidence.low': { en: 'Weak evidence', ru: 'Слабые основания' },
    'search.evidence.confidence.none': { en: 'Not enough evidence', ru: 'Недостаточно оснований' },
    'search.evidence.review.expert_approved': { en: 'Expert-approved', ru: 'Утверждено экспертом' },
    'search.evidence.review.published_source': { en: 'Published source', ru: 'Опубликованный источник' },
    'search.evidence.review.unreviewed_usage': { en: 'Unreviewed usage', ru: 'Непроверенное употребление' },
    'search.evidence.review.no_public_evidence': { en: 'No public evidence', ru: 'Публичных оснований нет' },
    'search.evidence.class.approved_parallel_pair': { en: 'Approved pair', ru: 'Утверждённая пара' },
    'search.evidence.class.direct_dictionary': { en: 'Dictionary translation', ru: 'Словарный перевод' },
    'search.evidence.class.attested_public_example': { en: 'Attested phrase pair', ru: 'Засвидетельствованная пара фраз' },
    'search.evidence.class.usage_support_only': { en: 'Public corpus example', ru: 'Пример из публичного корпуса' },
    'search.evidence.usageOnly': { en: 'context only — not proof of a translation', ru: 'только контекст — не доказательство перевода' },
    'search.review.heading': { en: 'Check translation', ru: 'Проверить перевод' },
    'search.review.correctionLabel': { en: 'Correction (optional)', ru: 'Исправление (необязательно)' },
    'search.review.correctionPlaceholder': { en: 'Corrected Lak text or translation…', ru: 'Исправленный лакский текст или перевод…' },
    'search.review.noteLabel': { en: 'Note (optional)', ru: 'Заметка (необязательно)' },
    'search.review.notePlaceholder': { en: 'Describe the issue or your finding…', ru: 'Опишите проблему или ваш вывод…' },
    'search.review.reviewingAs': { en: 'Reviewing as', ru: 'Рецензирование от имени' },
    'search.review.yourNameOptional': { en: 'Your name (optional)', ru: 'Ваше имя (необязательно)' },
    'search.review.attributedTooltip': { en: 'Attributed to your reviewer login', ru: 'Приписывается вашей учётной записи рецензента' },
    'search.review.loggedIn': { en: '✓ logged in', ru: '✓ выполнен вход' },
    'search.review.namePlaceholder': { en: 'Reviewer name or anonymous', ru: 'Имя рецензента или анонимно' },
    'search.review.approve': { en: '✓ Approve', ru: '✓ Утвердить' },
    'search.review.loginHint': {
      en: 'You can flag problems or leave suggestions. <a href="/login.html">Log in as a reviewer</a> to approve records.',
      ru: 'Вы можете помечать проблемы или оставлять предложения. <a href="/login.html">Войдите как рецензент</a>, чтобы утверждать записи.'
    },
    'search.review.flag': { en: '⚑ Flag', ru: '⚑ Пометить' },
    'search.review.markUnreviewed': { en: '↺ Mark unreviewed', ru: '↺ Отметить как непроверенное' },
    'search.review.cancel': { en: 'Cancel', ru: 'Отмена' },
    'search.review.current': { en: 'Current:', ru: 'Текущее:' },
    'search.review.serverError': { en: 'Server error ({status})', ru: 'Ошибка сервера ({status})' },
    'search.review.saved': { en: 'Review saved: {state}', ru: 'Рецензия сохранена: {state}' },
    'search.review.saveFailed': { en: 'Failed to save review. Please try again.', ru: 'Не удалось сохранить рецензию. Пожалуйста, попробуйте ещё раз.' },

    /* lab.js */
    'lab.status.approved': { en: 'approved', ru: 'утверждено' },
    'lab.status.rejected': { en: 'rejected', ru: 'отклонено' },
    'lab.status.pending': { en: 'pending', ru: 'ожидает' },
    'lab.error.requestFailed': { en: 'Request failed.', ru: 'Запрос не выполнен.' },
    'lab.providerInfo': { en: '{provider} · model {model} · prompt {prompt}', ru: '{provider} · модель {model} · промпт {prompt}' },
    'lab.evidenceOnlyMode': { en: 'Evidence-only mode', ru: 'Режим только доказательств' },
    'lab.toast.loginHistory': { en: 'Log in to view saved translation pairs.', ru: 'Войдите, чтобы просмотреть сохранённые пары перевода.' },
    'lab.mode.evidence_only': { en: 'evidence-only', ru: 'только доказательства' },
    'lab.confidence': { en: 'Confidence {pct}%', ru: 'Уверенность {pct}%' },
    'lab.evidenceRecords': { en: '{count} supporting examples', ru: 'подтверждающих примеров: {count}' },
    'lab.abstainedBadge': { en: 'Not enough examples — no answer given', ru: 'Недостаточно примеров — ответ не дан' },
    'lab.altHeading': { en: 'Alternatives and unknowns', ru: 'Альтернативы и неизвестные' },
    'lab.noAlternative': { en: 'No supported alternative found.', ru: 'Обоснованных альтернатив не найдено.' },
    'lab.unknownLabel': { en: 'Unknown:', ru: 'Неизвестно:' },
    'lab.retrievedEvidence': { en: 'Examples found', ru: 'Найденные примеры' },
    'lab.unspecified': { en: 'unspecified', ru: 'не указано' },
    'lab.noEvidence': { en: 'No approved examples found. The system has not made up a translation.', ru: 'Разрешённых примеров не найдено. Система не выдумала перевод.' },
    'lab.toast.loginSave': { en: 'Log in to save a translation pair.', ru: 'Войдите, чтобы сохранить пару перевода.' },
    'lab.toast.enterTranslation': { en: 'Enter a human translation or abstain.', ru: 'Введите человеческий перевод или воздержитесь.' },
    'lab.toast.pairSubmitted': { en: 'Translation pair submitted for independent review.', ru: 'Пара перевода отправлена на независимую проверку.' },
    'lab.col.direction': { en: 'Direction', ru: 'Направление' },
    'lab.col.source': { en: 'Source', ru: 'Источник' },
    'lab.col.literalTarget': { en: 'Literal target', ru: 'Дословный перевод' },
    'lab.col.naturalTarget': { en: 'Natural target', ru: 'Естественный перевод' },
    'lab.col.status': { en: 'Status', ru: 'Статус' },

    /* observatory.js */
    'obs.value.none': { en: '—', ru: '—' },
    'obs.openPublicSource': { en: 'Open public source', ru: 'Открыть публичный источник' },
    'obs.opensNewTab': { en: '(opens in a new tab)', ru: '(откроется в новой вкладке)' },
    'obs.localProvenance': { en: 'Material is only in the archive — not available online', ru: 'Материал есть только в архиве — недоступен онлайн' },
    'obs.permissionSensitive': { en: 'Permission-sensitive', ru: 'Требует разрешения' },
    'obs.fact.language': { en: 'Language', ru: 'Язык' },
    'obs.fact.rightsBoundary': { en: 'Rights boundary', ru: 'Границы прав' },
    'obs.fact.scale': { en: 'Scale', ru: 'Масштаб' },
    'obs.nextAction': { en: 'Next concrete action', ru: 'Следующее конкретное действие' },
    'obs.notes': { en: 'Notes:', ru: 'Примечания:' },
    'obs.resultsCount': { en: '{shown} of {total} resources', ru: '{shown} из {total} ресурсов' },
    'obs.empty.title': { en: 'No resources match these filters', ru: 'Нет ресурсов, соответствующих этим фильтрам' },
    'obs.empty.body': { en: 'Try a broader search or clear one of the filters.', ru: 'Попробуйте более широкий поиск или снимите один из фильтров.' },
    'obs.stat.registryRecords': { en: 'Registry records', ru: 'Записи реестра' },
    'obs.stat.p0Priorities': { en: 'P0 priorities', ru: 'Приоритеты P0' },
    'obs.stat.heldOrProcessed': { en: 'Held or processed', ru: 'Получено или обработано' },
    'obs.stat.permissionSensitive': { en: 'Permission-sensitive', ru: 'Требует разрешения' },
    'obs.error.title': { en: 'The register is temporarily unavailable', ru: 'Реестр временно недоступен' },
    'obs.error.body': { en: 'We could not load the resource register. Please try again.', ru: 'Не удалось загрузить реестр ресурсов. Пожалуйста, попробуйте ещё раз.' },
    'obs.tryAgain': { en: 'Try again', ru: 'Повторить' },

    /* ── Observatory curated metadata (auto-maintained; see scripts/check-observatory-i18n.js) ── */
    /* Categories */
    'obs.category.annotated_corpus': { en: 'Annotated corpus', ru: 'Аннотированный корпус' },
    'obs.category.annotated_examples': { en: 'Annotated examples', ru: 'Аннотированные примеры' },
    'obs.category.archive_search': { en: 'Archive search', ru: 'Поиск по архиву' },
    'obs.category.audio': { en: 'Audio', ru: 'Аудио' },
    'obs.category.bibliography': { en: 'Bibliography', ru: 'Библиография' },
    'obs.category.community_media': { en: 'Community media', ru: 'Медиа сообщества' },
    'obs.category.cultural_portal': { en: 'Cultural portal', ru: 'Культурный портал' },
    'obs.category.dataset_index': { en: 'Dataset index', ru: 'Указатель наборов данных' },
    'obs.category.dictionary': { en: 'Dictionary', ru: 'Словарь' },
    'obs.category.discovery_portal': { en: 'Discovery portal', ru: 'Поисковый портал' },
    'obs.category.folklore': { en: 'Folklore', ru: 'Фольклор' },
    'obs.category.gap_opportunity': { en: 'Gap / opportunity', ru: 'Пробел / возможность' },
    'obs.category.grammar': { en: 'Grammar', ru: 'Грамматика' },
    'obs.category.grammar_glossed_text': { en: 'Grammar + glossed text', ru: 'Грамматика + глоссированный текст' },
    'obs.category.grammar_texts': { en: 'Grammar + texts', ru: 'Грамматика + тексты' },
    'obs.category.interlinear_text': { en: 'Interlinear text', ru: 'Интерлинеарный текст' },
    'obs.category.literature': { en: 'Literature', ru: 'Литература' },
    'obs.category.model': { en: 'Model', ru: 'Модель' },
    'obs.category.newspaper': { en: 'Newspaper', ru: 'Газета' },
    'obs.category.parallel_literature': { en: 'Parallel literature', ru: 'Параллельная литература' },
    'obs.category.phrasebook': { en: 'Phrasebook', ru: 'Разговорник' },
    'obs.category.portal_bibliography': { en: 'Portal + bibliography', ru: 'Портал + библиография' },
    'obs.category.reference': { en: 'Reference', ru: 'Справочник' },
    'obs.category.research': { en: 'Research', ru: 'Исследование' },
    'obs.category.research_collection': { en: 'Research collection', ru: 'Исследовательская коллекция' },
    'obs.category.teaching': { en: 'Teaching', ru: 'Учебные материалы' },
    'obs.category.tool': { en: 'Tool', ru: 'Инструмент' },
    'obs.category.video': { en: 'Video', ru: 'Видео' },
    'obs.category.web_corpus': { en: 'Web corpus', ru: 'Веб-корпус' },
    'obs.category.wordlist': { en: 'Wordlist', ru: 'Список слов' },
    /* Statuses */
    'obs.status.catalog_only': { en: 'Catalog only', ru: 'Только по каталогу' },
    'obs.status.contact_lead': { en: 'Contact lead', ru: 'Контактная наводка' },
    'obs.status.discovery_portal': { en: 'Discovery portal', ru: 'Поисковый портал' },
    'obs.status.gap_confirmed': { en: 'Gap confirmed', ru: 'Пробел подтверждён' },
    'obs.status.held': { en: 'Held', ru: 'Имеется' },
    'obs.status.institutional_lead': { en: 'Institutional lead', ru: 'Институциональная наводка' },
    'obs.status.local_lead': { en: 'Local lead', ru: 'Локальная наводка' },
    'obs.status.needs_verification': { en: 'Needs verification', ru: 'Требует проверки' },
    'obs.status.processed': { en: 'Processed', ru: 'Обработано' },
    'obs.status.verified': { en: 'Verified', ru: 'Проверено' },
    'obs.status.verified_lead': { en: 'Verified lead', ru: 'Проверенная наводка' },
    /* Rights boundaries */
    'obs.rights.apache_2_0_model_terms_to_confirm': { en: 'Apache-2.0 / model terms to confirm', ru: 'Apache-2.0 / условия модели требуют уточнения' },
    'obs.rights.archive_edition_terms': { en: 'Archive/edition terms', ru: 'Условия архива/издания' },
    'obs.rights.assume_copyrighted_until_clarified': { en: 'Assume copyrighted until clarified', ru: 'Считать защищённым авторским правом до выяснения' },
    'obs.rights.author_manuscript_verify': { en: 'Author manuscript / verify', ru: 'Авторская рукопись / требует проверки' },
    'obs.rights.cc_by_4_0': { en: 'CC BY 4.0', ru: 'CC BY 4.0' },
    'obs.rights.cc_by_4_0_metadata': { en: 'CC BY 4.0 metadata', ru: 'Метаданные CC BY 4.0' },
    'obs.rights.cc_by_sa_4_0': { en: 'CC BY-SA 4.0', ru: 'CC BY-SA 4.0' },
    'obs.rights.cc_by_sa_gfdl': { en: 'CC BY-SA / GFDL', ru: 'CC BY-SA / GFDL' },
    'obs.rights.check_current_dataset_license': { en: 'Check current dataset license', ru: 'Проверить текущую лицензию набора данных' },
    'obs.rights.cite_verify_reuse': { en: 'Cite / verify reuse', ru: 'Цитировать / проверить возможность повторного использования' },
    'obs.rights.cite_only': { en: 'Cite only', ru: 'Только цитирование' },
    'obs.rights.confirm_per_site_license': { en: 'Confirm per-site license', ru: 'Уточнить лицензию по каждому сайту' },
    'obs.rights.consent_and_deposit_terms_required': { en: 'Consent and deposit terms required', ru: 'Требуются согласие и условия депонирования' },
    'obs.rights.consent_and_deposit_terms_to_verify': { en: 'Consent and deposit terms to verify', ru: 'Согласие и условия депонирования требуют проверки' },
    'obs.rights.consent_and_reuse_status_to_verify': { en: 'Consent and reuse status to verify', ru: 'Согласие и статус повторного использования требуют проверки' },
    'obs.rights.copyrighted': { en: 'Copyrighted', ru: 'Защищено авторским правом' },
    'obs.rights.copyrighted_cite': { en: 'Copyrighted / cite', ru: 'Защищено авторским правом / цитировать' },
    'obs.rights.copyrighted_verify': { en: 'Copyrighted / verify', ru: 'Защищено авторским правом / требует проверки' },
    'obs.rights.copyrighted_article': { en: 'Copyrighted article', ru: 'Статья, защищённая авторским правом' },
    'obs.rights.copyrighted_edition_verify': { en: 'Copyrighted edition / verify', ru: 'Издание, защищённое авторским правом / требует проверки' },
    'obs.rights.copyrighted_editions': { en: 'Copyrighted editions', ru: 'Издания, защищённые авторским правом' },
    'obs.rights.edition_and_archive_terms_to_confirm': { en: 'Edition and archive terms to confirm', ru: 'Условия издания и архива требуют уточнения' },
    'obs.rights.edition_copyright_to_confirm': { en: 'Edition copyright to confirm', ru: 'Авторские права на издание требуют уточнения' },
    'obs.rights.educational_verify': { en: 'Educational / verify', ru: 'Образовательное использование / требует проверки' },
    'obs.rights.inspect_model_card': { en: 'Inspect model card', ru: 'Изучить карточку модели' },
    'obs.rights.inspect_model_data_licenses': { en: 'Inspect model/data licenses', ru: 'Изучить лицензии модели/данных' },
    'obs.rights.library_access_terms': { en: 'Library access terms', ru: 'Условия доступа библиотеки' },
    'obs.rights.library_terms': { en: 'Library terms', ru: 'Условия библиотеки' },
    'obs.rights.license_unstated': { en: 'License unstated', ru: 'Лицензия не указана' },
    'obs.rights.mixed_upstream_rights': { en: 'Mixed upstream rights', ru: 'Смешанные права первоисточников' },
    'obs.rights.mixed_web_rights': { en: 'Mixed web rights', ru: 'Смешанные права веб-источников' },
    'obs.rights.mixed_source_provenance': { en: 'Mixed-source provenance', ru: 'Происхождение из смешанных источников' },
    'obs.rights.mixed_page_copyrighted': { en: 'Mixed; page copyrighted', ru: 'Смешанные; страница защищена авторским правом' },
    'obs.rights.n_a': { en: 'N/A', ru: 'Неприменимо' },
    'obs.rights.per_collection': { en: 'Per collection', ru: 'По каждой коллекции' },
    'obs.rights.per_dataset': { en: 'Per dataset', ru: 'По каждому набору данных' },
    'obs.rights.per_document': { en: 'Per document', ru: 'По каждому документу' },
    'obs.rights.permission_educational_reuse': { en: 'Permission / educational reuse', ru: 'Разрешение / образовательное повторное использование' },
    'obs.rights.permission_pending': { en: 'Permission pending', ru: 'Разрешение ожидается' },
    'obs.rights.permission_required': { en: 'Permission required', ru: 'Требуется разрешение' },
    'obs.rights.public_domain': { en: 'Public domain', ru: 'Общественное достояние' },
    'obs.rights.quote_cite_no_bulk_reuse_assumed': { en: 'Quote/cite; no bulk reuse assumed', ru: 'Цитирование; массовое повторное использование не предполагается' },
    'obs.rights.reproduction_status_to_confirm': { en: 'Reproduction status to confirm', ru: 'Статус воспроизведения требует уточнения' },
    'obs.rights.research_only_verify': { en: 'Research only / verify', ru: 'Только для исследований / требует проверки' },
    'obs.rights.researcher_community_agreement_needed': { en: 'Researcher/community agreement needed', ru: 'Требуется соглашение с исследователем/сообществом' },
    'obs.rights.reuse_terms_to_confirm': { en: 'Reuse terms to confirm', ru: 'Условия повторного использования требуют уточнения' },
    'obs.rights.scholarly_quotation_only': { en: 'Scholarly quotation only', ru: 'Только научное цитирование' },
    'obs.rights.scholarly_use': { en: 'Scholarly use', ru: 'Научное использование' },
    'obs.rights.underlying_rights_require_agreement': { en: 'Underlying rights require agreement', ru: 'Исходные права требуют соглашения' },
    'obs.rights.user_copyright_platform_terms': { en: 'User copyright + platform terms', ru: 'Авторские права пользователей + условия платформы' },
    'obs.rights.verify_edition_status': { en: 'Verify edition status', ru: 'Проверить статус издания' },
    'obs.rights.verify_upstream_terms': { en: 'Verify upstream terms', ru: 'Проверить условия первоисточников' },
    /* Per-resource scale / action / notes */
    'obs.resource.held_gadzhiev.scale': { en: '14,373 extracted entries', ru: '14 373 извлечённые записи' },
    'obs.resource.held_gadzhiev.action': { en: 'Expert-review samples; normalize senses and morphology.', ru: 'Экспертно проверить выборки; нормализовать значения и морфологию.' },
    'obs.resource.held_gadzhiev.notes': { en: 'Already ingested into corpus v1.1.', ru: 'Уже включено в корпус v1.1.' },
    'obs.resource.held_literary.scale': { en: '77 documents; 45,488 sentence candidates', ru: '77 документов; 45 488 кандидатов в предложения' },
    'obs.resource.held_literary.action': { en: 'Identify editions and rights holders; expert-review clean samples.', ru: 'Определить издания и правообладателей; экспертно проверить очищенные выборки.' },
    'obs.resource.held_literary.notes': { en: 'Modern prose and poetry; provenance must be completed before publication or training.', ru: 'Современная проза и поэзия; происхождение должно быть установлено до публикации или обучения.' },
    'obs.resource.held_pcmlbe.scale': { en: 'Morphologically parsed text', ru: 'Морфологически разобранный текст' },
    'obs.resource.held_pcmlbe.creator': { en: 'Erwin Komen · Radboud University', ru: 'Эрвин Комен · Радбаудский университет' },
    'obs.resource.held_pcmlbe.action': { en: 'Preserve native annotation and source IDs; reuse under CC BY-SA 4.0 with attribution.', ru: 'Сохранить исходную аннотацию и идентификаторы источника; использование по CC BY-SA 4.0 с указанием авторства.' },
    'obs.resource.held_pcmlbe.notes': { en: 'Core grammatical-search resource; avoid flattening its annotations. License confirmed: CC BY-SA 4.0 — credit Erwin Komen, Radboud University; ShareAlike applies to reuse.', ru: 'Ключевой ресурс для грамматического поиска; не следует уплощать его аннотации. Лицензия подтверждена: CC BY-SA 4.0 — указывайте Эрвина Комена, Радбаудский университет; при повторном использовании действует ShareAlike.' },
    'obs.resource.held_ids.scale': { en: 'Standard Lak plus Arakul, Balkhar and Shali lists', ru: 'Литературный лакский плюс аракульский, балхарский и шалинский списки' },
    'obs.resource.held_ids.action': { en: 'Retain variety labels and citations in every exported entry.', ru: 'Сохранять пометки разновидностей и ссылки в каждой экспортируемой записи.' },
    'obs.resource.held_ids.notes': { en: 'Already imported; strongest clear-license lexical layer.', ru: 'Уже импортировано; наиболее надёжный лексический слой с ясной лицензией.' },
    'obs.resource.held_wikipedia.scale': { en: 'Full lbe wiki dump', ru: 'Полный дамп вики lbe' },
    'obs.resource.held_wikipedia.action': { en: 'Reconcile against prior snapshot and preserve article/revision metadata.', ru: 'Сверить с предыдущим снимком и сохранить метаданные статей/ревизий.' },
    'obs.resource.held_wikipedia.notes': { en: 'Likely duplicated inside several multilingual web corpora.', ru: 'Вероятно, дублируется в нескольких многоязычных веб-корпусах.' },
    'obs.resource.held_uslar.scale': { en: 'Historical grammar, vocabulary and examples', ru: 'Историческая грамматика, словарь и примеры' },
    'obs.resource.held_uslar.action': { en: 'Keep in separate Historical [Uslar OCR] layer; manually transcribe selected examples.', ru: 'Держать в отдельном слое «Исторический [OCR Услара]»; вручную транскрибировать отобранные примеры.' },
    'obs.resource.held_uslar.notes': { en: 'Not a source of unmarked modern-standard forms.', ru: 'Не является источником непомеченных современных литературных форм.' },
    'obs.resource.held_tolstoy.scale': { en: 'Book-length bilingual alignment opportunity', ru: 'Возможность двуязычного выравнивания объёмом с книгу' },
    'obs.resource.held_tolstoy.action': { en: 'Locate exact Russian edition; align a pilot only after rights review.', ru: 'Найти точное русское издание; выровнять пилотный фрагмент только после проверки прав.' },
    'obs.resource.held_tolstoy.notes': { en: 'High translation value; OCR pilot exists locally.', ru: 'Высокая переводческая ценность; пилотный OCR имеется локально.' },
    'obs.resource.held_folktales.scale': { en: 'Book-length narrative text', ru: 'Нарративный текст объёмом с книгу' },
    'obs.resource.held_folktales.action': { en: 'Complete bibliographic record; OCR and expert-check a representative pilot.', ru: 'Завершить библиографическую запись; провести OCR и экспертную проверку репрезентативного пилота.' },
    'obs.resource.held_folktales.notes': { en: 'Oral tradition and printed edition rights should be tracked separately.', ru: 'Права на устную традицию и печатное издание следует отслеживать отдельно.' },
    'obs.resource.khaydakov.scale': { en: 'About 13,000 words', ru: 'Около 13 000 слов' },
    'obs.resource.khaydakov.action': { en: 'Acquire a lawful scan or library copy; extract with page-level citations.', ru: 'Приобрести законный скан или библиотечный экземпляр; извлечь с постраничными ссылками.' },
    'obs.resource.khaydakov.notes': { en: 'Reverse direction complements Gadzhiyev and is a top acquisition.', ru: 'Обратное направление дополняет Гаджиева и является приоритетным приобретением.' },
    'obs.resource.digiev.scale': { en: '5,383 imported pairs', ru: '5 383 импортированные пары' },
    'obs.resource.digiev.action': { en: 'Recover full edition metadata and page references; validate common phrases.', ru: 'Восстановить полные метаданные издания и постраничные ссылки; проверить распространённые фразы.' },
    'obs.resource.digiev.notes': { en: 'Useful conversational parallel data, but not yet publication-ready.', ru: 'Полезные разговорные параллельные данные, но пока не готовы к публикации.' },
    'obs.resource.ilchi.scale': { en: 'Multi-year issues; born-digital PDFs and articles', ru: 'Многолетние выпуски; цифровые PDF и статьи' },
    'obs.resource.ilchi.action': { en: 'Ask publisher for research/corpus permission and bulk archive access.', ru: 'Запросить у издателя разрешение на исследовательское/корпусное использование и массовый доступ к архиву.' },
    'obs.resource.ilchi.notes': { en: 'Best candidate for contemporary vocabulary, dates, names and public discourse.', ru: 'Лучший кандидат для современной лексики, дат, имён и публичного дискурса.' },
    'obs.resource.ilchi_orthography.scale': { en: 'Detailed orthographic guidance', ru: 'Подробные орфографические указания' },
    'obs.resource.ilchi_orthography.action': { en: 'Encode rules into tokenizer/search QA tests with source citation.', ru: 'Закодировать правила в тесты контроля качества токенизатора/поиска со ссылкой на источник.' },
    'obs.resource.ilchi_orthography.notes': { en: 'Directly relevant to хI/хӀ and multi-character-letter normalization.', ru: 'Непосредственно относится к нормализации хI/хӀ и многосимвольных букв.' },
    'obs.resource.gtrk_radio.scale': { en: 'Ongoing news and programs', ru: 'Постоянные новости и программы' },
    'obs.resource.gtrk_radio.action': { en: 'Contact broadcaster for preservation/research license, files and scripts.', ru: 'Связаться с вещателем для получения лицензии на сохранение/исследование, файлов и сценариев.' },
    'obs.resource.gtrk_radio.notes': { en: 'High-value modern speech with dates, topics and speaker context.', ru: 'Ценная современная речь с датами, темами и контекстом говорящего.' },
    'obs.resource.rutube_gtrk.scale': { en: '131 videos observed on 2026-07-29', ru: '131 видео, зафиксировано 2026-07-29' },
    'obs.resource.rutube_gtrk.action': { en: 'Inventory metadata and durations; seek permission before download/transcription.', ru: 'Составить опись метаданных и длительностей; получить разрешение до загрузки/транскрипции.' },
    'obs.resource.rutube_gtrk.notes': { en: 'Potential speech corpus and contemporary-language benchmark.', ru: 'Потенциальный речевой корпус и эталон современного языка.' },
    'obs.resource.rgvk.scale': { en: 'Recurring cultural program', ru: 'Регулярная культурная программа' },
    'obs.resource.rgvk.action': { en: 'Request archive, captions/scripts and research reuse terms.', ru: 'Запросить архив, субтитры/сценарии и условия исследовательского повторного использования.' },
    'obs.resource.rgvk.notes': { en: 'Includes culture, history, ethnography and «Учим Лакский язык вместе с Гереем».', ru: 'Включает культуру, историю, этнографию и «Учим Лакский язык вместе с Гереем».' },
    'obs.resource.dspu_video.scale': { en: 'Lesson and lecture series', ru: 'Серия уроков и лекций' },
    'obs.resource.dspu_video.action': { en: 'Catalog individual lessons; propose collaboration and transcripts.', ru: 'Каталогизировать отдельные уроки; предложить сотрудничество и транскрипты.' },
    'obs.resource.dspu_video.notes': { en: 'Pedagogically structured speech may support curriculum and evaluation.', ru: 'Педагогически структурированная речь может поддержать учебную программу и оценивание.' },
    'obs.resource.rsl_azbuka_guide.scale': { en: '115 pages', ru: '115 страниц' },
    'obs.resource.rsl_azbuka_guide.action': { en: 'Open/download through RSL; capture page images and metadata; assess OCR.', ru: 'Открыть/загрузить через РГБ; сделать изображения страниц и метаданные; оценить OCR.' },
    'obs.resource.rsl_azbuka_guide.notes': { en: 'Teacher-facing structure is useful for graded curriculum.', ru: 'Структура, ориентированная на учителя, полезна для поэтапной учебной программы.' },
    'obs.resource.neb_primer.scale': { en: '159 pages', ru: '159 страниц' },
    'obs.resource.neb_primer.action': { en: 'Locate legal library access; approach publisher/Ministry for research copy.', ru: 'Найти законный библиотечный доступ; обратиться к издателю/Министерству за исследовательским экземпляром.' },
    'obs.resource.neb_primer.notes': { en: 'Modern controlled vocabulary and graded examples.', ru: 'Современная контролируемая лексика и поэтапно усложняющиеся примеры.' },
    'obs.resource.dgu_course.scale': { en: 'University course PDF', ru: 'PDF университетского курса' },
    'obs.resource.dgu_course.action': { en: 'Extract bibliography, example sentences and learning outcomes with citations.', ru: 'Извлечь библиографию, примеры предложений и учебные результаты со ссылками.' },
    'obs.resource.dgu_course.notes': { en: 'Potential source map and curriculum benchmark, not automatically corpus text.', ru: 'Потенциальная карта источников и учебный эталон, но не автоматически корпусный текст.' },
    'obs.resource.schulze.scale': { en: '23 pages; grammar and interlinear sample', ru: '23 страницы; грамматика и интерлинеарный образец' },
    'obs.resource.schulze.action': { en: 'Extract the interlinear example and bibliography; request reuse permission.', ru: 'Извлечь интерлинеарный пример и библиографию; запросить разрешение на повторное использование.' },
    'obs.resource.schulze.notes': { en: 'Compact English-language grammar with machine-useful gloss structure.', ru: 'Компактная англоязычная грамматика с машиночитаемой структурой глосс.' },
    'obs.resource.oxford_handbook.scale': { en: 'Modern grammatical overview', ru: 'Современный грамматический обзор' },
    'obs.resource.oxford_handbook.action': { en: 'Use through library; ask author about examples/data and collaboration.', ru: 'Использовать через библиотеку; спросить автора о примерах/данных и сотрудничестве.' },
    'obs.resource.oxford_handbook.notes': { en: 'Authoritative modern overview of standard Lak.', ru: 'Авторитетный современный обзор литературного лакского языка.' },
    'obs.resource.minlang.scale': { en: 'Sociolinguistic profile, bibliography and sample tale', ru: 'Социолингвистический профиль, библиография и образец сказки' },
    'obs.resource.minlang.action': { en: 'Extract full bibliography; trace each primary source separately.', ru: 'Извлечь полную библиографию; проследить каждый первоисточник отдельно.' },
    'obs.resource.minlang.notes': { en: 'Good discovery hub and institutional context.', ru: 'Хороший поисковый узел и институциональный контекст.' },
    'obs.resource.glottolog.scale': { en: 'Language record plus linked references', ru: 'Языковая запись плюс связанные ссылки' },
    'obs.resource.glottolog.action': { en: 'Export references; deduplicate against Observatory by title/author/year.', ru: 'Экспортировать ссылки; устранить дубликаты с Обсерваторией по названию/автору/году.' },
    'obs.resource.glottolog.notes': { en: 'Discovery and bibliographic authority, not corpus content.', ru: 'Поисковый и библиографический авторитет, а не корпусный контент.' },
    'obs.resource.cldf_meta.scale': { en: 'Linked forms, values, entries and examples', ru: 'Связанные формы, значения, записи и примеры' },
    'obs.resource.cldf_meta.action': { en: 'Resolve each dataset and license; compare against IDS holdings.', ru: 'Разрешить каждый набор данных и лицензию; сравнить с фондами IDS.' },
    'obs.resource.cldf_meta.notes': { en: 'Likely includes duplicates; provenance-level reconciliation required.', ru: 'Вероятно, содержит дубликаты; требуется сверка на уровне происхождения.' },
    'obs.resource.glot500.scale': { en: 'Lak is among 511 covered languages', ru: 'Лакский входит в число 511 охваченных языков' },
    'obs.resource.glot500.action': { en: 'Identify exact lbe configuration, domains and overlap with Wikipedia before use.', ru: 'Определить точную конфигурацию lbe, домены и пересечение с Википедией перед использованием.' },
    'obs.resource.glot500.notes': { en: 'Useful discovery pool; the dataset card states some original data cannot be released.', ru: 'Полезный поисковый ресурс; в карточке набора данных указано, что часть исходных данных не может быть опубликована.' },
    'obs.resource.glotcc.scale': { en: 'Minority-language Common Crawl', ru: 'Common Crawl для языков меньшинств' },
    'obs.resource.glotcc.action': { en: 'Measure lbe volume, inspect domains and deduplicate; quarantine uncertain rights.', ru: 'Измерить объём lbe, изучить домены и устранить дубликаты; изолировать сомнительные права.' },
    'obs.resource.glotcc.notes': { en: 'Good for finding websites, not automatically safe as public training data.', ru: 'Хорош для поиска сайтов, но не автоматически безопасен как публичные обучающие данные.' },
    'obs.resource.goldfish.scale': { en: 'Full, 10 MB and 5 MB checkpoints', ru: 'Полная контрольная точка, а также на 10 МБ и 5 МБ' },
    'obs.resource.goldfish.action': { en: 'Audit model card, training corpus manifest and license; benchmark without treating outputs as truth.', ru: 'Проверить карточку модели, манифест обучающего корпуса и лицензию; тестировать, не считая выводы истиной.' },
    'obs.resource.goldfish.notes': { en: 'Evidence that a Lak pretraining corpus exists; source transparency is the key question.', ru: 'Свидетельство существования лакского корпуса для предобучения; ключевой вопрос — прозрачность источника.' },
    'obs.resource.mmbert.scale': { en: 'Base and small encoders', ru: 'Базовый и малый энкодеры' },
    'obs.resource.mmbert.action': { en: 'Evaluate embeddings and masked-token behavior on an expert-reviewed Lak test set.', ru: 'Оценить эмбеддинги и поведение маскированных токенов на экспертно проверенном лакском тестовом наборе.' },
    'obs.resource.mmbert.notes': { en: 'Not a translator; may help retrieval, tagging and transfer learning.', ru: 'Это не переводчик; может помочь в поиске, разметке и трансферном обучении.' },
    'obs.resource.opus_mul_en.scale': { en: '~0.3B parameters', ru: '~0,3 млрд параметров' },
    'obs.resource.opus_mul_en.action': { en: 'Confirm Lak language token and non-excluded training sources; run a tiny benchmark.', ru: 'Подтвердить токен лакского языка и неисключённые обучающие источники; провести небольшой тест.' },
    'obs.resource.opus_mul_en.notes': { en: 'A language tag is not proof of usable Lak translation quality.', ru: 'Языковая метка не является доказательством пригодного качества перевода на лакский.' },
    'obs.resource.abakarova_dissertation.scale': { en: 'Dissertation-length', ru: 'Объёмом с диссертацию' },
    'obs.resource.abakarova_dissertation.action': { en: 'Mine bibliography and record each example with page citation.', ru: 'Собрать библиографию и зафиксировать каждый пример с постраничной ссылкой.' },
    'obs.resource.abakarova_dissertation.notes': { en: 'Useful bridge to recent Russian scholarship.', ru: 'Полезный мост к недавней русскоязычной научной литературе.' },
    'obs.resource.infinitive_dissertation.scale': { en: 'Dissertation', ru: 'Диссертация' },
    'obs.resource.infinitive_dissertation.action': { en: 'Obtain through library; extract annotated examples and bibliography.', ru: 'Получить через библиотеку; извлечь аннотированные примеры и библиографию.' },
    'obs.resource.infinitive_dissertation.notes': { en: 'Potential morphology benchmark.', ru: 'Потенциальный эталон для морфологии.' },
    'obs.resource.substantives_dissertation.scale': { en: 'Uses prose, journalism, folklore and spoken observations', ru: 'Использует прозу, публицистику, фольклор и наблюдения устной речи' },
    'obs.resource.substantives_dissertation.action': { en: 'Locate dissertation through university/RSL and trace its primary text sources.', ru: 'Найти диссертацию через университет/РГБ и проследить её первоисточники текстов.' },
    'obs.resource.substantives_dissertation.notes': { en: 'Especially valuable because it names multiple modern usage domains.', ru: 'Особенно ценна, поскольку называет несколько современных сфер употребления.' },
    'obs.resource.tolstoy_study.scale': { en: 'Parallel-text analysis', ru: 'Анализ параллельного текста' },
    'obs.resource.tolstoy_study.action': { en: 'Use to guide alignment and record cited editions/pages.', ru: 'Использовать для руководства выравниванием и фиксации цитируемых изданий/страниц.' },
    'obs.resource.tolstoy_study.notes': { en: 'Connects directly to the locally held Tolstoy volume.', ru: 'Напрямую связана с локально хранимым томом Толстого.' },
    'obs.resource.onomatopoeia.scale': { en: 'Focused lexical examples', ru: 'Целенаправленные лексические примеры' },
    'obs.resource.onomatopoeia.action': { en: 'Extract a small cited example set for morphology/lexicon QA.', ru: 'Извлечь небольшой набор цитируемых примеров для контроля качества морфологии/лексикона.' },
    'obs.resource.onomatopoeia.notes': { en: 'Targeted specialist evidence, not a bulk corpus.', ru: 'Целенаправленное узкоспециальное свидетельство, а не массовый корпус.' },
    'obs.resource.online_language_archive.scale': { en: '2,100 collections across 270 languages', ru: '2 100 коллекций по 270 языкам' },
    'obs.resource.online_language_archive.action': { en: 'Search Lak, Lakk, Kazikumukh and consultant names; record only confirmed collections.', ru: 'Искать Lak, Lakk, Kazikumukh и имена консультантов; фиксировать только подтверждённые коллекции.' },
    'obs.resource.online_language_archive.notes': { en: 'No Lak-specific collection confirmed yet.', ru: 'Ни одной специфически лакской коллекции пока не подтверждено.' },
    'obs.resource.no_ud.scale': { en: 'No Lak treebank found in current language list', ru: 'В текущем списке языков лакский трибанк не найден' },
    'obs.resource.no_ud.action': { en: 'Propose a small expert-reviewed Lak UD seed treebank from licensed examples.', ru: 'Предложить небольшой экспертно проверенный начальный трибанк UD для лакского из лицензированных примеров.' },
    'obs.resource.no_ud.notes': { en: 'A fundable university contribution and a concrete research milestone.', ru: 'Финансируемый университетский вклад и конкретная исследовательская веха.' },
    'obs.resource.agamov_app.scale': { en: 'About 26,000 entries reported', ru: 'По сообщениям, около 26 000 записей' },
    'obs.resource.agamov_app.action': { en: 'Contact Agamov and IYALI for the original structured database and explicit public/research/model terms.', ru: 'Связаться с Агамовым и ИЯЛИ для получения исходной структурированной базы данных и явных условий публичного/исследовательского/модельного использования.' },
    'obs.resource.agamov_app.notes': { en: 'Do not scrape the app; this may overlap Khaydakov and other institutional dictionaries.', ru: 'Не скрапить приложение; возможно пересечение с Хайдаковым и другими институциональными словарями.' },
    'obs.resource.dictionary_2019_40k.scale': { en: 'More than 40,000 headwords reported', ru: 'По сообщениям, более 40 000 заглавных слов' },
    'obs.resource.dictionary_2019_40k.action': { en: 'Resolve exact title, compilers, ISBN, publisher and library locations; seek a licensed digital source.', ru: 'Установить точное название, составителей, ISBN, издателя и места хранения в библиотеках; найти лицензированный цифровой источник.' },
    'obs.resource.dictionary_2019_40k.notes': { en: 'Potentially the largest modern bilingual lexicon identified, but current metadata is incomplete.', ru: 'Потенциально крупнейший выявленный современный двуязычный лексикон, но текущие метаданные неполны.' },
    'obs.resource.dictionary_1949.scale': { en: 'About 23–24 pages', ru: 'Около 23–24 страниц' },
    'obs.resource.dictionary_1949.action': { en: 'Resolve the exact catalog record and inspect the full-view copy.', ru: 'Установить точную каталожную запись и изучить полнотекстовый экземпляр.' },
    'obs.resource.dictionary_1949.notes': { en: 'Small historical school lexicon; useful for diachronic comparison, not a modern authority.', ru: 'Небольшой исторический школьный лексикон; полезен для диахронического сравнения, но не современный авторитет.' },
    'obs.resource.komen_lexicon.scale': { en: 'Size unstated', ru: 'Размер не указан' },
    'obs.resource.komen_lexicon.action': { en: 'Ask Komen for export, schema, source lineage and reuse terms; deduplicate against PCMLBE and print dictionaries.', ru: 'Запросить у Komen экспорт, схему, происхождение источников и условия повторного использования; устранить дубликаты с PCMLBE и печатными словарями.' },
    'obs.resource.komen_lexicon.notes': { en: 'Potentially useful for OOV checking and source reconciliation.', ru: 'Потенциально полезен для проверки OOV и сверки источников.' },
    'obs.resource.tald.scale': { en: 'Glossed Lak examples by typological feature', ru: 'Глоссированные лакские примеры по типологическим признакам' },
    'obs.resource.tald.action': { en: 'Enumerate Lak examples and citations; confirm license before structured import.', ru: 'Перечислить лакские примеры и ссылки; подтвердить лицензию до структурированного импорта.' },
    'obs.resource.tald.notes': { en: 'Small but potentially gold-quality morphosyntactic evidence.', ru: 'Небольшое, но потенциально высококачественное морфосинтаксическое свидетельство.' },
    'obs.resource.suxasulu.scale': { en: 'Two-page narrative with glosses and Russian translation', ru: 'Двухстраничный нарратив с глоссами и русским переводом' },
    'obs.resource.suxasulu.action': { en: 'Acquire the exact text file/page; ask for reuse permission and preserve morpheme alignment.', ru: 'Приобрести точный файл/страницу текста; запросить разрешение на повторное использование и сохранить выравнивание морфем.' },
    'obs.resource.suxasulu.notes': { en: 'High-value gold-format parallel and interlinear micro-corpus; distinct from the portal record.', ru: 'Ценный параллельный и интерлинеарный микрокорпус эталонного формата; отличается от записи портала.' },
    'obs.resource.asjp.scale': { en: 'Small basic-vocabulary list', ru: 'Небольшой список базовой лексики' },
    'obs.resource.asjp.action': { en: 'Confirm language/variety metadata and license; compare forms against IDS rather than counting as new blindly.', ru: 'Подтвердить метаданные языка/разновидности и лицензию; сравнить формы с IDS, а не считать вслепую новыми.' },
    'obs.resource.asjp.notes': { en: 'Useful for typology and validation, limited for translation.', ru: 'Полезен для типологии и валидации, ограничен для перевода.' },
    'obs.resource.glotlid.scale': { en: 'Language-ID model; not a text corpus', ru: 'Модель определения языка; не текстовый корпус' },
    'obs.resource.glotlid.action': { en: 'Use as an independent check in Lak web-corpus filtering; evaluate false positives on Daghestanian neighbors.', ru: 'Использовать как независимую проверку при фильтрации лакского веб-корпуса; оценить ложные срабатывания на дагестанских соседях.' },
    'obs.resource.glotlid.notes': { en: 'Useful pipeline tool; must not be counted as Lak training text.', ru: 'Полезный конвейерный инструмент; не должен учитываться как лакский обучающий текст.' },
    'obs.resource.omniglot.scale': { en: 'Alphabet, phrases and a tiny sample', ru: 'Алфавит, фразы и крошечный образец' },
    'obs.resource.omniglot.action': { en: 'Use only as a cross-check; verify every Lak form against a second authoritative source.', ru: 'Использовать только для перекрёстной проверки; сверять каждую лакскую форму со вторым авторитетным источником.' },
    'obs.resource.omniglot.notes': { en: 'Tiny and potentially duplicative; not a corpus acquisition.', ru: 'Крошечный и потенциально дублирующий; не является корпусным приобретением.' },
    'obs.resource.glosbe.scale': { en: 'Unknown; mixed examples', ru: 'Неизвестно; смешанные примеры' },
    'obs.resource.glosbe.action': { en: 'Use to discover candidate forms only; trace each example to its original source before accepting it.', ru: 'Использовать только для обнаружения кандидатных форм; проследить каждый пример до первоисточника перед принятием.' },
    'obs.resource.glosbe.notes': { en: 'Not suitable for blind bulk import, gold labels or novelty counts.', ru: 'Не подходит для слепого массового импорта, эталонных меток или подсчёта новизны.' },
    'obs.resource.kayaev_dictionary.scale': { en: 'Encyclopedic historical, etymological and translation dictionary', ru: 'Энциклопедический исторический, этимологический и переводной словарь' },
    'obs.resource.kayaev_dictionary.action': { en: 'Partner with IYALI/library custodians for authoritative digitization and editorial history.', ru: 'Сотрудничать с ИЯЛИ/библиотечными хранителями для авторитетной оцифровки и редакционной истории.' },
    'obs.resource.kayaev_dictionary.notes': { en: 'High scholarly value; historical layers must remain marked rather than normalized into modern Lak.', ru: 'Высокая научная ценность; исторические слои должны оставаться помеченными, а не нормализованными в современный лакский.' },
    'obs.resource.kayaev_grammar.scale': { en: 'Book-length grammar', ru: 'Грамматика объёмом с книгу' },
    'obs.resource.kayaev_grammar.action': { en: 'Resolve edition and obtain through IYALI/RSL; structure cited examples separately.', ru: 'Установить издание и получить через ИЯЛИ/РГБ; структурировать цитируемые примеры отдельно.' },
    'obs.resource.kayaev_grammar.notes': { en: 'Important historical grammatical analysis.', ru: 'Важный исторический грамматический анализ.' },
    'obs.resource.kayaev_archive.scale': { en: 'Songs, tales, Nasreddin stories, riddles, proverbs, beliefs, wishes and curses', ru: 'Песни, сказки, истории о Насреддине, загадки, пословицы, поверья, пожелания и проклятия' },
    'obs.resource.kayaev_archive.action': { en: 'Ask IYALI DFRC RAS for an item-level inventory, digitization status and collaboration terms.', ru: 'Запросить у ИЯЛИ ДФИЦ РАН опись на уровне единиц, статус оцифровки и условия сотрудничества.' },
    'obs.resource.kayaev_archive.notes': { en: 'Potentially unique cultural-language material; access and descriptive metadata are not yet confirmed.', ru: 'Потенциально уникальный культурно-языковой материал; доступ и описательные метаданные пока не подтверждены.' },
    'obs.resource.murkelinsky.scale': { en: 'Book-length grammar', ru: 'Грамматика объёмом с книгу' },
    'obs.resource.murkelinsky.action': { en: 'Resolve exact edition and table of contents; obtain through a library.', ru: 'Установить точное издание и оглавление; получить через библиотеку.' },
    'obs.resource.murkelinsky.notes': { en: 'Major Russian-language grammar reference omitted from the initial dashboard.', ru: 'Крупный русскоязычный справочник по грамматике, пропущенный в первоначальной панели.' },
    'obs.resource.kazenin_syntax.scale': { en: 'Monograph on modern syntax', ru: 'Монография о современном синтаксисе' },
    'obs.resource.kazenin_syntax.action': { en: 'Acquire legally; create page-cited syntax examples and use its analysis to design a treebank guide.', ru: 'Приобрести законно; создать постранично цитируемые синтаксические примеры и использовать её анализ для проектирования руководства по трибанку.' },
    'obs.resource.kazenin_syntax.notes': { en: 'Especially relevant to the proposed Universal Dependencies seed treebank.', ru: 'Особенно актуальна для предлагаемого начального трибанка Universal Dependencies.' },
    'obs.resource.abdullaev_classes.scale': { en: '215 pages', ru: '215 страниц' },
    'obs.resource.abdullaev_classes.action': { en: 'Locate a library copy and extract a cited class/morphology benchmark.', ru: 'Найти библиотечный экземпляр и извлечь цитируемый эталон по классам/морфологии.' },
    'obs.resource.abdullaev_classes.notes': { en: 'Substantial specialist monograph, not currently acquired.', ru: 'Значительная узкоспециальная монография, пока не приобретена.' },
    'obs.resource.folklore_monuments.scale': { en: 'Multi-volume folklore collection', ru: 'Многотомное собрание фольклора' },
    'obs.resource.folklore_monuments.action': { en: 'Identify Lak-containing volumes and rights holders; propose institutional digitization with genre metadata.', ru: 'Определить содержащие лакский тома и правообладателей; предложить институциональную оцифровку с жанровыми метаданными.' },
    'obs.resource.folklore_monuments.notes': { en: 'Likely one of the richest curated narrative and oral-tradition sources.', ru: 'Вероятно, один из богатейших курируемых источников нарративов и устной традиции.' },
    'obs.resource.khalilov_song.scale': { en: 'Book-length song-folklore study/collection', ru: 'Исследование/собрание песенного фольклора объёмом с книгу' },
    'obs.resource.khalilov_song.action': { en: 'Resolve exact record and whether associated recordings survive in an archive.', ru: 'Установить точную запись и сохранились ли связанные записи в архиве.' },
    'obs.resource.khalilov_song.notes': { en: 'Could connect textual lyrics with performance audio, subject to permissions.', ru: 'Может связать текстовые тексты песен с исполнительским аудио при наличии разрешений.' },
    'obs.resource.school_curricula.scale': { en: 'Grades 1–11; readers, plans and named works', ru: '1–11 классы; хрестоматии, планы и названные произведения' },
    'obs.resource.school_curricula.action': { en: 'Build a grade-by-grade bibliography; seek licensed digital readers and teacher materials.', ru: 'Составить библиографию по классам; найти лицензированные цифровые хрестоматии и материалы для учителей.' },
    'obs.resource.school_curricula.notes': { en: 'Curricula identify stories, poems, riddles, counting rhymes and authors by grade.', ru: 'Учебные программы определяют по классам рассказы, стихи, загадки, считалки и авторов.' },
    'obs.resource.forker_audio.scale': { en: 'Exact inventory not yet confirmed', ru: 'Точная опись пока не подтверждена' },
    'obs.resource.forker_audio.action': { en: 'Follow up for an inventory, formats, consultant consent, varieties, deposit status and collaboration route.', ru: 'Уточнить опись, форматы, согласие консультантов, разновидности, статус депонирования и путь сотрудничества.' },
    'obs.resource.forker_audio.notes': { en: 'High-priority lead from the professor conversation; existence and transfer must be confirmed directly.', ru: 'Высокоприоритетная наводка из беседы с профессором; существование и передачу необходимо подтвердить напрямую.' },
    'obs.resource.daniel_recordings.scale': { en: 'Exact inventory not yet confirmed', ru: 'Точная опись пока не подтверждена' },
    'obs.resource.daniel_recordings.action': { en: 'Request an item-level inventory, archive/deposit links, consent restrictions and a research collaboration path.', ru: 'Запросить опись на уровне единиц, ссылки на архив/депозит, ограничения согласия и путь исследовательского сотрудничества.' },
    'obs.resource.daniel_recordings.notes': { en: 'Potential source of natural speech and field materials; no files are currently held.', ru: 'Потенциальный источник естественной речи и полевых материалов; файлы в настоящее время не хранятся.' },
    'obs.resource.ismailova_link_verbs.scale': { en: 'One academic article', ru: 'Одна научная статья' },
    'obs.resource.ismailova_link_verbs.action': { en: 'Locate the local/source PDF, record full citation and extract only page-cited examples under scholarly use.', ru: 'Найти локальный/исходный PDF, зафиксировать полную ссылку и извлечь только постранично цитируемые примеры в рамках научного использования.' },
    'obs.resource.ismailova_link_verbs.notes': { en: 'Also identifies a potential DGU collaborator for corpus and speaker work.', ru: 'Также указывает на потенциального соавтора из ДГУ для работы над корпусом и с носителями.' },
    'obs.resource.dialect_occasionalisms.scale': { en: 'Focused article', ru: 'Целенаправленная статья' },
    'obs.resource.dialect_occasionalisms.action': { en: 'Extract cited translation examples and their source editions; label dialectal/occasional status.', ru: 'Извлечь цитируемые переводческие примеры и их исходные издания; пометить диалектный/окказиональный статус.' },
    'obs.resource.dialect_occasionalisms.notes': { en: 'Important guardrail against treating every literary translation form as standard modern Lak.', ru: 'Важный ограничитель против трактовки любой литературной переводческой формы как стандартного современного лакского.' },
    'obs.resource.postpositions_comparison.scale': { en: 'Dissertation', ru: 'Диссертация' },
    'obs.resource.postpositions_comparison.action': { en: 'Obtain through a library/university and extract a page-cited semantic-relation benchmark.', ru: 'Получить через библиотеку/университет и извлечь постранично цитируемый эталон семантических отношений.' },
    'obs.resource.postpositions_comparison.notes': { en: 'Potentially valuable for Lak–English contrastive modeling.', ru: 'Потенциально ценна для контрастивного моделирования лакского и английского.' },
    'obs.resource.adjective_comparison.scale': { en: 'Focused article', ru: 'Целенаправленная статья' },
    'obs.resource.adjective_comparison.action': { en: 'Add cited adjective examples to a morphology QA set after expert review.', ru: 'Добавить цитируемые примеры прилагательных в набор контроля качества морфологии после экспертной проверки.' },
    'obs.resource.adjective_comparison.notes': { en: 'Small specialist evidence, not bulk corpus material.', ru: 'Небольшое узкоспециальное свидетельство, а не массовый корпусный материал.' },
    'obs.resource.dgu_corpora_paper.scale': { en: 'One article', ru: 'Одна статья' },
    'obs.resource.dgu_corpora_paper.action': { en: 'Extract named Lak corpora, researchers, software and bibliographic leads.', ru: 'Извлечь названные лакские корпуса, исследователей, программное обеспечение и библиографические наводки.' },
    'obs.resource.dgu_corpora_paper.notes': { en: 'A map to prior regional corpus work rather than Lak text itself.', ru: 'Скорее карта предшествующих региональных корпусных работ, чем сам лакский текст.' },
    'obs.resource.georgian_dagestanian_volume.scale': { en: 'Book-length scanned volume', ru: 'Отсканированный том объёмом с книгу' },
    'obs.resource.georgian_dagestanian_volume.action': { en: 'Inspect contents/index for Lak sections and resolve their authors and source data.', ru: 'Изучить содержание/указатель на лакские разделы и установить их авторов и исходные данные.' },
    'obs.resource.georgian_dagestanian_volume.notes': { en: 'Not yet confirmed as a substantive Lak source; retained as a scoped inspection lead.', ru: 'Пока не подтверждён как содержательный лакский источник; сохранён как ограниченная наводка для инспекции.' },
    'obs.resource.bigenc.scale': { en: 'Encyclopedia overview', ru: 'Энциклопедический обзор' },
    'obs.resource.bigenc.action': { en: 'Use for reference and bibliography only; trace claims to primary linguistic sources.', ru: 'Использовать только для справки и библиографии; проследить утверждения до первичных лингвистических источников.' },
    'obs.resource.bigenc.notes': { en: 'Not Lak-language corpus content.', ru: 'Не является корпусным контентом на лакском языке.' },
    'obs.resource.lakskysite_portal.scale': { en: 'Books, articles, folklore and cultural media', ru: 'Книги, статьи, фольклор и культурные медиа' },
    'obs.resource.lakskysite_portal.action': { en: 'Inventory Lak-language pages and hosted editions; request permission rather than bulk scraping.', ru: 'Составить опись страниц на лакском языке и размещённых изданий; запрашивать разрешение, а не массово скрапить.' },
    'obs.resource.lakskysite_portal.notes': { en: 'The Khaydakov page is one known child resource; the portal may expose additional distinct materials.', ru: 'Страница Хайдакова — один известный дочерний ресурс; портал может содержать дополнительные отдельные материалы.' },
    'obs.resource.social_lak.scale': { en: 'Potentially large but noisy and code-switched', ru: 'Потенциально большой, но зашумлённый и с переключением кодов' },
    'obs.resource.social_lak.action': { en: 'Identify active communities and seek opt-in contributions or admin partnership; do not scrape private/user content.', ru: 'Выявить активные сообщества и искать добровольные вклады или партнёрство с администрацией; не скрапить приватный/пользовательский контент.' },
    'obs.resource.social_lak.notes': { en: 'Potential informal-language and community-validation channel, not automatically reusable data.', ru: 'Потенциальный канал неформального языка и проверки сообществом, а не автоматически пригодные для повторного использования данные.' },
    'obs.resource.quba_audio.scale': { en: 'Audio inventory exists locally', ru: 'Аудиоопись имеется локально' },
    'obs.resource.quba_audio.action': { en: 'Resolve speakers, varieties, consent, recording dates, transcripts and file availability.', ru: 'Установить говорящих, разновидности, согласие, даты записей, транскрипты и доступность файлов.' },
    'obs.resource.quba_audio.notes': { en: 'Existing local lead omitted from the first dashboard; no public/trainable claim until consent is audited.', ru: 'Существующая локальная наводка, пропущенная в первой панели; никаких заявлений о публичности/пригодности для обучения до аудита согласия.' },
    'obs.resource.pear_stories.scale': { en: 'Elicited narrative recordings', ru: 'Записи вызванного нарратива' },
    'obs.resource.pear_stories.action': { en: 'Match recordings to speakers, transcripts and the stimulus version; create consent-aware alignment records.', ru: 'Сопоставить записи с говорящими, транскриптами и версией стимула; создать записи выравнивания с учётом согласия.' },
    'obs.resource.pear_stories.notes': { en: 'Comparable narrative elicitation can support discourse and speech research.', ru: 'Сопоставимое вызывание нарратива может поддержать исследования дискурса и речи.' },

    /* validate.js */
    'validate.question.default': { en: 'Your answer:', ru: 'Ваш ответ:' },
    'validate.stat.dayStreak': { en: 'day streak', ru: 'дней подряд' },
    'validate.stat.pointsToday': { en: 'points today', ru: 'очков сегодня' },
    'validate.stat.reliability': { en: 'reliability', ru: 'надёжность' },
    'validate.taskId': { en: 'task {id}', ru: 'задача {id}' },
    'validate.lang.russian': { en: 'Russian', ru: 'Русский' },
    'validate.lang.lak': { en: 'Lak', ru: 'Лакский' },
    'validate.sourceLabel': { en: 'Source:', ru: 'Источник:' },
    'validate.votesCount': {
      en: { one: '{count} vote', other: '{count} votes' },
      ru: { one: '{count} голос', few: '{count} голоса', many: '{count} голосов', other: '{count} голосов' }
    },
    'validate.noOtherVotes': { en: 'No other votes yet — yours is the first.', ru: 'Пока других голосов нет — ваш первый.' },
    'validate.consensus.goldMatch': { en: 'This was a calibration task — your answer matched the reference answer.', ru: 'Это была калибровочная задача — ваш ответ совпал с эталонным.' },
    'validate.consensus.goldDiffered': { en: 'This was a calibration task — the reference answer differed. These tasks keep reliability scores honest.', ru: 'Это была калибровочная задача — эталонный ответ отличался. Такие задачи поддерживают честность оценок надёжности.' },
    'validate.consensus.community': { en: 'Community consensus reached. This is not expert verification yet — an expert may still review it.', ru: 'Достигнут консенсус сообщества. Это ещё не экспертная проверка — эксперт может её пересмотреть.' },
    'validate.consensus.disputed': { en: 'Opinions diverged — this item now goes to trusted validators and experts.', ru: 'Мнения разошлись — этот элемент направляется доверенным проверяющим и экспертам.' },
    'validate.consensus.recorded': { en: 'Your assessment is recorded. Consensus forms as more contributors answer independently.', ru: 'Ваша оценка записана. Консенсус формируется по мере того, как всё больше участников отвечают независимо.' },
    'validate.points.tooFast': { en: 'Submitted too fast to count — slow down and read each task carefully.', ru: 'Отправлено слишком быстро, чтобы засчитать — не спешите и внимательно читайте каждую задачу.' },
    'validate.points.provisional': {
      en: '+{points} provisional points <span style="color:var(--text3); font-size:12px;">(confirmed when consensus, a reference answer, or an expert agrees)</span>',
      ru: '+{points} предварительных очков <span style="color:var(--text3); font-size:12px;">(подтверждаются при консенсусе, эталонном ответе или согласии эксперта)</span>'
    },
    'validate.points.questCompleted': { en: 'Quest completed! Bonus points added.', ru: 'Задание выполнено! Начислены бонусные очки.' },
    'validate.achievementPrefix': { en: '🏅 Achievement: ', ru: '🏅 Достижение: ' },
    'validate.voteFailed': { en: 'Vote failed', ru: 'Не удалось проголосовать' },

    /* queue.js */
    'queue.error.server': { en: 'Server error', ru: 'Ошибка сервера' },
    'queue.error.title': { en: 'Could not load reviews', ru: 'Не удалось загрузить рецензии' },
    'queue.reviewsLoaded': {
      en: { one: '{count} review loaded', other: '{count} reviews loaded' },
      ru: { one: 'загружена {count} рецензия', few: 'загружено {count} рецензии', many: 'загружено {count} рецензий', other: 'загружено {count} рецензий' }
    },
    'queue.empty.title': { en: 'No reviews yet', ru: 'Пока нет рецензий' },
    'queue.empty.body': { en: 'Reviews submitted from the search page appear here.', ru: 'Рецензии, отправленные со страницы поиска, появляются здесь.' },
    'queue.correctionLabel': { en: 'Correction:', ru: 'Исправление:' },
    'queue.noteLabel': { en: 'Note:', ru: 'Заметка:' },
    'queue.verifiedTooltip': { en: 'Submitted by a logged-in reviewer', ru: 'Отправлено авторизованным рецензентом' },
    'queue.verified': { en: '✓ verified', ru: '✓ подтверждено' },
    'queue.col.correctionNote': { en: 'Correction / Note', ru: 'Исправление / Заметка' },

    /* Role badges (leaderboard.js, dashboard.js) */
    'role.badge.expert': { en: 'expert', ru: 'эксперт' },
    'role.badge.admin': { en: 'admin', ru: 'админ' },
    'role.badge.trusted': { en: 'trusted', ru: 'доверенный' },

    /* leaderboard.js */
    'leaderboard.col.rank': { en: 'Rank', ru: 'Место' },
    'leaderboard.col.contributor': { en: 'Contributor', ru: 'Участник' },
    'leaderboard.col.verifiedValidations': { en: 'Verified validations', ru: 'Подтверждённые проверки' },
    'leaderboard.col.reliability': { en: 'Reliability', ru: 'Надёжность' },
    'leaderboard.col.streak': { en: 'Streak', ru: 'Серия' },
    'leaderboard.col.confirmedPoints': { en: 'Confirmed points', ru: 'Подтверждённые очки' },
    'leaderboard.empty': { en: 'No opted-in contributors for this period yet — be the first.', ru: 'Пока нет участников, согласившихся на показ, за этот период — будьте первым.' },
    'leaderboard.noEvents': { en: 'no events yet', ru: 'событий пока нет' },
    'leaderboard.me.yourProgress': { en: 'Your progress', ru: 'Ваш прогресс' },
    'leaderboard.me.notListed': { en: 'You are not publicly listed — opt in on your profile', ru: 'Вы не показаны публично — включите показ в своём профиле' },
    'leaderboard.me.rank': { en: 'rank', ru: 'место' },
    'leaderboard.me.topPercent': { en: 'top {pct}%', ru: 'топ {pct}%' },
    'leaderboard.me.confirmedPoints': { en: 'confirmed points', ru: 'подтверждённые очки' },
    'leaderboard.me.verifiedValidations': { en: 'verified validations', ru: 'подтверждённые проверки' },
    'leaderboard.me.dayStreak': { en: 'day streak', ru: 'дней подряд' },
    'leaderboard.me.reliability': { en: 'reliability', ru: 'надёжность' },
    'leaderboard.me.howCalculated': { en: 'How is my reliability calculated?', ru: 'Как рассчитывается моя надёжность?' },

    /* profile.js */
    'profile.pairs.unavailable': { en: 'Translation status is temporarily unavailable.', ru: 'Статус перевода временно недоступен.' },
    'profile.saved': { en: 'Saved ✓', ru: 'Сохранено ✓' },
    'profile.saveFailed': { en: 'Save failed', ru: 'Не удалось сохранить' },
    'profile.appealSubmitted': { en: 'Appeal submitted ✓', ru: 'Апелляция отправлена ✓' },
    'profile.appealFailed': { en: 'Failed to submit', ru: 'Не удалось отправить' },
    'profile.bandSuffix': { en: '{band} reliability', ru: 'надёжность: {band}' },
    'profile.stat.confirmedPoints': { en: 'confirmed points', ru: 'подтверждённые очки' },
    'profile.stat.provisional': { en: 'provisional', ru: 'предварительные' },
    'profile.stat.dayStreak': { en: 'day streak', ru: 'дней подряд' },
    'profile.reliabilityBasis': { en: 'Reliability basis —', ru: 'Основа надёжности —' },
    'profile.pairs.versionShort': { en: 'v{version}', ru: 'в.{version}' },
    'profile.pairs.none': { en: 'No translation pairs submitted yet.', ru: 'Пока не отправлено ни одной пары перевода.' },

    /* dashboard.js */
    'dashboard.requestFailed': { en: 'Request failed', ru: 'Запрос не выполнен' },
    'dashboard.labQueueUnavailable': { en: 'Translation queue is temporarily unavailable.', ru: 'Очередь переводов временно недоступна.' },
    'dashboard.granted': { en: 'Granted {role} to {name} ✓', ru: 'Роль {role} назначена {name} ✓' },
    'dashboard.inviteToken': { en: 'Invite token: {token}', ru: 'Токен приглашения: {token}' },
    'dashboard.revoked': { en: 'Revoked {count} point entries ✓', ru: 'Отозвано записей очков: {count} ✓' },
    'dashboard.taskAdded': { en: 'Task {id} added ✓', ru: 'Задача {id} добавлена ✓' },
    'dashboard.signedInAs': { en: 'Signed in as {role}. Consensus confidence and reliability are transparent by design.', ru: 'Вход выполнен как {role}. Уверенность консенсуса и надёжность прозрачны по замыслу.' },
    'dashboard.card.pending': { en: 'pending', ru: 'ожидает' },
    'dashboard.card.communityConsensus': { en: 'community consensus', ru: 'консенсус сообщества' },
    'dashboard.card.expertVerified': { en: 'expert verified', ru: 'проверено экспертом' },
    'dashboard.card.disputed': { en: 'disputed', ru: 'спорно' },
    'dashboard.card.avgConsensus': { en: 'avg consensus confidence ({n})', ru: 'средняя уверенность консенсуса ({n})' },
    'dashboard.card.reliabilityBands': { en: 'reliability bands', ru: 'уровни надёжности' },
    'dashboard.dispute.meta': { en: '{votes} votes · v{version} · {id}', ru: 'голосов: {votes} · в.{version} · {id}' },
    'dashboard.dispute.decisionPlaceholder': { en: 'decision (e.g. correct / moon)', ru: 'решение (напр. верно / луна)' },
    'dashboard.dispute.notePlaceholder': { en: 'note (optional)', ru: 'заметка (необязательно)' },
    'dashboard.adjudicate': { en: 'Expert decision', ru: 'Решение эксперта' },
    'dashboard.noDisputes': { en: 'No disputed items. 🎉', ru: 'Спорных элементов нет. 🎉' },
    'dashboard.noHighPriority': { en: 'No unresolved high-priority queries.', ru: 'Нет нерешённых высокоприоритетных запросов.' },
    'dashboard.gold.task': { en: 'Task', ru: 'Задача' },
    'dashboard.gold.kind': { en: 'Kind', ru: 'Тип' },
    'dashboard.gold.votes': { en: 'Votes', ru: 'Голоса' },
    'dashboard.gold.hits': { en: 'Hits', ru: 'Совпадения' },
    'dashboard.gold.hitRate': { en: 'Hit rate', ru: 'Доля совпадений' },
    'dashboard.noGoldVotes': { en: 'No gold-task votes yet.', ru: 'Пока нет голосов по эталонным задачам.' },
    'dashboard.noSuspicion': { en: 'Nothing suspicious detected.', ru: 'Ничего подозрительного не обнаружено.' },
    'dashboard.appeal.resolutionPlaceholder': { en: 'resolution note', ru: 'заметка о решении' },
    'dashboard.resolve': { en: 'Resolve', ru: 'Решить' },
    'dashboard.noAppeals': { en: 'No open appeals.', ru: 'Нет открытых апелляций.' },
    'dashboard.contributor': { en: 'contributor', ru: 'участник' },
    'dashboard.review': { en: 'Check', ru: 'Проверить' },
    'dashboard.noPairsAwaitReview': { en: 'No translation pairs await review.', ru: 'Нет пар перевода, ожидающих проверки.' },
    'dashboard.resolved': { en: 'Resolved ✓', ru: 'Решено ✓' },

    /* ── Canonical dynamic values (validate.js / dashboard.js / profile.js / leaderboard.js) ──
     * These localize server-generated canonical constants and seeded values so
     * authenticated Russian screens never show raw snake_case or an English
     * fallback. Canonical values themselves are never altered. */

    /* Contributor roles (contributors.role — routes/validation.js, lib/auth.js).
     * Full-word labels used by dashboard.js roleLabel() and profile.js roleLabel(). */
    'role.contributor': { en: 'Contributor', ru: 'Участник' },
    'role.trusted_validator': { en: 'Trusted validator', ru: 'Доверенный проверяющий' },
    'role.verified_expert': { en: 'Verified expert', ru: 'Подтверждённый эксперт' },
    'role.administrator': { en: 'Administrator', ru: 'Администратор' },

    /* Validation task kinds (scripts/seed-validation.js KINDS; used by kindLabel). */
    'validate.kind.translation_correctness': { en: 'Translation correctness', ru: 'Правильность перевода' },
    'validate.kind.sense_choice': { en: 'Sense choice', ru: 'Выбор значения' },
    'validate.kind.moon_vs_month': { en: 'Moon or month?', ru: 'Луна или месяц?' },
    'validate.kind.dialect': { en: 'Dialect / variety', ru: 'Диалект / разновидность' },
    'validate.kind.spelling': { en: 'Spelling', ru: 'Правописание' },
    'validate.kind.ocr_quality': { en: 'OCR quality', ru: 'Качество OCR' },
    'validate.kind.example_usefulness': { en: 'Example usefulness', ru: 'Полезность примера' },
    'validate.kind.source_reliability': { en: 'Source reliability', ru: 'Надёжность источника' },

    /* Per-kind questions (validate.js kindQuestion). */
    'validate.question.translation_correctness': { en: 'Is this Russian→Lak translation correct?', ru: 'Верен ли этот перевод русский→лакский?' },
    'validate.question.sense_choice': { en: 'Which sense fits this context best?', ru: 'Какое значение лучше всего подходит к этому контексту?' },
    'validate.question.moon_vs_month': { en: 'Here, does this word mean “moon” or “month”?', ru: 'Здесь это слово означает «луна» или «месяц»?' },
    'validate.question.dialect': { en: 'Which dialect or variety does this form belong to?', ru: 'К какому диалекту или разновидности относится эта форма?' },
    'validate.question.spelling': { en: 'Is the spelling correct?', ru: 'Верно ли написание?' },
    'validate.question.ocr_quality': { en: 'How clean is this OCR-scanned text?', ru: 'Насколько чист этот отсканированный текст OCR?' },
    'validate.question.example_usefulness': { en: 'Is this example sentence useful for learners and researchers?', ru: 'Полезно ли это примерное предложение для учащихся и исследователей?' },
    'validate.question.source_reliability': { en: 'How reliable is this source for this record?', ru: 'Насколько надёжен этот источник для данной записи?' },

    /* Validation task statuses (validation_tasks.status — dashboard.js taskStatusLabel). */
    'validate.taskStatus.pending': { en: 'pending', ru: 'ожидает' },
    'validate.taskStatus.community_consensus': { en: 'community consensus', ru: 'консенсус сообщества' },
    'validate.taskStatus.expert_verified': { en: 'expert verified', ru: 'проверено экспертом' },
    'validate.taskStatus.disputed': { en: 'disputed', ru: 'спорно' },
    'validate.taskStatus.rejected': { en: 'rejected', ru: 'отклонено' },

    /* Reliability bands (lib/gamification.js reliabilityBand). Canonical family
     * used by profile.js, leaderboard.js and dashboard.js bandLabel(). */
    'reliability.band.high': { en: 'High', ru: 'Высокая' },
    'reliability.band.established': { en: 'Established', ru: 'Устойчивая' },
    'reliability.band.developing': { en: 'Developing', ru: 'Развивающаяся' },
    'reliability.band.new': { en: 'New', ru: 'Новая' },
    /* validate.band.* aliases: validate.js bandLabel() reads this family. */
    'validate.band.high': { en: 'High', ru: 'Высокая' },
    'validate.band.established': { en: 'Established', ru: 'Устойчивая' },
    'validate.band.developing': { en: 'Developing', ru: 'Развивающаяся' },
    'validate.band.new': { en: 'New', ru: 'Новая' },

    /* Reliability event kinds (lib/gamification.js EVENT_WEIGHTS — profile.js,
     * leaderboard.js eventLabel). */
    'reliability.event.gold_hit': { en: 'gold-task hits', ru: 'попадания по эталонным задачам' },
    'reliability.event.gold_miss': { en: 'gold-task misses', ru: 'промахи по эталонным задачам' },
    'reliability.event.consensus_agree': { en: 'consensus agreements', ru: 'согласия с консенсусом' },
    'reliability.event.consensus_disagree': { en: 'consensus disagreements', ru: 'расхождения с консенсусом' },
    'reliability.event.reversal': { en: 'reversals', ru: 'пересмотры' },
    'reliability.event.expert_confirmed': { en: 'expert-confirmed', ru: 'подтверждено экспертом' },

    /* Quest keys (lib/gamification.js DAILY_QUESTS + WEEKLY_QUESTS).
     * quest.* — profile.js, leaderboard.js questLabel(). */
    'quest.ocr3': { en: 'Check the OCR quality of 3 records', ru: 'Проверьте качество OCR у 3 записей' },
    'quest.dialect2': { en: 'Assess 2 dialect questions', ru: 'Оцените 2 вопроса о диалектах' },
    'quest.sense3': { en: 'Resolve 3 sense choices', ru: 'Решите 3 выбора значения' },
    'quest.evidence2': { en: 'Add 2 evidence-backed notes', ru: 'Добавьте 2 заметки с обоснованием' },
    'quest.any5': { en: 'Complete 5 validations', ru: 'Выполните 5 проверок' },
    'quest.any15': { en: 'Complete 15 validations this week', ru: 'Выполните 15 проверок за эту неделю' },
    'quest.gold5': { en: 'Answer 5 calibration tasks', ru: 'Ответьте на 5 калибровочных задач' },
    'quest.evidence5': { en: 'Add 5 evidence-backed notes', ru: 'Добавьте 5 заметок с обоснованием' },
    /* validate.quest.* aliases: validate.js questLabel() reads this family. */
    'validate.quest.ocr3': { en: 'Check the OCR quality of 3 records', ru: 'Проверьте качество OCR у 3 записей' },
    'validate.quest.dialect2': { en: 'Assess 2 dialect questions', ru: 'Оцените 2 вопроса о диалектах' },
    'validate.quest.sense3': { en: 'Resolve 3 sense choices', ru: 'Решите 3 выбора значения' },
    'validate.quest.evidence2': { en: 'Add 2 evidence-backed notes', ru: 'Добавьте 2 заметки с обоснованием' },
    'validate.quest.any5': { en: 'Complete 5 validations', ru: 'Выполните 5 проверок' },
    'validate.quest.any15': { en: 'Complete 15 validations this week', ru: 'Выполните 15 проверок за эту неделю' },
    'validate.quest.gold5': { en: 'Answer 5 calibration tasks', ru: 'Ответьте на 5 калибровочных задач' },
    'validate.quest.evidence5': { en: 'Add 5 evidence-backed notes', ru: 'Добавьте 5 заметок с обоснованием' },

    /* Achievement keys (lib/gamification.js ACHIEVEMENTS).
     * achievement.* — profile.js, leaderboard.js. */
    'achievement.first_expert_correction': { en: 'First expert-confirmed correction', ru: 'Первое исправление, подтверждённое экспертом' },
    'achievement.ten_quality_validations': { en: 'Ten high-quality validations', ru: 'Десять качественных проверок' },
    'achievement.dialect_specialist': { en: 'Dialect specialist', ru: 'Специалист по диалектам' },
    'achievement.ocr_restorer': { en: 'OCR restorer', ru: 'Реставратор OCR' },
    'achievement.source_detective': { en: 'Source detective', ru: 'Детектив источников' },
    'achievement.consensus_builder': { en: 'Consensus builder', ru: 'Строитель консенсуса' },
    'achievement.sustained_7': { en: 'Seven-day contributor', ru: 'Участник семи дней' },
    'achievement.sustained_30': { en: 'Thirty-day contributor', ru: 'Участник тридцати дней' },
    /* validate.achievement.* aliases: validate.js achievementLabel() reads this family. */
    'validate.achievement.first_expert_correction': { en: 'First expert-confirmed correction', ru: 'Первое исправление, подтверждённое экспертом' },
    'validate.achievement.ten_quality_validations': { en: 'Ten high-quality validations', ru: 'Десять качественных проверок' },
    'validate.achievement.dialect_specialist': { en: 'Dialect specialist', ru: 'Специалист по диалектам' },
    'validate.achievement.ocr_restorer': { en: 'OCR restorer', ru: 'Реставратор OCR' },
    'validate.achievement.source_detective': { en: 'Source detective', ru: 'Детектив источников' },
    'validate.achievement.consensus_builder': { en: 'Consensus builder', ru: 'Строитель консенсуса' },
    'validate.achievement.sustained_7': { en: 'Seven-day contributor', ru: 'Участник семи дней' },
    'validate.achievement.sustained_30': { en: 'Thirty-day contributor', ru: 'Участник тридцати дней' },

    /* Suspicion-flag kinds (routes/validation.js flagSuspicion — dashboard.js). */
    'dashboard.suspicion.rapid_submission': { en: 'rapid submission', ru: 'слишком быстрая отправка' },
    'dashboard.suspicion.burst': { en: 'burst', ru: 'всплеск активности' },

    /* Seeded validation option values (scripts/gold-set.json).
     * validate.js optionLabel() slugifies the canonical value; the submitted
     * value stays canonical. RU labels keep authenticated screens fully localized. */
    'validate.option.correct': { en: 'correct', ru: 'верно' },
    'validate.option.incorrect': { en: 'incorrect', ru: 'неверно' },
    'validate.option.uncertain': { en: 'uncertain', ru: 'не уверен(а)' },
    'validate.option.moon': { en: 'moon', ru: 'луна' },
    'validate.option.month': { en: 'month', ru: 'месяц' },
    'validate.option.both_senses_are_active': { en: 'both senses are active', ru: 'оба значения актуальны' },
    'validate.option.clean': { en: 'clean', ru: 'чистый' },
    'validate.option.ocr_noise': { en: 'OCR noise', ru: 'шум OCR' },
    'validate.option.a_canonical_lak_greeting_exists': { en: 'a canonical Lak greeting exists', ru: 'существует каноническое лакское приветствие' },
    'validate.option.no_established_translation': { en: 'no established translation', ru: 'устоявшегося перевода нет' },
    'validate.option.kumukh_variety': { en: 'Kumukh variety', ru: 'кумухская разновидность' },
    'validate.option.vikhli_variety': { en: 'Vikhli variety', ru: 'вихлинская разновидность' },
    'validate.option.other_variety': { en: 'other variety', ru: 'другая разновидность' },
    'validate.option.standard_literary_lak': { en: 'standard literary Lak', ru: 'литературный лакский' },
    'validate.option.not_useful': { en: 'not useful', ru: 'бесполезно' },
    'validate.option.somewhat_useful': { en: 'somewhat useful', ru: 'отчасти полезно' },
    'validate.option.very_useful': { en: 'very useful', ru: 'очень полезно' },
    'validate.option.reliable_with_caution': { en: 'reliable with caution', ru: 'надёжно с осторожностью' },
    'validate.option.partially_reliable': { en: 'partially reliable', ru: 'частично надёжно' },
    'validate.option.unreliable_until_verified': { en: 'unreliable until verified', ru: 'ненадёжно до проверки' },

    /* ── Search landing / results (purpose-led states) ──────────── */
    'search.landing.purpose': {
      en: 'Search Lak and Russian words and sentences. Every result shows where it comes from and whether a person has checked it.',
      ru: 'Ищите лакские и русские слова и предложения. У каждого результата видно, откуда он взят и проверял ли его человек.'
    },
    'search.landing.whatToDoTitle': { en: 'What you can do here', ru: 'Что здесь можно делать' },
    'search.landing.whatToDoBody': {
      en: 'Type a word to see how it is used and translated. If you speak Lak, you can help by checking whether translations are right. You can also browse the materials we have collected.',
      ru: 'Наберите слово, чтобы увидеть, как оно используется и переводится. Если вы говорите по-лакски, вы можете помочь и проверить, верны ли переводы. Ещё можно посмотреть собранные нами материалы.'
    },
    'search.landing.searchAction': { en: 'Search words and sentences', ru: 'Искать слова и предложения' },
    'search.landing.validateAction': { en: 'Check translations', ru: 'Проверить переводы' },
    'search.landing.resourcesAction': { en: 'Browse the materials', ru: 'Посмотреть материалы' },
    'search.landing.browseAll': { en: 'Show everything', ru: 'Показать всё' },
    'search.results.translation': { en: 'Translation', ru: 'Перевод' },
    'search.results.sourceDocument': { en: 'Source document', ru: 'Исходный документ' },
    'search.results.recordId': { en: 'Record ID', ru: 'Номер записи' },
    'search.results.translationMissing': { en: 'Translation not added yet', ru: 'Перевод пока не добавлен' },
    'search.results.validateAction': { en: 'Check this translation', ru: 'Проверить этот перевод' },

    /* ── Help button accessible labels ─────────────────────────── */
    'help.button.aria': { en: 'What does this mean?', ru: 'Что это значит?' },
    'help.button.title': { en: 'What does this mean?', ru: 'Что это значит?' },
    'help.close.aria': { en: 'Close help', ru: 'Закрыть подсказку' },

    /* ── Plain-language help texts (say what it means, why shown,
     * and what to do) ──────────────────────────────────────────── */
    'help.pcmlbe': {
      en: 'PCMLBE — the Parsed Corpus of Modern Lak — is one of the collections of Lak texts inside this project: prose and poetry with grammar tags, built by Erwin Komen at Radboud University. It is shared under a CC BY-SA 4.0 license: you may reuse these examples if you credit “PCMLBE, Erwin Komen, Radboud University” and pass the same license on. The link on each row points to the original corpus record. The texts were imported in bulk and have not yet been checked by a person — treat them as reliable but unconfirmed, and flag anything that looks wrong.',
      ru: 'PCMLBE — Parsed Corpus of Modern Lak — одна из коллекций лакских текстов в проекте: проза и поэзия с грамматической разметкой, созданная Эрвином Коменом в Радбаудском университете. Она распространяется по лицензии CC BY-SA 4.0: примеры можно использовать повторно, указывая «PCMLBE, Эрвин Комен, Радбаудский университет» и сохраняя ту же лицензию. Ссылка в каждой строке ведёт на исходное описание корпуса. Тексты загружены целыми файлами и пока не проверены человеком — считайте их надёжными, но неподтверждёнными, и отмечайте всё, что выглядит неверно.'
    },
    'search.license.pcmlbeTitle': {
      en: 'PCMLBE by Erwin Komen, Radboud University — CC BY-SA 4.0; reuse requires attribution and ShareAlike',
      ru: 'PCMLBE — Эрвин Комен, Радбаудский университет — CC BY-SA 4.0; повторное использование требует указания авторства и ShareAlike'
    },
    'help.corpusRecord': {
      en: 'A record is one item in the collection — a single sentence, phrase, or dictionary entry. Each record keeps its original text, its meaning, where it came from, and whether it has been checked. It is shown so you can look at, and if you speak Lak, check one small piece at a time.',
      ru: 'Запись — это одна единица в коллекции: отдельное предложение, фраза или словарная статья. У каждой записи сохраняются исходный текст, значение, источник и отметка о проверке. Она показана, чтобы вы могли рассмотреть и, если вы говорите по-лакски, проверять по одному небольшому фрагменту.'
    },
    'help.source': {
      en: 'The source tells you which book, dictionary, or collection this text came from. We show it so you can judge how much to trust the text and cite it correctly. If a translation looks unusual, checking the source often explains why.',
      ru: 'Источник показывает, из какой книги, словаря или коллекции взят этот текст. Мы указываем его, чтобы вы могли оценить, насколько тексту можно доверять, и правильно на него сослаться. Если перевод выглядит необычно, источник часто объясняет причину.'
    },
    'help.lakVariety': {
      en: 'Lak is spoken in several local forms. The Lak variety says which one this text belongs to — the standard written form, a village dialect, or an older historical form. We show it so a word is not judged wrong just because it belongs to a different variety. If the label looks incorrect, you can flag it.',
      ru: 'На лакском говорят в нескольких местных формах. «Вариант лакского» показывает, к какому из них относится текст: к литературной письменной норме, сельскому диалекту или более старой исторической форме. Мы указываем его, чтобы слово не считали ошибочным лишь потому, что оно принадлежит другому варианту. Если пометка кажется неверной, вы можете её отметить.'
    },
    'help.reviewStatus': {
      en: 'The review status says whether a person has checked this record. “Not checked yet” means it came straight from a source and no one has confirmed it. “Approved” means a reviewer confirmed it is correct. “Flagged” means someone found a problem. We show it so you know how much to trust the item — and where your help is most useful.',
      ru: 'Статус проверки показывает, проверял ли запись человек. «Ещё не проверено» — она пришла прямо из источника, и никто её не подтвердил. «Утверждено» — проверяющий подтвердил, что всё верно. «Помечено» — кто-то нашёл проблему. Мы показываем его, чтобы вы понимали, насколько доверять записи и где ваша помощь нужнее всего.'
    },
    'help.expertValidation': {
      en: 'An expert decision is the final word on a hard case from a verified Lak-language expert. When people disagree about a translation, the item is passed to an expert whose decision settles it. We show this so you know a difficult item has been resolved by someone with proven knowledge, not by a simple vote.',
      ru: 'Решение эксперта — это последнее слово по трудному случаю от проверенного специалиста по лакскому языку. Когда мнения о переводе расходятся, запись передают эксперту, чьё решение всё решает. Мы показываем это, чтобы вы знали: сложную запись разрешил человек с подтверждёнными знаниями, а не простое голосование.'
    },
    'help.consensus': {
      en: 'Agreement means several people checked the same item on their own and gave the same answer. When enough of them agree, the item is marked as agreed. This is a good sign, but it is not the same as an expert decision. We show it so you can see how settled an answer is.',
      ru: 'Согласие означает, что несколько человек самостоятельно проверили одну и ту же запись и дали одинаковый ответ. Когда их набирается достаточно, запись помечается как согласованная. Это хороший знак, но это не то же самое, что решение эксперта. Мы показываем это, чтобы вы видели, насколько ответ устоялся.'
    },
    'help.sourceReliability': {
      en: 'This asks how much a particular source can be trusted for this record. Some sources are careful and well edited; others are old scans or informal texts. We ask it so weaker sources are used with care. Choose the answer that matches how confident you are in the source here.',
      ru: 'Здесь спрашивается, насколько можно доверять конкретному источнику для этой записи. Одни источники тщательно выверены, другие — это старые сканы или неформальные тексты. Мы спрашиваем, чтобы слабые источники использовались осторожно. Выберите ответ, соответствующий тому, насколько вы уверены в источнике.'
    },
    'help.rightsAccess': {
      en: 'This says whether the material may be reused and whether you can open it. Some texts are free to use, some need permission, and some are only available in an archive. We show it so nothing is copied or shared without the right permission. When in doubt, treat the material as permission-needed.',
      ru: 'Здесь указано, можно ли повторно использовать материал и можете ли вы его открыть. Одни тексты свободны в использовании, для других нужно разрешение, а некоторые есть только в архиве. Мы показываем это, чтобы ничего не копировали и не распространяли без нужного разрешения. Если сомневаетесь, считайте, что требуется разрешение.'
    },
    'help.translationLab': {
      en: 'The translation workspace is where a computer model suggests a translation and you improve it. The suggestion is only a draft: you check it against real examples, correct it, and note where it comes from before saving. We provide it so translations are built carefully and always backed by real evidence, not guessed.',
      ru: '«Работа с переводами» — это место, где компьютерная модель предлагает перевод, а вы его улучшаете. Предложение — лишь черновик: вы сверяете его с реальными примерами, исправляете и указываете источник перед сохранением. Мы даём этот инструмент, чтобы переводы создавались бережно и всегда опирались на реальные примеры, а не на догадки.'
    },
    'help.resourceObservatory': {
      en: 'The resource guide is a catalogue of materials about the Lak language — books, dictionaries, recordings, and archives. For each one it shows what it is, who holds it, whether it may be used, and the next step to obtain it. We provide it so anyone can see what already exists and help track down more.',
      ru: '«Каталог материалов» — это список материалов о лакском языке: книг, словарей, записей и архивов. Для каждого показано, что это, у кого хранится, можно ли использовать и каков следующий шаг для получения. Мы даём его, чтобы каждый видел, что уже существует, и помогал находить новое.'
    },
    'help.privateResearchLayer': {
      en: 'Some materials are kept aside as private research leads instead of being added to the corpus. They are not searchable, not published, and not used to train anything until a person has checked them and the rights are clear. This panel shows the counts and the current state, never the material itself.',
      ru: 'Часть материалов хранится отдельно как закрытые исследовательские наводки и не добавляется в корпус. Они не участвуют в поиске, не публикуются и не используются для обучения, пока их не проверит человек и не будут урегулированы права. Здесь показаны только количества и текущее состояние, но не сами материалы.'
    },
    'help.researchUpdate': {
      en: 'This page reports what the latest source audit found: how many files were checked and what could be extracted from them. The materials themselves stay private until the rights are clear and a person has reviewed them, so only counts and states are shown here.',
      ru: 'На этой странице показано, что нашла последняя проверка источников: сколько файлов проверено и что удалось из них извлечь. Сами материалы остаются закрытыми, пока не урегулированы права и их не проверил человек, поэтому здесь показаны только количества и состояния.'
    },
    'help.publicEvidence': {
      en: 'Evidence shows what publicly backs a record: a dictionary translation, a pair an expert approved, or an example from the public corpus. Corpus examples give context but do not prove a translation, and when nothing qualifies the card says there is not enough evidence.',
      ru: '«Основания» показывают, что публично подтверждает запись: словарный перевод, пара, утверждённая экспертом, или пример из публичного корпуса. Примеры из корпуса дают контекст, но не доказывают перевод; если ничего не подходит, карточка прямо сообщает, что оснований недостаточно.'
    },

    /* ── Private workspace: shared chrome ─────────────────────── */
    'nav.intelligence': { en: 'Private workspace', ru: 'Закрытая мастерская' },
    'pw.subnav.label': { en: 'Private workspace sections', ru: 'Разделы закрытой мастерской' },
    'pw.subnav.sources': { en: 'Sources', ru: 'Источники' },
    'pw.subnav.alignment': { en: 'Alignment Lab', ru: 'Сопоставление текстов' },
    'pw.subnav.rights': { en: 'Rights & review', ru: 'Права и проверка' },
    'pw.loading': { en: 'Loading…', ru: 'Загрузка…' },
    'pw.empty': { en: 'Nothing to show yet.', ru: 'Пока нечего показать.' },
    'pw.error.generic': { en: 'Something went wrong. Try again.', ru: 'Что-то пошло не так. Попробуйте ещё раз.' },
    'pw.error.network': { en: 'The server could not be reached.', ru: 'Не удалось связаться с сервером.' },
    'pw.error.unauthenticated': { en: 'Log in to open the private workspace.', ru: 'Войдите, чтобы открыть закрытую мастерскую.' },
    'pw.error.forbidden': { en: 'Your role does not allow this action.', ru: 'Ваша роль не позволяет выполнить это действие.' },
    'pw.candidateBanner.title': { en: 'Candidate, not validated.', ru: 'Это предположение, а не проверенный результат.' },
    'pw.candidateBanner.body': {
      en: 'Everything on this screen was proposed from deterministic evidence. Nothing here is a validated translation until a reviewer with the right role accepts it.',
      ru: 'Всё на этом экране предложено на основании воспроизводимых признаков. Ничто здесь не считается проверенным переводом, пока это не примет проверяющий с нужной ролью.'
    },
    'pw.gate.signedOut.title': { en: 'This workspace is private', ru: 'Эта мастерская закрыта' },
    'pw.gate.signedOut.body': {
      en: 'Private sources, relationship candidates and alignment drafts are only available to signed-in reviewers. Nothing on these screens is public.',
      ru: 'Закрытые источники, предполагаемые связи и черновики сопоставлений доступны только вошедшим проверяющим. Ничего из этого не публикуется.'
    },
    'pw.gate.logIn': { en: 'Log in', ru: 'Войти' },
    'pw.gate.noRole.title': { en: 'A reviewer role is required', ru: 'Нужна роль проверяющего' },
    'pw.gate.noRole.body': {
      en: 'Your account is signed in, but only trusted validators and verified experts can open the private workspace.',
      ru: 'Вы вошли в аккаунт, но открыть закрытую мастерскую могут только доверенные проверяющие и подтверждённые эксперты.'
    },
    'pw.gate.profile': { en: 'Your profile', ru: 'Ваш профиль' },

    /* Canonical values — display labels only. The stored, exported and
       API values stay canonical and language-neutral. */
    'pw.value.none': { en: '—', ru: '—' },
    'pw.value.yes': { en: 'Yes', ru: 'Да' },
    'pw.value.no': { en: 'No', ru: 'Нет' },
    'pw.value.true': { en: 'Yes', ru: 'Да' },
    'pw.value.false': { en: 'No', ru: 'Нет' },
    'pw.value.private_v13': { en: 'Private v1.3', ru: 'Закрытый слой v1.3' },
    'pw.value.private_v12': { en: 'Private v1.2', ru: 'Закрытый слой v1.2' },
    'pw.value.public_corpus': { en: 'Public corpus', ru: 'Открытый корпус' },
    'pw.value.v13_source': { en: 'Private v1.3 source', ru: 'Источник слоя v1.3' },
    'pw.value.v12_source': { en: 'Private v1.2 source', ru: 'Источник слоя v1.2' },
    'pw.value.permission_pending': { en: 'Permission pending', ru: 'Разрешение ожидается' },
    'pw.value.permission_granted': { en: 'Permission granted', ru: 'Разрешение получено' },
    'pw.value.public_domain': { en: 'Public domain', ru: 'Общественное достояние' },
    'pw.value.restricted': { en: 'Restricted', ru: 'Ограничено' },
    'pw.value.unknown': { en: 'Unknown', ru: 'Неизвестно' },
    'pw.value.private_research': { en: 'Private research', ru: 'Только для исследования' },
    'pw.value.public': { en: 'Public', ru: 'Открыто' },
    'pw.value.source_import_unreviewed': { en: 'Unreviewed', ru: 'Не проверено' },
    'pw.value.in_review': { en: 'In review', ru: 'На проверке' },
    'pw.value.accepted_candidate': { en: 'Accepted candidate', ru: 'Предположение принято' },
    'pw.value.rejected': { en: 'Rejected', ru: 'Отклонено' },
    'pw.value.translation': { en: 'Translation', ru: 'Перевод' },
    'pw.value.parallel_text': { en: 'Parallel text', ru: 'Параллельный текст' },
    'pw.value.transliteration': { en: 'Transliteration', ru: 'Транслитерация' },
    'pw.value.alternate_edition': { en: 'Alternate edition', ru: 'Другая редакция' },
    'pw.value.duplicate': { en: 'Duplicate', ru: 'Дубликат' },
    'pw.value.deterministic_signal_scan': { en: 'Deterministic signal scan', ru: 'Воспроизводимый разбор признаков' },
    'pw.value.war_family_seed': { en: 'War family seed', ru: 'Заданная семья «War»' },
    'pw.value.section': { en: 'Section', ru: 'Раздел' },
    'pw.value.paragraph': { en: 'Paragraph', ru: 'Абзац' },
    'pw.value.sentence': { en: 'Sentence', ru: 'Предложение' },
    'pw.value.one_to_one': { en: 'One to one', ru: 'Один к одному' },
    'pw.value.one_to_many': { en: 'One to many', ru: 'Один ко многим' },
    'pw.value.many_to_one': { en: 'Many to one', ru: 'Многие к одному' },
    'pw.value.unmatched_left': { en: 'Unmatched on the left', ru: 'Без пары слева' },
    'pw.value.unmatched_right': { en: 'Unmatched on the right', ru: 'Без пары справа' },
    'pw.value.rights': { en: 'Rights', ru: 'Права' },
    'pw.value.access': { en: 'Access', ru: 'Доступ' },
    'pw.value.review': { en: 'Review', ru: 'Проверка' },
    'pw.value.training': { en: 'Training use', ru: 'Использование для обучения' },
    'pw.value.lak_primary': { en: 'Lak text', ru: 'Лакский текст' },
    'pw.value.lak_alternate_near_duplicate': { en: 'Alternate near-duplicate Lak version', ru: 'Другая, почти совпадающая лакская версия' },
    'pw.value.russian_translation_candidate': { en: 'Russian parallel / translation candidate', ru: 'Предполагаемый русский параллельный текст или перевод' },
    'pw.value.lak': { en: 'Lak', ru: 'Лакский' },
    'pw.value.russian': { en: 'Russian', ru: 'Русский' },
    'pw.value.latin_or_transliteration': { en: 'Latin script or transliteration', ru: 'Латиница или транслитерация' },
    'pw.value.arabic_script': { en: 'Arabic script', ru: 'Арабское письмо' },
    'pw.value.mixed': { en: 'Mixed', ru: 'Смешанный' },
    'pw.value.contributor': { en: 'Contributor', ru: 'Участник' },
    'pw.value.trusted_validator': { en: 'Trusted validator', ru: 'Доверенный проверяющий' },
    'pw.value.verified_expert': { en: 'Verified expert', ru: 'Подтверждённый эксперт' },
    'pw.value.administrator': { en: 'Administrator', ru: 'Администратор' },
    'pw.value.identical_file_digest': { en: 'Identical file digest', ru: 'Совпадающий отпечаток файла' },
    'pw.value.declared_duplicate_group': { en: 'Declared duplicate group', ru: 'Заявленная группа дубликатов' },
    'pw.value.declared_canonical_duplicate': { en: 'Declared canonical duplicate', ru: 'Заявленный основной дубликат' },
    'pw.value.normalised_title_base': { en: 'Matching normalised title', ru: 'Совпадение нормализованных названий' },
    'pw.value.title_root_family': { en: 'Shared title root', ru: 'Общая основа названия' },
    'pw.value.edition_marker': { en: 'Edition marker in the file name', ru: 'Пометка редакции в имени файла' },
    'pw.value.folder_family': { en: 'Same folder family', ru: 'Одна папка' },
    'pw.value.near_duplicate_text': { en: 'Near-duplicate text', ru: 'Почти совпадающий текст' },
    'pw.value.partial_text_overlap': { en: 'Partial text overlap', ru: 'Частичное совпадение текста' },
    'pw.value.script_contrast': { en: 'Different scripts', ru: 'Разные системы письма' },
    'pw.value.language_contrast': { en: 'Different languages', ru: 'Разные языки' },
    'pw.value.same_language': { en: 'Same language', ru: 'Один язык' },
    'pw.value.paragraph_structure': { en: 'Similar paragraph structure', ru: 'Схожая структура абзацев' },
    'pw.value.length_ratio': { en: 'Plausible length ratio', ru: 'Правдоподобное соотношение длин' },
    'pw.value.number_overlap': { en: 'Shared numbers', ru: 'Совпадающие числа' },
    'pw.value.heading_overlap': { en: 'Shared headings', ru: 'Совпадающие заголовки' },
    'pw.value.punctuation_profile': { en: 'Similar punctuation profile', ru: 'Схожая пунктуация' },
    'pw.value.dictionary_anchor': { en: 'Dictionary anchors', ru: 'Словарные опоры' },
    'pw.value.public_corpus_overlap': { en: 'Public corpus overlap', ru: 'Пересечение с открытым корпусом' },
    'pw.value.text_similarity': { en: 'Text similarity', ru: 'Схожесть текста' },
    'pw.value.paragraph_ratio': { en: 'Paragraph ratio', ru: 'Соотношение абзацев' },
    'pw.value.punctuation_similarity': { en: 'Punctuation similarity', ru: 'Схожесть пунктуации' },
    'pw.value.number_overlap_count': { en: 'Shared numbers', ru: 'Совпадающих чисел' },
    'pw.value.left_language': { en: 'Language, left', ru: 'Язык слева' },
    'pw.value.right_language': { en: 'Language, right', ru: 'Язык справа' },
    'pw.value.left_script': { en: 'Script, left', ru: 'Письмо слева' },
    'pw.value.right_script': { en: 'Script, right', ru: 'Письмо справа' },
    'pw.value.left_file': { en: 'File, left', ru: 'Файл слева' },
    'pw.value.right_file': { en: 'File, right', ru: 'Файл справа' },
    'pw.value.seeded_roles': { en: 'Seeded roles', ru: 'Заданные роли' },
    'pw.value.dictionary_anchor_forms': { en: 'Dictionary anchor forms', ru: 'Словарные формы-опоры' },
    'pw.value.cyrillic': { en: 'Cyrillic', ru: 'Кириллица' },
    'pw.value.latin': { en: 'Latin', ru: 'Латиница' },
    'pw.value.arabic': { en: 'Arabic', ru: 'Арабское письмо' },

    /* ── Source Intelligence ──────────────────────────────────── */
    'si.meta.title': { en: 'Source Intelligence · Lak Corpus Explorer', ru: 'Обзор источников · Лакский корпус' },
    'si.kicker': { en: 'Private workspace · authenticated only', ru: 'Закрытая мастерская · только после входа' },
    'si.h1': { en: 'Source Intelligence', ru: 'Обзор источников' },
    'si.intro': {
      en: 'Every source held in the research layers — public corpus sources alongside the private v1.2 and v1.3 material — with what it is, what language it holds, which family it belongs to, how well it extracted, and where its rights and review stand.',
      ru: 'Все источники исследовательских слоёв — материалы открытого корпуса вместе с закрытыми слоями v1.2 и v1.3 — с указанием типа, языка, семьи, качества извлечения, а также состояния прав и проверки.'
    },
    'si.views.label': { en: 'Source views', ru: 'Виды списка источников' },
    'si.view.sources': { en: 'All sources', ru: 'Все источники' },
    'si.view.families': { en: 'Families', ru: 'Семьи' },
    'si.filter.search': { en: 'Search sources', ru: 'Поиск по источникам' },
    'si.filter.searchPlaceholder': { en: 'File name, path, material type…', ru: 'Имя файла, путь, тип материала…' },
    'si.filter.scope': { en: 'Layer', ru: 'Слой' },
    'si.filter.scope.all': { en: 'All layers', ru: 'Все слои' },
    'si.filter.material': { en: 'Material type', ru: 'Тип материала' },
    'si.filter.material.all': { en: 'All material types', ru: 'Все типы материала' },
    'si.filter.language': { en: 'Language scope', ru: 'Языковой охват' },
    'si.filter.language.all': { en: 'All language scopes', ru: 'Любой языковой охват' },
    'si.filter.family': { en: 'Family', ru: 'Семья' },
    'si.filter.family.all': { en: 'All families', ru: 'Все семьи' },
    'si.filter.quality': { en: 'Extraction quality', ru: 'Качество извлечения' },
    'si.filter.quality.all': { en: 'All extraction qualities', ru: 'Любое качество извлечения' },
    'si.filter.rights': { en: 'Rights status', ru: 'Состояние прав' },
    'si.filter.rights.all': { en: 'All rights statuses', ru: 'Любое состояние прав' },
    'si.filter.review': { en: 'Review status', ru: 'Состояние проверки' },
    'si.filter.review.all': { en: 'All review statuses', ru: 'Любое состояние проверки' },
    'si.filter.access': { en: 'Access', ru: 'Доступ' },
    'si.filter.access.all': { en: 'All access levels', ru: 'Любой уровень доступа' },
    'si.list.title': { en: 'Sources', ru: 'Источники' },
    'si.list.count': { en: '{n} sources', ru: 'Источников: {n}' },
    'si.list.empty': { en: 'No source matches these filters.', ru: 'Нет источников, подходящих под эти условия.' },
    'si.detail.empty': {
      en: 'Select a private source to see its provenance, relationships and decisions.',
      ru: 'Выберите закрытый источник, чтобы увидеть его происхождение, связи и решения.'
    },
    'si.chars': { en: 'chars', ru: 'знаков' },
    'si.tag.relationships': { en: '{n} related', ru: 'связей: {n}' },
    'si.tag.training': { en: 'Training: {v}', ru: 'Обучение: {v}' },
    'si.stat.privateSources': { en: 'Private sources', ru: 'Закрытых источников' },
    'si.stat.publicSources': { en: 'Public corpus sources', ru: 'Источников открытого корпуса' },
    'si.stat.families': { en: 'Families', ru: 'Семей' },
    'si.stat.candidates': { en: 'Relationship candidates', ru: 'Предполагаемых связей' },
    'si.stat.alignmentUnits': { en: 'Alignment units', ru: 'Единиц сопоставления' },
    'si.stat.rightsOpen': { en: 'Rights items open', ru: 'Незакрытых вопросов по правам' },
    'si.provenance.title': { en: 'Provenance', ru: 'Происхождение' },
    'si.provenance.hint': {
      en: 'Copied verbatim from the received package. A decision never edits it.',
      ru: 'Скопировано дословно из полученного пакета. Решения его не изменяют.'
    },
    'si.provenance.path': { en: 'Source path', ru: 'Путь к файлу' },
    'si.provenance.digest': { en: 'File digest (SHA-256)', ru: 'Отпечаток файла (SHA-256)' },
    'si.provenance.sequence': { en: 'Source sequence', ru: 'Номер источника' },
    'si.provenance.units': { en: 'Unit range', ru: 'Диапазон единиц' },
    'si.provenance.lines': { en: 'Line range', ru: 'Диапазон строк' },
    'si.provenance.candidates': { en: 'Extracted candidates', ru: 'Извлечённых кандидатов' },
    'si.provenance.chars': { en: 'Characters', ru: 'Знаков' },
    'si.provenance.declared': { en: 'Declared rights', ru: 'Заявленные права' },
    'si.provenance.family': { en: 'Family', ru: 'Семья' },
    'si.provenance.quality': { en: 'Extraction quality', ru: 'Качество извлечения' },
    'si.relationships.title': { en: 'Relationship candidates', ru: 'Предполагаемые связи' },
    'si.relationships.empty': { en: 'No relationship has been proposed for this source.', ru: 'Для этого источника связи не предложены.' },
    'si.rel.roles': { en: 'This source: {a} · Other source: {b}', ru: 'Этот источник: {a} · Другой источник: {b}' },
    'si.rel.confidence': { en: 'Confidence {v}', ru: 'Уверенность {v}' },
    'si.rel.open': { en: 'Open in Alignment Lab', ru: 'Открыть в сопоставлении' },
    'si.spellings.title': { en: 'Corroborating spellings', ru: 'Подтверждающие написания' },
    'si.spellings.hint': {
      en: 'Spellings from this source that also occur elsewhere. They corroborate provenance; nothing is merged.',
      ru: 'Написания из этого источника, встречающиеся и в других местах. Они подтверждают происхождение; ничего не объединяется.'
    },
    'si.spellings.public': { en: 'public corpus', ru: 'открытый корпус' },
    'si.spellings.private': { en: '{n} private', ru: 'закрытых: {n}' },
    'si.spellings.empty': { en: 'No corroborating spelling was found.', ru: 'Подтверждающих написаний не найдено.' },
    'si.decisions.title': { en: 'Decisions', ru: 'Решения' },
    'si.decisions.hint': {
      en: 'Rights, access, review and training are four separate decisions. The server refuses to raise exposure until rights are cleared and the review is accepted.',
      ru: 'Права, доступ, проверка и обучение — четыре отдельных решения. Сервер не расширит доступ, пока права не урегулированы, а проверка не принята.'
    },
    'si.decisions.training': { en: 'Training use', ru: 'Использование для обучения' },
    'si.decisions.note': { en: 'Decision note', ru: 'Примечание к решению' },
    'si.decisions.notePlaceholder': { en: 'What was checked, and where the evidence came from.', ru: 'Что проверено и на чём основаны выводы.' },
    'si.decisions.roleHint': {
      en: 'Accepting a review and raising exposure are verified-expert decisions.',
      ru: 'Принять проверку и расширить доступ может только подтверждённый эксперт.'
    },
    'si.decisions.save': { en: 'Record decisions', ru: 'Записать решения' },
    'si.decisions.saved': { en: 'Decisions recorded.', ru: 'Решения записаны.' },
    'si.history.title': { en: 'Decision history', ru: 'История решений' },
    'si.history.empty': { en: 'No decision has been recorded yet.', ru: 'Решения ещё не записывались.' },
    'si.families.title': { en: 'Families', ru: 'Семьи' },
    'si.families.hint': {
      en: 'Sources grouped by the family key derived from the path they arrived on. A family with proposed relationships is listed first.',
      ru: 'Источники, сгруппированные по семье, выведенной из пути поступления. Семьи с предложенными связями показаны первыми.'
    },
    'si.families.members': { en: '{n} sources', ru: 'источников: {n}' },
    'si.families.empty': { en: 'No family groups more than one source yet.', ru: 'Пока нет семей больше чем из одного источника.' },

    /* ── Alignment Lab ────────────────────────────────────────── */
    'align.meta.title': { en: 'Alignment Lab · Lak Corpus Explorer', ru: 'Сопоставление текстов · Лакский корпус' },
    'align.kicker': { en: 'Private workspace · authenticated only', ru: 'Закрытая мастерская · только после входа' },
    'align.h1': { en: 'Alignment Lab', ru: 'Сопоставление текстов' },
    'align.intro': {
      en: 'Open a proposed pair of sources, read the evidence behind the proposal, and align the two texts down to sentence level — one to one, one to many, many to one, or explicitly unmatched.',
      ru: 'Откройте предложенную пару источников, изучите основания предположения и сопоставьте тексты вплоть до предложений — один к одному, один ко многим, многие к одному или явно без пары.'
    },
    'align.filter.search': { en: 'Search candidates', ru: 'Поиск по предположениям' },
    'align.filter.searchPlaceholder': { en: 'File name or family…', ru: 'Имя файла или семья…' },
    'align.filter.type': { en: 'Relationship type', ru: 'Тип связи' },
    'align.filter.type.all': { en: 'All relationship types', ru: 'Все типы связей' },
    'align.filter.review': { en: 'Review status', ru: 'Состояние проверки' },
    'align.filter.review.all': { en: 'All review statuses', ru: 'Любое состояние проверки' },
    'align.list.title': { en: 'Relationship candidates', ru: 'Предполагаемые связи' },
    'align.list.count': { en: '{n} candidates', ru: 'Предположений: {n}' },
    'align.list.empty': { en: 'No relationship candidate matches these filters.', ru: 'Нет предположений, подходящих под эти условия.' },
    'align.detail.empty': { en: 'Select a candidate pair to see the evidence behind it.', ru: 'Выберите пару, чтобы увидеть основания предположения.' },
    'align.signals.count': { en: '{n} signals', ru: 'признаков: {n}' },
    'align.units': { en: '{n} units', ru: 'единиц: {n}' },
    'align.confidence': { en: 'Confidence {v}', ru: 'Уверенность {v}' },
    'align.notValidated': { en: 'Not a validated translation', ru: 'Не проверенный перевод' },
    'align.sources.title': { en: 'The two sources', ru: 'Два источника' },
    'align.evidence.title': { en: 'Signals that fired', ru: 'Сработавшие признаки' },
    'align.measurements.title': { en: 'Measurements', ru: 'Измерения' },
    'align.decision.title': { en: 'Candidate decision', ru: 'Решение по предположению' },
    'align.decision.note': { en: 'Note', ru: 'Примечание' },
    'align.decision.notePlaceholder': { en: 'Why this pair is or is not what it claims to be.', ru: 'Почему эта пара соответствует или не соответствует предположению.' },
    'align.decision.accept': { en: 'Accept candidate', ru: 'Принять предположение' },
    'align.decision.inReview': { en: 'Mark in review', ru: 'Отметить «на проверке»' },
    'align.decision.reject': { en: 'Reject', ru: 'Отклонить' },
    'align.decision.roleHint': { en: 'Accepting a candidate is a verified-expert decision.', ru: 'Принять предположение может только подтверждённый эксперт.' },
    'align.decision.saved': { en: 'Decision recorded.', ru: 'Решение записано.' },
    'align.alignment.title': { en: 'Alignment', ru: 'Сопоставление' },
    'align.alignment.hint': {
      en: 'Section, paragraph and sentence units produced from the stored text. Correct a unit rather than regenerating the alignment: regeneration is refused once decisions exist.',
      ru: 'Разделы, абзацы и предложения, полученные из сохранённого текста. Исправляйте отдельные единицы, а не пересоздавайте сопоставление: после принятых решений пересоздание запрещено.'
    },
    'align.alignment.empty': { en: 'No alignment has been produced for this pair yet.', ru: 'Для этой пары сопоставление ещё не построено.' },
    'align.alignment.generate': { en: 'Produce alignment', ru: 'Построить сопоставление' },
    'align.alignment.noText': {
      en: 'One of these sources has no extracted text, so no alignment can be produced.',
      ru: 'У одного из источников нет извлечённого текста, поэтому сопоставление построить нельзя.'
    },
    'align.unit.accept': { en: 'Accept', ru: 'Принять' },
    'align.unit.reject': { en: 'Reject', ru: 'Отклонить' },
    'align.unit.adjust': { en: 'Save adjustment', ru: 'Сохранить исправление' },
    'align.unit.adjusted': { en: 'adjusted by a reviewer', ru: 'исправлено проверяющим' },
    'align.unit.saved': { en: 'Unit decision recorded.', ru: 'Решение по единице записано.' },
    'align.unit.noLeft': { en: 'No counterpart on this side', ru: 'С этой стороны пары нет' },
    'align.unit.noRight': { en: 'No counterpart on this side', ru: 'С этой стороны пары нет' },

    /* ── Rights & candidate review ────────────────────────────── */
    'rights.meta.title': { en: 'Rights & candidate review · Lak Corpus Explorer', ru: 'Права и проверка · Лакский корпус' },
    'rights.kicker': { en: 'Private workspace · authenticated only', ru: 'Закрытая мастерская · только после входа' },
    'rights.h1': { en: 'Rights & candidate review', ru: 'Права и проверка' },
    'rights.intro': {
      en: 'Work the rights queue one source at a time: read its immutable provenance, check the spellings that corroborate it, and record rights, access, review and training as four separate decisions.',
      ru: 'Разбирайте очередь по правам по одному источнику: читайте неизменяемое происхождение, проверяйте подтверждающие написания и записывайте права, доступ, проверку и обучение как четыре отдельных решения.'
    },
    'rights.filter.search': { en: 'Search queue', ru: 'Поиск по очереди' },
    'rights.filter.searchPlaceholder': { en: 'File name or material type…', ru: 'Имя файла или тип материала…' },
    'rights.filter.action': { en: 'Required action', ru: 'Требуемое действие' },
    'rights.filter.action.all': { en: 'All required actions', ru: 'Любое требуемое действие' },
    'rights.filter.material': { en: 'Material type', ru: 'Тип материала' },
    'rights.filter.material.all': { en: 'All material types', ru: 'Все типы материала' },
    'rights.filter.rights': { en: 'Rights status', ru: 'Состояние прав' },
    'rights.filter.rights.all': { en: 'All rights statuses', ru: 'Любое состояние прав' },
    'rights.filter.review': { en: 'Review status', ru: 'Состояние проверки' },
    'rights.filter.review.all': { en: 'All review statuses', ru: 'Любое состояние проверки' },
    'rights.list.title': { en: 'Rights queue', ru: 'Очередь по правам' },
    'rights.list.count': { en: '{n} items · showing {from}–{to}', ru: 'Записей: {n} · показаны {from}–{to}' },
    'rights.list.empty': { en: 'No queue item matches these filters.', ru: 'Нет записей, подходящих под эти условия.' },
    'rights.detail.empty': {
      en: 'Select a queue item to read its provenance and record decisions.',
      ru: 'Выберите запись очереди, чтобы прочитать её происхождение и записать решения.'
    },
    'rights.page.prev': { en: 'Previous', ru: 'Назад' },
    'rights.page.next': { en: 'Next', ru: 'Вперёд' },
    'rights.stat.total': { en: 'Items in view', ru: 'Записей в выборке' },
    'rights.stat.open': { en: 'Still unreviewed', ru: 'Ещё не проверено' },
    'rights.tag.training': { en: 'Training: {v}', ru: 'Обучение: {v}' },
    'rights.provenance.title': { en: 'Immutable provenance', ru: 'Неизменяемое происхождение' },
    'rights.provenance.hint': {
      en: 'Exactly what the package recorded when the file was received. Decisions never rewrite it.',
      ru: 'Ровно то, что зафиксировал пакет при получении файла. Решения это не переписывают.'
    },
    'rights.provenance.path': { en: 'Source path', ru: 'Путь к файлу' },
    'rights.provenance.digest': { en: 'File digest (SHA-256)', ru: 'Отпечаток файла (SHA-256)' },
    'rights.provenance.sequence': { en: 'Source sequence', ru: 'Номер источника' },
    'rights.provenance.units': { en: 'Page / unit reference', ru: 'Страница или единица' },
    'rights.provenance.lines': { en: 'Line reference', ru: 'Строки' },
    'rights.provenance.declared': { en: 'Declared rights', ru: 'Заявленные права' },
    'rights.provenance.duplicate': { en: 'Duplicate group', ru: 'Группа дубликатов' },
    'rights.provenance.canonical': { en: 'Canonical duplicate', ru: 'Основной дубликат' },
    'rights.provenance.chars': { en: 'Characters', ru: 'Знаков' },
    'rights.spellings.title': { en: 'Corroborating spellings', ru: 'Подтверждающие написания' },
    'rights.spellings.hint': {
      en: 'Spellings from this source attested elsewhere. Corroboration only — nothing is merged.',
      ru: 'Написания из этого источника, встречающиеся и в других местах. Только подтверждение — ничего не объединяется.'
    },
    'rights.spellings.public': { en: 'public corpus', ru: 'открытый корпус' },
    'rights.spellings.private': { en: '{n} private', ru: 'закрытых: {n}' },
    'rights.spellings.empty': { en: 'No corroborating spelling was found.', ru: 'Подтверждающих написаний не найдено.' },
    'rights.decisions.title': { en: 'Four independent decisions', ru: 'Четыре отдельных решения' },
    'rights.decisions.hint': {
      en: 'Each decision is recorded separately with its note. The server refuses public access or training use until rights are cleared and the review is accepted.',
      ru: 'Каждое решение записывается отдельно вместе с примечанием. Сервер не даст открытый доступ или использование для обучения, пока права не урегулированы, а проверка не принята.'
    },
    'rights.decision.rights': { en: 'Rights', ru: 'Права' },
    'rights.decision.access': { en: 'Access', ru: 'Доступ' },
    'rights.decision.review': { en: 'Review', ru: 'Проверка' },
    'rights.decision.training': { en: 'Training', ru: 'Обучение' },
    'rights.decision.note': { en: 'Note', ru: 'Примечание' },
    'rights.decision.notePlaceholder': {
      en: 'Who was contacted, what was found, what still blocks this.',
      ru: 'С кем связывались, что выяснено, что ещё мешает.'
    },
    'rights.decision.roleHint': {
      en: 'Accepting a review and raising exposure are verified-expert decisions.',
      ru: 'Принять проверку и расширить доступ может только подтверждённый эксперт.'
    },
    'rights.decision.save': { en: 'Record decisions', ru: 'Записать решения' },
    'rights.decision.saved': { en: 'Decisions recorded.', ru: 'Решения записаны.' },
    'rights.history.title': { en: 'Decision history', ru: 'История решений' },
    'rights.history.empty': { en: 'No decision has been recorded yet.', ru: 'Решения ещё не записывались.' },

    /* ── Public Source Library ──────────────────────────────────
     * Canonical values (material types, roles, rights states, script
     * profiles) are localized for display only. The values themselves stay
     * language-neutral in the API, in filters and in links.
     */
    'lib.meta.title': { en: 'Source Library · Lak Corpus Explorer', ru: 'Библиотека источников · Лакский корпус' },
    'lib.kicker': { en: 'Public source catalogue', ru: 'Открытый каталог источников' },
    'lib.h1': { en: 'Source Library', ru: 'Библиотека источников' },
    'lib.intro': {
      en: 'Every substantive source in the research batch, described in the open. You can see <strong>what each source is</strong>, what language and script it uses, what rights state it is in, and what it contributes — without any of the source text being published.',
      ru: 'Все содержательные источники исследовательской подборки — открыто описаны. Видно, <strong>что представляет собой каждый источник</strong>, на каком он языке и письме, каков его правовой статус и что он даёт проекту, — при этом сам текст источника не публикуется.'
    },
    'lib.statsLabel': { en: 'Library summary', ru: 'Сводка по библиотеке' },
    'lib.stat.items': { en: 'Audited items', ru: 'Аудировано единиц' },
    'lib.stat.receipts': { en: 'Metadata receipts', ru: 'Служебных квитанций' },
    'lib.corpusRoleLabel': { en: 'Corpus role', ru: 'Роль в корпусе' },
    'lib.corpusRole.all': { en: 'Any role', ru: 'Любая роль' },
    'lib.extractionQualityLabel': { en: 'Extraction quality', ru: 'Качество извлечения' },
    'lib.extractionQuality.all': { en: 'Any quality', ru: 'Любое качество' },

    'lib.coverage.aria': { en: 'Source-family coverage', ru: 'Охват по видам материала' },
    'lib.coverage.h2': { en: 'Source-family coverage', ru: 'Охват по видам материала' },
    'lib.coverage.intro': {
      en: 'The audit counted <strong>320 items</strong> in this collection: <strong>293 substantive sources</strong> — every one catalogued below — and <strong>27 system metadata receipts</strong> (operating-system files with no content, listed at the foot of the page). Each family is shown with the role it can play once its rights are cleared.',
      ru: 'Аудит насчитал в коллекции <strong>320 единиц</strong>: <strong>293 содержательных источника</strong> — все представлены ниже — и <strong>27 служебных файлов-квитанций</strong> (системные файлы без содержания, перечислены внизу страницы). Для каждого вида указана роль, которую он сможет сыграть после урегулирования прав.'
    },

    'lib.themes.aria': { en: 'How these sources strengthen the corpus', ru: 'Как эти источники усилят корпус' },
    'lib.themes.h2': { en: 'How these sources will strengthen the corpus', ru: 'Как эти источники усилят корпус' },
    'lib.themes.dictionaries.h3': { en: 'Dictionary reconciliation', ru: 'Сверка словарей' },
    'lib.themes.dictionaries.body': {
      en: 'Twenty-one dictionaries and lexicons — held privately — can be cross-checked against the Khaydakov, Dzhidalaev, Gadzhiyev and Digiev layers already in the corpus, so duplicate headwords become corroboration instead of silent repeats.',
      ru: 'Двадцать один словарь и лексикон — хранятся закрыто — можно сверить со слоями Хайдакова, Джидалаева, Гаджиева и Дигиева, уже имеющимися в корпусе, чтобы повторные словарные статьи стали подтверждением, а не скрытым дублем.'
    },
    'lib.themes.ocr.h3': { en: 'OCR correction', ru: 'Исправление OCR' },
    'lib.themes.ocr.body': {
      en: 'Scanned documents with known extraction quality give reviewers a focused queue: the word-form index shows which spellings are widely attested and which appear only where OCR struggled.',
      ru: 'Сканированные документы с известным качеством извлечения дают проверяющим чёткую очередь: указатель словоформ показывает, какие написания широко засвидетельствованы, а какие встречаются лишь там, где OCR ошибался.'
    },
    'lib.themes.morphology.h3': { en: 'Morphology research', ru: 'Исследование морфологии' },
    'lib.themes.morphology.body': {
      en: 'Fifty-eight grammar and linguistic-analysis sources can supply paradigms, rules and cited examples for lemma and morphology work — reviewed by experts before any of it becomes data.',
      ru: 'Пятьдесят восемь источников по грамматике и лингвистическому анализу могут дать парадигмы, правила и цитируемые примеры для работы над леммами и морфологией — после экспертной проверки, прежде чем что-либо станет данными.'
    },
    'lib.themes.benchmark.h3': { en: 'Benchmark design', ru: 'Устройство бенчмарка' },
    'lib.themes.benchmark.body': {
      en: 'Elicitation questionnaires and graded educational material inform how a fair Lak benchmark should be built, while the held-out benchmark stays isolated from everything public.',
      ru: 'Анкеты для элиситации и градуированные учебные материалы подсказывают, как построить честный бенчмарк лакского языка; отложенный бенчмарк при этом остаётся изолированным от всего публичного.'
    },
    'lib.themes.review.h3': { en: 'Expert review', ru: 'Экспертная проверка' },
    'lib.themes.review.body': {
      en: 'Sixty-six translation or parallel-text candidates give reviewers concrete pairs to accept or reject inside the Alignment Lab — where every relationship starts as a draft, never a conclusion.',
      ru: 'Шестьдесят шесть кандидатов в переводы и параллельные тексты дают проверяющим конкретные пары для принятия или отклонения в Лаборатории выравнивания, где каждая связь начинается как черновик, а не как вывод.'
    },
    'lib.themes.alignment.h3': { en: 'Cautious alignment', ru: 'Осторожное выравнивание' },
    'lib.themes.alignment.body': {
      en: 'Lak–Russian and Lak–English parallel candidates are aligned provisionally, section by section, so future corpus growth can draw on them. A provisional pair is not a verified translation: nothing is published or trained on until a reviewer confirms it.',
      ru: 'Лакско-русские и лакско-английские параллельные кандидаты выравниваются предварительно, раздел за разделом, чтобы будущий рост корпуса мог на них опираться. Предварительная пара — не проверенный перевод: ничто не публикуется и не используется для обучения, пока проверяющий её не подтвердит.'
    },

    'lib.receipts.aria': { en: 'System metadata receipts', ru: 'Служебные файлы-квитанции' },
    'lib.receipts.h2': { en: 'System metadata receipts', ru: 'Служебные файлы-квитанции' },
    'lib.receipts.intro': {
      en: 'The collection also contained <strong>27 operating-system metadata files</strong> (folder index files created by macOS). They hold no text and no linguistic value; they are listed so the public account of what was received matches the audit exactly. Their filenames and folder locations are not published.',
      ru: 'В коллекции также было <strong>27 служебных файлов операционной системы</strong> (индексы папок, созданные macOS). В них нет ни текста, ни лингвистической ценности; они перечислены, чтобы открытый отчёт о полученном в точности совпадал с аудитом. Их имена и расположение не публикуются.'
    },
    'lib.receipts.bytes': { en: '{n} bytes', ru: '{n} байт' },
    'lib.receipts.empty': { en: 'No receipts are recorded yet.', ru: 'Квитанции пока не записаны.' },
    'lib.receiptKind.macos_folder_metadata': { en: 'macOS folder metadata file', ru: 'Служебный файл macOS' },
    'lib.disposition.no_extractable_text': { en: 'No extractable text', ru: 'Нет извлекаемого текста' },
    'lib.disposition.provenance_witness_only': { en: 'Provenance witness only', ru: 'Только свидетельство получения' },
    'lib.method': {
      en: '<strong>What is published here, and what is not.</strong> This catalogue publishes description, never content: the kind of material, its language and script mix, its size, its rights state, and the role it plays in this project. It does not publish file paths, checksums, who supplied a source, descriptions of what a source says, or any of its text. Document titles are shown only where the file’s own metadata carries a real title; where it does not, the entry is named by its material type rather than by an invented name. A name in “attributed to” is the name recorded inside the file, which is not always the author. Dates are file dates, not publication dates.',
      ru: '<strong>Что здесь публикуется, а что нет.</strong> Каталог публикует описание, но никогда — содержание: вид материала, соотношение языков и письма, объём, правовой статус и роль в проекте. Не публикуются пути к файлам, контрольные суммы, сведения о том, кто передал источник, описания того, о чём источник, и никакой его текст. Название документа показывается только там, где оно действительно есть в метаданных файла; иначе запись называется по виду материала, а не выдуманным именем. Имя в поле «приписывается» — это имя, записанное внутри файла, и это не всегда автор. Даты — это даты файла, а не даты публикации.'
    },
    'lib.catalogueLabel': { en: 'Source catalogue', ru: 'Каталог источников' },
    'lib.searchLabel': { en: 'Search sources', ru: 'Поиск по источникам' },
    'lib.searchPlaceholder': { en: 'Title, name, kind of material…', ru: 'Название, имя, вид материала…' },
    'lib.materialType': { en: 'Material type', ru: 'Вид материала' },
    'lib.materialType.all': { en: 'All material types', ru: 'Все виды материала' },
    'lib.languageScope': { en: 'Language', ru: 'Язык' },
    'lib.languageScope.all': { en: 'All languages', ru: 'Все языки' },
    'lib.scriptProfile': { en: 'Script', ru: 'Письмо' },
    'lib.scriptProfile.all': { en: 'Any script', ru: 'Любое письмо' },
    'lib.contribution': { en: 'Contribution', ru: 'Вклад' },
    'lib.contribution.all': { en: 'Any contribution', ru: 'Любой вклад' },
    'lib.rightsState': { en: 'Rights state', ru: 'Правовой статус' },
    'lib.rightsState.all': { en: 'Any rights state', ru: 'Любой правовой статус' },
    'lib.toWordForms': { en: 'Open the Lak word-form index →', ru: 'Открыть указатель лакских словоформ →' },
    'lib.loading': { en: 'Loading sources', ru: 'Загрузка источников' },
    'lib.pagerLabel': { en: 'Catalogue pages', ru: 'Страницы каталога' },

    'lib.unknown': { en: 'Not recorded', ru: 'Не указано' },
    'lib.none': { en: 'None', ru: 'Нет' },
    'lib.name.withheld': { en: 'Fieldwork material {ref}', ru: 'Полевой материал {ref}' },
    'lib.name.family': { en: '{family} — {ref}', ru: '{family} — {ref}' },
    'lib.name.material': { en: '{material} — {ref}', ru: '{material} — {ref}' },
    'lib.name.note.derived': {
      en: 'This file records no usable title, so the entry is named by what kind of material it is.',
      ru: 'В файле нет пригодного названия, поэтому запись названа по виду материала.'
    },
    'lib.name.note.withheld': {
      en: 'Named by material type only. Fieldwork recordings can identify the people taking part, so no filename, title or date is published.',
      ru: 'Названо только по виду материала. Полевые записи могут указывать на участников, поэтому имя файла, название и дата не публикуются.'
    },
    'lib.fileYear': { en: 'file dated {year}', ru: 'файл датирован {year}' },
    'lib.attributedTo': { en: 'Attributed to {name}', ru: 'Приписывается: {name}' },
    'lib.attributionCaveat': {
      en: 'This is the name recorded inside the file. It is often the author, but it can also be whoever prepared or scanned the document.',
      ru: 'Это имя, записанное внутри файла. Часто это автор, но так же часто — тот, кто подготовил или отсканировал документ.'
    },
    'lib.size.words': { en: '{n} words', ru: '{n} слов' },
    'lib.size.chars': { en: '{n} characters', ru: '{n} знаков' },
    'lib.openOriginal': { en: 'Open the original', ru: 'Открыть оригинал' },
    'lib.noPublicLink': { en: 'No public link recorded for this source', ru: 'Публичная ссылка для этого источника не записана' },
    'lib.duplicate.canonical': { en: 'Kept copy of a repeated file', ru: 'Основной экземпляр повторяющегося файла' },
    'lib.duplicate.other': { en: 'Repeated file', ru: 'Повторяющийся файл' },
    'lib.howUsed': { en: 'How this source is used', ru: 'Как используется этот источник' },
    'lib.viewDetail': { en: 'Full entry →', ru: 'Полная запись →' },
    'lib.backToList': { en: '← All sources', ru: '← Все источники' },
    'lib.seeWordForms': { en: 'See the word-form index this source feeds →', ru: 'Посмотреть указатель словоформ, который пополняет этот источник →' },
    'lib.text.published': { en: 'The text of this source is published.', ru: 'Текст этого источника опубликован.' },
    'lib.text.unpublished': {
      en: 'The text of this source is not published. It is held privately while its rights are unresolved, and it is not used for model training.',
      ru: 'Текст этого источника не публикуется. Он хранится закрыто, пока не решён вопрос прав, и не используется для обучения моделей.'
    },
    'lib.related.h3': { en: 'The same file appears {n} more times', ru: 'Тот же файл встречается ещё {n} раз' },
    'lib.related.intro': {
      en: 'These entries are byte-identical copies received separately. They are catalogued individually so the record of what was received stays accurate, and counted once so the totals do not double up.',
      ru: 'Это побайтово одинаковые копии, полученные по отдельности. Они каталогизированы отдельно, чтобы запись о полученном оставалась точной, и учтены один раз, чтобы итоги не удваивались.'
    },
    'lib.fact.role': { en: 'Role here', ru: 'Роль в проекте' },
    'lib.fact.size': { en: 'Size', ru: 'Объём' },
    'lib.fact.contribution': { en: 'Contributes', ru: 'Даёт проекту' },
    'lib.fact.wordForms': { en: 'Word forms indexed', ru: 'Словоформ в указателе' },
    'lib.fact.materialType': { en: 'Material type', ru: 'Вид материала' },
    'lib.fact.language': { en: 'Language', ru: 'Язык' },
    'lib.fact.script': { en: 'Script', ru: 'Письмо' },
    'lib.fact.rights': { en: 'Rights state', ru: 'Правовой статус' },
    'lib.fact.format': { en: 'File format', ru: 'Формат файла' },
    'lib.fact.pages': { en: 'Pages', ru: 'Страниц' },
    'lib.fact.extraction': { en: 'Text extraction', ru: 'Извлечение текста' },
    'lib.fact.extractionQuality': { en: 'Extraction quality', ru: 'Качество извлечения' },
    'lib.fact.candidateRows': { en: 'Rows held privately', ru: 'Строк в закрытом хранении' },

    'lib.resultCount': { en: '{shown} of {total} sources', ru: '{shown} из {total} источников' },
    'lib.pageOf': { en: 'Page {page} of {pages}', ru: 'Страница {page} из {pages}' },
    'lib.prev': { en: '← Previous', ru: '← Назад' },
    'lib.next': { en: 'Next →', ru: 'Вперёд →' },
    'lib.empty.title': { en: 'No sources match these filters', ru: 'Под эти фильтры ничего не подходит' },
    'lib.empty.body': { en: 'Try a broader search, or clear one of the filters.', ru: 'Попробуйте более широкий запрос или снимите один из фильтров.' },
    'lib.error.title': { en: 'The catalogue could not be loaded', ru: 'Не удалось загрузить каталог' },
    'lib.error.body': { en: 'Reload the page to try again.', ru: 'Обновите страницу, чтобы повторить.' },
    'lib.notFound.title': { en: 'No such source', ru: 'Такого источника нет' },
    'lib.notFound.body': { en: 'That reference is not in the catalogue.', ru: 'Этого номера нет в каталоге.' },
    'lib.preparing.title': { en: 'The library is still being built', ru: 'Библиотека ещё формируется' },
    'lib.preparing.body': {
      en: 'Descriptions are being derived from the research batch — {done} of {total} steps are done. Reload in a moment.',
      ru: 'Описания выводятся из исследовательской подборки — готово {done} из {total} шагов. Обновите страницу чуть позже.'
    },
    'lib.stat.sources': { en: 'Sources catalogued', ru: 'Источников в каталоге' },
    'lib.stat.materialTypes': { en: 'Kinds of material', ru: 'Видов материала' },
    'lib.stat.contributing': { en: 'Feeding the word-form index', ru: 'Пополняют указатель словоформ' },
    'lib.stat.underReview': { en: 'Awaiting a rights decision', ru: 'Ждут решения по правам' },
    'lib.review.sectionLabel': { en: 'Rights review queue', ru: 'Очередь проверки прав' },
    'lib.review.h2': { en: 'Rights review queue', ru: 'Очередь проверки прав' },
    'lib.review.intro': {
      en: 'A handful of sources in this batch look like they may already be in the public domain. <strong>Looking like it is not a clearance.</strong> They are listed here in the open so the question is visible and answerable — and their text stays unpublished until someone checks.',
      ru: 'Несколько источников подборки выглядят так, будто уже перешли в общественное достояние. <strong>«Выглядит» — это ещё не разрешение.</strong> Они перечислены здесь открыто, чтобы вопрос был виден и на него можно было ответить, а их текст не публикуется, пока никто не проверил.'
    },
    'lib.review.empty': { en: 'Nothing is waiting on a rights decision right now.', ru: 'Сейчас ничего не ждёт решения по правам.' },

    /* Canonical vocabulary — display labels only. */
    'lib.materialType.translation_or_parallel_text': { en: 'Translation or parallel text', ru: 'Перевод или параллельный текст' },
    'lib.materialType.academic_reference': { en: 'Academic reference', ru: 'Научная литература' },
    'lib.materialType.grammar_or_linguistic_analysis': { en: 'Grammar or linguistic analysis', ru: 'Грамматика или лингвистический разбор' },
    'lib.materialType.primary_text_or_folklore': { en: 'Primary text or folklore', ru: 'Первичный текст или фольклор' },
    'lib.materialType.educational_material': { en: 'Educational material', ru: 'Учебный материал' },
    'lib.materialType.dictionary_or_lexicon': { en: 'Dictionary or lexicon', ru: 'Словарь или лексикон' },
    'lib.materialType.non_lak_comparative': { en: 'Non-Lak comparative material', ru: 'Сравнительный нелакский материал' },
    'lib.materialType.historical_cultural_reference': { en: 'Historical or cultural reference', ru: 'Историко-культурный справочный материал' },
    'lib.materialType.research_administration': { en: 'Research administration', ru: 'Документы по организации работы' },
    'lib.materialType.fieldwork_transcript': { en: 'Fieldwork transcript', ru: 'Полевая расшифровка' },
    'lib.materialType.elicitation_questionnaire': { en: 'Elicitation questionnaire', ru: 'Опросник для сбора данных' },
    'lib.materialType.archive_container': { en: 'Archive container', ru: 'Архив с вложениями' },
    'lib.materialType.system_metadata': { en: 'System metadata', ru: 'Системные метаданные' },

    'lib.languageScope.Lak-Russian mixed': { en: 'Lak and Russian mixed', ru: 'Лакский и русский вместе' },
    'lib.languageScope.Latin-script/English or transliteration': { en: 'Latin script — English or transliteration', ru: 'Латиница — английский или транслитерация' },
    'lib.languageScope.Lak-dominant or Lak examples': { en: 'Mainly Lak, or Lak examples', ru: 'Преимущественно лакский или лакские примеры' },
    'lib.languageScope.Lak-related, text signal insufficient': { en: 'Lak-related, too little text to tell', ru: 'Связано с лакским, но текста слишком мало' },
    'lib.languageScope.Russian-dominant': { en: 'Mainly Russian', ru: 'Преимущественно русский' },
    'lib.languageScope.non-Lak Caucasian/comparative': { en: 'Other Caucasian or comparative', ru: 'Другие кавказские или сравнительные' },
    'lib.languageScope.undetermined': { en: 'Undetermined', ru: 'Не определено' },

    'lib.scriptProfile.cyrillic': { en: 'Cyrillic', ru: 'Кириллица' },
    'lib.scriptProfile.latin': { en: 'Latin', ru: 'Латиница' },
    'lib.scriptProfile.mixed': { en: 'Both scripts', ru: 'Оба письма' },
    'lib.scriptProfile.none': { en: 'No script detected', ru: 'Письмо не определено' },

    'lib.rightsState.pending_permission': { en: 'Rights not cleared — permission pending', ru: 'Права не урегулированы — ждёт разрешения' },
    'lib.rightsState.public_domain_candidate_review': { en: 'Public-domain candidate — under review', ru: 'Возможно общественное достояние — на проверке' },

    'lib.contribution.word_forms': { en: 'Word forms to the public index', ru: 'Словоформы в открытый указатель' },
    'lib.contribution.alignment_candidate': { en: 'Alignment candidate', ru: 'Кандидат на сопоставление' },
    'lib.contribution.reference_only': { en: 'Reference only', ru: 'Только справочно' },
    'lib.contribution.withheld_pending_review': { en: 'Held back pending review', ru: 'Отложено до проверки' },

    'lib.priority.P0': { en: 'P0', ru: 'P0' },
    'lib.priority.P1': { en: 'P1', ru: 'P1' },
    'lib.priority.P2': { en: 'P2', ru: 'P2' },
    'lib.priority.P3': { en: 'P3', ru: 'P3' },

    'lib.fileFormat.pdf': { en: 'PDF', ru: 'PDF' },
    'lib.fileFormat.doc': { en: 'Word document', ru: 'Документ Word' },
    'lib.fileFormat.djvu': { en: 'DjVu', ru: 'DjVu' },
    'lib.fileFormat.tiff': { en: 'TIFF image', ru: 'Изображение TIFF' },
    'lib.fileFormat.jpg': { en: 'JPEG image', ru: 'Изображение JPEG' },
    'lib.fileFormat.rtf': { en: 'Rich text', ru: 'Текст RTF' },
    'lib.fileFormat.archive': { en: 'Archive', ru: 'Архив' },
    'lib.fileFormat.other': { en: 'Other format', ru: 'Другой формат' },

    'lib.extractionStatus.full_text': { en: 'Full text read from the file', ru: 'Полный текст прочитан из файла' },
    'lib.extractionStatus.full_text_layer': { en: 'Full embedded text layer', ru: 'Полный встроенный текстовый слой' },
    'lib.extractionStatus.ocr_full_document': { en: 'Whole document recognised by OCR', ru: 'Весь документ распознан OCR' },
    'lib.extractionStatus.ocr_full_image': { en: 'Scanned image recognised by OCR', ru: 'Скан распознан OCR' },
    'lib.extractionStatus.archive_member_list': { en: 'Archive contents listed, not opened', ru: 'Состав архива перечислен, но не раскрыт' },
    'lib.extractionStatus.empty_document_verified': { en: 'Checked and found empty', ru: 'Проверено — пусто' },

    'lib.extractionQuality.usable_private_extraction': { en: 'Usable', ru: 'Пригодно' },
    'lib.extractionQuality.not_applicable': { en: 'Not applicable', ru: 'Неприменимо' },
    'lib.extractionQuality.very_short': { en: 'Very short', ru: 'Очень короткое' },

    'lib.confidence.high': { en: 'Well attested', ru: 'Хорошо засвидетельствовано' },
    'lib.confidence.medium': { en: 'Attested', ru: 'Засвидетельствовано' },
    'lib.confidence.low': { en: 'Barely attested', ru: 'Едва засвидетельствовано' },

    'lib.corpusRole.private alignment candidate': { en: 'Private alignment candidate', ru: 'Закрытый кандидат на сопоставление' },
    'lib.corpusRole.bibliographic and linguistic reference': { en: 'Bibliographic and linguistic reference', ru: 'Библиографический и лингвистический справочник' },
    'lib.corpusRole.grammar evidence and search-rule source': { en: 'Grammar evidence and search rules', ru: 'Грамматические свидетельства и правила поиска' },
    'lib.corpusRole.private sentence and genre candidate': { en: 'Private sentence and genre candidate', ru: 'Закрытый кандидат по предложениям и жанрам' },
    'lib.corpusRole.curriculum and controlled-language evidence': { en: 'Curriculum and graded-language evidence', ru: 'Учебная программа и материал по уровням языка' },
    'lib.corpusRole.private lexicon candidate': { en: 'Private lexicon candidate', ru: 'Закрытый лексический кандидат' },
    'lib.corpusRole.comparative reference and negative control': { en: 'Comparative reference and negative control', ru: 'Сравнительный справочник и контрольный материал' },
    'lib.corpusRole.cultural context and named-entity reference': { en: 'Cultural context and names reference', ru: 'Культурный контекст и справочник имён' },
    'lib.corpusRole.project provenance and research-history record': { en: 'Project provenance and research history', ru: 'Происхождение проекта и история исследования' },
    'lib.corpusRole.elicitation design and expert benchmark source': { en: 'Elicitation design and expert benchmark', ru: 'Составление опросников и экспертный эталон' },
    'lib.corpusRole.private elicitation and aligned-gloss candidate': { en: 'Private elicitation and glossing candidate', ru: 'Закрытый кандидат по опросам и глоссированию' },
    'lib.corpusRole.preservation and member inventory': { en: 'Preservation and contents inventory', ru: 'Сохранение и опись содержимого' },

    'lib.family.lak_russian_epics': { en: 'Lak and Russian epic versions', ru: 'Лакские и русские версии эпоса' },
    'lib.family.ttul_daghustan': { en: 'Gamzatov — Ttul Daghustan versions', ru: 'Гамзатов — версии «Ттул Дагъусттан»' },
    'lib.family.authier_tales': { en: 'Authier — Lak tales in Cyrillic and Latin', ru: 'Отье — лакские сказки кириллицей и латиницей' },
    'lib.family.tolstoy_versions': { en: 'Tolstoy in Lak — Cyrillic and Latin versions', ru: 'Толстой на лакском — кириллица и латиница' },
    'lib.family.lorca': { en: 'García Lorca — Lak and Russian versions', ru: 'Гарсиа Лорка — лакская и русская версии' },
    'lib.family.eleonora_materials': { en: 'Eleonora — transcription and translation material', ru: 'Элеонора — материалы расшифровки и перевода' },
    'lib.family.war_pilot': { en: 'War — Russian/Lak pilot set', ru: 'Война — пилотный русско-лакский набор' },

    /* One recommendation per material type; the API carries the same sentence
     * in English and this is its Russian counterpart. */
    'lib.use.translation_or_parallel_text': {
      en: 'Preserve document structure and align Lak with the corresponding Russian/Latin/English version after human verification.',
      ru: 'Сохранять структуру документа и сопоставлять лакский текст с соответствующей русской, латинской или английской версией после проверки человеком.'
    },
    'lib.use.academic_reference': {
      en: 'Index metadata, citations and any reviewed Lak examples; do not ingest article prose as Lak corpus data.',
      ru: 'Индексировать метаданные, ссылки и проверенные лакские примеры; текст самих статей в лакский корпус не включать.'
    },
    'lib.use.grammar_or_linguistic_analysis': {
      en: 'Extract cited Lak examples and grammatical analyses for lemma/morphology rules and expert benchmarks; keep prose out of the sentence corpus.',
      ru: 'Извлекать приведённые лакские примеры и грамматические разборы для правил лемматизации и морфологии и для экспертных эталонов; авторский текст в корпус предложений не включать.'
    },
    'lib.use.primary_text_or_folklore': {
      en: 'Segment into documents, paragraphs and sentences for concordance and genre coverage; retain author, translator and edition metadata.',
      ru: 'Разбивать на документы, абзацы и предложения для конкорданса и охвата жанров; сохранять сведения об авторе, переводчике и издании.'
    },
    'lib.use.educational_material': {
      en: 'Use privately for orthography, graded vocabulary and benchmark design; extract examples only after rights review.',
      ru: 'Использовать закрыто для орфографии, лексики по уровням и подготовки эталонов; примеры извлекать только после проверки прав.'
    },
    'lib.use.dictionary_or_lexicon': {
      en: 'Segment headwords, translations, examples and morphology; reconcile against existing Khaydakov, Dzhidalaev, Gadzhiyev and Digiev layers.',
      ru: 'Выделять заголовочные слова, переводы, примеры и морфологию; сверять со слоями Хайдакова, Джидалаева, Гаджиева и Дигиева.'
    },
    'lib.use.non_lak_comparative': {
      en: 'Index metadata and relevant comparisons; exclude non-Lak sentences from the Lak corpus.',
      ru: 'Индексировать метаданные и уместные сопоставления; нелакские предложения в лакский корпус не включать.'
    },
    'lib.use.historical_cultural_reference': {
      en: 'Index people, places, dates and Lak cultural context; do not mix Russian historical prose into the Lak sentence corpus.',
      ru: 'Индексировать людей, места, даты и лакский культурный контекст; русскую историческую прозу в лакский корпус предложений не добавлять.'
    },
    'lib.use.research_administration': {
      en: 'Preserve names, dates and project context; exclude administrative prose from linguistic candidate layers.',
      ru: 'Сохранять имена, даты и контекст проекта; служебные тексты в лингвистические слои не включать.'
    },
    'lib.use.fieldwork_transcript': {
      en: 'Preserve speaker/session cues and align Lak transcription with supplied translations; require speaker-consent and encoding review before any release.',
      ru: 'Сохранять пометы о говорящем и сеансе и сопоставлять лакскую расшифровку с приложенными переводами; до любой публикации требуется согласие говорящих и проверка кодировки.'
    },
    'lib.use.elicitation_questionnaire': {
      en: 'Convert prompts into a reviewed elicitation and morphology benchmark; do not treat prompt prose as attested Lak usage.',
      ru: 'Превращать вопросы в проверенный эталон по сбору данных и морфологии; сами формулировки вопросов не считать засвидетельствованным лакским употреблением.'
    },
    'lib.use.archive_container': {
      en: 'Retain unchanged; reconcile members against separately received files before extraction.',
      ru: 'Хранить без изменений; перед извлечением сверить вложения с отдельно полученными файлами.'
    },

    /* ── Public word-form index ─────────────────────────────── */
    'wf.meta.title': { en: 'Lak word forms · Lak Corpus Explorer', ru: 'Лакские словоформы · Лакский корпус' },
    'wf.kicker': { en: 'Derived public index', ru: 'Производный открытый указатель' },
    'wf.h1': { en: 'Lak word forms', ru: 'Лакские словоформы' },
    'wf.intro': {
      en: 'Word forms as they actually appear across the research batch — not dictionary headwords, but <strong>the shapes the words take in real texts</strong>. Each entry shows how often the form occurs and how many independent sources attest it.',
      ru: 'Словоформы в том виде, в каком они реально встречаются в исследовательской подборке, — не словарные заголовки, а <strong>тот облик, который слова принимают в живых текстах</strong>. Для каждой формы показано, как часто она встречается и сколько независимых источников её подтверждают.'
    },
    'wf.statsLabel': { en: 'Index summary', ru: 'Сводка по указателю' },
    'wf.method': {
      en: '<strong>Why a form has to appear twice.</strong> A word that occurs in only one restricted document is a fact about that document, and enough such facts would reconstruct it. So a form is published only when <strong>at least two independent sources</strong> use it. That is also why the index carries no sentences, no context and no line references: it is a list of words and counts, deliberately not a way to read anything. Fieldwork recordings contribute nothing at all, because their filenames and content can identify the people who were recorded.',
      ru: '<strong>Почему форма должна встретиться дважды.</strong> Слово, встречающееся лишь в одном закрытом документе, — это факт об этом документе, и достаточное число таких фактов позволило бы его восстановить. Поэтому форма публикуется, только если её используют <strong>не менее двух независимых источников</strong>. По той же причине в указателе нет ни предложений, ни контекста, ни ссылок на строки: это список слов и чисел и намеренно не способ что-либо прочитать. Полевые записи не дают сюда ничего — их имена файлов и содержание могут указать на записанных людей.'
    },
    'wf.indexLabel': { en: 'Word form index', ru: 'Указатель словоформ' },
    'wf.searchLabel': { en: 'Find a form', ru: 'Найти форму' },
    'wf.searchPlaceholder': { en: 'Start typing a Lak word…', ru: 'Начните вводить лакское слово…' },
    'wf.script': { en: 'Script', ru: 'Письмо' },
    'wf.script.all': { en: 'Any script', ru: 'Любое письмо' },
    'wf.confidence': { en: 'Attestation', ru: 'Подтверждённость' },
    'wf.confidence.all': { en: 'Any attestation', ru: 'Любая подтверждённость' },
    'wf.sort': { en: 'Order by', ru: 'Сортировать' },
    'wf.sort.sources': { en: 'Most sources', ru: 'Больше источников' },
    'wf.sort.occurrences': { en: 'Most occurrences', ru: 'Чаще встречается' },
    'wf.sort.alphabetical': { en: 'Alphabetical', ru: 'По алфавиту' },
    'wf.markerOnly': { en: 'Only forms with Lak-specific letters', ru: 'Только формы с лакскими буквами' },
    'wf.loading': { en: 'Loading word forms', ru: 'Загрузка словоформ' },
    'wf.pagerLabel': { en: 'Index pages', ru: 'Страницы указателя' },
    'wf.markerTitle': { en: 'Contains a Lak-specific letter', ru: 'Содержит специфическую лакскую букву' },
    'wf.markerShort': { en: 'Lak', ru: 'лак.' },
    'wf.findSources': { en: 'Sources', ru: 'Источники' },
    'wf.tableCaption': { en: 'Lak word forms with occurrence and source counts', ru: 'Лакские словоформы с числом вхождений и источников' },
    'wf.col.form': { en: 'Form', ru: 'Форма' },
    'wf.col.occurrences': { en: 'Occurrences', ru: 'Вхождений' },
    'wf.col.sources': { en: 'Sources', ru: 'Источников' },
    'wf.col.script': { en: 'Script', ru: 'Письмо' },
    'wf.col.confidence': { en: 'Attestation', ru: 'Подтверждённость' },
    'wf.col.explore': { en: 'Explore', ru: 'Перейти' },
    'wf.resultCount': { en: '{shown} of {total} forms', ru: '{shown} из {total} форм' },
    'wf.empty.title': { en: 'No forms match', ru: 'Ничего не найдено' },
    'wf.empty.body': {
      en: 'A form appears here only when at least two independent sources use it. Try a shorter beginning, or clear a filter.',
      ru: 'Форма попадает сюда, только если её используют не менее двух независимых источников. Попробуйте более короткое начало слова или снимите фильтр.'
    },
    'wf.error.title': { en: 'The index could not be loaded', ru: 'Не удалось загрузить указатель' },
    'wf.error.body': { en: 'Reload the page to try again.', ru: 'Обновите страницу, чтобы повторить.' },
    'wf.preparing.title': { en: 'The index is still being built', ru: 'Указатель ещё формируется' },
    'wf.preparing.body': {
      en: 'Word forms are being derived from the research batch — {done} of {total} steps are done. Reload in a moment.',
      ru: 'Словоформы выводятся из исследовательской подборки — готово {done} из {total} шагов. Обновите страницу чуть позже.'
    },
    'wf.stat.forms': { en: 'Published word forms', ru: 'Опубликованных словоформ' },
    'wf.stat.threshold': { en: 'Sources needed to publish a form', ru: 'Источников нужно для публикации формы' },
    'wf.stat.thresholdValue': { en: '2+', ru: '2+' },

    /* Search-page collections */
    'search.collections.sources': { en: 'Sources matching “{q}”', ru: 'Источники по запросу «{q}»' },
    'search.collections.forms': { en: 'Word forms starting with “{q}”', ru: 'Словоформы, начинающиеся на «{q}»' },
    'search.collections.allSources': { en: 'All {n} matching sources →', ru: 'Все совпадающие источники ({n}) →' },
    'search.collections.allForms': { en: 'All {n} matching forms →', ru: 'Все совпадающие формы ({n}) →' },
    'search.collections.formSummary': { en: '{occurrences} occurrences · {sources} sources', ru: '{occurrences} вхождений · {sources} источников' },

    /* Help popovers */
    'help.sourceLibrary': {
      en: 'A catalogue of every research source we hold: what it is and how it is used. The documents themselves stay private until their rights are cleared.',
      ru: 'Каталог всех имеющихся исследовательских источников: что это и как используется. Сами документы остаются закрытыми, пока не решён вопрос прав.'
    },
    'help.contribution': {
      en: 'How this source feeds the project: some contribute word forms to the public index, others are held as references only.',
      ru: 'Что источник даёт проекту: одни пополняют открытый указатель словоформ, другие хранятся только как справочные.'
    },
    'help.rightsReview': {
      en: 'These sources look like they may already be out of copyright. Until someone confirms that, their text stays unpublished.',
      ru: 'Похоже, что срок охраны этих источников уже истёк. Пока это не подтверждено, их текст не публикуется.'
    },
    'help.wordForms': {
      en: 'Single words as they actually appear across the research sources, with how often they occur and how many separate sources use them.',
      ru: 'Отдельные слова в том виде, в каком они встречаются в исследовательских источниках, с числом вхождений и числом использующих их источников.'
    },
    'help.attestation': {
      en: 'How many separate sources use this form. More sources means the form is better attested.',
      ru: 'Сколько разных источников используют эту форму. Чем больше источников, тем надёжнее подтверждение.'
    }
  };

  /* ── State ────────────────────────────────────────────────── */
  var currentLang = DEFAULT_LANG;
  var explicitSelection = false;
  var listeners = [];
  var warnedKeys = {};

  function normalizeLang(lang) {
    if (!lang) return null;
    var base = String(lang).toLowerCase().split('-')[0];
    return SUPPORTED.indexOf(base) !== -1 ? base : null;
  }

  function readStored() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return null;
    }
  }

  function writeStored(lang) {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (e) { /* ignore */ }
  }

  function resolveInitialLang() {
    var stored = normalizeLang(readStored());
    if (stored) {
      explicitSelection = true;
      return stored;
    }
    var nav = null;
    try {
      nav = normalizeLang(navigator.language ||
        (navigator.languages && navigator.languages[0]));
    } catch (e) { nav = null; }
    return nav || DEFAULT_LANG;
  }

  /* ── Interpolation ────────────────────────────────────────── */
  function interpolate(str, vars) {
    if (!vars) return str;
    return str.replace(/\{(\w+)\}/g, function (m, name) {
      return Object.prototype.hasOwnProperty.call(vars, name)
        ? String(vars[name]) : m;
    });
  }

  function warnMissing(key, sub) {
    if (!IS_DEV) return;
    var id = key + (sub ? '::' + sub : '');
    if (warnedKeys[id]) return;
    warnedKeys[id] = true;
    console.warn('[i18n] missing translation for key "' + key + '"' +
      (sub ? ' (' + sub + ')' : '') + ' in language "' + currentLang + '"');
  }

  function lookup(key) {
    var entry = DICT[key];
    if (!entry) {
      warnMissing(key, 'undefined key');
      return null;
    }
    if (typeof entry[currentLang] === 'string') return entry[currentLang];
    // Fall back to English.
    if (currentLang !== 'en') warnMissing(key, 'no ' + currentLang);
    if (typeof entry.en === 'string') return entry.en;
    return null;
  }

  /* ── Public API ───────────────────────────────────────────── */
  function t(key, vars) {
    var str = lookup(key);
    if (str == null) return key;
    return interpolate(str, vars);
  }

  // Plural helper. `key` resolves to an object of plural-form strings:
  //   { one, few, many, other } (Russian) or { one, other } (English).
  // Falls back to `other`, then to the flat string, then to the key.
  function plural(key, count, vars) {
    var entry = DICT[key];
    var forms = entry ? (entry[currentLang] || entry.en) : null;
    var allVars = Object.assign({ count: count }, vars || {});
    if (!forms) {
      warnMissing(key, 'undefined plural key');
      return String(count);
    }
    if (typeof forms === 'string') {
      // Not actually a plural map; just interpolate.
      return interpolate(forms, allVars);
    }
    var rules;
    try {
      rules = new Intl.PluralRules(currentLang === 'ru' ? 'ru' : 'en');
    } catch (e) {
      rules = null;
    }
    var category = rules ? rules.select(count) : 'other';
    var chosen = forms[category];
    if (chosen == null) chosen = forms.other;
    if (chosen == null && currentLang !== 'en' && entry.en && typeof entry.en !== 'string') {
      chosen = entry.en[category] || entry.en.other;
    }
    if (chosen == null) {
      warnMissing(key, 'no plural form "' + category + '"');
      return String(count);
    }
    return interpolate(chosen, allVars);
  }

  function getLanguage() {
    return currentLang;
  }

  function setLanguage(lang, opts) {
    var norm = normalizeLang(lang);
    if (!norm) return;
    var explicit = !(opts && opts.implicit);
    currentLang = norm;
    if (explicit) {
      explicitSelection = true;
      writeStored(norm);
    }
    document.documentElement.setAttribute('lang', norm);
    apply(document);
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](norm); } catch (e) { /* ignore */ }
    }
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  /* ── DOM application ──────────────────────────────────────── */
  function apply(root) {
    root = root || document;
    var els, i, el, key;

    els = root.querySelectorAll('[data-i18n]');
    for (i = 0; i < els.length; i++) {
      el = els[i];
      key = el.getAttribute('data-i18n');
      el.textContent = t(key);
    }

    els = root.querySelectorAll('[data-i18n-html]');
    for (i = 0; i < els.length; i++) {
      el = els[i];
      key = el.getAttribute('data-i18n-html');
      el.innerHTML = t(key);
    }

    els = root.querySelectorAll('[data-i18n-placeholder]');
    for (i = 0; i < els.length; i++) {
      el = els[i];
      key = el.getAttribute('data-i18n-placeholder');
      el.setAttribute('placeholder', t(key));
    }

    els = root.querySelectorAll('[data-i18n-aria]');
    for (i = 0; i < els.length; i++) {
      el = els[i];
      key = el.getAttribute('data-i18n-aria');
      el.setAttribute('aria-label', t(key));
    }

    els = root.querySelectorAll('[data-i18n-title]');
    for (i = 0; i < els.length; i++) {
      el = els[i];
      key = el.getAttribute('data-i18n-title');
      el.setAttribute('title', t(key));
    }

    // Localize <title> if it declares a key.
    var titleEl = document.querySelector('title[data-i18n]');
    if (titleEl && root === document) {
      document.title = t(titleEl.getAttribute('data-i18n'));
    }
  }

  /* ── Initialise ───────────────────────────────────────────── */
  currentLang = resolveInitialLang();
  document.documentElement.setAttribute('lang', currentLang);

  window.I18n = {
    t: t,
    plural: plural,
    getLanguage: getLanguage,
    setLanguage: setLanguage,
    onChange: onChange,
    apply: apply,
    supported: SUPPORTED.slice(),
    _dict: DICT
  };

  function ready() {
    apply(document);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready);
  } else {
    ready();
  }
})();
