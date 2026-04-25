# AGENT

Read `specs/`.
Read `specs/roadmap.csv`.

Order:

1. `specs/roadmap.csv`
2. `00-domains/`
3. `01-features/`
4. `02-requirements/`

Low number = more global.
High number = more concrete.

Do not jump.
Read from low to high.

If conflict:
lower folder wins.

`roadmap.csv` is registry.
Keep it in sync.

When spec changes:
update `roadmap.csv`.

When implementation changes:
update `roadmap.csv`.

Use roadmap columns:

`status`:
- `todo`
- `in_progress`
- `done`

`priority`:
- `a` critical
- `b` important
- `c` nice to have

Priority order:
`a` > `b` > `c`

`blocked_by`:
- empty = can do now
- ids = wait first

Pick next work like this:

1. not blocked
2. highest priority
3. most concrete item

Johnny Decimal idea:

Domain:
`xx`

Feature:
`domain-id.xx`

Requirement:
`domain-id.feature-id.xx`

Name after id:
short slug
lowercase
dash words

Example:

- `00-update`
- `00.00-update-on-start`
- `00.00.00-update-global-install-only`
