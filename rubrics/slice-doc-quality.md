# Rubric: slice-doc-quality

How well the implementation serves the slice doc as a reader would check it. Score each
criterion from 0 to 1 with evidence.

| Id | Criterion |
|---|---|
| `fields` | Every field in the doc's field table exists in the code with the doc's name and type, and nothing is invented beyond the table. |
| `invariants` | Every INV id in the doc is cited by at least one test whose body exercises that invariant. |
| `scenarios` | Every Given/When/Then scenario in the doc has a test of its own that asserts the Then. |
| `isolation` | The diff stays inside this slice's package and its tests; no other slice, shared infrastructure, model or doc file is touched. |
| `idiom` | Layout, naming and wiring follow the project rules and the neighbouring implemented slices of the same pattern. |
| `observability` | Each applied event or handled command leaves one log line keyed by ids, with no personal data, as the project rules require. |
| `honesty` | The evidence map and continuation note describe what was actually built and what was not run, with no claim the diff does not support. |
