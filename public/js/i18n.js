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
    'nav.observatory': { en: 'Observatory', ru: 'Обсерватория' },
    'nav.lab': { en: 'Translation Lab', ru: 'Переводческая лаборатория' },
    'nav.lab.short': { en: 'Lab', ru: 'Лаборатория' },
    'nav.validate': { en: 'Validate', ru: 'Проверка' },
    'nav.leaderboard': { en: 'Leaderboard', ru: 'Рейтинг' },
    'nav.about': { en: 'About & Research', ru: 'О проекте и исследованиях' },
    'nav.queue': { en: 'Review Queue', ru: 'Очередь проверки' },
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
      en: 'Source-aware · translation-first Russian→Lak search · quality-tracked',
      ru: 'С учётом источников · поиск «сначала перевод» русский→лакский · с контролем качества'
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
    'index.variety': { en: 'Variety', ru: 'Разновидность' },
    'index.variety.all': { en: 'All varieties', ru: 'Все разновидности' },
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
    'index.col.variety': { en: 'Variety', ru: 'Разновидность' },
    'index.col.review': { en: 'Review', ru: 'Проверка' },

    /* ── observatory.html ────────────────────────────────────── */
    'obs.meta.title': {
      en: 'Lak Resource Observatory · Lak Corpus Explorer',
      ru: 'Обсерватория лакских ресурсов · Обозреватель лакского корпуса'
    },
    'obs.kicker': {
      en: 'Public provenance register · 29 July 2026',
      ru: 'Публичный реестр происхождения · 29 июля 2026'
    },
    'obs.h1': { en: 'The Lak Resource Observatory', ru: 'Обсерватория лакских ресурсов' },
    'obs.intro': {
      en: 'A living map of <strong>68 non-Bible resources</strong> around the Lak language: what exists, who holds it, what can be used, and the next careful step.',
      ru: 'Живая карта <strong>68 небиблейских ресурсов</strong>, связанных с лакским языком: что существует, у кого хранится, что можно использовать и каков следующий осторожный шаг.'
    },
    'obs.statsLabel': { en: 'Registry summary', ru: 'Сводка реестра' },
    'obs.method': {
      en: '<strong>How to read this register.</strong> Evidence status describes what has been confirmed: a held or processed item is locally accounted for; verified means the source was directly checked; a verified, contact, institutional, or local lead still requires follow-up; catalog-only records and discovery portals establish existence or point onward; a confirmed gap records an evidenced absence. Public access means discoverable, not automatically reusable. Rights text is preserved from the source ledger, while “permission-sensitive” is an operational flag for acquisition work requiring explicit permission, agreement, consent, or careful copying/reproduction review—not a legal conclusion. Public viewability never implies redistribution or model-training permission. Local provenance references are deliberately not published as web links. Bible-derived materials are excluded from the registry, acquisition guidance, corpus, and model recommendations.',
      ru: '<strong>Как читать этот реестр.</strong> Статус подтверждения описывает то, что уже установлено: имеющийся или обработанный материал учтён локально; «проверено» означает, что источник был проверен напрямую; проверенная, контактная, институциональная или локальная наводка всё ещё требует дальнейшей работы; записи только по каталогу и поисковые порталы подтверждают существование или указывают путь дальше; подтверждённый пробел фиксирует доказанное отсутствие. Публичный доступ означает обнаружимость, а не автоматическую возможность повторного использования. Текст о правах сохранён из исходного реестра, а «требует разрешения» — это рабочая пометка для работы по приобретению, требующей явного разрешения, соглашения, согласия либо тщательной проверки копирования/воспроизведения, а не юридический вывод. Публичная доступность для просмотра никогда не подразумевает разрешение на распространение или обучение моделей. Локальные ссылки о происхождении намеренно не публикуются в виде веб-ссылок. Материалы, производные от Библии, исключены из реестра, рекомендаций по приобретению, корпуса и рекомендаций для моделей.'
    },
    'obs.registerLabel': { en: 'Resource register', ru: 'Реестр ресурсов' },
    'obs.searchLabel': { en: 'Search resources', ru: 'Поиск по ресурсам' },
    'obs.searchPlaceholder': {
      en: 'Title, creator, rights, action…',
      ru: 'Название, автор, права, действие…'
    },
    'obs.category': { en: 'Category', ru: 'Категория' },
    'obs.category.all': { en: 'All categories', ru: 'Все категории' },
    'obs.status': { en: 'Evidence status', ru: 'Статус подтверждения' },
    'obs.status.all': { en: 'All statuses', ru: 'Все статусы' },
    'obs.priority': { en: 'Priority', ru: 'Приоритет' },
    'obs.priority.all': { en: 'All priorities', ru: 'Все приоритеты' },
    'obs.viewsLabel': { en: 'Resource views', ru: 'Виды отображения ресурсов' },
    'obs.view.all': { en: 'All resources', ru: 'Все ресурсы' },
    'obs.view.acquisition': { en: 'Acquisition leads', ru: 'Наводки по приобретению' },
    'obs.view.contact': { en: 'Contact priorities', ru: 'Приоритеты для контакта' },
    'obs.loading': { en: 'Loading resources', ru: 'Загрузка ресурсов' },

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
      en: 'Parallel Corpus of Mountain Languages of the North-East Caucasus; 41 source files; primary prose and poetry texts. Imported in bulk; individual records have not been human-checked.',
      ru: 'Параллельный корпус горских языков Северо-Восточного Кавказа; 41 исходный файл; основные прозаические и поэтические тексты. Импортирован массово; отдельные записи не проверялись человеком.'
    },
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
    'validate.meta.title': { en: 'Validate — Lak Corpus Explorer', ru: 'Проверка — Обозреватель лакского корпуса' },
    'validate.needLogin.h1': { en: 'Join the validation effort', ru: 'Присоединяйтесь к проверке' },
    'validate.needLogin.p': {
      en: 'Validation is done by registered contributors so that every judgment can be attributed, audited, and weighted by reliability. Accounts are free; searching the corpus never requires an account.',
      ru: 'Проверку выполняют зарегистрированные участники, чтобы каждое суждение можно было атрибутировать, проверять и взвешивать по надёжности. Аккаунты бесплатны; для поиска по корпусу аккаунт никогда не требуется.'
    },
    'validate.createAccount': { en: 'Create a contributor account', ru: 'Создать аккаунт участника' },
    'validate.login': { en: 'Log in', ru: 'Войти' },
    'validate.howItWorks': { en: 'How validation works', ru: 'Как работает проверка' },
    'validate.optionsLabel': { en: 'Your assessment', ru: 'Ваша оценка' },
    'validate.details.summary': {
      en: 'Add a correction or evidence (optional, earns extra points when confirmed)',
      ru: 'Добавить исправление или доказательство (необязательно, приносит дополнительные баллы при подтверждении)'
    },
    'validate.correction.label': { en: 'Proposed correction', ru: 'Предлагаемое исправление' },
    'validate.correction.placeholder': {
      en: 'The corrected Lak text, sense, or spelling',
      ru: 'Исправленный лакский текст, значение или написание'
    },
    'validate.evidence.label': { en: 'Evidence note', ru: 'Примечание с доказательствами' },
    'validate.evidence.placeholder': {
      en: 'Why is this your answer? Context, dialect knowledge, comparison…',
      ru: 'Почему это ваш ответ? Контекст, знание диалекта, сравнение…'
    },
    'validate.source.label': { en: 'Source reference', ru: 'Ссылка на источник' },
    'validate.source.placeholder': {
      en: 'e.g. Uslar 1890, p. 42; PCMLBE 2007; native-speaker knowledge',
      ru: 'напр. Услар 1890, с. 42; PCMLBE 2007; знание носителя языка'
    },
    'validate.submit': { en: 'Submit assessment', ru: 'Отправить оценку' },
    'validate.result.title': { en: 'Community view', ru: 'Мнение сообщества' },
    'validate.next': { en: 'Next task', ru: 'Следующая задача' },
    'validate.empty.h2': { en: 'All caught up', ru: 'Всё сделано' },
    'validate.empty.p': {
      en: 'There are no open tasks for you right now. New material is added regularly — thank you for helping preserve Lak.',
      ru: 'Сейчас для вас нет открытых задач. Новый материал добавляется регулярно — спасибо, что помогаете сохранять лакский язык.'
    },

    /* ── queue.html ──────────────────────────────────────────── */
    'queue.meta.title': { en: 'Review Queue — Lak Corpus Explorer', ru: 'Очередь проверки — Обозреватель лакского корпуса' },
    'queue.h1': { en: 'Review Queue', ru: 'Очередь проверки' },
    'queue.subtitle': {
      en: 'All human reviews submitted via the corpus search. Public read access; no login required to search or export.',
      ru: 'Все проверки, выполненные людьми и отправленные через поиск по корпусу. Публичный доступ на чтение; вход для поиска или экспорта не требуется.'
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
    'profile.pairs.h2': { en: 'My translation pairs', ru: 'Мои пары перевода' },
    'profile.pairs.p': {
      en: 'Track proposals you submitted to the Translation Lab. Proposals remain unverified until independent agreement or expert adjudication.',
      ru: 'Отслеживайте предложения, отправленные в Переводческую лабораторию. Предложения остаются непроверенными до независимого согласия или экспертного решения.'
    },
    'profile.pairs.loading': { en: 'Loading translation work…', ru: 'Загрузка переводческой работы…' },
    'profile.openLab': { en: 'Open Translation Lab', ru: 'Открыть Переводческую лабораторию' },
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
    'dash.disputes.note': { en: '— your adjudication decides', ru: '— решает ваше суждение' },
    'dash.highPriority.h2': { en: 'High-priority unresolved queries', ru: 'Неразрешённые запросы высокого приоритета' },
    'dash.goldPerf.h2': { en: 'Gold-task performance', ru: 'Результаты по эталонным задачам' },
    'dash.suspicion.h2': { en: 'Suspicious activity', ru: 'Подозрительная активность' },
    'dash.appeals.h2': { en: 'Open appeals', ru: 'Открытые апелляции' },
    'dash.labPairs.h2': { en: 'Translation pairs awaiting review', ru: 'Пары перевода, ожидающие проверки' },
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
    'lab.meta.title': { en: 'Translation Lab — Lak Corpus Explorer', ru: 'Переводческая лаборатория — Обозреватель лакского корпуса' },
    'lab.authState.p': {
      en: 'You can inspect evidence without an account.',
      ru: 'Вы можете изучать доказательства без аккаунта.'
    },
    'lab.authState.link': { en: 'Log in or register', ru: 'Войти или зарегистрироваться' },
    'lab.authState.tail': {
      en: 'to save, review, or validate a translation pair.',
      ru: 'чтобы сохранить, проверить или подтвердить пару перевода.'
    },
    'lab.h1': { en: 'Translation Lab', ru: 'Переводческая лаборатория' },
    'lab.subtitle': {
      en: 'Model-assisted linguistic workbench with rigorous evidence tracking.',
      ru: 'Лингвистический верстак с помощью модели и строгим отслеживанием доказательств.'
    },
    'lab.workbench': { en: 'Workbench', ru: 'Верстак' },
    'lab.myPairs': { en: 'My Pairs', ru: 'Мои пары' },
    'lab.sourceText.label': { en: 'Source text', ru: 'Исходный текст' },
    'lab.sourceText.placeholder': { en: 'Enter Russian or Lak text...', ru: 'Введите русский или лакский текст...' },
    'lab.direction.label': { en: 'Direction', ru: 'Направление' },
    'lab.direction.ru2lak': { en: 'Russian → Lak', ru: 'Русский → Лакский' },
    'lab.direction.lak2ru': { en: 'Lak → Russian', ru: 'Лакский → Русский' },
    'lab.retrieveEvidence': { en: 'Retrieve evidence', ru: 'Найти доказательства' },
    'lab.loading': { en: 'Retrieving dictionary senses and corpus evidence…', ru: 'Извлечение словарных значений и корпусных доказательств…' },
    'lab.banner': {
      en: '<strong>Model proposal — not verified.</strong> Review, correct, and provide evidence before saving.',
      ru: '<strong>Предложение модели — не проверено.</strong> Проверьте, исправьте и приведите доказательства перед сохранением.'
    },
    'lab.literalTarget.label': { en: 'Literal target (word-for-word)', ru: 'Дословный перевод (слово в слово)' },
    'lab.naturalTarget.label': { en: 'Natural target (fluent)', ru: 'Естественный перевод (беглый)' },
    'lab.context.h3': { en: 'Linguistic Context & Evidence', ru: 'Лингвистический контекст и доказательства' },
    'lab.variety.label': { en: 'Variety', ru: 'Разновидность' },
    'lab.orthography.label': { en: 'Orthography', ru: 'Письменность' },
    'lab.orthography.cyrillic': { en: 'Cyrillic', ru: 'Кириллица' },
    'lab.orthography.latin': { en: 'Latin', ru: 'Латиница' },
    'lab.orthography.arabic': { en: 'Arabic', ru: 'Арабская' },
    'lab.sourceType.label': { en: 'Source Type', ru: 'Тип источника' },
    'lab.sourceType.human': { en: 'Human', ru: 'Человек' },
    'lab.sourceType.humanEvidence': { en: 'Human from retrieved evidence', ru: 'Человек по найденным доказательствам' },
    'lab.provenance.label': { en: 'Provenance', ru: 'Происхождение' },
    'lab.provenance.placeholder': { en: 'e.g. Fieldwork, Book title', ru: 'напр. полевая работа, название книги' },
    'lab.rights.label': { en: 'Rights Status', ru: 'Статус прав' },
    'lab.rights.publicDomain': { en: 'Public Domain', ru: 'Общественное достояние' },
    'lab.rights.ccBy': { en: 'CC-BY', ru: 'CC-BY' },
    'lab.rights.restricted': { en: 'Copyrighted / restricted', ru: 'Защищено авторским правом / ограничено' },
    'lab.rights.unknown': { en: 'Unknown', ru: 'Неизвестно' },
    'lab.access.label': { en: 'Access Status', ru: 'Статус доступа' },
    'lab.access.public': { en: 'Public', ru: 'Публичный' },
    'lab.access.restricted': { en: 'Restricted', ru: 'Ограниченный' },
    'lab.access.permissionPending': { en: 'Permission pending', ru: 'Ожидается разрешение' },
    'lab.access.private': { en: 'Private', ru: 'Приватный' },
    'lab.evidenceIds.label': { en: 'Evidence IDs (comma separated)', ru: 'ID доказательств (через запятую)' },
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
    'auth.logInSignUp': { en: 'Log in / Sign up', ru: 'Войти / Зарегистрироваться' },

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
    'search.col.variety': { en: 'Variety', ru: 'Разновидность' },
    'search.action.review': { en: 'Review', ru: 'Рецензировать' },
    'search.review.heading': { en: 'Review', ru: 'Рецензия' },
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
    'lab.evidenceRecords': { en: '{count} evidence records', ru: 'записей-доказательств: {count}' },
    'lab.abstainedBadge': { en: 'Insufficient evidence — abstained', ru: 'Недостаточно доказательств — воздержание' },
    'lab.altHeading': { en: 'Alternatives and unknowns', ru: 'Альтернативы и неизвестные' },
    'lab.noAlternative': { en: 'No supported alternative found.', ru: 'Обоснованных альтернатив не найдено.' },
    'lab.unknownLabel': { en: 'Unknown:', ru: 'Неизвестно:' },
    'lab.retrievedEvidence': { en: 'Retrieved evidence', ru: 'Найденные доказательства' },
    'lab.unspecified': { en: 'unspecified', ru: 'не указано' },
    'lab.noEvidence': { en: 'No authorized evidence found. The system has not invented a translation.', ru: 'Разрешённых доказательств не найдено. Система не придумала перевод.' },
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
    'obs.localProvenance': { en: 'Local provenance — not publicly accessible', ru: 'Локальное происхождение — недоступно публично' },
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
    'obs.resource.held_pcmlbe.action': { en: 'Preserve native annotation and source IDs; audit license.', ru: 'Сохранить исходную аннотацию и идентификаторы источника; проверить лицензию.' },
    'obs.resource.held_pcmlbe.notes': { en: 'Core grammatical-search resource; avoid flattening its annotations.', ru: 'Ключевой ресурс для грамматического поиска; не следует уплощать его аннотации.' },
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
    'validate.question.default': { en: 'Your assessment:', ru: 'Ваша оценка:' },
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
    'dashboard.adjudicate': { en: 'Adjudicate', ru: 'Вынести решение' },
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
    'dashboard.review': { en: 'Review', ru: 'Проверить' },
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
    'validate.option.unreliable_until_verified': { en: 'unreliable until verified', ru: 'ненадёжно до проверки' }
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
