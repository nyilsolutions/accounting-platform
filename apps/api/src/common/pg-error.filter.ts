import { ArgumentsHost, Catch, HttpStatus, Logger, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { DatabaseError } from 'pg';

/** User-facing messages for unique constraints, keyed by index name. */
const UNIQUE_MESSAGES: Record<string, string> = {
  data_exports_open_key: 'An export is already being prepared. Wait for it to finish.',
  pay_runs_regular_period_key: 'This pay period already has a regular pay run',
  paychecks_pay_run_id_employee_id_key: 'This employee is already in the pay run',
  ach_batches_pay_run_key: 'A direct deposit file was already created for this pay run',
  accounts_name_key: 'An account with this name already exists at this level',
  accounts_number_key: 'This account number is already in use',
  accounts_system_role_key: 'This company already has that system account',
  customers_name_key: 'A customer with this name already exists',
  vendors_name_key: 'A vendor with this name already exists',
  items_name_key: 'A product or service with this name already exists',
  items_sku_key: 'This SKU is already in use',
  terms_name_key: 'Terms with this name already exist',
  classes_name_key: 'A class with this name already exists at this level',
  locations_name_key: 'A location with this name already exists at this level',
  payment_methods_name_key: 'A payment method with this name already exists',
  transactions_doc_number_key: 'This number is already used by another document of this type',
  estimates_number_key: 'This estimate number is already in use',
  deposit_lines_source_key: 'This payment is already in another deposit',
  purchase_orders_number_key: 'This purchase order number is already in use',
  payment_applications_payment_id_target_id_key: 'This invoice is listed twice on the payment',
  reconciliations_in_progress_key: 'A reconciliation of this account is already in progress',
  bank_feed_accounts_account_key: 'That account is already connected to another bank account',
  bank_feed_connections_item_key: 'This bank login is already connected',
  bank_rules_name_key: 'A bank rule with this name already exists',
  bank_feed_transactions_account_id_external_id_key: 'This bank transaction was already imported',
  tax_agencies_name_key: 'A sales tax agency with this name already exists',
  tax_rates_name_key: 'A sales tax rate with this name already exists',
  budgets_name_key: 'A budget with this name already exists',
  budget_amounts_key: 'An account is listed twice in the budget',
  memorized_reports_name_key: 'You already have a memorized report with this name',
  payroll_settings_pkey: 'Payroll is already set up for this company',
  pay_schedules_name_key: 'A pay schedule with this name already exists',
  payroll_state_registrations_company_id_state_key: 'This state is already set up for payroll',
  workers_comp_classes_code_key:
    "A workers' comp class with this code already exists in this state",
  pto_policies_name_key: 'A PTO policy with this name already exists',
  payroll_items_name_key: 'A payroll item with this name already exists',
  employees_number_key: 'This employee number is already in use',
  employee_w4_employee_id_effective_from_key: 'A Form W-4 already starts on this date',
  employee_state_certificates_employee_id_state_effective_from_key:
    'A certificate for this state already starts on this date',
  employee_pto_pkey: 'A PTO policy is listed twice',
};

/**
 * Maps database constraint errors that reach the API into clean HTTP responses. Services
 * validate first; this is the backstop for races and database-enforced rules.
 */
@Catch(DatabaseError)
export class PgErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('Database');

  catch(err: DatabaseError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const send = (status: number, message: string, code?: string): void => {
      res.status(status).json({ statusCode: status, message, ...(code ? { code } : {}) });
    };

    switch (err.code) {
      case '23505':
        return send(
          HttpStatus.CONFLICT,
          UNIQUE_MESSAGES[err.constraint ?? ''] ?? 'This record already exists',
        );
      case '23503':
        return send(HttpStatus.BAD_REQUEST, 'A referenced record does not exist');
      case '23514': // check_violation (including ledger triggers)
        return send(
          HttpStatus.BAD_REQUEST,
          err.message.startsWith('new row') ? 'Invalid value' : err.message,
        );
      case 'P0001':
        if (err.hint === 'closing_date')
          return send(HttpStatus.CONFLICT, err.message, 'CLOSING_DATE');
        break;
      case '22021': // invalid byte sequence (a NUL in text that skipped validation)
      case '22P05':
        return send(HttpStatus.BAD_REQUEST, 'The text contains a character that is not allowed');
      case '40001':
      case '40P01':
        return send(HttpStatus.CONFLICT, 'The record was changed by someone else. Please retry.');
    }
    this.logger.error(`Unhandled database error ${err.code}: ${err.message}`);
    send(HttpStatus.INTERNAL_SERVER_ERROR, 'Internal server error');
  }
}
