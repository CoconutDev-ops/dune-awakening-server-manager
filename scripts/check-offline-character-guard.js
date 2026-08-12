'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverPath = path.join(__dirname, '..', 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');

function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `Missing ${startMarker}`);
  assert.notEqual(end, -1, `Missing ${endMarker}`);
  return source.slice(start, end);
}

const predicate = between(
  'function offlinePresencePredicateSql',
  'async function requireStoppedOfflineCharacter'
);
assert.match(predicate, /lower\(\$\{playerAlias\}\.online_status::text\) = 'offline'/);
assert.match(predicate, /\$\{playerAlias\}\.server_id IS NULL/);
assert.match(predicate, /NOT EXISTS \(SELECT 1 FROM active_server_ids asi/);
assert.doesNotMatch(predicate, /farm_state/);

const preflight = between(
  'async function requireStoppedOfflineCharacter',
  'function offlineCharacterGuardSql'
);
assert.match(preflight, /battlegroupSuspended/);
assert.match(preflight, /gameServersEmpty/);
assert.match(preflight, /!battlegroupSuspended \|\| !gameServersEmpty/);
assert.match(preflight, /offlinePresencePredicateSql\('ps'\)/);
assert.match(preflight, /players\.length !== 1/);
assert.match(preflight, /player\.effectivelyOffline !== true/);
assert.match(preflight, /Number\.isSafeInteger\(controllerId\)/);
assert.doesNotMatch(preflight, /farm_state/);

const transactionGuard = between(
  'function offlineCharacterGuardSql',
  'async function backupBeforeCharacterMutation'
);
assert.match(transactionGuard, /SELECT ps\.\* INTO STRICT selected_player/);
assert.match(transactionGuard, /WHERE ps\.player_pawn_id = \$\{pawnId\} FOR UPDATE/);
assert.match(transactionGuard, /WHEN no_data_found/);
assert.match(transactionGuard, /WHEN too_many_rows/);
assert.match(transactionGuard, /offlinePresencePredicateSql\('selected_player'\)/);
assert.match(transactionGuard, /IS DISTINCT FROM TRUE/);
assert.doesNotMatch(transactionGuard, /farm_state/);

console.log('Offline character presence guards passed focused static assertions.');
