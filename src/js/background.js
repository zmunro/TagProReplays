const JSZip = require('jszip');
const saveAs = require('file-saver').saveAs;
const semver = require('semver');
require('chrome-storage-promise');

const logger = require('./modules/logger')('background');
const fs = require('./modules/filesystem');
const Renderer = require('./modules/renderer');
const Textures = require('./modules/textures');
const Whammy = require('./modules/whammy');

logger.info('Starting background page.');

Textures.ready().then(() => {
  logger.info('Textures ready.');
});

let tileSize = 40;

let can = document.createElement('canvas');
can.id = 'mapCanvas';
document.body.appendChild(can);

can = document.getElementById('mapCanvas');
can.width = localStorage.getItem('canvasWidth') || 32 * tileSize;
can.height = localStorage.getItem('canvasHeight') || 20 * tileSize;
can.style.zIndex = 200;
can.style.position = 'absolute';
can.style.top = 0;
can.style.left = 0;

let context = can.getContext('2d');

/**
 * Provide a progress callback to some bit of work wrapped
 * in a Promise.
 * 
 * Use with regular promises like:
 *   
 *   var p = new Progress((resolve, reject, progress) => {
 * 
 *   });
 * 
 *   // elsewhere...
 * 
 *   promise_returning_fn().then(p.progress((progress) => {
 *     update_something(progress);
 *   })).then((result) => {
 *     all_done();
 *   });
 */
class Progress {
  constructor(wrapped) {
    this.__callback = () => {};
    this.__promise = new Promise((resolve, reject) => {
      return wrapped(resolve, reject, (progress) => {
        this.__callback(progress);
      });
    });
  }

  progress(callback) {
    this.__callback = callback;
    return this.__promise;
  }
}

/**
 * Resolves the given callback after a timeout.
 */
function PromiseTimeout(callback, timeout=0) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      resolve(callback());
    }, timeout);
  });
}

// Function to test integrity of position data before attempting to render
// Returns false if a vital piece is missing, true if no problems were found
// Currently does not do a very thorough test
function checkData(positions) {
  logger.info('checkData()');
  const props = ["chat", "splats", "bombs", "spawns", "map", "wallMap", "floorTiles", "score", "gameEndsAt", "clock", "tiles"];
  for (let prop of props) {
    if (!positions[prop]) {
      logger.error(`Replay missing property: ${prop}`);
      return false;
    }
  }
  const nonempty = ['map', 'wallMap', 'clock'];
  for (let prop of nonempty) {
    if (positions[prop].length === 0) {
      logger.error(`Replay property was empty: ${prop}`);
      return false;
    }
  }

  let player_exists = Object.keys(positions).some(k => k.startsWith('player'));
  if (!player_exists) {
    logger.error('No player property found in replay.');
    return false;
  }
  return true;
}

/**
 * Renders replay.
 * 
 * Interface:
 *   Progress is returned. Call .progress on it and pass a handler for
 *   the progress events, which contain the % complete. That function returns
 *   a Promise which can be used like normal for completion/error handling.
 * 
 * A small delay in rendering is provided after progress notification to give
 * async operations a chance to complete.
 */
function renderVideo(replay, id, options) {
  return new Progress((resolve, reject, progress) => {
    // Check replay data.
    if (!checkData(replay)) {
      logger.warn(`${name} was a bad replay.`);
      reject("The replay was not valid.");
    }
    
    let renderer = new Renderer(can, replay, options);
    let me = Object.keys(replay).find(k => replay[k].me == 'me');
    let fps = replay[me].fps;
    let encoder = new Whammy.Video(fps);
    let frames = replay.clock.length;
    // Fraction of completion that warrants progress notification.
    let notification_freq = 0.05;
    let portions_complete = 0;

    resolve(renderer.ready().then(function render(frame=0) {
      for (; frame < frames; frame++) {
        //logger.trace(`Rendering frame ${frame} of ${frames}`);
        renderer.draw(frame);
        encoder.add(context);
        let amount_complete = frame / frames;
        if (Math.floor(amount_complete / notification_freq) != portions_complete) {
          portions_complete++;
          progress(amount_complete);
          // Slight delay to give our progress message time to propagate.
          return PromiseTimeout(() => render(++frame));
        }
      }

      let output = encoder.compile();
      let filename = id.replace(/.*DATE/, '').replace('replays', '');
      return fs.saveFile(`savedMovies/${filename}`, output).then(() => {
        logger.debug('File saved.');
      }).catch((err) => {
        logger.error('Error saving render: ', err);
        throw err;
      });
    }));
  });
}

