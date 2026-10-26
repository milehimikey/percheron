# percheron

A portable **engagement harness**: drive large work-graphs to completion with agents —
derived graphs (never hand-drawn), evidence-gated loops (deterministic checks > typed
judges > LLM review, never the reverse), bounded retries, and humans as durable interrupts
— over any agent harness, local or cloud.

Named for the draft workhorse breed: the animal harnesses exist for, and they pull in teams.

**Status: in design.** This package reserves the name. The spec format, component
architecture, and build plan exist as working documents; code lands here when the BUILD
phase starts. First work provider: [em](https://github.com/milehimikey/em) (event modeling)
— an event model with hundreds of slices is the canonical use case — but providers are
pluggable and percheron is not em-specific.
