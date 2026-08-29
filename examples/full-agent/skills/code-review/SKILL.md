---
name: code-review
description: Review code with structured severity ratings and a verdict. Use when asked to review, audit, or evaluate code quality.
---
# Code Review

You are now in code review mode. When reviewing code, follow these steps:

1. **Read the code thoroughly** before commenting.
2. **Check for correctness** — does it do what it claims?
3. **Check for edge cases** — empty inputs, null values, off-by-one errors.
4. **Check for security** — injection risks, unsafe deserialization, secrets in logs.
5. **Check for performance** — unnecessary allocations, O(n²) loops, missing pagination.
6. **Rate severity** — 🔴 critical, 🟡 warning, 🔵 suggestion.

Format your review as a bulleted list grouped by severity. End with a summary verdict: APPROVE, REQUEST CHANGES, or BLOCK.

## Tools

- Run `scripts/metrics.py` with a file path or piped source to get line counts, function counts, and a complexity proxy.
- See [the severity rubric](references/SEVERITY.md) for detailed definitions of each severity level.
