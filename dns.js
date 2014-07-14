
/**
 * DataWriter writes data to an ArrayBuffer, presenting it as the instance
 * variable 'buffer'.
 *
 * @constructor
 */
var DataWriter = function(opt_size) {
  var loc = 0;
  var view = new Uint8Array(new ArrayBuffer(opt_size || 512));

  this.byte_ = function(v) {
    view[loc] = v;
    ++loc;
    this.buffer = view.buffer.slice(0, loc);
  }.bind(this);
};

DataWriter.prototype.byte = function(v) {
  this.byte_(v);
  return this;
};

DataWriter.prototype.short = function(v) {
  return this.byte((v >> 8) & 0xff).byte(v & 0xff);
};

DataWriter.prototype.long = function(v) {
  return this.short((v >> 16) & 0xffff).short(v & 0xffff);
};

/**
 * Writes a DNS name. If opt_ref is specified, will finish this name with a
 * suffix reference (i.e., 0xc0 <ref>). If not, then will terminate with a NULL
 * byte.
 */
DataWriter.prototype.name = function(v, opt_ref) {
  var parts = v.split('.');
  parts.forEach(function(part) {
    this.byte(part.length);
    for (var i = 0; i < part.length; ++i) {
      this.byte(part.charCodeAt(i));
    }
  }.bind(this));
  if (opt_ref) {
    this.byte(0xc0).byte(opt_ref);
  } else {
    this.byte(0);
  }
  return this;
};

/**
 * DataConsumer consumes data from an ArrayBuffer.
 *
 * @constructor
 */
var DataConsumer = function(arg) {
  if (arg instanceof Uint8Array) {
    this.view_ = arg;
  } else {
    this.view_ = new Uint8Array(arg);
  }
  this.loc_ = 0;
};

/**
 * @return whether this DataConsumer has consumed all its data
 */
DataConsumer.prototype.isEOF = function() {
  return this.loc_ >= this.view_.byteLength;
};

/**
 * @param length {integer} number of bytes to return from the front of the view
 * @return a Uint8Array 
 */
DataConsumer.prototype.slice = function(length) {
  var view = this.view_.subarray(this.loc_, this.loc_ + length);
  this.loc_ += length;
  return view;
};

DataConsumer.prototype.byte = function() {
  this.loc_ += 1;
  return this.view_[this.loc_ - 1];
};

DataConsumer.prototype.short = function() {
  return (this.byte() << 8) + this.byte();
};

DataConsumer.prototype.long = function() {
  return (this.short() << 16) + this.short();
};

/**
 * Consumes a DNS name, which will either finish with a NULL byte or a suffix
 * reference (i.e., 0xc0 <ref>).
 */
DataConsumer.prototype.name = function() {
  var parts = [];
  for (;;) {
    var len = this.byte();
    if (!len) {
      break;
    } else if (len == 0xc0) {
      // TODO: This indicates a pointer to another valid name inside the
      // DNSPacket, and is always a suffix: we're at the end of the name.
      // We should probably hold onto this value instead of discarding it.
      var ref = this.byte();
      break;
    }

    // Otherwise, consume a string!
    var v = '';
    while (len-- > 0) {
      v += String.fromCharCode(this.byte());
    }
    parts.push(v);
  }
  return parts.join('.');
};

/**
 * Consumes a DNS character string
 * @returns an array of strings found
 */
DataConsumer.prototype.string = function() {
  var parts = [];
  for (;;) {
    var len = this.byte();
    if (!len) {
      break;
    }

    // Otherwise, consume a string!
    var v = '';
    while (len-- > 0) {
      v += String.fromCharCode(this.byte());
    }
    parts.push(v);
  }
  return parts;
};

/**
 * DNSPacket holds the state of a DNS packet. It can be modified or serialized
 * in-place.
 *
 * @constructor
 */
var DNSPacket = function(opt_id, opt_flags) {
  this.id_    = opt_id;
  this.flags_ = opt_flags || 0; /* uint16 */
  this.data_ = {'qd': [], 'an': [], 'ns': [], 'ar': []};
};

/**
 * Parse a DNSPacket from an ArrayBuffer (or Uint8Array).
 */
