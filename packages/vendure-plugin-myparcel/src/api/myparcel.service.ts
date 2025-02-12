import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import {
  Channel,
  FulfillmentService,
  FulfillmentState,
  Logger,
  Order,
  RequestContext,
  TransactionalConnection,
} from '@vendure/core';
import { OrderAddress } from '@vendure/common/lib/generated-types';
import { ApolloError } from 'apollo-server-core';
import axios from 'axios';
import { Fulfillment } from '@vendure/core/dist/entity/fulfillment/fulfillment.entity';
import { MyparcelConfigEntity } from './myparcel-config.entity';
import { loggerCtx, PLUGIN_INIT_OPTIONS } from '../constants';
import { MyparcelConfig } from '../myparcel.plugin';
import {
  MyparcelDropOffPoint,
  MyparcelDropOffPointInput,
} from '../generated/graphql';

@Injectable()
export class MyparcelService implements OnApplicationBootstrap {
  client = axios.create({ baseURL: 'https://api.myparcel.nl/' });

  constructor(
    private fulfillmentService: FulfillmentService,
    private connection: TransactionalConnection,
    @Inject(PLUGIN_INIT_OPTIONS) private config: MyparcelConfig
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.syncWebhookOnStartup) {
      // Async, because webhook setting is not really needed for application startup
      this.setWebhooksForAllChannels()
        .then(() => Logger.info(`Initialized MyParcel plugin`, loggerCtx))
        .catch((err) =>
          Logger.error(`Failed to initialized MyParcel plugin`, loggerCtx, err)
        );
    } else {
      Logger.info(
        `Initialized MyParcel plugin without syncing webhook to MyParcel`,
        loggerCtx
      );
    }
  }

  async setWebhooksForAllChannels(): Promise<void> {
    // Create webhook subscription for all channels
    const webhook = `${this.config.vendureHost}/myparcel/update-status`;
    const configs = await this.getAllConfigs();
    await Promise.all(
      configs.map(({ channelId, apiKey }) => {
        return this.request('webhook_subscriptions', 'POST', apiKey, {
          webhook_subscriptions: [
            {
              hook: 'shipment_status_change',
              url: webhook,
            },
          ],
        })
          .then(() =>
            Logger.info(`Set webhook for ${channelId} to ${webhook}`, loggerCtx)
          )
          .catch((error: Error) =>
            Logger.error(
              `Failed to set webhook for ${channelId}`,
              loggerCtx,
              error.stack
            )
          );
      })
    );
  }

  /**
   * Upserts a MyparcelConfig. Deletes record if apiKey is null/undefined/empty string
   * @param config
   */
  async upsertConfig(config: {
    channelId: string;
    apiKey: string;
  }): Promise<MyparcelConfigEntity | void> {
    const existing = await this.connection
      .getRepository(MyparcelConfigEntity)
      .findOne({ channelId: config.channelId });
    if ((!config.apiKey || config.apiKey === '') && existing) {
      await this.connection
        .getRepository(MyparcelConfigEntity)
        .delete(existing.id);
    } else if (existing) {
      await this.connection
        .getRepository(MyparcelConfigEntity)
        .update(existing.id, { apiKey: config.apiKey });
    } else {
      await this.connection.getRepository(MyparcelConfigEntity).insert(config);
    }
    return this.connection
      .getRepository(MyparcelConfigEntity)
      .findOne({ channelId: config.channelId });
  }

  async getDropOffPoints(
    ctx: RequestContext,
    input: MyparcelDropOffPointInput
  ): Promise<MyparcelDropOffPoint[]> {
    const config = await this.getConfig(String(ctx.channelId));
    if (!config || !config?.apiKey) {
      throw new MyParcelError(
        `No apiKey found for channel ${ctx.channel.token}`
      );
    }
    const searchParams = new URLSearchParams({
      postal_code: input.postalCode,
      limit: '10',
    });
    if (input.countryCode) {
      searchParams.append('cc', input.countryCode);
    } else if (input.carrierId) {
      searchParams.append('carried_id', input.carrierId);
    }
    const path = `drop_off_points?${searchParams.toString()}`;
    const res = await this.request(path, 'GET', config.apiKey);
    const results = res.data.drop_off_points || [];
    Logger.debug(
      `Fetched ${results.length} drop off points from MyParcel for channel ${ctx.channel.token}`,
      loggerCtx
    );
    return results.slice(0, 10);
  }

  async getConfig(
    channelId: string
  ): Promise<MyparcelConfigEntity | undefined> {
    return this.connection
      .getRepository(MyparcelConfigEntity)
      .findOne({ channelId });
  }

  async getConfigByKey(apiKey: string): Promise<MyparcelConfigEntity> {
    const config = await this.connection
      .getRepository(MyparcelConfigEntity)
      .findOne({ apiKey });
    if (!config) {
      throw new MyParcelError(`No config found for apiKey ${apiKey}`);
    }
    return config;
  }

  async getAllConfigs(): Promise<MyparcelConfigEntity[]> {
    const configs = await this.connection
      .getRepository(MyparcelConfigEntity)
      .find();
    return configs || [];
  }

  async updateStatus(
    channelId: string,
    shipmentId: string,
    status: number
  ): Promise<void> {
    const fulfillmentReference = this.getFulfillmentReference(shipmentId);
    const channel = await this.connection
      .getRepository(Channel)
      .findOneOrFail(channelId);
    const fulfillment = await this.connection
      .getRepository(Fulfillment)
      .findOne({ method: fulfillmentReference });
    if (!fulfillment) {
      return Logger.error(
        `No fulfillment found with method ${fulfillmentReference} for channel with id ${channelId}`,
        loggerCtx
      );
    }
    const fulfillmentStatus = myparcelStatusses[status];
    if (!fulfillmentStatus) {
      return Logger.info(
        `No fulfillmentStatus found for myparcelStatus ${status}, not updating fulfillment ${shipmentId}`,
        loggerCtx
      );
    }
    const ctx = new RequestContext({
      apiType: 'admin',
      isAuthorized: true,
      authorizedAsOwnerOnly: false,
      channel,
    });
    await this.fulfillmentService.transitionToState(
      ctx,
      fulfillment.id,
      fulfillmentStatus
    );
    Logger.info(
      `Updated fulfillment ${fulfillmentReference} to ${fulfillmentStatus}`,
      loggerCtx
    );
  }

  async createShipments(channelId: string, orders: Order[]): Promise<string> {
    const config = await this.getConfig(channelId);
    if (!config) {
      throw new MyParcelError(`No config found for channel ${channelId}`);
    }
    const shipments = this.toShipment(orders);
    const res = await this.request('shipments', 'POST', config.apiKey, {
      shipments,
    });
    const id = res.data?.ids?.[0]?.id;
    return this.getFulfillmentReference(id);
  }

  toShipment(orders: Order[]): MyparcelShipment[] {
    return orders.map((order) => {
      Logger.info(`Creating shipment for ${order.code}`, loggerCtx);
      const address: OrderAddress = order.shippingAddress;
      const [nr, nrSuffix] = this.getHousenumber(address.streetLine2!);
      return {
        carrier: 1, // PostNL
        reference_identifier: order.code,
        options: {
          package_type: 1, // Parcel
          label_description: order.code,
        },
        recipient: {
          cc: address.countryCode!,
          region: address.province || undefined,
          city: address.city!,
          street: address.streetLine1!,
          number: nr,
          number_suffix: nrSuffix,
          postal_code: address.postalCode!,
          person: address.fullName!,
          phone: address.phoneNumber || undefined,
          email: order.customer?.emailAddress,
        },
      };
    });
  }

  private getFulfillmentReference(shipmentId: string | number): string {
    return `MyParcel ${shipmentId}`;
  }

  private async request(
    path: 'shipments' | 'webhook_subscriptions' | 'drop_off_points' | string,
    method: 'GET' | 'POST',
    apiKey: string,
    body?: unknown
  ): Promise<MyparcelResponse> {
    const shipmentContentType =
      'application/vnd.shipment+json;version=1.1;charset=utf-8';
    const defaultContentType = 'application/json';
    const contentType =
      path === 'shipments' ? shipmentContentType : defaultContentType;
    const buff = Buffer.from(apiKey);
    const encodedKey = buff.toString('base64');
    const headers = {
      Authorization: `basic ${encodedKey}`,
      'Content-Type': contentType,
      'User-Agent': 'CustomApiCall/2',
    };
    try {
      if (method === 'POST') {
        const res = await this.client.post(
          path,
          {
            data: body,
          },
          {
            headers,
          }
        );
        return res.data;
      } else {
        const res = await this.client.get(path, {
          headers,
        });
        return res.data;
      }
    } catch (err) {
      if (err.response?.status >= 400 && err.response?.status < 500) {
        const errorMessage = this.getReadableError(err.response.data);
        Logger.error(err.response.data, loggerCtx);
        throw errorMessage ? new MyParcelError(errorMessage) : err;
      } else {
        Logger.error(err.response, loggerCtx);
        throw err;
      }
    }
  }

  private getHousenumber(nrAndSuffix: string): [string, string] {
    if (!nrAndSuffix) {
      throw new MyParcelError(`No houseNr given`);
    }
    const [_, houseNr, suffix] = nrAndSuffix.split(/^[^\d]*(\d+)/);
    if (!houseNr) {
      throw new MyParcelError(`Invalid houseNumber ${nrAndSuffix}`);
    }
    return [houseNr, suffix];
  }

  private getReadableError(data: MyparcelErrorResponse): string | undefined {
    const error = Object.values(data.errors?.[0] || {}).find(
      (value) => value?.human?.[0]
    );
    return error?.human?.[0];
  }
}

