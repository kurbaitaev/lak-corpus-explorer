#!/usr/bin/env python3
"""Regenerate data/corpus-data.json and corpus-meta.json from the
canonical index.html at the project root.

The original minified script in index.html contains a single declaration:
    const DATA=[...], STATS={...}, ALIASES={...};
so we locate the raw byte boundaries rather than per-variable `const`
keywords.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'index.html')
OUT_DIR = os.path.join(ROOT, 'data')
DATA_OUT = os.path.join(OUT_DIR, 'corpus-data.json')
META_OUT = os.path.join(OUT_DIR, 'corpus-meta.json')


def fail(msg):
    print(f'extract-corpus: ERROR: {msg}', file=sys.stderr)
    sys.exit(1)


def main():
    if not os.path.exists(SRC):
        fail(f'canonical source not found: {SRC}')

    with open(SRC, 'rb') as f:
        raw = f.read()

    data_marker = b'const DATA='
    stats_marker = b'], STATS='
    aliases_marker = b'}, ALIASES='

    i_data = raw.find(data_marker)
    i_stats = raw.find(stats_marker)
    i_aliases = raw.find(aliases_marker)
    if min(i_data, i_stats, i_aliases) < 0:
        fail('boundary markers not found in index.html — format may have changed')
    if not (i_data < i_stats < i_aliases):
        fail('boundary markers out of order — format may have changed')

    data_bytes = raw[i_data + len(data_marker):i_stats + 1]        # include closing ]
    stats_bytes = raw[i_stats + len(stats_marker):i_aliases + 1]   # include closing }

    aliases_start = i_aliases + len(aliases_marker)
    # ALIASES strings may contain ';', so parse the object with raw_decode
    # instead of scanning for the statement terminator.
    aliases_text = raw[aliases_start:].decode('utf-8')

    try:
        data = json.loads(data_bytes)
        stats = json.loads(stats_bytes)
        aliases, _ = json.JSONDecoder().raw_decode(aliases_text)
    except json.JSONDecodeError as e:
        fail(f'extracted segment is not valid JSON: {e}')

    if not isinstance(data, list) or not data:
        fail('DATA is empty or not a list')

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(DATA_OUT, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    # Rights that have been cleared for public sources, recorded next to the
    # corpus itself so the download carries its own attribution. PCMLBE is
    # confirmed CC BY-SA 4.0: reuse requires credit to Erwin Komen / Radboud
    # University and ShareAlike redistribution.
    licenses = {
        'PCMLBE': {
            'license': 'CC BY-SA 4.0',
            'attribution': 'Dr Erwin R. Komen, Radboud University / SIL International',
            'license_url': 'https://creativecommons.org/licenses/by-sa/4.0/',
            'corpus_url': 'https://cls.ru.nl/staff/ekomen/lbe/crp/',
            'persistent_id': 'http://hdl.handle.net/21.11114/COLL-0000-0021-959C-3',
        },
    }
    with open(META_OUT, 'w', encoding='utf-8') as f:
        json.dump({'stats': stats, 'aliases': aliases, 'licenses': licenses}, f,
                  ensure_ascii=False, separators=(',', ':'))

    print(f'extract-corpus: wrote {len(data)} records to {DATA_OUT}')
    print(f'extract-corpus: wrote stats + {len(aliases)} aliases to {META_OUT}')


if __name__ == '__main__':
    main()
