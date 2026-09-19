# Генерация статических языковых версий лендинга.
#
# Зачем: переводы на сайте подставляются скриптом на одном и том же адресе.
# Google такой сайт кое-как отрендерит, Яндекс — почти наверняка нет, и в обоих
# случаях EN/KZ-версии не получают собственных URL, а значит не индексируются.
# Скрипт разворачивает словарь в готовый HTML и раскладывает по /en/ и /kz/.
#
# Запуск:  python tools/build-langs.py     (из корня проекта, перед деплоем)

import io, sys, os, re, json, shutil

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'index.html')
SITE = 'https://smarthub-kz.com'

# Дата последнего содержательного изменения страниц, для <lastmod> в sitemap.
# НЕ дата сборки: lastmod, который меняется на каждый деплой, поисковик
# перестаёт учитывать — он видит «изменение» без единой правки текста.
# Правьте вручную вместе с содержимым.
LASTMOD = '2026-09-19'

# lang -> (папка, значение атрибута lang, og:locale)
# путь в URL (без завершающего слэша — в vercel.json trailingSlash:false),
# папка для файла, значение <html lang>, og:locale
TARGETS = {
    'ru': ('',    '',   'ru', 'ru_KZ'),
    'en': ('en',  'en', 'en', 'en_US'),
    'kz': ('kz',  'kz', 'kk', 'kk_KZ'),
}

source = open(SRC, encoding='utf-8', newline='').read()


# ── словари из самой страницы, чтобы не держать перевод в двух местах ──
def dict_of(lang):
    m = re.search(r'\n\s*' + lang + r':\s*\{', source)
    i = source.index('{', m.start())
    depth = 0
    for j in range(i, len(source)):
        if source[j] == '{':
            depth += 1
        elif source[j] == '}':
            depth -= 1
            if depth == 0:
                return json.loads(source[i:j + 1])
    raise RuntimeError('словарь ' + lang + ' не найден')


DICTS = {l: dict_of(l) for l in TARGETS}

TITLES = dict(re.findall(r'(\w+):\s*"((?:[^"\\]|\\.)*)"',
                         re.search(r'const titles = \{(.*?)\};', source, re.S).group(1)))


# ── замена содержимого элементов с data-i18n ──
OPEN_TAG = re.compile(r'<([a-zA-Z][\w-]*)\b[^>]*?\sdata-i18n="([^"]+)"[^>]*>')


def close_of(html, tag, start):
    """Ищет закрывающий тег с учётом вложенности одноимённых."""
    depth = 1
    i = start
    op = re.compile(r'<' + tag + r'\b', re.I)
    cl = re.compile(r'</' + tag + r'\s*>', re.I)
    while True:
        mo = op.search(html, i)
        mc = cl.search(html, i)
        if not mc:
            return None
        if mo and mo.start() < mc.start():
            depth += 1
            i = mo.end()
        else:
            depth -= 1
            if depth == 0:
                return mc.start()
            i = mc.end()


def translate(html, dic):
    spans, missing, end_of_prev = [], [], -1
    for m in OPEN_TAG.finditer(html):
        if m.start() < end_of_prev:        # вложенный — внешний уже заменит
            continue
        tag, key = m.group(1), m.group(2)
        close = close_of(html, tag, m.end())
        if close is None:
            continue
        if key not in dic:
            missing.append(key)
            continue
        spans.append((m.end(), close, dic[key]))
        end_of_prev = close

    out, pos = [], 0
    for a, b, value in spans:
        out.append(html[pos:a]); out.append(value); pos = b
    out.append(html[pos:])
    return ''.join(out), len(spans), missing


def translate_placeholders(html, dic):
    def sub(m):
        key = m.group(2)
        if key not in dic:
            return m.group(0)
        return re.sub(r'placeholder="[^"]*"',
                      'placeholder="' + dic[key].replace('"', '&quot;') + '"',
                      m.group(0))
    return re.subn(r'<(input|textarea)\b[^>]*?data-i18n-ph="([^"]+)"[^>]*>', sub, html)


# ── head: canonical, og, hreflang ──
def alternates():
    rows = ['  <link rel="alternate" hreflang="x-default" href="%s/">' % SITE]
    for lang, (path, _, _, _) in TARGETS.items():
        code = {'ru': 'ru', 'en': 'en', 'kz': 'kk'}[lang]
        rows.append('  <link rel="alternate" hreflang="%s" href="%s/%s">' % (code, SITE, path))
    return '\r\n'.join(rows)


