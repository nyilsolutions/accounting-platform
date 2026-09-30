# Supported payroll states

The states payroll supports first, chosen by the product owner (open question 4):

- **Illinois**
- **Texas**
- **Florida**
- **California**
- **New York**

Every rate, wage base, table and threshold for these states lives in
`tax-data/<year>/states/<state>.json` with its source and revision date, like the federal figures
(CLAUDE.md rule 7). The state calculations are in the same tax engine as the federal one
(`apps/api/src/payroll/tax/tax-engine.ts`, ADR 0016); a licensed engine (Symmetry Tax Engine) or an
embedded payroll provider can replace it later.

## What each state needs

| State          | Income tax withholding                                                                                                                                                                                       | Unemployment (employer)                                                                                           | Other                                                                                                                                                                                            | Sources to read                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| **Illinois**   | Flat rate on wages less exemption allowances claimed on **IL-W-4** (Booklet IL-700-T)                                                                                                                        | IDES unemployment insurance: employer rate per notice, taxable wage base                                          | None statewide                                                                                                                                                                                   | tax.illinois.gov (IL-700-T, IL-W-4), ides.illinois.gov                   |
| **Texas**      | None                                                                                                                                                                                                         | TWC unemployment tax: employer rate per notice (incl. replenishment and obligation assessment), taxable wage base | None                                                                                                                                                                                             | twc.texas.gov                                                            |
| **Florida**    | None                                                                                                                                                                                                         | Reemployment tax: employer rate per notice (new-employer rate), taxable wage base                                 | None                                                                                                                                                                                             | floridarevenue.com                                                       |
| **California** | Method B (exact calculation) from the **DE 4** (or the federal W-4 when no DE 4 is filed): low-income exemption, estimated deduction, standard deduction and exemption credit tables (EDD Publication DE 44) | UI (employer rate per notice) and ETT, taxable wage base                                                          | **SDI** withheld from employees (rate, and whether a wage ceiling applies that year); supplemental wages at the state supplemental rates                                                         | edd.ca.gov (DE 44, rates and withholding schedules)                      |
| **New York**   | Exact calculation method from **IT-2104** (Publication NYS-50-T-NYS); **New York City** and **Yonkers** residents have local withholding (NYS-50-T-NYC, NYS-50-T-Y)                                          | UI: employer rate per notice, re-employment service fund, taxable wage base                                       | **Paid Family Leave** (employee rate and annual cap) and **Disability Benefits Law** (employee contribution limit); **MCTMT** for employers in the metropolitan commuter transportation district | tax.ny.gov (NYS-50-T series, NYS-50), dol.ny.gov, paidfamilyleave.ny.gov |

## What is calculated today (2026)

| State          | Calculated                                                                                                                             | Refused until sourced (`docs/open-questions.md`, item 44)                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Illinois**   | Withholding (automated method, no IL-W-4 = no allowances, bonuses at the flat rate); unemployment including 401(k) and cafeteria plans | 403(b), HSA and reimbursements for unemployment                                                       |
| **Texas**      | Unemployment, including every employee salary reduction and a company 401(k) match                                                     | Company health outside a cafeteria plan, tips, reimbursements, fringe benefits; the new-employer rate |
| **Florida**    | Reemployment tax, including cafeteria plans, 403(b) and company health and 401(k) contributions                                        | **Employee 401(k) deferrals**; company HSA; reimbursements                                            |
| **California** | Which pay counts for income tax, UI/ETT and SDI (DE 231A, DE 231EB); UI, ETT and SDI amounts                                           | **Income tax withholding (DE 44)**, so every California paycheck is refused today                     |
| **New York**   | State, New York City and Yonkers resident withholding; Paid Family Leave; unemployment and the Re-employment Service Fund              | Employee pre-tax deductions and tips for unemployment and PFL; "married, withhold at single"; MCTMT   |

The golden tests reproduce every worked example in the state booklets supplied
(`apps/api/src/payroll/tax/tax-engine.test.ts`).

Each employer's own rates (unemployment rate from the state's annual notice, workers'
compensation, NY DBL policy) are entered per company in payroll setup, not in `tax-data`.

## Local taxes

Only New York City and Yonkers resident withholding is in scope among the states above. Other local
income taxes (for example Ohio or Pennsylvania municipalities) are not, until a state that needs
them is added.

## Adding a state

1. Add `tax-data/<year>/states/<state>.json` with every figure and its source and revision date.
2. Add the state's withholding method to the tax engine (if it has income tax), its `taxableWages`
   rules, and its withholding certificate fields.
3. Add golden tests from the state's own worked examples (their withholding publications include
   examples).
4. List it here.
