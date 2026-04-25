# Orchestration

App coordinates AI tools through local workflow config.

Goal:
run repeatable agent workflows from one CLI.

`.aio/` stores orchestration only.
Project knowledge stays in project files.

Workflows must remain observable and bounded.
Long-running agent projects need visible progress, user attention signals, and
usage controls so automation does not silently exhaust context windows or user
subscriptions.
