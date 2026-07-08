---
trigger: always_on
description: Hunch engineering memory — consult the hunch_* MCP tools before editing
---

<!-- HUNCH:START — auto-generated, do not edit by hand -->
## 🧠 Hunch (Engineering Memory)

This repo has **Hunch** — a curated graph of *why* the code is the way it is (decisions, bug history, invariants). It currently holds **0 decisions, 0 bugs, 0 constraints, 2 components**.

**Consult Hunch via the `hunch_*` MCP tools — pick by MOMENT, not from memory:**

**Orient (session/task start):**
- `hunch_context(target_or_task)` — the minimal relevant slice for what you're about to do; a task phrase falls back to the closest graph matches. **Call FIRST.**
- `hunch_structure(target?)` — the indexed shape of the repo/dir/file/symbol — orient from the graph, not grep rounds.
- `hunch_runbook(task)` — the proven steps for a recurring task, before re-deriving them.
- `hunch now` (CLI) — recent decisions + the live roadmap.

**Before designing / choosing an approach:**
- `hunch_why(target)` — why a file/symbol is shaped this way (decisions, bugs, constraints) — including what was already REJECTED.
- `hunch_current_decision(topic)` — the one live answer for a topic (history + rejected included).
- `hunch_bug_lineage(symptom_or_symbol)` — has this failed before? what was the root cause?
- `hunch_compare(candidates)` — rank candidate branches/commits by fewest invariant hits.
- `hunch_query(query)` — free-text search when nothing above fits.

**Before editing:**
- `hunch_check_constraints(scope)` and `hunch_get_dependents(symbol)` / `hunch_blast_radius(target)` — invariants in scope + who you'd break. (The pre-edit hook injects this per file automatically; call these for PLANNING breadth.)

**Before committing / merging:**
- `hunch_conformance()` — does the code still SATISFY recorded intent? Run before and after a refactor.
- `hunch_pr_impact(base?)` / `hunch_merge_verdict(...)` — a change's memory surface; would it re-open a closed bug?

**After deciding / when corrected:**
- `hunch_capture_decision(topic?)` → `hunch_record_decision(...)` — interview first, then write; status `proposed` = roadmap intent (shows in `hunch now`).
- `hunch_record_correction(...)` — a human correction becomes an ENFORCED rule (Never Twice), not a one-session memory.
- `hunch_timeline(target)` — decision history when investigating how something evolved.

_Hunch updates itself from commits and test failures. Records carry provenance + confidence; treat low-confidence items as advisory._
<!-- HUNCH:END -->
