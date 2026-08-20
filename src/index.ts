import { runCli } from "./cli.js";
import { KakeboError } from "./errors.js";
import { safeMessage } from "./utils/text.js";
import { createKakeboApplication } from "./application/create-application.js";

async function main(): Promise<void> {
  let application: ReturnType<typeof createKakeboApplication> | undefined;
  try {
    application = createKakeboApplication();
    const { config, database, client, authorization, sync, logger } = application;
    await runCli(process.argv.slice(2), {
      config,
      database,
      client,
      authorization,
      sync,
      logger
    });
  } catch (error) {
    console.error(`Error: ${safeMessage(error)}`);
    process.exitCode = error instanceof KakeboError ? error.exitCode : 1;
  } finally {
    application?.close();
  }
}

await main();