DNSPacket.parse = function(buffer) {
  var consumer = new DataConsumer(buffer);
  var id = consumer.short();
  // if (consumer.short()) {
  //   throw new Error('DNS packet must start with 00 00');
  // }
  var flags = consumer.short();
  var count = {
    'qd': consumer.short(),
    'an': consumer.short(),
    'ns': consumer.short(),
    'ar': consumer.short(),
  };
  var packet = new DNSPacket(id, flags);

  // Parse the QUESTION section.
  for (var i = 0; i < count['qd']; ++i) {
    var part = new DNSRecord(
        consumer.name(),
        consumer.short(),  // type
        consumer.short()); // class
    packet.push('qd', part);
  }

  // Parse the ANSWER, AUTHORITY and ADDITIONAL sections.
  ['an', 'ns', 'ar'].forEach(function(section) {
    for (var i = 0; i < count[section]; ++i) {
      var part = new DNSRecord(
          consumer.name(),
          consumer.short(), // type
          consumer.short(), // class
          consumer.long(),  // ttl
          consumer.slice(consumer.short()));
      packet.push(section, part);
    }
  });

  consumer.isEOF() || console.warn('was not EOF on incoming packet');
  return packet;
};

DNSPacket.prototype.push = function(section, record) {
  this.data_[section].push(record);
};

DNSPacket.prototype.each = function(section) {
  var filter = false;
  var call;
  if (arguments.length == 2) {
    call = arguments[1];
  } else {
    filter = arguments[1];
    call = arguments[2];
  }
  this.data_[section].forEach(function(rec) {
    if (!filter || rec.type == filter) {
      call(rec);
    }
  });
};

/**
 * Serialize this DNSPacket into an ArrayBuffer for sending over UDP.
 */
DNSPacket.prototype.serialize = function() {
  var out = new DataWriter();
  var s = ['qd', 'an', 'ns', 'ar'];

  out.short(this.id_).short(this.flags_);

  s.forEach(function(section) {
    out.short(this.data_[section].length);
  }.bind(this));

  s.forEach(function(section) {
    this.data_[section].forEach(function(rec) {
      out.name(rec.name).short(rec.type).short(rec.cl);

      if (section != 'qd') {
        // TODO: implement .bytes()
        throw new Error('can\'t yet serialize non-QD records');
//        out.long(rec.ttl).bytes(rec.data_);
      }
    });
  }.bind(this));

  return out.buffer;
};

/**
 * DNSRecord is a record inside a DNS packet; e.g. a QUESTION, or an ANSWER,
 * AUTHORITY, or ADDITIONAL record. Note that QUESTION records are special,
 * and do not have ttl or data.
 */
var DNSRecord = function(name, type, cl, opt_ttl, opt_data) {
  this.name = name;
  this.type = type;
  this.cl = cl;

  this.isQD = (arguments.length == 3);
  if (!this.isQD) {
    this.ttl = opt_ttl;
    this.data_ = opt_data;

    if (this.data_) {
      this.data = DNSRecord.parseType(type, this.data_);
      console.log('type: %o, value: %o, name: %o, data: %o', DNSRecord.TYPES[type] || '-', type , this.name || '-', this.data);
    }
  }
};

DNSRecord.TYPES = {
  'A'   :  1,  1: 'A',
  'PTR' : 12, 12: 'PTR',
  'TXT' : 16, 16: 'TXT',
  // 'AAAA': 28, 28: 'AAAA',
  'SRV' : 33, 33: 'SRV'
};

DNSRecord.TYPE_PARSERS = {};

DNSRecord.TYPE_PARSERS.A = function (data) {
  var consumer = new DataConsumer(data);
  return {
    'address': [ consumer.byte(), consumer.byte(), consumer.byte(), consumer.byte() ].join('.')
  };
};

// DNSRecord.TYPE_PARSERS.AAAA = function (data) {
//   var consumer = new DataConsumer(data);
//   return {
//     'address': [ 
//       consumer.byte(), consumer.byte(), consumer.byte(), consumer.byte(),
//       consumer.byte(), consumer.byte(), consumer.byte(), consumer.byte()
//      ].join(':')
//   };
// };

DNSRecord.TYPE_PARSERS.PTR = function (data) {
  var consumer = new DataConsumer(data);
  return {
    'ptrdname': consumer.name()
  };
};

DNSRecord.TYPE_PARSERS.SRV = function (data) {
  var consumer = new DataConsumer(data);
  return {
    priority: consumer.short(),
    weight  : consumer.short(),
    port    : consumer.short(),
    host    : consumer.name()
  };
};

DNSRecord.TYPE_PARSERS.TXT = function (data) {
  var consumer = new DataConsumer(data);
  return {
    txtdata: consumer.string()
  };
};

DNSRecord.parseType = function (typeCode, data) {
  var type   = DNSRecord.TYPES[typeCode],
      parser = DNSRecord.TYPE_PARSERS[ type ],
      fields = {};

  if (typeof parser === 'function') {
    fields = parser(data);
  }

  return fields;
};

DNSRecord.prototype.asName = function() {
  return new DataConsumer(this.data_).name();
};