export class MyParcelError extends ApolloError {
  constructor(message: string) {
    super(message, 'MY_PARCEL_ERROR');
  }
}

export interface MyparcelRecipient {
  cc: string;
  region?: string;
  city: string;
  street: string;
  number: string;
  number_suffix?: string;
  postal_code: string;
  person: string;
  phone?: string;
  email?: string;
}

export interface MyparcelShipmentOptions {
  package_type: number;
  label_description?: string;
}

export interface MyparcelShipment {
  carrier: number;
  reference_identifier?: string;
  recipient: MyparcelRecipient;
  options: MyparcelShipmentOptions;
}

export interface WebhookSubscription {
  url: string;
  hook: string;
}

export interface MyparcelResponse {
  data: any;
}

export interface MyparcelErrorResponse {
  errors: MyparcelError[];
  message: string;
}

export interface MyparcelError {
  [key: string]: {
    fields: string[];
    human: string[];
  };
}

export interface MyparcelStatusChangeEvent {
  data: {
    hooks: [
      {
        shipment_id: string;
        account_id: number;
        shop_id: number;
        status: number;
        barcode: string;
        shipment_reference_identifier: string;
      }
    ];
  };
}

export const myparcelStatusses: { [key: string]: FulfillmentState } = {
  1: 'Pending',
  2: 'Pending',
  3: 'Shipped',
  4: 'Shipped',
  5: 'Shipped',
  6: 'Shipped',
  7: 'Delivered',
  8: 'Delivered',
  9: 'Delivered',
  10: 'Delivered',
  11: 'Delivered',
  32: 'Shipped',
  33: 'Shipped',
  34: 'Shipped',
  35: 'Shipped',
  36: 'Delivered',
  37: 'Delivered',
  38: 'Delivered',
  99: 'Delivered',
};
