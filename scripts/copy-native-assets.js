#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { copyAssets, readManifest } = require('../app/app-assets');

function copyNativeAssets(destination, source = path.resolve(__dirname, '../app')) {
  destination = path.resolve(destination); source = path.resolve(source);
  if (destination === source) throw Error('Native assets must be copied into a separate staging directory.');
  copyAssets(destination, source);
  // This optional addon belongs to Electron. A reused checkout can contain an
  // ignored build from another version; never ship it in the Swift application.
  // Remove only the staged copy, preserving the developer's source checkout.
  fs.rmSync(path.join(destination, 'native-glass.node'), { force: true });
  return readManifest(destination).files.length;
}

if (require.main === module) {
  const [destination, source, ...extra] = process.argv.slice(2);
  if (!destination || extra.length) throw Error('Usage: node scripts/copy-native-assets.js DESTINATION [SOURCE]');
  console.log(`Copied ${copyNativeAssets(destination, source)} native application resources`);
}
module.exports = { copyNativeAssets };
