import { z } from 'zod';
import { isIsoDate } from './dates';
import { decimalPlaces, MAX_AMOUNT, parseMoney, tryParseMoney } from './money';

/** Zod field builders shared by the document schemas (not exported from the package index). */
const QTY_RATE = /^-?\d{1,15}(\.\d{1,4})?$/;

export const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

export const isoDate = z.string().refine(isIsoDate, 'Enter a valid date');
export const optDate = isoDate
  .nullable()
  .optional()
  .or(z.literal('').transform(() => null));

export const qtyRate = z
  .string()
  .trim()
  .transform((v) => v.replace(/[$,\s]/g, ''))
  .refine((v) => v === '' || QTY_RATE.test(v), 'Use up to 4 decimal places')
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();

export const signedAmount = z
  .string()
  .trim()
  .transform((v) => v.replace(/[$,\s]/g, ''))
  .refine((v) => v === '' || tryParseMoney(v) !== null, 'Enter a valid amount')
  .refine((v) => v === '' || decimalPlaces(v) <= 2, 'Amounts can have at most 2 decimal places')
  .refine(
    (v) => v === '' || (parseMoney(v) <= MAX_AMOUNT && parseMoney(v) >= -MAX_AMOUNT),
    'Amount is too large',
  )
  .optional();

export const positiveAmount = z
  .string()
  .trim()
  .transform((v) => v.replace(/[$,\s]/g, ''))
  .refine((v) => tryParseMoney(v) !== null, 'Enter a valid amount')
  .refine(
    (v) => tryParseMoney(v) === null || decimalPlaces(v) <= 2,
    'Amounts can have at most 2 decimal places',
  )
  .refine((v) => tryParseMoney(v) === null || parseMoney(v) >= 0n, 'Enter a positive amount')
  .refine((v) => tryParseMoney(v) === null || parseMoney(v) <= MAX_AMOUNT, 'Amount is too large');
