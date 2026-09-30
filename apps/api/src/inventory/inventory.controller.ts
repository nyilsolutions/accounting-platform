import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  closingPasswordSchema,
  inventoryAdjustmentInputSchema,
  inventoryBuildInputSchema,
  type InventoryAdjustmentDto,
  type InventoryBuildDto,
  type InventoryTxnSummaryDto,
} from '@acct/shared';
import { CurrentAuth, CurrentCompany, Meta, RequirePermission } from '../common/decorators';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { InventoryDocumentsService } from './inventory-documents.service';

type Parsed<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;

/** Inventory quantity adjustments and assembly builds (`inventory.manage`). */
@Controller('companies/:companyId/inventory')
@UseGuards(CompanyAccessGuard)
export class InventoryController {
  constructor(private readonly documents: InventoryDocumentsService) {}

  @Get('transactions')
  @RequirePermission('inventory.manage')
  list(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<InventoryTxnSummaryDto[]> {
    return this.documents.list(a, c);
  }

  // ---- Adjustments ------------------------------------------------------------------------
  @Get('adjustments/:id')
  @RequirePermission('inventory.manage')
  getAdjustment(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
  ): Promise<InventoryAdjustmentDto> {
    return this.documents.getAdjustment(a, c, id);
  }

  @Post('adjustments')
  @RequirePermission('inventory.manage')
  createAdjustment(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(inventoryAdjustmentInputSchema))
    body: Parsed<typeof inventoryAdjustmentInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<InventoryAdjustmentDto> {
    return this.documents.saveAdjustment(a, c, null, body, meta);
  }

  @Put('adjustments/:id')
  @RequirePermission('inventory.manage')
  updateAdjustment(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(inventoryAdjustmentInputSchema))
    body: Parsed<typeof inventoryAdjustmentInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<InventoryAdjustmentDto> {
    return this.documents.saveAdjustment(a, c, id, body, meta);
  }

  @Post('adjustments/:id/void')
  @HttpCode(204)
  @RequirePermission('inventory.manage')
  voidAdjustment(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(closingPasswordSchema)) body: Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.documents.setStatus(
      a,
      c,
      'inventory_adjustment',
      id,
      'void',
      body.closingPassword,
      meta,
    );
  }

  @Delete('adjustments/:id')
  @HttpCode(204)
  @RequirePermission('inventory.manage')
  deleteAdjustment(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(closingPasswordSchema)) body: Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.documents.setStatus(
      a,
      c,
      'inventory_adjustment',
      id,
      'deleted',
      body.closingPassword,
      meta,
    );
  }

  // ---- Builds -----------------------------------------------------------------------------
  @Get('builds/:id')
  @RequirePermission('inventory.manage')
  getBuild(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
  ): Promise<InventoryBuildDto> {
    return this.documents.getBuild(a, c, id);
  }

  @Post('builds')
  @RequirePermission('inventory.manage')
  createBuild(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(inventoryBuildInputSchema)) body: Parsed<typeof inventoryBuildInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<InventoryBuildDto> {
    return this.documents.saveBuild(a, c, null, body, meta);
  }

  @Put('builds/:id')
  @RequirePermission('inventory.manage')
  updateBuild(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(inventoryBuildInputSchema)) body: Parsed<typeof inventoryBuildInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<InventoryBuildDto> {
    return this.documents.saveBuild(a, c, id, body, meta);
  }

  @Post('builds/:id/void')
  @HttpCode(204)
  @RequirePermission('inventory.manage')
  voidBuild(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(closingPasswordSchema)) body: Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.documents.setStatus(
      a,
      c,
      'inventory_build',
      id,
      'void',
      body.closingPassword,
      meta,
    );
  }

  @Delete('builds/:id')
  @HttpCode(204)
  @RequirePermission('inventory.manage')
  deleteBuild(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(closingPasswordSchema)) body: Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.documents.setStatus(
      a,
      c,
      'inventory_build',
      id,
      'deleted',
      body.closingPassword,
      meta,
    );
  }
}
