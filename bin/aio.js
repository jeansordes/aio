#!/usr/bin/env node

const { main } = require("../lib/cli");
const { compareVersions, detectInstallContext, getUpdateCommand, shouldOfferUpdate } = require("../lib/update");

module.exports = {
  compareVersions,
  detectInstallContext,
  getUpdateCommand,
  shouldOfferUpdate,
};

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