// this is a function to get all the keys in the object store
//   It also gets the list of names of rendered movies
//   It sends a message to the content script once it gets the keys and movie names
//   It also sends custom texture files as well.
function listItems() {
  var allKeys = [];
  var allMetaData = [];
  var transaction = db.transaction(["positions"], "readonly");
  var store = transaction.objectStore("positions");
  var request = store.openCursor(null);
  request.onsuccess = function () {
    if (request.result) {
      var metadata = localStorage.getItem(request.result.key);
      if (!metadata || !JSON.parse(metadata) || typeof JSON.parse(metadata).map === 'undefined') {
        if (request.result.value === undefined || request.result.value === "undefined") {
          var metadata = extractMetaData(null);
        } else {
          try {
            var data = JSON.parse(request.result.value);
            var metadata = extractMetaData(data);
          } catch (err) {
            var metadata = extractMetaData(null);
          }
        }
        localStorage.setItem(request.result.key, JSON.stringify(metadata));
      }
      allMetaData.push(metadata);
      allKeys.push(request.result.key);
      request.result.continue();
    } else {
      fs.getDirectory('savedMovies').then(fs.getEntryNames)
        .then((names) => {
          logger.info('Sending listItems response.');
          chrome.tabs.sendMessage(tabNum, {
            method: "itemsList",
            positionKeys: allKeys,
            movieNames: names,
            metadata: JSON.stringify(allMetaData)
          });
        }).catch((err) => {
          logger.error('Error getting savedMovies directory: ', err);
        });
    }
  }
}

function getAllKeys(store_name) {
  return new Promise((resolve, reject) => {
    var trans = db.transaction([store_name], "readonly");
    var store = trans.objectStore(store_name);
    var req = store.openCursor(null);
    var keys = [];
    req.onsuccess = () => {
      if (req.result) {
        keys.push(req.result.key);
        req.result.continue();
      }
    };
  });
}

// Remove any movie files that don't have a corresponding replay in
// indexedDB.
function getCurrentReplaysForCleaning() {
  getAllKeys("positions").then((keys) => {
    // Make set for movie file name lookup.
    var ids = new Set(keys.map(
      k => k.replace(/.*DATE/, '').replace('replays', '')));
    return fs.getDirectory('savedMovies').then(fs.getEntryNames)
      .then((names) => {
        return Promise.all(names.map((name) => {
          if (!ids.has(name)) {
            return fs.deleteFile(name);
          } else {
            return Promise.resolve();
          }
        }));
      });
  });
}

/**
 * Returns a promise that resolves to the retrieved replay.
 */
function get_replay(id) {
  logger.info(`Retrieving replay: ${id}.`);
  return new Promise((resolve, reject) => {
    let trans = db.transaction(["positions"], "readonly");
    let store = trans.objectStore("positions");
    let request = store.get(id);
    request.onsuccess = (e) => {
      logger.debug(`Replay ${id} retrieved.`);
      let data = JSON.parse(e.target.result);
      resolve(data);
    };
  });
}

function delete_replay(id) {
  logger.info(`Deleting replay: ${id}.`);
  return new Promise((resolve, reject) => {
    let trans = db.transaction(['positions'], 'readwrite');
    let store = trans.objectStore('positions');
    let request = store.delete(id);
    request.onsuccess = () => {
      resolve();
    };
  });
}

/**
 * Saves replay in IndexedDB, returns promise that resolves to id.
 */
function set_replay(id, replay) {
  logger.info(`Saving replay: ${id}.`);
  return new Promise((resolve, reject) => {
    let trans = db.transaction(['positions'], 'readwrite');
    let store = trans.objectStore('positions');
    let request = store.put(JSON.stringify(replay), id);
    request.onsuccess = () => {
      resolve(id);
    };
  })
}

// Handles metadata extraction/saving in addition to IDB saving.
function save_replay(id, replay) {
  let metadata = extractMetaData(replay);
  return set_replay(id, replay).then((id) => {
    localStorage.setItem(id, JSON.stringify(metadata));
    return id;
  });
}

