const hyperdrive = require('hyperdrive')
const mutexify = require('mutexify')
const raf = require('random-access-file')
const crypto = require('hypercore-crypto')
const thunky = require('thunky')
const { EventEmitter } = require('events')
const p = require('path')

module.exports = (...args) => new Multidrive(...args)

const P_SOURCES = '.sources'

class Multidrive extends EventEmitter {
  constructor (storage, key, opts) {
    super()
    this.storage = name => nestStorage(storage, name)

    this.primaryDrive = hyperdrive(this.storage('primary'), key)

    this.ready = thunky(this._ready.bind(this))

    this.writerLock = mutexify()

    this._sources = new Map()
  }

  _ready (cb) {
    this.primaryDrive.ready(err => {
      if (err) return cb(err)
      this.key = this.primaryDrive.key
      this._pushSource(this.primaryDrive, cb)
    })
  }

  _pushSource (drive, cb) {
    cb = cb || noop
    drive.ready(err => {
      if (err) return cb(err)

      this._sources.set(hex(drive.key), drive)
      this.emit('source', drive)

      drive.readdir(P_SOURCES, (err, list) => {
        // console.log('DRIVE READDIR', err, list)
        if (err || !list.length) return cb(err, drive)
        let missing = list.length
        for (let source of list) {
          this._addSource(source, finish)
        }
        function finish (err) {
          if (err) return cb(err, drive)
          if (--missing === 0) cb(null, drive)
        }
      })
    })
  }

  _addSource (key, opts, cb) {
    // console.log('as', key, opts, cb)
    if (typeof opts === 'function') return this._addSource(key, null, opts)
    const drive = hyperdrive(this.storage(hex(key)), key, opts)
    this._pushSource(drive, cb)
  }

  _writeSource (key, cb) {
    this.writer(drive => {
      drive.writeFile(p.join(P_SOURCES, hex(key)), Buffer.alloc(0), cb)
    })
  }

  addSource (key, cb) {
    this.ready(() => {
      if (this._sources.has(hex(key))) return cb(null, this._sources.get(key))
      this._addSource(key, cb)
    })
  }

  saveSource (key, cb) {
    this.addSource(key, err => {
      if (err) return cb(err)
      this._writeSource(key, cb)
    })
  }

  sources (cb) {
    this.ready(() => {
      cb(null, [...this._sources.values()])
    })
  }

  writer (cb) {
    const self = this
    if (this._localWriter) return cb(null, this._localWriter)
    let release = null
    this.ready(err => {
      if (err) return cb(err)
      if (this.primaryDrive.writable) {
        finish(null, this.primaryDrive)
      } else {
        readKey()
        // TODO: Re-enable writer lock.
        // self.writerLock(_release => {
        //   release = _release
        //   readKey()
        // })
      }
    })

    function readKey () {
      if (self._localWriter) finish(null, self._localWriter)
      let keystore = self.storage()('localwriter')
      keystore.stat((err, stat) => {
        if (err || !stat || !stat.length) createWriter(keystore)
        else {
          keystore.read(0, 32, (err, key) => {
            if (err) return finish(err)
            openWriter({ publicKey: key })
          })
        }
      })
    }

    function createWriter (keystore) {
      const keyPair = crypto.keyPair()
      keystore.write(0, keyPair.publicKey, err => {
        if (err) return cb(err)
        openWriter(keyPair)
      })
    }

    function openWriter (keyPair) {
      const { publicKey, secretKey } = keyPair
      self._addSource(publicKey, { secretKey }, finish)
    }

    function finish (err, drive) {
      self._localWriter = drive
      if (release) release()
      cb(err, drive)
    }
  }

  replicate (opts) {
    const self = this
    if (!opts) opts = {}

    const stream = this.primaryDrive.replicate(opts)

    for (let drive of this._sources.values()) {
      addDrive(drive)
    }

    this.on('source', drive => addDrive(drive))

    return stream

    function addDrive (drive) {
      if (drive === self.primaryDrive) return
      if (stream.destroyed) return
      drive.replicate({
        live: opts.live,
        download: opts.download,
        upload: opts.upload,
        stream: stream
      })
      // Each hyperdrive has two feeds, so increase the amount
      // of expected feeds.
      stream.expectedFeeds = stream.expectedFeeds + 2
    }
  }
}

function hex (key) {
  return Buffer.isBuffer(key) ? key.toString('hex') : key
}

function noop () {}

function nestStorage (storage, prefix) {
  prefix = prefix || ''
  return function (name, opts) {
    let path = p.join(prefix, name)
    if (typeof storage === 'string') return raf(p.join(storage, path))
    return storage(path, opts)
  }
}
