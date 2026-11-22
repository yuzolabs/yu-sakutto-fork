# Page bench — mock-baseline-586254a

- Mode: mock
- Commit: `586254a4e479ac0addbf5bb9e2e343de1b46dde4`
- Started: 2026-11-22T01:13:30.730Z
- Fixtures: 8, samples per fixture: 3

| Page                           | First visible text (ms) | Viewport done (ms) | Full page (ms) | Blocks/s | Output chars | Engine |
| ------------------------------ | ----------------------: | -----------------: | -------------: | -------: | -----------: | ------ |
| long-article                   |                     150 |                575 |           1826 |       26 |         6983 | mock   |
| first-paragraph-then-long-tail |                     150 |                450 |           1450 |       20 |         5952 | mock   |
| many-cards                     |                     150 |               1126 |           1400 |     44.9 |         2614 | mock   |
| single-long-paragraph          |                     200 |               1201 |           1201 |      2.9 |         2779 | mock   |
| model-card-sidebar             |                     200 |                575 |           1125 |       44 |         2582 | mock   |
| mixed-ui                       |                     150 |                575 |           1100 |     44.1 |         1812 | mock   |
| headline-in-header             |                     175 |                425 |           1175 |     30.2 |         3733 | mock   |
| late-mount-spa                 |                     150 |               1550 |           1625 |      9.3 |         1685 | mock   |

## Headline numbers (long-article)

Engine: **mock translator** · mode `mock` · commit `586254a`

| Metric                                     | Value |
| ------------------------------------------ | ----: |
| Time to first visible translated paragraph | 0.1 s |
| Full page translated                       | 1.8 s |
| Remaining work after the first paragraph   | 1.7 s |

These are the two numbers to cite from a `live` run. Mock numbers measure the
scheduler, not the model, and must not be presented as translation speed.

Mock mode replaces the model with an in-page stub, so these durations describe
scheduling, DOM painting, batching and harness overhead — not translation speed.
They are only comparable with other mock runs.
