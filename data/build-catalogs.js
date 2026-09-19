'use strict';

/** @type {readonly import('../types').BuildCatalog[]} */
const buildCatalogs = [
  require('./builds.json'),
  require('./game-builds.json'),
];

module.exports = buildCatalogs;
