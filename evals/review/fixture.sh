#!/usr/bin/env bash
# A small repo with one part to review: sumTo(n) with a seeded off-by-one, and a three-line plan (the reviewer reads the diff; this eval checks how it starts and what is recorded, D-133).
set -euo pipefail
git init -q -b main
mkdir -p src docs
printf '# Plan: sumTo\n\nPart A. `src/sum.js` exports `sumTo(n)`, the sum of the integers from 1 to n.\nAcceptance: `node test.js` prints `ok` and exits 0.\n' > docs/plan.md
printf 'module.exports = {}\n' > src/sum.js
git add docs/plan.md src/sum.js
git -c user.name=eval -c user.email=eval@example.com commit -qm init
printf '// Sum of the integers from 1 to n.\nfunction sumTo(n) {\n  let total = 0\n  for (let i = 1; i < n; i++) total += i\n  return total\n}\n\nmodule.exports = { sumTo }\n' > src/sum.js
git add src/sum.js
git -c user.name=eval -c user.email=eval@example.com commit -qm "Add sumTo"
# a cheap reviewer for the eval
mkdir -p .claude
printf '{ "roles": { "reviewer": { "model": "haiku", "effort": "low" } } }' > .claude/foreman.json
