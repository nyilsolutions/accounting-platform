# Supported payroll states

The states payroll supports first, chosen by the product owner (open question 4):

- **Illinois**
- **Texas**
- **Florida**
- **California**
- **New York**

Every rate, wage base, table and threshold for these states lives in
`tax-data/<year>/states/<state>.json` with its source and revision date, like the federal figures
(CLAUDE.md rule 7). The state implementations sit behind the same `TaxEngine` interface as the
federal one, so a licensed engine (Symmetry Tax Engine) or an embedded payroll provider can replace
them later.

## What each state needs

| State          | Income tax withholding                                                                                                                                                                                       | Unemployment (employer)                                                                                           | Other                                                                                                                                                                                            | Sources to read                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| **Illinois**   | Flat rate on wages less exemption allowances claimed on **IL-W-4** (Booklet IL-700-T)                                                                                                                        | IDES unemployment insurance: employer rate per notice, taxable wage base                                          | None statewide                                                                                                                                                                                   | tax.illinois.gov (IL-700-T, IL-W-4), ides.illinois.gov                   |
| **Texas**      | None                                                                                                                                                                                                         | TWC unemployment tax: employer rate per notice (incl. replenishment and obligation assessment), taxable wage base | None                                                                                                                                                                                             | twc.texas.gov                                                            |
| **Florida**    | None                                                                                                                                                                                                         | Reemployment tax: employer rate per notice (new-employer rate), taxable wage base                                 | None                                                                                                                                                                                             | floridarevenue.com                                                       |
| **California** | Method B (exact calculation) from the **DE 4** (or the federal W-4 when no DE 4 is filed): low-income exemption, estimated deduction, standard deduction and exemption credit tables (EDD Publication DE 44) | UI (employer rate per notice) and ETT, taxable wage base                                                          | **SDI** withheld from employees (rate, and whether a wage ceiling applies that year); supplemental wages at the state supplemental rates                                                         | edd.ca.gov (DE 44, rates and withholding schedules)                      |
| **New York**   | Exact calculation method from **IT-2104** (Publication NYS-50-T-NYS); **New York City** and **Yonkers** residents have local withholding (NYS-50-T-NYC, NYS-50-T-Y)                                          | UI: employer rate per notice, re-employment service fund, taxable wage base                                       | **Paid Family Leave** (employee rate and annual cap) and **Disability Benefits Law** (employee contribution limit); **MCTMT** for employers in the metropolitan commuter transportation district | tax.ny.gov (NYS-50-T series, NYS-50), dol.ny.gov, paidfamilyleave.ny.gov |

Each employer's own rates (unemployment rate from the state's annual notice, workers'
compensation, NY DBL policy) are entered per company in payroll setup, not in `tax-data`.

## Local taxes

Only New York City and Yonkers resident withholding is in scope among the states above. Other local
income taxes (for example Ohio or Pennsylvania municipalities) are not, until a state that needs
them is added.

## Adding a state

1. Add `tax-data/<year>/states/<state>.json` with every figure and its source and revision date.
2. Implement the state's `StateTaxCalculator` behind `TaxEngine`, and its withholding certificate
   fields.
3. Add golden tests from the state's own worked examples (their withholding publications include
   examples).
4. List it here.
