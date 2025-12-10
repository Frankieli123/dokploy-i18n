#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json
import re

# 品牌名列表（不翻译）
BRANDS = [
    'Dokploy', 'GitHub', 'GitLab', 'Bitbucket', 'Gitea',
    'Docker', 'Traefik', 'Redis', 'Slack', 'Telegram', 'Discord', 'Lark',
    'Hostinger', 'DigitalOcean', 'Hetzner', 'Vultr', 'Linode', 'American Cloud',
    'Ubuntu', 'Debian', 'Fedora', 'CentOS',
    'NVIDIA', 'CUDA', 'AWS', 'Cloudflare', 'Wasabi', 'Swagger',
    'OAuth', 'SMTP', 'HTTPS', 'SSL', 'SSH', 'API', 'CLI', 'VPS', 'R2', 'S3',
    'Email', 'Gotify', 'ntfy', 'Let\'s Encrypt', 'Docker Hub'
]

def contains_brand(text):
    """检查文本是否包含品牌名"""
    if not isinstance(text, str):
        return False
    text_upper = text.upper()
    for brand in BRANDS:
        if brand.upper() in text_upper:
            return True
    return False

def contains_variable(text):
    """检查文本是否包含变量（如 {{count}}, {{error}} 等）"""
    if not isinstance(text, str):
        return False
    return bool(re.search(r'\{\{[^}]+\}\}', text))

def is_english_text(text):
    """简单判断是否为英文文本（首字母大写且包含常见英文单词）"""
    if not isinstance(text, str) or not text.strip():
        return False
    # 如果包含品牌名或变量，不认为是纯英文
    if contains_brand(text) or contains_variable(text):
        return False
    # 检查是否主要是英文字符
    if text.strip()[0].isupper() and any(word in text.lower() for word in ['the', 'and', 'or', 'for', 'with', 'from', 'to', 'is', 'are', 'was', 'were', 'has', 'have', 'will', 'can', 'should', 'must', 'error', 'success', 'update', 'create', 'delete', 'select', 'enter', 'click', 'button', 'label', 'description', 'title', 'name', 'email', 'password', 'server', 'domain', 'certificate', 'provider', 'settings', 'configuration']):
        return True
    return False

# 读取文件
with open('ko/settings.json', 'r', encoding='utf-8') as f:
    ko_data = json.load(f)

with open('kz/settings.json', 'r', encoding='utf-8') as f:
    kz_data = json.load(f)

# 统计需要更新的键
updated_count = 0
needs_translation = []

for key in ko_data:
    ko_value = ko_data[key]
    kz_value = kz_data.get(key, '')
    
    # 如果 ko 中的值是英文，且 kz 中的值不同，则需要翻译
    if isinstance(ko_value, str) and ko_value:
        # 检查是否需要翻译（是英文且不包含品牌名和变量，或者 kz 中还没有翻译）
        if is_english_text(ko_value) or (kz_value and kz_value == ko_value):
            needs_translation.append((key, ko_value, kz_value))

print(f"需要翻译的键数量: {len(needs_translation)}")
print(f"\n前10个需要翻译的键:")
for i, (key, ko_val, kz_val) in enumerate(needs_translation[:10], 1):
    print(f"{i}. {key}")
    print(f"   KO (英文): {ko_val[:80]}...")
    print(f"   KZ (当前): {kz_val[:80] if kz_val else '(空)'}...")
    print()
























