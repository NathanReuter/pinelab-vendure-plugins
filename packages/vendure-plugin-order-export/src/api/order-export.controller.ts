import {
  Allow,
  Ctx,
  Logger,
  OrderService,
  ProductVariantService,
  RequestContext,
} from '@vendure/core';
import { ExportPluginConfig, orderExportPermission } from '..';
import {
  ArgumentMetadata,
  Controller,
  Get,
  Inject,
  Param,
  PipeTransform,
  Query,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Resolver, Query as GraphqlQuery } from '@nestjs/graphql';
import { Response } from 'express';
import { loggerCtx, PLUGIN_INIT_OPTIONS } from '../constants';
import * as fs from 'fs';
import { promises as promisedFs } from 'fs';

export class ParseDatePipe implements PipeTransform {
  transform(value: any, metadata: ArgumentMetadata) {
    if (!value) {
      throw new UnprocessableEntityException(`Date is required`);
    }
    return new Date(value);
  }
}

@Controller('export-orders')
export class OrderExportController {
  constructor(
    @Inject(PLUGIN_INIT_OPTIONS) private config: ExportPluginConfig,
    private orderService: OrderService,
    private productVariantService ProductVariantService
  ) {}

  @Allow(orderExportPermission.Permission)
  @Get('/export/:strategy')
  async downloadMultipleInvoices(
    @Ctx() ctx: RequestContext,
    @Param('strategy') strategyName: string,
    @Query('startDate', new ParseDatePipe()) startDate: Date,
    @Query('endDate', new ParseDatePipe()) endDate: Date,
    @Res() res: Response
  ) {
    if (!ctx.channelId) {
      throw Error(`Channel id is needed to export orders`);
    }
    const strategy = this.config.exportStrategies.find(
      (strategy) => strategy.name === strategyName
    );
    if (!strategy) {
      throw new UnprocessableEntityException(
        `No strategy named '${strategyName}' configured`
      );
    }
    Logger.info(
      `Exporting orders for user ${
        ctx.activeUserId
      } from ${startDate.toDateString()} to ${endDate.toDateString()} with strategy ${strategyName}`,
      loggerCtx
    );
    const filePath = await strategy.createExportFile({
      ctx,
      startDate,
      endDate,
      orderService: this.orderService,
      productVariantService: this.productVariantService,
    });
    const readStream = fs.createReadStream(filePath);
    res.set({
      'Content-Type': strategy.contentType,
      'Content-Disposition': `inline; filename=order-export.${strategy.fileExtension}`,
    });
    Logger.info(`Exported orders`, loggerCtx);
    readStream.on('end', async () => {
      Logger.info(`Export downloaded, deleting file ${filePath}`, loggerCtx);
      await promisedFs.unlink(filePath);
    });
    readStream.pipe(res);
  }
}

@Resolver()
export class OrderExportResolver {
  constructor(
    @Inject(PLUGIN_INIT_OPTIONS) private config: ExportPluginConfig
  ) {}

  @Allow(orderExportPermission.Permission)
  @GraphqlQuery()
  availableOrderExportStrategies(): string[] {
    return this.config.exportStrategies.map((strategy) => strategy.name);
  }
}
