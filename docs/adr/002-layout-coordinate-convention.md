# ADR-002: Use directed 3-terminal installation lines

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-06-29 |

## Decision

Each supply or return group has one directed installation line and one offset
direction. For line midpoint `m`, normalized line direction `d`, normalized
offset direction `o`, candidate spacing `s`, and candidate offset `q`:

```text
anchor = m + q × o
terminal[0] = anchor - s × d
terminal[1] = anchor
terminal[2] = anchor + s × d
```

Supply and return groups use independent spacing and offset variables. Terminal
order is always `-s`, `0`, `+s`. Candidate IDs hash the role and canonical
nine-decimal coordinates in that order.

Room-local axes are `(x, y, z) = (length, width, height)`. All terminal centres
must remain within room bounds after footprint clearance, and every pair of
terminal footprints must satisfy the minimum edge clearance.

## Consequences

- The active template is exactly 3+3, not the historical 4+4 grid.
- Four scalar variables completely determine a candidate.
- Coordinate generation, candidate selection, and IDs are deterministic.
- Arbitrary counts, asymmetric movement, and curved installation paths are
  deferred.
