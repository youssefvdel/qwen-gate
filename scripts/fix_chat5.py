#!/usr/bin/env python3
"""Replace corrupted logging block in chat.ts"""

# Build the strings using chr() to avoid angle bracket issues
LT = chr(60)   # <
GT = chr(62)   # >

tool_call_open = LT + 'tool_call' + GT
tool_call_close = LT + '/tool_call' + GT

with open('src/routes/chat.ts', 'r') as f:
    lines = f.readlines()

# Find the first corrupted line
start_idx = None
end_idx = None
for i, line in enumerate(lines):
    stripped = line.lstrip()
    if stripped.startswith('if (vStr') and ('undefined' in stripped or tool_call_open in stripped):
        if start_idx is None:
            start_idx = i
    if start_idx is not None and i > start_idx + 5:
        break

# Find the end of the corrupted block (the line before the DEBUG line)
for i in range(start_idx, min(start_idx + 10, len(lines))):
    if 'process.env.DEBUG' in lines[i]:
        end_idx = i
        break

print(f"Corrupted block: lines {start_idx+1} to {end_idx}")
print(f"Lines to replace:")
for i in range(start_idx, end_idx):
    print(f"  {i+1}: {repr(lines[i][:80])}")

# Build the replacement (single merged if block)
q = chr(39)  # single quote
indent = '                '
line1 = indent + 'if (vStr.includes(' + q + tool_call_open + q + ') || vStr.includes(' + q + tool_call_close + q + ') || vStr.includes(' + q + '"name"' + q + ') || vStr.includes(' + q + '{' + q + ')) {\n'
line2 = indent + '  logStore.addRawChunk(logId, vStr);\n'
line3 = indent + '  logStore.updateEntry(logId, entry => { entry.rawFullContent += vStr; });\n'
line4 = indent + '}\n'

replacement = [line1, line2, line3, line4]

# Replace
new_lines = lines[:start_idx] + replacement + lines[end_idx:]

with open('src/routes/chat.ts', 'w') as f:
    f.writelines(new_lines)

print("Fixed!")
