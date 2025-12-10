#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json
from pathlib import Path

root = Path('.')
en = json.load((root / 'en' / 'common.json').open(encoding='utf-8'))
ai_keys = sorted([k for k in en if k.startswith('ai.')])

print(f'Total AI keys: {len(ai_keys)}\n')
print('='*70)

langs = ['zh-Hans', 'zh-Hant', 'fr', 'de', 'es', 'ja', 'ru', 'it', 'pt-br', 'nl', 'pl', 'tr', 'ko', 'uk', 'fa', 'no', 'kz', 'id', 'ml', 'az']

for lang in langs:
    if not (root / lang / 'common.json').exists():
        continue
    
    data = json.load((root / lang / 'common.json').open(encoding='utf-8'))
    untranslated = []
    
    for key in ai_keys:
        if key in data and data[key] == en[key]:
            untranslated.append(key)
    
    if untranslated:
        print(f'\n{lang}: {len(untranslated)} untranslated keys')
        if len(untranslated) <= 10:
            for k in untranslated:
                print(f'  - {k}')
        else:
            for k in untranslated[:10]:
                print(f'  - {k}')
            print(f'  ... and {len(untranslated) - 10} more')

