#!/usr/bin/env python3
with open('src/routes/chat.ts', 'r') as f:
    lines = f.readlines()

fixed = 0
for i, line in enumerate(lines):
    stripped = line.lstrip()
    indent = line[:len(line) - len(stripped)]
    # Match lines starting with "undefined" followed by angle bracket chars
    if stripped.startswith('undefined'):
        # Reconstruct: indent + "if (vStr" + rest_of_line_after_undefined
        rest = stripped[len('undefined'):]
        lines[i] = indent + 'if (vStr' + rest
        fixed += 1
        print(f"Fixed line {i+1}")

print(f"Total fixed: {fixed}")

with open('src/routes/chat.ts', 'w') as f:
    f.writelines(lines)
