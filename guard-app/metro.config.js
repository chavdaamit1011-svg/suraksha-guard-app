require('./scripts/metro-windows-files.cjs').install();

const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
