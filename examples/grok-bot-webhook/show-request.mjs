#!/usr/bin/env node
// Prints the trusted smoke task for one pending id. Extra fields in the record are refused, not echoed.
import { showRequest } from "./lib.mjs";

if (process.argv.length !== 3) {
  process.stderr.write("用法：show-request.mjs <请求编号>\n");
  process.exitCode = 2;
} else {
  try {
    process.stdout.write(`${JSON.stringify(showRequest(process.env.GROK_BOT_HOME, process.argv[2]))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "没能读取待办"}\n`);
    process.exitCode = 2;
  }
}