function get_metadata(id) {
  return JSON.parse(localStorage.getItem(id));
}

/**
 * @param {Array.<string>} ids  ids of items to delete from database.
 * @param {Function} iteratee   function to be called on each deletion,
 *   will be passed the index of the item removed. Should only do sync-
 *   ronous operations.
 */
function delete_replays(ids, iteratee=null) {
  logger.info(`Deleting replays: ${ids}`);
  return new Promise((resolve, reject) => {
    let trans = db.transaction(['positions'], 'readwrite');
    let store = trans.objectStore('positions');
    let deleted = 0;
    let request = store.delete(ids[deleted]);
    request.onsuccess = function deleter() {
      if (iteratee) iteratee(deleted);
      deleted++;
      if (deleted === ids.length) {
        resolve();
        return;
      }
      let request = store.delete(ids[deleted]);
      request.onsuccess = deleter;
    };
  });
}

// gets position data from object store for multiple files and zips it into blob
// saves as zip file
function getRawDataAndZip(files) {
  logger.info('getRawDataAndZip()');
  var zip = new JSZip();
  var transaction = db.transaction(["positions"], "readonly");
  var store = transaction.objectStore("positions");
  var request = store.openCursor(null);
  request.onsuccess = function () {
    let cursor = request.result;
    if (cursor) {
      if (files.includes(cursor.key)) {
        zip.file(`${cursor.key}.txt`, cursor.value);
      }
      request.result.continue();
    } else {
      zip.generateAsync({
        type: "blob",
        compression: "DEFLATE"
      }).then((content) => {
        saveAs(content, 'raw_data.zip');
      });
    }
  };
}

// this renames data in the object store
function renameData(oldName, newName, tabNum) {
  let trans = db.transaction(["positions"], "readonly");
  let store = trans.objectStore("positions");
  let request = store.get(oldName);
  request.onsuccess = function (e) {
    let thisObj = e.target.result;
    let request = store.delete(oldName)
    request.onsuccess = function () {
      let request = objectStore.add(thisObj, newName)
      request.onsuccess = function () {
        localStorage.removeItem(oldName);
        chrome.storage.local.remove(oldName);
        chrome.tabs.sendMessage(tabNum, {
          method: "replay.renamed",
          old_name: oldName,
          new_name: newName
        });
        logger.info('sent rename reply');
      }
    }
  }
}

// this downloads a rendered movie (found in the FileSystem) to disk
function downloadMovie(name) {
  //var nameDate = name.replace(/.*DATE/,'').replace('replays','')
  var id = name.replace(/.*DATE/, '').replace('replays', '');
  return fs.getFile(`savedMovies/${id}`).then((file) => {
    var filename = name.replace(/DATE.*/, '') + '.webm';
    saveAs(file, filename);
  }).catch((err) => {
    logger.error('Error downloading movie: ', err);
    throw err;
  });
}

/**
 * Crop a replay, including all frames from start to end (includive)
 * Edits the input replay.
 * @param {object} replay  the replay to crop
 * @param {number} start   the frame to start cropping
 * @param {number} end     the frame to stop cropping at
 * @return {object} 
 */
