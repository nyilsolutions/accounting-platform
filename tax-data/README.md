# Tax data

Rates, wage bases, thresholds and tables used by the app, one folder per tax year. Code never
hard-codes these values (CLAUDE.md rule 7).

- Every file cites its sources (`sources`), and records who reviewed it (`reviewedBy`, null until a
  CPA or payroll specialist signs off).
- Add a new year by copying the previous year's files and updating values and citations. Never edit
  a past year after it has been used for filings; correct it with a note instead.

| File             | Used by                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `form-1099.json` | 1099 summary report: reporting threshold per box                                                                                                                                                  |
| `federal.json`   | Payroll: federal income tax withholding (Pub. 15-T percentage method), social security, Medicare, Additional Medicare, FUTA, supplemental wages, deposit rules, tips, taxability of payroll items |

Payroll files cite each value with its source document, revision date and page (`cite`), so a
reviewer can check every figure against the publication. State payroll files go in
`states/<state>.json` (see `docs/states.md`); parts not yet sourced are marked
`"status": "pending"` and the engine must refuse to calculate them.
