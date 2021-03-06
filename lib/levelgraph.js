
var filterStream = require('./filterstream')
  , nextStartStream = require('./nextstartstream')
  , materializer = require('./materializerstream')
  , Variable = require('./variable')
  , Navigator = require('./navigator')
  , extend = require('xtend')
  , utilities = require('./utilities')
  , queryplanner = require('./queryplanner')
  , PassThrough = require('readable-stream').PassThrough
  , WriteStream = require('./writestream')
  , levelWriteStream = require('level-writestream')
  , levelup = require('levelup')
  , Leveljs
  , searchStream
  , doAction
  , doActionStream;

var joinDefaults = {
  solution: {}
};

module.exports = function levelgraph(leveldb, options, readyCallback) {

  var name = leveldb
    , db
    , callTheCallback
    , wrappedCallback;

  if (typeof options  === 'function') {
    readyCallback = options;
    options = {}; //options can not remain a function, the rest of the
    //code expects it to be an object.
  }

  callTheCallback = !!readyCallback;

  options = options || {};

  if (typeof leveldb === 'string') {
    // do not call the callback immediately
    // if we do not have a level() instance
    callTheCallback = false;

    // we are using LevelDown on node or level-js in the Browser
    if (!options.db) {
      options.db = require('./getdb');
    }

    if (readyCallback){
      wrappedCallback = function(err, leveldb){
        readyCallback(err, db);
      };
    }

    leveldb = levelup(name, options, wrappedCallback);

  }

  utilities.patchApproximateSize(leveldb);

  // it may be an empty object if we are on browserify.
  // we are not patching it up if a sublevel is passed in.
  if (typeof levelWriteStream === 'function' && leveldb.parent) {
    levelWriteStream(leveldb);
  }

  db = {
    // nextStart is a callback to retrieve the next start to be set to get the next page if a limit has been set
    getStream: function(pattern, options, nextStart) {
      var query = utilities.createQuery(pattern, options)
        , stream = leveldb.createValueStream(query);

      if (pattern.filter || pattern.offset) {
        stream = stream.pipe(filterStream({
            filter: pattern.filter
          , offset: pattern.offset
        }));
      }
      var nss = new nextStartStream(pattern);
      stream.pipe(nss);
      stream.on('end', function () {
        if (nextStart) {
          nextStart(nss.getNextStart());
        }
      });

      return stream;
    }
    , get: utilities.wrapCallback('getStream')
    , put: doAction('put', leveldb)
    , del: doAction('del', leveldb)
    , putStream: doActionStream('put', leveldb)
    , delStream: doActionStream('del', leveldb)
    , close: function(callback) {
        if (typeof leveldb.close === 'function') {
          leveldb.close(callback);
        } else if(typeof callback === 'function') {
          callback();
        }
      }
    , v: Variable
    , searchStream: searchStream(leveldb, options)
    , search: utilities.wrapCallback('searchStream')
    , nav: function(start) {
      return new Navigator({ start: start, db: this });
    }
    , generateBatch: utilities.generateBatch
  };

  db.joinStream = function(a, b, c) {
    console.warn('joinStream is deprecated, use searchStream instead');
    return db.searchStream(a, b, c);
  };

  db.join = function(a, b, c) {
    console.warn('join is deprecated, use search instead');
    return db.search(a, b, c);
  };

  db.approximateSize = function(pattern, callback) {
    var query = utilities.createQuery(utilities.queryMask(pattern));
    leveldb.db.approximateSize(query.start, query.end, function (error, size) {
      callback(error, error ? null : size >> 8);
    });
  };

  if (callTheCallback && readyCallback) {
    process.nextTick(readyCallback.bind(null, null, db));
  }

  return db;
};

searchStream = function(db, options) {
  options = extend({ joinAlgorithm: 'sort' }, options);

  var planner = queryplanner(db, options);

  return function(query, options) {
    var that = this
      , result = new PassThrough({ objectMode: true });


    options = extend(joinDefaults, options);

    if (!query || query.length === 0) {
      result.end();
      return result;
    }

    planner(query, function(err, newquery) {
      if (err) {
        result.emit('error', err);
        return;
      }

      var streams = newquery.map(function(triple) {
        var stream = triple.stream
          , index  = triple.index;

        delete triple.stream;
        delete triple.index;
        return stream({ triple: triple, db: that, index: index });
      });

      streams[0].start = true;
      streams[0].end(options.solution);

      if (options.limit) {
        streams[streams.length - 1].limit = options.limit;
      }

      if (options.filter || options.offset) {
        streams.push(filterStream({
            filter: options.filter
          , offset: options.offset
        }));
      }

      if (options.materialized) {
        streams.push(materializer({
          pattern: options.materialized
        }));
      }

      streams.reduce(function(prev, current) {
        return prev.pipe(current);
      }).pipe(result);
    });

    return result;
  };
};

doAction = function(action, leveldb) {
  return function(triples, cb) {
    if(!triples.reduce) {
      triples = [triples];
    }

    var actions = triples.reduce(function(acc, triple) {
      return acc.concat(utilities.generateBatch(triple, action));
    }, []);

    leveldb.batch(actions, cb);
  };
};

doActionStream = function(type, leveldb) {
  return function() {
    var levelStream = leveldb.createWriteStream({ type: type });
    var writeStream = new WriteStream();
    writeStream.pipe(levelStream);
    levelStream.on('error', function(err) {
      writeStream.emit('error', err);
    });
    levelStream.on('close', function() {
      writeStream.emit('close');
    });
    return writeStream;
  };
};