# ── микроразметка вопросов ────────────────────────────────────────────
# FAQPage строится из того же словаря, что подставляется в видимую секцию
# #faq, — значит вопросы и ответы в разметке дословно совпадают с тем, что
# читает посетитель. Это единственное условие, при котором FAQ-разметку
# вообще можно отдавать: ответы, которых нет на странице, Google в лучшем
# случае игнорирует, в худшем — снимает расширенные сниппеты со всего сайта.
def faq_graph(lang):
    dic = DICTS[lang]
    items = []
    i = 1
    while ('faq.q%d' % i) in dic and ('faq.a%d' % i) in dic:
        items.append({
            '@type': 'Question',
            'name': dic['faq.q%d' % i],
            'acceptedAnswer': {'@type': 'Answer', 'text': dic['faq.a%d' % i]},
        })
        i += 1
    if not items:
        return []

    path = TARGETS[lang][0]
    url = '%s/%s' % (SITE, path)
    code = {'ru': 'ru', 'en': 'en', 'kz': 'kk'}[lang]
    # <h2> секции содержит <span class='hl'>, в имя крошки разметка не идёт.
    return [
        {
            '@type': 'WebPage',
            '@id': url + '#webpage',
            'url': url,
            'name': TITLES.get(lang, ''),
            'description': dic.get('seo.desc', ''),
            'inLanguage': code,
            'isPartOf': {'@id': SITE + '/#website'},
            'about': {'@id': SITE + '/#organization'},
            'primaryImageOfPage': SITE + '/assets/og-image.jpg?v=2',
            'breadcrumb': {'@id': url + '#breadcrumb'},
        },
        {
            '@type': 'BreadcrumbList',
            '@id': url + '#breadcrumb',
            'itemListElement': [
                {'@type': 'ListItem', 'position': 1, 'name': 'SmartHub', 'item': url},
            ],
        },
        {
            '@type': 'FAQPage',
            '@id': url + '#faq',
            'inLanguage': code,
            'isPartOf': {'@id': url + '#webpage'},
            'mainEntity': items,
        },
    ]


def faq_block(lang):
    nodes = faq_graph(lang)
    if not nodes:
        return ''
    doc = {'@context': 'https://schema.org', '@graph': nodes}
    body = json.dumps(doc, ensure_ascii=False, indent=2)
    return ('<script type="application/ld+json" id="ld-page">\r\n'
            + body.replace('\n', '\r\n') + '\r\n</script>\r\n')


