# Cloud Migration Readiness Assessment

Version 4.2 · Platform Engineering Practice

## Purpose

This assessment establishes whether an application estate is ready to begin a
migration wave, and where the residual risk sits. It is designed to be delivered as
a facilitated conversation with a technical lead and a service owner present
together, typically over ninety minutes.

## Domain 1 — Estate and inventory

1. How many applications are in the estate in scope for this wave?
2. Where does the authoritative inventory live, and who maintains it?
3. What proportion of applications have a named service owner today?
4. How current is the dependency map between applications?
5. Which application in scope has the least well understood dependencies?

## Domain 2 — Architecture and coupling

6. Describe the most common architectural pattern across the estate.
7. Where does shared state live between applications?
8. Which integrations cross a trust boundary?
9. What in the estate assumes a fixed IP address or hostname?
10. How much of the estate could tolerate being restarted without coordination?

## Domain 3 — Data

11. Where does the largest data store in scope sit, and how big is it?
12. What is the tolerable data loss window for the most sensitive store?
13. Which data in scope is subject to a residency or sovereignty constraint?
14. How is data classified today, and by whom?

## Domain 4 — Operability

15. How is the estate monitored, and who receives the alerts?
16. What does the on-call rota look like for the applications in scope?
17. How long does a typical change take from merge to production?
18. What is your current mean time to restore for a severity-one incident?

## Domain 5 — Security posture

19. How is access to production granted and reviewed?
20. Where do secrets live today?
21. When did this estate last have an independent security assessment?
22. What compensating controls exist for the least well patched component?

## Domain 6 — Financial management

23. What is the current annual run cost of the estate in scope?
24. How is that cost attributed back to services or business units?
25. Who approves a change in run rate, and at what threshold?

## Domain 7 — Regulatory and audit

26. Which regulatory regimes apply to any application in scope?
27. What evidence does your auditor currently expect, and how is it produced?
28. What would a migration change about that evidence?

## Domain 8 — Legacy and end-of-life

29. What in scope runs on an unsupported operating system or runtime?
30. Who understands the oldest component well enough to change it?
31. What is the plan for that component if the person who knows it leaves?

## Domain 9 — Organisational readiness

32. How much cloud delivery experience sits inside the team today?
33. What has this organisation migrated before, and how did it go?
34. Who will say no if the wave should be stopped?

## Domain 10 — Wrap-up

35. What worries you most about this wave?
36. What would make you confident enough to start next month?

---

## Appendix A — Glossary

**Wave** — a batch of applications migrated together under a single cutover plan.
**Estate** — the total set of applications owned by the requesting organisation.
**Trust boundary** — the line across which authentication is required.

## Appendix B — Scoring notes

Each domain is scored 1–5. Domain scores are not averaged: the readiness verdict
takes the lowest scoring domain as the binding constraint, on the basis that a wave
fails at its weakest point rather than its mean.

## Appendix C — Routing notes

Not every domain applies to every engagement, and asking all ten of a small estate
produces a long conversation and a thin assessment. Use the following:

- Domains 1, 2, 4 and 10 are asked in every engagement without exception.
- Ask Domain 3 only where the estate holds a persistent data store the client
  operates themselves.
- Ask Domain 5 only where the client has told us they hold personal or payment data.
- Ask Domain 6 only where the engagement was commissioned with a cost-reduction
  objective.
- Ask Domain 7 only where the client operates in a regulated sector.
- Ask Domain 8 only where any component in scope is already out of vendor support.
- Ask Domain 9 only where this is the client's first migration wave.

Cover no more than four of the situational domains in a single session. Where more
than four would apply, take the four the service owner ranks highest and record the
remainder as deferred.
