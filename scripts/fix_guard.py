#!/usr/bin/env python3
"""Fix truncated guard.ts"""

LT = chr(60)
GT = chr(62)
BT = chr(96)

# Read the file
with open('src/tools/guard.ts', 'r') as f:
    content = f.read()

# Find and remove the truncated line at the end
lines = content.split('\n')
# Remove the last line if it's truncated
while lines and lines[-1].strip().startswith('correctionPrompt +='):
    lines.pop()
while lines and lines[-1].strip() == '':
    lines.pop()

# Add the proper ending
ending = f"""    correctionPrompt += {BT}Please fix the format and retry. Use {LT}tool_call{GT} tags with raw JSON inside.{BT};
  }}

  return {{
    valid: errors.length === 0 ? [tc] : [],
    errors,
    correctionPrompt,
    ok: errors.length === 0,
  }};
}}
"""

result = '\n'.join(lines) + '\n' + ending

with open('src/tools/guard.ts', 'w') as f:
    f.write(result)

print("Fixed guard.ts!")
print(f"File now has {result.count(chr(10))} lines")