function cropReplay(replay, start, end) {
  let length = replay.clock.length;
  if (start === 0 && end === length)
    return replay;
  
  let start_time = Date.parse(replay.clock[start]),
      end_time   = Date.parse(replay.clock[end]);

  function cropFrameArray(ary) {
    return ary.slice(start, end + 1);
  }

  function cropBombs(bombs) {
    // Only show bomb animation for 200ms.
    let cutoff = 200;
    return bombs.filter((bomb) => {
      let time = Date.parse(bomb.time);
      return start_time - cutoff < time && time < end_time;
    });
  }

  function cropPlayer(player) {
    let name = cropFrameArray(player.name);
    // Don't make a new player if they were not in any frame.
    let valid = name.some(v => v !== null);
    if (!valid) return null;

    let new_player = {
      auth: cropFrameArray(player.auth),
      bomb: cropFrameArray(player.bomb),
      dead: cropFrameArray(player.dead),
      degree: cropFrameArray(player.degree),
      draw: cropFrameArray(player.draw),
      flag: cropFrameArray(player.flag),
      // Clone?
      flair: cropFrameArray(player.flair),
      fps: player.fps,
      grip: cropFrameArray(player.grip),
      map: player.map,
      me: player.me,
      name: name,
      tagpro: cropFrameArray(player.tagpro),
      team: cropFrameArray(player.team),
      x: cropFrameArray(player.x),
      y: cropFrameArray(player.y)
    };

    if (player.angle) {
      new_player.angle = cropFrameArray(player.angle);
    }
    return new_player;
  }

  function cropDynamicTile(tile) {
    return {
      x: tile.x,
      y: tile.y,
      value: cropFrameArray(tile.value)
    };
  }

  function cropSpawns(spawns) {
    return spawns.filter((spawn) => {
      let time = Date.parse(spawn.time);
      return start_time - spawn.w < time && time < end_time;
    });
  }

  function cropChats(chats) {
    return chats.filter((chat) => {
      let time = chat.removeAt;
      return time && start_time < time && time < end_time;
    });
  }

  let new_replay = {
    bombs:      cropBombs(replay.bombs),
    chat:       cropChats(replay.chat),
    clock:      cropFrameArray(replay.clock),
    end:        replay.end,
    gameEndsAt: replay.gameEndsAt,
    floorTiles: replay.floorTiles.map(cropDynamicTile),
    map:        replay.map,
    score:      cropFrameArray(replay.score),
    spawns:     cropSpawns(replay.spawns),
    splats:     replay.splats,
    tiles:      replay.tiles,
    wallMap:    replay.wallMap
  };
  // Add players.
  for (let key in replay) {
    if (key.startsWith('player')) {
      let new_player = cropPlayer(replay[key]);
      if (new_player === null) continue;
      new_replay[key] = new_player;
    }
  }
  return new_replay;
}

// Truncates frame arrays to length of replay.
// Guards against leading 0/null values in case replay is saved soon
// after game start.
function trimReplay(replay) {
  let data_start = replay.clock.findIndex(t => t !== 0);
  let data_end = replay.clock.length - 1;
  return cropReplay(replay, data_start, data_end);
}

// this takes a positions file and returns the duration in seconds of that replay
function getDuration(positions) {
  for (var iii in positions) {
    if (iii.search("player") === 0) {
      var player = positions[iii];
      break;
    }
  }
  if (typeof player === 'undefined') return (0)
  var duration = Math.round(player.x.length / player.fps);
  return (duration);
}

// this takes a positions file and returns the metadata of that file, including:
//     players, their teams at the start of the replay, the map name, the fps of the 
//     recording, and the duration of the recording
// TODO: Stop verifying that a single player was recording after implementing
// replay validation.
function extractMetaData(positions) {
  var metadata = {
    redTeam: [],
    blueTeam: [],
    duration: 0,
    fps: 0,
    map: ''
  };

  var found_self = false;
  var duration = 0;
  for (let key in positions) {
    if (key.startsWith('player')) {
      let player = positions[key];
      let name = player.name.find(n => n);
      if (typeof name == 'undefined') continue;
      let team = player.team[0];
      let me = player.me == 'me';
      name = (me ? '* ' : '  ') + name;
      if (me) {
        metadata.duration = Math.round(player.x.length / player.fps);
        metadata.fps = player.fps;
        metadata.map = player.map;
        found_self = true;
      }
      if (team == 1) {
        metadata.redTeam.push(name);
      } else {
        metadata.blueTeam.push(name);
      }
    }
  }
  if (!found_self) {
    logger.error('Did not find recording player in replay.');
    throw 'player not found';
  }
  return metadata;
}

// Set up indexedDB
var openRequest = indexedDB.open("ReplayDatabase", 1);

// Set handlers for request.
setHandlers(openRequest);

