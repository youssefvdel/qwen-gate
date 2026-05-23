#!/usr/bin/env python3
with open('src/routes/chat.ts', 'r') as f:
    lines = f.readlines()

for i, line in enumerate(lines):
    stripped = line.lstrip()
    if stripped.startswith('undefined'):
        print(f"Line {i+1}: {repr(line[:80])}")
