/*eslint-env node*/
'use strict';

let fs = require('fs');

let input_path = process.env.REGION_REPORT;
if (!input_path) {
  throw new Error('REGION_REPORT is required.');
}
let report = JSON.parse(fs.readFileSync(input_path));
let base_catalog_path = process.env.REGION_BASE_CATALOG;
let catalog = base_catalog_path ? JSON.parse(fs.readFileSync(base_catalog_path)) : {};
let candidate_prefix = process.env.REGION_CANDIDATE_PREFIX || 'Region';
report.profiles.forEach(function(profile) {
  let prefix = profile.profile.split('+').map(function(type) {
    return type[0].toUpperCase() + type.slice(1);
  }).join('');
  let candidate_index = 0;
  profile.configured_proxy_screen.finalists.forEach(function(entry) {
    let configurations = entry.configurations || [ { build: entry.build } ];
    configurations.forEach(function(configuration) {
      candidate_index++;
      let id = candidate_prefix + prefix + String(candidate_index).padStart(4, '0');
      catalog[id] = Object.assign({}, configuration.build, {
        name: id,
        reference: false,
      });
    });
  });
});
process.stdout.write(JSON.stringify(catalog, null, 2) + '\n');
