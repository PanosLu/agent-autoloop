#!/usr/bin/env node
// Waits for a real submission. HTTP 200 is recorded only as "accepted" and never becomes the receipt by itself.
import { runRound } from "./lib.mjs";

function report(error) {
  const message = error instanceof Error ? error.message : "失败";
  process.stderr.write(`${message.startsWith("没跑成") ? message : `没跑成：${message}`}\n`);
  process.exitCode = 2;
}

try {
  const text = await runRound({
    home: process.env.GROK_BOT_HOME,
    run: process.env.AGENT_AUTOLOOP_RUN,
    waitMs: process.env.GROK_BOT_WAIT_MS,
  });
  process.stdout.write(`${text}\n`);
} catch (error) {
  report(error);
}
