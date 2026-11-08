#!/usr/bin/env node
// Records the Bot's smoke sum for one accepted id. A second identical submit is idempotent; anything else is refused.
import { submitResult } from "./lib.mjs";

if (process.argv.length !== 4) {
  process.stderr.write("用法：submit-result.mjs <请求编号> <整数结果>\n");
  process.exitCode = 2;
} else {
  try {
    process.stdout.write(`${JSON.stringify(submitResult(process.env.GROK_BOT_HOME, process.argv[2], process.argv[3]))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "没能提交"}\n`);
    process.exitCode = 2;
  }
}
