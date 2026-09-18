# Legal and Product Decisions Required

Open items that cannot be decided from the repository. Each blocks some aspect of public
distribution. None is a software defect.

| # | Decision | Why it matters | Blocks |
|---|---|---|---|
| 1 | **Repository licence** — no `LICENSE` file exists | Without a licence, others have no rights to use, modify or distribute the code; "public repository" does not imply a licence | Open-sourcing; external contribution; distribution |
| 2 | **Legal entity / publisher identity** | Required as the party in terms, policy and store listings, and as data controller | Privacy policy; terms; app-store submission |
| 3 | **Jurisdiction and governing law** | Determines which privacy regime and consumer-protection law applies. Developer location does not settle this | Privacy policy; terms |
| 4 | **Distribution model** — public store, private, internal, portfolio only | Changes obligations substantially | Most legal documents |
| 5 | **Commercial status** — free, paid, subscription, non-commercial | Drives consumer-protection and payment terms | Terms |
| 6 | **Minimum age / children's data position** | Location data from minors carries specific obligations in several regimes | Privacy policy; terms; store listing |
| 7 | **Data controller identity and rights-request procedure** | Statutory rights require a named controller and a working process | Privacy policy |
| 8 | **Security reporting contact** | `SECURITY.md` currently carries a placeholder | Responsible disclosure |
| 9 | **OpenStreetMap attribution** | ODbL attribution obligations typically apply to applications using OSM-derived data | Distribution |
| 10 | **Map tile provider attribution** | Depends on the provider configured at distribution | Distribution |
| 11 | **Third-party dependency notices** | No aggregated notice file is generated today | Distribution |
| 12 | **Warranty and liability wording** | Requires jurisdiction-specific drafting | Terms; disclaimer |
| 13 | **Privacy-policy hosting location** | Stores require a reachable public URL | App-store submission |
| 14 | **Version identity reconciliation** | `package.json` is `1.0.0` while Android is `versionName 1.1.0` / `versionCode 3`; diagnostics can therefore report different versions across environments | Recommended before device qualification |

## Notes

- Items 1–3 are prerequisites for essentially every other legal question. Deciding them first
  makes the rest tractable.
- Item 14 is a product-identity decision rather than a legal one, recorded here because it affects
  what a report or store listing states.
- Nothing in this repository should be treated as legal advice. These items require a qualified
  reviewer.
