-- Sales tax on foreign-currency documents (ADR 0020, open question 63, decided 2026-09-30).
--
-- The tax is calculated in the document's currency and recorded in US dollars at the document's
-- rate: taxable_amount and amount stay in US dollars (so each agency's liability ties to Sales
-- Tax Payable); the amounts in the document's currency are kept for the document itself.

alter table sales_tax_lines
  add column foreign_taxable_amount numeric(19,4),
  add column foreign_amount numeric(19,4),
  add constraint sales_tax_lines_foreign_pair
    check ((foreign_taxable_amount is null) = (foreign_amount is null));
