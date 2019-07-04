/* globals window */

if (!window._babelPolyfill) {
  require('babel-polyfill')
}

var Y = require('yjs')
require('y-memory')(Y)
require('y-array')(Y)
require('y-map')(Y)
require('../../y-multihack')(Y)
var YText = require('y-text')(Y)

var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')
var Voice

inherits(RemoteManager, EventEmitter)

function RemoteManager (opts) {
  var self = this
  
  opts = opts || {}
  Voice = opts.voice || null
  opts.wrtc = opts.wrtc || null
  self.roomID = opts.room || 'welcome'
  self.hostname = opts.hostname || 'localhost'
  self.nickname = opts.nickname || 'Guest'
  self.id = null
  self.yfs = null
  self.ySelections = null
  self.posFromIndex = function (filePath, index, cb) {
    console.warn('No "remote.posFromIndex" provided. Unable to apply change!')
  }
  self.client = null
  self.voice = null
  self.peers = []
  self.lastSelection = null
  
  var tokens = {}
  self.mutualExcluse = function (key, f) {
    if (!tokens[key]) {
      tokens[key] = true
      try {
        f()
      } catch (e) {
        delete tokens[key]
        throw new Error(e)
      }
      delete tokens[key]
    }
  }
  
  self.onceReady = function (f) {
    if (!self.yfs) {
      self.once('ready', function () {
        f()
      })
    } else {
      f()
    }
  }
  
  Y({
    db: {
      name: 'memory'
    },
    connector: {
      name: 'multihack', // TODO: Use a custom connector
      room: self.roomID,
      hostname: self.hostname,
      nickname: self.nickname,
      wrtc: opts.wrtc,
      events: function (event, value) {
        if (event === 'id') {
          self.id = value.id
          self.nop2p = value.nop2p
        } else if (event === 'client') {
          self.client = value
        } else if (event === 'voice') {
          if (Voice) {
            self.voice = new Voice(value.socket, value.client, self.roomID)
          }
        } else if (event === 'peers') {
          self.peers = value.peers
          self.mustForward = value.mustForward
        } else if (event === 'lostPeer') {
          self._onLostPeer(value)
        }
        self.emit(event, value)
      }
    },
    share: {
      selections: 'Array',
      dir_tree: 'Map'
    }
  }).then(function (y) {
    self.y = y
    self.yfs = y.share.dir_tree
    self.ySelections = y.share.selections
    
    self.ySelections.observe(function (event) {
      event.values.forEach(function (sel) {
        if (sel.id !== self.id || !self.id) {
          self.emit('changeSelection', self.ySelections.toArray().filter(function (sel) {
            return sel.id !== self.id
          }))
        }
      })
    })
    
    self.yfs.observe(function (event) {
      var filePath = event.name

      if (event.type === 'add' || event.type === 'update') { // create file/folder     

        if (event.value instanceof Y.Text.typeDefinition.class) {
          event.value.observe(self._onYTextAdd.bind(self, filePath))
          
          self.emit('createFile', {
            filePath: filePath,
            content: event.value.toString()
          })
        } else {
          self.emit('createDir', {
            path: filePath
          })
        }
      } else if (event.type === 'delete') { // delete
        self.emit('deleteFile', {
          filePath: filePath
        })
      }
    })
    
    self.emit('ready')
  })
}

RemoteManager.prototype.getContent = function (filePath) {
  var self = this
  return self.yfs.get(filePath).toString()
}

RemoteManager.prototype.createFile = function (filePath, contents) {
  var self = this
  
  self.onceReady(function () {
    self.yfs.set(filePath, Y.Text)
    insertChunked(self.yfs.get(filePath), 0, contents || '')
  })
}

RemoteManager.prototype.createDir = function (filePath, contents) {
  var self = this
  
  self.onceReady(function () {
    self.yfs.set(filePath, 'DIR')
  })
}

function insertChunked(ytext, start, str) {
  var i = start
  var CHUNK_SIZE = 60000
  chunkString(str, CHUNK_SIZE).forEach(function (chunk) {
    ytext.insert(i, chunk)
    i+=chunk.length
  })
}

function chunkString(str, size) {
  var numChunks = Math.ceil(str.length / size),
      chunks = new Array(numChunks);

  for(var i = 0, o = 0; i < numChunks; ++i, o += size) {
    chunks[i] = str.substr(o, size);
  }

  return chunks;
}

RemoteManager.prototype.replaceFile = function (oldPath, newPath) {
  var self = this
  
  self.onceReady(function () {
    self.yfs.set(newPath, self.yfs.get(oldPath))
  })
}
  
RemoteManager.prototype.deleteFile = function (filePath) {
  var self = this
  
  self.onceReady(function () {
    self.yfs.delete(filePath)
  })
}

RemoteManager.prototype.changeFile = function (filePath, delta) {
  var self = this
  
  self.onceReady(function () {
    self.mutualExcluse(filePath, function () {
      var ytext = self.yfs.get(filePath)
      if (!ytext) {
        self.createFile(filePath, '')
        ytext = self.yfs.get(filePath)
      }

      // apply the delta to the ytext instance
      var start = delta.start

      // apply the delete operation first
      if (delta.removed.length > 0) {
        var delLength = 0
        for (var j = 0; j < delta.removed.length; j++) {
          delLength += delta.removed[j].length
        }
        // "enter" is also a character in our case
        delLength += delta.removed.length - 1
        ytext.delete(start, delLength)
      }

      // apply insert operation
      insertChunked(ytext, start, delta.text.join('\n'))
    })
  })
}

RemoteManager.prototype.changeSelection = function (data) {
  var self = this
  
  self.onceReady(function () {
    // remove our last select first
    if (self.lastSelection !== null) {
      self.ySelections.toArray().forEach(function (a, i) {
        if (a.tracker === self.lastSelection) {
          self.ySelections.delete(i)
        }
      })
    } 

    data.id = self.id
    data.tracker = Math.random()
    self.lastSelection = data.tracker
    self.ySelections.push([data])
  })
}

RemoteManager.prototype._onYTextAdd = function (filePath, event) {
  var self = this
  
  self.mutualExcluse(filePath, function () { 
    self.posFromIndex(filePath, event.index, function (from) {
      if (event.type === 'insert') {
        self.emit('changeFile', {
          filePath, filePath,
          change: {
            from: from,
            to: from,
            text: event.values.join('')
          }
        })
      } else if (event.type === 'delete') {
        self.posFromIndex(filePath, event.index + event.length, function (to) {
          self.emit('changeFile', {
            filePath, filePath,
            change: {
              from: from,
              to: to,
              text: ''
            }
          })
        })
      }
    })
  })
}

RemoteManager.prototype._onLostPeer = function (peer) {
  var self = this
  
  self.ySelections.toArray().forEach(function (sel, i) {
    if (sel.id === peer.id) {
      self.ySelections.delete(i)
    }
  })
}

RemoteManager.prototype.destroy = function () {
  var self = this
  
  self.y.connector.disconnect()
  self.client = null
  self.voice = null
  self.id = null
  self.y = null
  self.yfs = null
  self.ySelections = null
  self.posFromIndex = null
  self.lastSelection = null
}

module.exports = RemoteManager
