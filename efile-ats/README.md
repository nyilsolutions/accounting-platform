# IRS Assurance Testing System (ATS) scenarios

Each tax year's folder holds the test returns the IRS publishes for software developers:

- the Forms 94x scenarios for Modernized e-File (MeF);
- the IRIS test scenarios for Forms 1099.

The ATS harness (`apps/api/src/efile/ats/`, ADR 0024) sends them to the IRS's test system and
reports each scenario's outcome. One scenario per file, in the `AtsScenario` shape: the filer,
the signer, and either the form's figures or the 1099 recipients.

Every file says where it comes from in `source`. The `sample-*` files were written for the
harness itself and are **not IRS scenarios**. The IRS's own scenarios are added here when the
documents are supplied (open question 74).

Run it with `pnpm --filter @acct/api ats -- --year 2026`. It refuses a transmitter that isn't in
the test environment, so ATS returns are never filed.
