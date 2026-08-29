#!/usr/bin/env python3
"""Count lines, functions, and complexity metrics for a file or stdin."""

import sys
import re
import os

def analyze(source: str) -> str:
    lines = source.splitlines()
    total = len(lines)
    blank = sum(1 for l in lines if not l.strip())
    comment = sum(1 for l in lines if l.strip().startswith(('#', '//', '/*', '*')))
    code = total - blank - comment

    # Rough function count (works for JS/TS/Python-ish).
    funcs = len(re.findall(r'(?:function\s+\w+|def\s+\w+|const\s+\w+\s*=\s*(?:async\s+)?\()', source))

    # Cyclomatic complexity proxy: count branching keywords.
    branches = len(re.findall(r'\b(if|else|for|while|switch|case|catch|elif|and|or)\b', source))
    complexity = branches + 1

    return f"""Lines: {total}
  Code: {code}
  Blank: {blank}
  Comment: {comment}
Functions: {funcs}
Cyclomatic complexity (proxy): {complexity}"""

def main():
    if len(sys.argv) > 1:
        path = sys.argv[1]
        if not os.path.isfile(path):
            print(f"Error: {path} is not a file", file=sys.stderr)
            sys.exit(1)
        with open(path) as f:
            source = f.read()
    else:
        source = sys.stdin.read()

    print(analyze(source))

if __name__ == '__main__':
    main()
