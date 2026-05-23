#!/usr/bin/env python3
"""Fix corrupted lines in chat.ts"""

with open('src/routes/chat.ts', 'r') as f:
    content = f.read()

# Fix corrupted lines: "undefined