def retarget_head(html, lang):
    path, folder, lang_attr, locale = TARGETS[lang]
    url = '%s/%s' % (SITE, path)
    dic = DICTS[lang]

    html = html.replace('<html lang="ru">', '<html lang="%s">' % lang_attr, 1)
    html = re.sub(r'<title>.*?</title>',
                  lambda m: '<title>%s</title>' % TITLES.get(lang, ''), html, count=1, flags=re.S)
    html = html.replace('<link rel="canonical" href="%s/">' % SITE,
                        '<link rel="canonical" href="%s">' % url, 1)
    html = html.replace('<meta property="og:url" content="%s/">' % SITE,
                        '<meta property="og:url" content="%s">' % url, 1)
    html = html.replace('<meta property="og:locale" content="ru_KZ">',
                        '<meta property="og:locale" content="%s">' % locale, 1)

    # og:locale:alternate — ОСТАЛЬНЫЕ языки, а не скопированный из русской
    # версии список. Раньше он переносился дословно, поэтому /en объявлял
    # своей альтернативой en_US (сам себя) и вовсе не упоминал ru_KZ.
    others = [TARGETS[l][3] for l in TARGETS if l != lang]
    html = re.sub(
        r'(?:[ \t]*<meta property="og:locale:alternate" content="[^"]*">\r?\n)+',
        lambda m: ''.join('  <meta property="og:locale:alternate" content="%s">\r\n' % o
                          for o in others),
        html, count=1)

    # geo.placename в латинице для английской версии: в остальных двух город
    # называется кириллицей, и подставлять её в англоязычную страницу незачем.
    if lang == 'en':
        html = html.replace('<meta name="geo.placename" content="Астана">',
                            '<meta name="geo.placename" content="Astana">', 1)

    # описание и og:title берём из словаря, если ключи заданы
    if 'seo.desc' in dic:
        html = re.sub(r'(<meta name="description" content=")[^"]*(")',
                      lambda m: m.group(1) + dic['seo.desc'] + m.group(2), html, count=1)
        for prop in ('og:description', 'twitter:description'):
            html = re.sub(r'((?:property|name)="%s" content=")[^"]*(")' % prop,
                          lambda m: m.group(1) + dic['seo.desc'] + m.group(2), html, count=1)
    if 'seo.ogtitle' in dic:
        for prop in ('og:title', 'twitter:title'):
            html = re.sub(r'((?:property|name)="%s" content=")[^"]*(")' % prop,
                          lambda m: m.group(1) + dic['seo.ogtitle'] + m.group(2), html, count=1)

    # hreflang: сначала сносим прошлый блок, потом ставим свежий.
    # Скрипт читает index.html, который сам же и перезаписывает, — без этой
    # чистки старые адреса накапливались бы от запуска к запуску.
    html = re.sub(r'[ \t]*<link rel="alternate" hreflang="[^"]*" href="[^"]*">\r?\n', '', html)
    marker = '<link rel="canonical" href="%s">' % url
    assert marker in html, 'canonical для %s не найден' % lang
    html = html.replace(marker, marker + '\r\n' + alternates(), 1)

    # Разметка страницы (WebPage + BreadcrumbList + FAQPage) на нужном языке.
    # Сначала сносим блок прошлой сборки: скрипт читает index.html, который сам
    # же перезаписывает, иначе блоки копились бы от запуска к запуску.
    html = re.sub(r'[ \t]*<script type="application/ld\+json" id="ld-page">[\s\S]*?</script>\r?\n',
                  '', html)
    block = faq_block(lang)
    if block:
        assert '</body>' in html, 'нет </body> у %s' % lang
        html = html.replace('</body>', block + '</body>', 1)
    return html


def build(lang):
    html = source
    if lang != 'ru':
        html, n, missing = translate(html, DICTS[lang])
        html, np = translate_placeholders(html, DICTS[lang])
    else:
        n, np, missing = 0, 0, []
    html = retarget_head(html, lang)

    folder = TARGETS[lang][1]
    out_dir = os.path.join(ROOT, folder.rstrip('/')) if folder else ROOT
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, 'index.html')
    open(path, 'w', encoding='utf-8', newline='').write(html)

    rel = (folder + '/' if folder else '') + 'index.html'
    print('  %-14s элементов %-4s плейсхолдеров %-3s %s' %
          (rel, n or '—', np or '—', ('НЕТ КЛЮЧЕЙ: ' + ', '.join(missing[:5])) if missing else ''))
    return path


print('Сборка языковых версий:')
for lang in ('ru', 'en', 'kz'):
    build(lang)

# ── sitemap со всеми языками ──
pages = []
for lang, (path, _, _, _) in TARGETS.items():
    alts = '\n'.join(
        '      <xhtml:link rel="alternate" hreflang="%s" href="%s/%s"/>' %
        ({'ru': 'ru', 'en': 'en', 'kz': 'kk'}[l], SITE, TARGETS[l][0])
        for l in TARGETS)
    pages.append(
        '  <url>\n'
        '    <loc>%s/%s</loc>\n'
        '%s\n'
        '      <xhtml:link rel="alternate" hreflang="x-default" href="%s/"/>\n'
        '    <lastmod>%s</lastmod>\n'
        '    <changefreq>weekly</changefreq>\n'
        '    <priority>%s</priority>\n'
        '  </url>' % (SITE, path, alts, SITE, LASTMOD, '1.0' if lang == 'ru' else '0.9'))

pages.append(
    '  <url>\n'
    '    <loc>%s/privacy</loc>\n'
    '    <lastmod>%s</lastmod>\n'
    '    <changefreq>yearly</changefreq>\n'
    '    <priority>0.3</priority>\n'
    '  </url>' % (SITE, LASTMOD))

sitemap = ('<?xml version="1.0" encoding="UTF-8"?>\n'
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n'
           '        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n'
           + '\n'.join(pages) + '\n</urlset>\n')
open(os.path.join(ROOT, 'sitemap.xml'), 'w', encoding='utf-8').write(sitemap)
print('  sitemap.xml   страниц %d' % (len(TARGETS) + 1))
print('Готово.')