// Function to set handlers for request.
function setHandlers(request) {
  request.onerror = function (e) {
    // Reset database and version.
    if (e.target.error.name == "VersionError") {
      logger.info("Resetting database.");
      // Reset the database.
      var req = indexedDB.deleteDatabase("ReplayDatabase");
      req.onsuccess = function () {
        logger.info("Deleted database successfully");
        // Recreate the database.
        var openRequest = indexedDB.open("ReplayDatabase", 1);
        setHandlers(openRequest);
      };
      req.onerror = function () {
        logger.info("Couldn't delete database");
      };
      req.onblocked = function () {
        logger.info("Couldn't delete database due to the operation being blocked");
      };
    } else {
      logger.error("Unforseen error opening database.");
      logger.dir(e);
    }
  }
  request.onupgradeneeded = function (e) {
    logger.info("running onupgradeneeded");
    var thisDb = e.target.result;
    //Create Object Store
    if (!thisDb.objectStoreNames.contains("positions")) {
      logger.info("I need to make the positions objectstore");
      var objectStore = thisDb.createObjectStore("positions", { autoIncrement: true });
    }
    if (!thisDb.objectStoreNames.contains("savedMovies")) {
      logger.info("I need to make the savedMovies objectstore");
      var objectStore = thisDb.createObjectStore("savedMovies", { autoIncrement: true });
    }
  }

  request.onsuccess = function (e) {
    db = e.target.result;
    db.onerror = function (e) {
      alert("Sorry, an unforseen error was thrown.");
      logger.info("***ERROR***");
      logger.dir(e.target);
    }

    if (!db.objectStoreNames.contains("positions")) {
      version = db.version
      db.close()
      secondRequest = indexedDB.open("ReplayDatabase", version + 1)
      secondRequest.onupgradeneeded = function (e) {
        logger.info("running onupgradeneeded");
        var thisDb = e.target.result;
        //Create Object Store
        if (!thisDb.objectStoreNames.contains("positions")) {
          logger.info("I need to make the positions objectstore");
          var objectStore = thisDb.createObjectStore("positions", { autoIncrement: true });
        }
        if (!thisDb.objectStoreNames.contains("savedMovies")) {
          logger.info("I need to make the savedMovies objectstore");
          var objectStore = thisDb.createObjectStore("savedMovies", { autoIncrement: true });
        }
      }
      secondRequest.onsuccess = function (e) {
        db = e.target.result
      }
    }
    if (!db.objectStoreNames.contains("savedMovies")) {
      version = db.version
      db.close()
      secondRequest = indexedDB.open("ReplayDatabase", version + 1)
      secondRequest.onupgradeneeded = function (e) {
        logger.info("running onupgradeneeded");
        var thisDb = e.target.result;
        //Create Object Store
        if (!thisDb.objectStoreNames.contains("positions")) {
          logger.info("I need to make the positions objectstore");
          var objectStore = thisDb.createObjectStore("positions", { autoIncrement: true });
        }
        if (!thisDb.objectStoreNames.contains("savedMovies")) {
          logger.info("I need to make the savedMovies objectstore");
          var objectStore = thisDb.createObjectStore("savedMovies", { autoIncrement: true });
        }
      }
      secondRequest.onsuccess = function (e) {
        db = e.target.result
      }
    }
  }
}

