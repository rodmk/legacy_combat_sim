/*eslint-env node*/
'use strict';

let src = require('../combatsim');

let build = src.Build.ShadowDojoDLGunBuild3;
let opponent = src.Player.generateBuild(build);
let started = Date.now();
let result = src.MatchupGame.equipmentBestResponse(
  build,
  [ opponent ],
  [ 'ShadowDojoDLGunBuild3' ],
  [ 1 ],
  { minimumSurvivalProbability: 0.01 }
);
result.elapsed_ms = Date.now() - started;
console.log(JSON.stringify(result, null, 2));
