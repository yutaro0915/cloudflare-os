# Rubric: a good fix

1. **Scope**: touches only what the issue requires. No drive-by refactors, renames, or
   formatting churn. If the right fix is bigger than the issue implies, say so on the
   issue (`needs-human`) instead of doing it.
2. **Root cause**: fixes the cause, not the symptom. If you can't explain why the bug
   happened in one sentence, keep investigating before editing.
3. **Regression test**: a bug fix adds or extends a test that fails without the fix,
   when the area is testable. Say explicitly if it isn't and why.
4. **Verification**: run the targeted tests for the touched package, plus lint and type
   check (playbooks/verify-before-pr.md). Paste what you ran into the PR's Verification
   section. Unrun checks are unverified claims.
5. **Style**: match the surrounding code's idioms and comment density. Comments state
   constraints the code can't show — not narration of the change.
6. **PR shape**: one concern per PR; body = `Closes #N`, what/why in 2-4 sentences,
   Verification section.

Rule of two: if review flags the same class of problem twice, propose an addition to
this rubric in a separate small PR rather than relying on memory.
