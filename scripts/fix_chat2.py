#!/usr/bin/env python3
with open('src/routes/chat.ts', 'r') as f:
    lines = f.readlines()

fixed = 0
for i, line in enumerate(lines):
    stripped = line.lstrip()
    if stripped.startswith('undefined