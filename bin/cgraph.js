#!/usr/bin/env node
import { main } from '../src/cli/index.js';

main(process.argv.slice(2)).catch((err) => {
  // Agents and humans both read stderr; a stack trace is noise unless debugging.
  if (process.env.CGRAPH_DEBUG) console.error(err);
  else console.error(`cgraph: ${err.message}`);
  process.exit(1);
});
