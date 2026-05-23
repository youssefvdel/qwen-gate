#!/usr/bin/env python3
"""Fix duplicate line in guard.ts"""

LT = chr(60)
GT = chr(62)
BT = chr(96)

with open('src/tools/guard.ts', 'r') as f:
    lines = f.readlines()

# Find and remove lines that start with "    correctionPrompt += `Please fix"
# but keep only the complete one
new_lines = []
skip_next = False
found_good = False
for i, line in enumerate(lines):
    if 'correctionPrompt += ' in line and 'Please fix' in line:
        if BT + 'Please fix the format and retry. Use ' in line and line.rstrip().endswith(BT + ';'):
            # This is the complete line — keep it
            if not found_good:
                new_lines.append(line)
                found_good = True
            # Skip duplicates
            continue
        elif line.rstrip().endswith(BT + ';') and 'Use ' in line:
            # Complete line — keep it
            if not found_good:
                new_lines.append(line)
                found_good = True
            continue
        else:
            # Incomplete/truncated line — skip
            continue
    else:
        new_lines.append(line)

with open('src/tools/guard.ts', 'w') as f:
    f.writelines(new_lines)

print(f"Fixed! Now {len(new_lines)} lines")

# Verify the ending
for i, line in enumerate(new_lines[-10:]):
    print(f"  {len(new_lines)-10+i+1}: {repr(line[:80])}")
