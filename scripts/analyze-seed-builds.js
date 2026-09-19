/*eslint-env node*/
'use strict';

let MatchupGame = require('../combatsim').MatchupGame;
let seedBuilds = require('../data/game-builds.json');

console.log(JSON.stringify(MatchupGame.analyzeBuildCatalog(seedBuilds), null, 2));
