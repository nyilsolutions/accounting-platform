import type { FieldEncryptor } from '@acct/crypto';
import type { Tx } from '@acct/db';
import { bad } from './payroll-common';
import { einAad } from '../security/aad';

/** The origination details for ACH files: the ODFI and the company as the bank knows it. */
export async function achOrigin(tx: Tx, companyId: string, encryptor: FieldEncryptor) {
  const s = await tx
    .selectFrom('payroll_settings as s')
    .innerJoin('companies as c', 'c.id', 's.company_id')
    .select([
      's.ach_odfi_routing',
      's.ach_odfi_name',
      's.ach_company_name',
      's.ach_company_id',
      'c.ein_enc',
      'c.legal_name',
    ])
    .where('s.company_id', '=', companyId)
    .executeTakeFirst();
  if (!s) throw bad('effectiveDate', 'Set up payroll first');
  if (!s.ach_odfi_routing || !s.ach_odfi_name) {
    throw bad('achOdfiRouting', "Enter your bank's routing number and name in Payroll › Setup");
  }
  let companyAchId = s.ach_company_id;
  if (!companyAchId) {
    if (!s.ein_enc) {
      throw bad('achCompanyId', 'Enter the company ID your bank assigned, or the company EIN');
    }
    const ein = encryptor.decrypt(s.ein_enc, einAad(companyId));
    companyAchId = `1${ein.replace(/-/g, '')}`;
  }
  const companyName = s.ach_company_name ?? s.legal_name;
  return {
    odfiRouting: s.ach_odfi_routing,
    odfiName: s.ach_odfi_name,
    immediateOrigin: companyAchId,
    originName: companyName,
    companyName,
  };
}
