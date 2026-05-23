#!/usr/bin/env python3
with open('src/routes/chat.ts', 'r') as f:
    lines = f.readlines()

for i in [432, 433, 434, 435, 436, 437]:
    print(f"Line {i+1}: {repr(lines[i][:100])}")
