#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json
from pathlib import Path

root = Path('.')
en = json.load((root / 'en' / 'common.json').open(encoding='utf-8'))
ai_keys = [k for k in en if k.startswith('ai.')]

langs = ['nl','pl','tr','ko','uk','fa','no','kz','id','ml','az']
print('需要翻译的语言:')
print('='*50)
for lang in langs:
    if (root / lang / 'common.json').exists():
        data = json.load((root / lang / 'common.json').open(encoding='utf-8'))
        needs_trans = [k for k in ai_keys if k in data and data[k] == en[k]]
        print(f'{lang}: {len(needs_trans)} keys')

