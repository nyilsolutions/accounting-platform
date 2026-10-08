import {
  reportToCsv,
  reportToTable,
  type GeneralLedgerDto,
  type ReportDto,
  type ReportFormat,
} from '@acct/shared';
import { reportToPdf } from './pdf';
import { reportToXlsx } from './xlsx';

export interface RenderedReport {
  data: Buffer;
  contentType: string;
  filename: string;
}

const TYPES: Record<ReportFormat, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
};

/** "Profit-and-Loss-2026-09-30.pdf": letters, digits and dashes only. */
export function reportFilename(report: ReportDto | GeneralLedgerDto, format: ReportFormat): string {
  const base = report.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'Report';
  return `${base}-${report.to}.${format}`;
}

export async function renderReport(
  report: ReportDto | GeneralLedgerDto,
  format: ReportFormat,
): Promise<RenderedReport> {
  const data =
    format === 'csv'
      ? // A byte-order mark so Excel opens the file as UTF-8.
        Buffer.from(`\ufeff${reportToCsv(report)}`, 'utf8')
      : format === 'xlsx'
        ? reportToXlsx(reportToTable(report))
        : await reportToPdf(reportToTable(report));
  return { data, contentType: TYPES[format], filename: reportFilename(report, format) };
}
