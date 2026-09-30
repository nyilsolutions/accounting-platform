import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  CURRENCIES,
  currencyInfo,
  HOME_CURRENCY,
  parseRate,
  rateToString,
  type CurrencySettingsDto,
  type ExchangeRateDto,
  type ExchangeRateInput,
  type FetchRatesResultDto,
  type RateLookupDto,
} from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { validationError } from '../sales/sales-common';
import { createControlAccount, gainLossAccount, rateOn } from './fx';
import {
  EXCHANGE_RATE_PROVIDER,
  RateProviderError,
  type ExchangeRateProvider,
} from './rates-provider';

/**
 * Multi-currency settings, the company's currencies and their exchange rates (ADR 0020). The
 * home currency is US dollars; multi-currency can't be turned off once on.
 */
@Injectable()
export class CurrencyService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EXCHANGE_RATE_PROVIDER) private readonly provider: ExchangeRateProvider | null,
    private readonly audit: AuditService,
  ) {}

  private tenant<T>(auth: AuthContext, ctx: CompanyContext, fn: (tx: Tx) => Promise<T>) {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, fn);
  }

  settings(auth: AuthContext, ctx: CompanyContext): Promise<CurrencySettingsDto> {
    return this.tenant(auth, ctx, (tx) => this.settingsInTx(tx, ctx.companyId));
  }

  private async settingsInTx(tx: Tx, companyId: string): Promise<CurrencySettingsDto> {
    const company = await tx
      .selectFrom('companies')
      .select('multicurrency')
      .where('id', '=', companyId)
      .executeTakeFirstOrThrow();
    const rows = await sql<{
      currency: string;
      rate: string | null;
      rate_date: string | null;
      ar: string | null;
      ap: string | null;
      customers: number;
      vendors: number;
    }>`
      select cc.currency,
             r.rate, r.rate_date,
             (select id from accounts where company_id = cc.company_id
                and account_type = 'accounts_receivable' and currency = cc.currency) as ar,
             (select id from accounts where company_id = cc.company_id
                and account_type = 'accounts_payable' and currency = cc.currency) as ap,
             (select count(*)::int from customers where company_id = cc.company_id
                and currency = cc.currency) as customers,
             (select count(*)::int from vendors where company_id = cc.company_id
                and currency = cc.currency) as vendors
      from company_currencies cc
      left join lateral (
        select rate, rate_date::text from exchange_rates
        where company_id = cc.company_id and currency = cc.currency
        order by rate_date desc limit 1
      ) r on true
      where cc.company_id = ${companyId}
      order by cc.currency`.execute(tx);
    return {
      multicurrency: company.multicurrency,
      homeCurrency: HOME_CURRENCY,
      ratesProvider: this.provider?.name ?? null,
      currencies: rows.rows.map((r) => {
        const info = currencyInfo(r.currency);
        return {
          code: r.currency,
          name: info.name,
          decimals: info.decimals,
          latestRate: r.rate ? rateToString(parseRate(r.rate)) : null,
          latestRateDate: r.rate_date,
          receivablesAccountId: r.ar,
          payablesAccountId: r.ap,
          customers: r.customers,
          vendors: r.vendors,
        };
      }),
    };
  }

  /** Turns multi-currency on (for good) and creates the Exchange Gain or Loss account. */
  enable(auth: AuthContext, ctx: CompanyContext, meta: RequestMeta): Promise<CurrencySettingsDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const c = await tx
        .selectFrom('companies')
        .select('multicurrency')
        .where('id', '=', ctx.companyId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (!c.multicurrency) {
        await gainLossAccount(tx, ctx.companyId);
        await tx
          .updateTable('companies')
          .set({ multicurrency: true, updated_by: auth.userId })
          .where('id', '=', ctx.companyId)
          .execute();
        await this.audit.record(
          tx,
          {
            companyId: ctx.companyId,
            actorUserId: auth.userId,
            action: 'company.multicurrency_enabled',
            entityType: 'company',
            entityId: ctx.companyId,
          },
          meta,
        );
      }
      return this.settingsInTx(tx, ctx.companyId);
    });
  }

  /** Adds a currency with its Accounts Receivable and Accounts Payable accounts. */
  addCurrency(
    auth: AuthContext,
    ctx: CompanyContext,
    currency: string,
    meta: RequestMeta,
  ): Promise<CurrencySettingsDto> {
    return this.tenant(auth, ctx, async (tx) => {
      await this.assertOn(tx, ctx.companyId);
      if (!CURRENCIES.some((c) => c.code === currency))
        throw new BadRequestException(
          validationError([{ path: 'currency', message: 'Choose a currency' }]),
        );
      const exists = await tx
        .selectFrom('company_currencies')
        .select('currency')
        .where('company_id', '=', ctx.companyId)
        .where('currency', '=', currency)
        .executeTakeFirst();
      if (exists) throw new ConflictException(`${currency} is already in the list`);
      await tx
        .insertInto('company_currencies')
        .values({ company_id: ctx.companyId, currency, created_by: auth.userId })
        .execute();
      await createControlAccount(tx, ctx.companyId, 'ar', currency);
      await createControlAccount(tx, ctx.companyId, 'ap', currency);
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'currency.added',
          entityType: 'currency',
          metadata: { currency },
        },
        meta,
      );
      return this.settingsInTx(tx, ctx.companyId);
    });
  }

  listRates(
    auth: AuthContext,
    ctx: CompanyContext,
    q: { currency?: string; from?: string; to?: string },
  ): Promise<ExchangeRateDto[]> {
    return this.tenant(auth, ctx, async (tx) => {
      let query = tx
        .selectFrom('exchange_rates')
        .selectAll()
        .where('company_id', '=', ctx.companyId)
        .orderBy('rate_date', 'desc')
        .orderBy('currency')
        .limit(1000);
      if (q.currency) query = query.where('currency', '=', q.currency);
      if (q.from) query = query.where('rate_date', '>=', q.from);
      if (q.to) query = query.where('rate_date', '<=', q.to);
      return (await query.execute()).map(rateDto);
    });
  }

  /** Enters (or replaces) the rate for a currency on a date. */
  saveRate(
    auth: AuthContext,
    ctx: CompanyContext,
    input: ExchangeRateInput,
    meta: RequestMeta,
  ): Promise<ExchangeRateDto> {
    return this.tenant(auth, ctx, async (tx) => {
      await this.assertCurrency(tx, ctx.companyId, input.currency);
      const rate = rateToString(parseRate(input.rate));
      const saved = await this.upsertRate(
        tx,
        ctx.companyId,
        auth.userId,
        input.currency,
        input.rateDate,
        rate,
        'manual',
        true,
      );
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'exchange_rate.saved',
          entityType: 'exchange_rate',
          entityId: saved!.id,
          after: { currency: input.currency, date: input.rateDate, rate },
        },
        meta,
      );
      return saved!;
    });
  }

  deleteRate(auth: AuthContext, ctx: CompanyContext, id: string, meta: RequestMeta) {
    return this.tenant(auth, ctx, async (tx) => {
      const row = await tx
        .deleteFrom('exchange_rates')
        .where('company_id', '=', ctx.companyId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw new NotFoundException('Exchange rate not found');
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'exchange_rate.deleted',
          entityType: 'exchange_rate',
          entityId: id,
          before: { currency: row.currency, date: row.rate_date, rate: row.rate },
        },
        meta,
      );
    });
  }

  /** The rate a document dated `date` would use (the latest on or before it). */
  lookup(
    auth: AuthContext,
    ctx: CompanyContext,
    currency: string,
    date: string,
  ): Promise<RateLookupDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const r = await rateOn(tx, ctx.companyId, currency, date);
      return { currency, date, rate: r?.rate ?? null, rateDate: r?.rateDate ?? null };
    });
  }

  /**
   * Gets the European Central Bank's rates (the latest, or for a date in the last 90 days) for
   * the company's currencies. A rate entered by hand for the same date is kept.
   */
  async fetchRates(
    auth: AuthContext,
    ctx: CompanyContext,
    date: string | undefined,
    meta: RequestMeta,
  ): Promise<FetchRatesResultDto> {
    if (!this.provider)
      throw new ServiceUnavailableException(
        'No exchange rate feed is set up. Enter rates by hand.',
      );
    const currencies = await this.tenant(auth, ctx, async (tx) => {
      await this.assertOn(tx, ctx.companyId);
      return (
        await tx
          .selectFrom('company_currencies')
          .select('currency')
          .where('company_id', '=', ctx.companyId)
          .execute()
      ).map((r) => r.currency);
    });
    if (currencies.length === 0) throw new ConflictException('Add a currency first');
    let fetched;
    try {
      fetched = await this.provider.rates(date);
    } catch (e) {
      if (e instanceof RateProviderError) throw new ServiceUnavailableException(e.message);
      throw e;
    }
    return this.tenant(auth, ctx, async (tx) => {
      const saved: ExchangeRateDto[] = [];
      const missing: string[] = [];
      for (const currency of currencies) {
        const rate = fetched.rates.get(currency);
        if (!rate) {
          missing.push(currency);
          continue;
        }
        const row = await this.upsertRate(
          tx,
          ctx.companyId,
          auth.userId,
          currency,
          fetched.date,
          rateToString(rate),
          'ecb',
          false,
        );
        if (row) saved.push(row);
      }
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'exchange_rate.fetched',
          entityType: 'exchange_rate',
          metadata: {
            source: 'ecb',
            date: fetched.date,
            rates: Object.fromEntries(saved.map((r) => [r.currency, r.rate])),
          },
        },
        meta,
      );
      return { date: fetched.date, saved, missing };
    });
  }

  /** Inserts or updates a rate; a feed never replaces a rate entered by hand. */
  private async upsertRate(
    tx: Tx,
    companyId: string,
    userId: string,
    currency: string,
    date: string,
    rate: string,
    source: 'manual' | 'ecb',
    replaceManual: boolean,
  ): Promise<ExchangeRateDto | null> {
    const existing = await tx
      .selectFrom('exchange_rates')
      .selectAll()
      .where('company_id', '=', companyId)
      .where('currency', '=', currency)
      .where('rate_date', '=', date)
      .forUpdate()
      .executeTakeFirst();
    if (existing) {
      if (existing.source === 'manual' && !replaceManual) return null;
      const row = await tx
        .updateTable('exchange_rates')
        .set({ rate, source, updated_by: userId })
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return rateDto(row);
    }
    const row = await tx
      .insertInto('exchange_rates')
      .values({
        company_id: companyId,
        currency,
        rate_date: date,
        rate,
        source,
        created_by: userId,
        updated_by: userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return rateDto(row);
  }

  private async assertOn(tx: Tx, companyId: string): Promise<void> {
    const c = await tx
      .selectFrom('companies')
      .select('multicurrency')
      .where('id', '=', companyId)
      .executeTakeFirstOrThrow();
    if (!c.multicurrency) throw new ConflictException('Turn on multi-currency first');
  }

  private async assertCurrency(tx: Tx, companyId: string, currency: string): Promise<void> {
    const row = await tx
      .selectFrom('company_currencies')
      .select('currency')
      .where('company_id', '=', companyId)
      .where('currency', '=', currency)
      .executeTakeFirst();
    if (!row)
      throw new BadRequestException(
        validationError([{ path: 'currency', message: `Add ${currency} to the currencies first` }]),
      );
  }
}

function rateDto(r: {
  id: string;
  currency: string;
  rate_date: string;
  rate: string;
  source: string;
}): ExchangeRateDto {
  return {
    id: r.id,
    currency: r.currency,
    rateDate: r.rate_date,
    rate: rateToString(parseRate(r.rate)),
    source: r.source as 'manual' | 'ecb',
  };
}
