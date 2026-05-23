#!/usr/bin/env python3
"""
Replace the corrupted logging block in chat.ts non-streaming path.
Lines 433-438 are corrupted. Replace with clean merged logging block.
"""
with open('src/routes/chat.ts', 'r') as f:
    lines = f.readlines()

# The correct replacement for lines 433-438 (0-indexed: 432-437)
# These 6 lines need to be replaced with the fixed logging code
replacement = [
    '                if (vStr.includes(' + repr('