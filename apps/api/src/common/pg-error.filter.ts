import { ArgumentsHost, Catch, HttpStatus, Logger, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { DatabaseError } from 'pg';

/** User-facing messages for unique constraints, keyed by index name. */
const UNIQUE_MESSAGES: Record<string, string> = {
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
  payment_applications_payment_id_target_id_key: 'This invoice is listed twice on the payment',
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
      case '40001':
      case '40P01':
        return send(HttpStatus.CONFLICT, 'The record was changed by someone else. Please retry.');
    }
    this.logger.error(`Unhandled database error ${err.code}: ${err.message}`);
    send(HttpStatus.INTERNAL_SERVER_ERROR, 'Internal server error');
  }
}