var title;
// Guard against multi-page rendering.
let rendering = false;
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let method = message.method;
  let tab = sender.tab.id;
  logger.info(`Received ${method}.`)

  if (method == 'replay.get') {
    get_replay(message.id).then((replay) => {
      sendResponse(replay);
    });
    return true;

  } else if (method == 'replay.crop') {
    get_replay(message.id).then((replay) => {
      let cropped_replay = cropReplay(replay, message.start, message.end);
      return save_replay(message.new_name, cropped_replay);
    }).then((id) => {
      chrome.tabs.sendMessage(tab, {
        method: 'replay.added',
        id: id,
        metadata: get_metadata(id)
      });
    });

  } else if (method == 'replay.crop_and_replace') {
    get_replay(message.id).then((replay) => {
      let cropped_replay = cropReplay(replay, message.start, message.end);
      return save_replay(message.new_name, replay);
    }).then((id) => {
      if (message.new_name == message.old_name) {
        chrome.tabs.sendMessage(tab, {
          method: 'replay.replaced',
          id: message.id,
          new_id: id,
          metadata: get_metadata(id)
        });
      } else {
        chrome.tabs.sendMessage(tab, {
          method: 'replay.deleted',
          ids: [message.id]
        });
        chrome.tabs.sendMessage(tab, {
          method: 'replay.added',
          id: id,
          metadata: get_metadata(message.new_name)
        });
      }
    });

  } else if (method == 'replay.delete') {
    let ids = message.ids;
    delete_replays(ids, (index) => {
      localStorage.removeItem(ids[index]);
    }).then(() => {
      logger.info('Finished deleting replays.');
      chrome.tabs.sendMessage(tab, {
        method: 'replay.deleted',
        ids: ids
      });
    });

  } else if (method == 'replay.import') {
    save_replay(message.name, message.data).then((id) => {
      chrome.tabs.sendMessage(tab, {
        method: 'replay.added',
        id: id,
        metadata: get_metadata(id)
      });
      sendResponse();
    });
    return true;

  } else if (method == 'replay.save_record') {
    try {
      let data = JSON.parse(message.data);
      data = trimReplay(data);
      save_replay(message.name, data).then((id) => {
        sendResponse({
          failed: false
        });
      }).catch((err) => {
        logger.error('Error saving replay: ', err);
        sendResponse({
          failed: true
        });
      });
    } catch (e) {
      logger.error('Error saving replay: ', e);
      sendResponse({
        failed: true
      });
    }
    return true;

  } else if (method == 'requestList') {
    tabNum = sender.tab.id;
    logger.info('got list request');
    listItems();

  } else if (method == 'replay.download') {
    let ids = message.ids;
    logger.info(`Received replay download request for: ${ids}.`);
    if (ids.length === 1) {
      let id = ids[0];
      get_replay(id).then((replay) => {
        let data = JSON.stringify(replay);
        let file = new Blob([data], { type: "data:text/txt;charset=utf-8" });
        saveAs(file, `${id}.txt`);
      });
    } else {
      getRawDataAndZip(ids);
    }

  } else if (method == 'requestFileRename') {
    tabNum = sender.tab.id;
    logger.info('got rename request for ' + message.oldName + ' to ' + message.newName)
    renameData(message.oldName, message.newName, tabNum);

  } else if (method == 'movie.download') {
    logger.info(`Received request to download movie for: ${message.id}.`);
    downloadMovie(message.id).then(() => {
      sendResponse({
        failed: false
      });
    }).catch((err) => {
      sendResponse({
        failed: true,
        reason: err
      });
    });
    return true;

  } else if (method == 'cleanRenderedReplays') {
    logger.info('got request to clean rendered replays')
    getCurrentReplaysForCleaning()

  } else if (method == 'replay.render') {
    let id = message.id;
    logger.info(`Rendering replay: ${id}`);
    // Persist the value.
    localStorage.setItem('canvasWidth', message.options.width);
    localStorage.setItem('canvasHeight', message.options.height);
    can.width = message.options.width;
    can.height = message.options.height;
    if (rendering) {
      sendResponse({
        failed: true,
        severity: 'fatal',
        reason: "Rendering is already occurring, wait for a bit or" +
          " disable/enable the extension."
      });
    } else {
      rendering = true;
    }
    get_replay(id).then((replay) => {
      return renderVideo(replay, id, message.options)
      .progress((progress) => {
        logger.debug(`Sending progress update for ${id}: ${progress}`);
        chrome.tabs.sendMessage(tab, {
          method: 'render.update',
          id: id,
          progress: progress
        });
      });
    }).then(() => {
      logger.info(`Rendering finished for ${id}`);
      // Reset rendering state.
      rendering = false;
      sendResponse({
        failed: false
      });
    }).catch((err) => {
      logger.error(`Rendering failed for ${id}`);
      // Reset rendering state.
      rendering = false;
      sendResponse({
        failed: true,
        severity: 'transient',
        reason: err
      });
    });
    return true;

  } else {
    logger.error(`Message type not recognized: ${method}.`);

  }
});

chrome.runtime.onInstalled.addListener((details) => {
  logger.info('onInstalled handler called');
  let reason = details.reason;
  let version = chrome.runtime.getManifest().version;
  if (reason == 'install') {
    logger.info('onInstalled: install');
  } else if (reason == 'update') {
    logger.info('onInstalled: update');
    let last_version = details.previousVersion;
    if (last_version) {
      if (last_version == version) {
        logger.info('Reloaded in dev mode.');
      } else {
        logger.info(`Upgrade from ${last_version} to ${version}.`);
        // Clear preview from versions prior to 1.3.
        if (semver.satisfies(last_version, '<1.3.0')) {
          chrome.storage.promise.local.clear().then(() => {
            chrome.runtime.reload();
          }).catch((err) => {
            logger.error('Error clearing chrome.storage.local: ', err);
          });
        }
      }
    }
  }
});