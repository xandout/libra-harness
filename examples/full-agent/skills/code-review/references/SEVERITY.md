# Severity Rubric

## 🔴 Critical
- Security vulnerabilities (injection, auth bypass, data leak)
- Data loss or corruption
- Crashes or unhandled exceptions on valid input
- Logic errors that produce wrong results

## 🟡 Warning
- Edge cases that produce unexpected but non-crashing behavior
- Missing input validation
- Race conditions
- Resource leaks (file handles, connections)
- Deprecated API usage

## 🔵 Suggestion
- Code style and readability improvements
- Performance optimizations (non-critical)
- Documentation gaps
- Alternative approaches worth considering
- Test coverage suggestions
