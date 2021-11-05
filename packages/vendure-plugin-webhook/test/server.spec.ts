import { createTestEnvironment, registerInitializer, SqljsInitializer, testConfig } from "@vendure/testing";
import { initialData } from "../../test/src/initial-data";
import {
  CollectionModificationEvent,
  DefaultLogger,
  InitialData,
  LogLevel,
  mergeConfig,
  ProductEvent,
  ProductVariantChannelEvent,
  ProductVariantEvent
} from "@vendure/core";
import { WebhookPlugin } from "../src";
import { TestServer } from "@vendure/testing/lib/test-server";

jest.setTimeout(20000);

describe("Mollie plugin", function() {
  let server: TestServer;
  let serverStarted = false;

  beforeAll(async () => {
    registerInitializer("sqljs", new SqljsInitializer("__data__"));
    const config = mergeConfig(testConfig, {
      apiOptions: {
        port: 3104
      },
      logger: new DefaultLogger({ level: LogLevel.Debug }),
      plugins: [
        WebhookPlugin.init({
          httpMethod: "POST",
          delay: 3000,
          events: [
            ProductEvent,
            ProductVariantChannelEvent,
            ProductVariantEvent,
            CollectionModificationEvent
          ]
        })
      ]
    });

    ({ server } = createTestEnvironment(config));
    await server.init({
      initialData: initialData as InitialData,
      productsCsvPath: "../test/src/products-import.csv"
    });
    serverStarted = true;
  }, 10000);

  it("Should start successfully", async () => {
    await expect(serverStarted).toBe(true);
  });

  afterAll(() => {
    return server.destroy();
  });
});
