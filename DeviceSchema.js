// const mongoose = require("mongoose");

// const DeviceSchema = new mongoose.Schema({
//   deviceUUID: { type: String, required: true },
//   fingerprint: { type: String, required: true, unique: true }, // browser + IP
//   ip: { type: String },
//   createdAt: { type: Date, default: Date.now }
// });

// module.exports = mongoose.model("Device", DeviceSchema);
// DeviceSchema.js
// DeviceSchema.js



// const mongoose = require("mongoose");

// const deviceSchema = new mongoose.Schema({
//   deviceUUID: {
//     type: String,
//     required: true,
//     unique: true,
//   },
//   fingerprint: {
//     type: String,
//     required: true,
//   },
//   visitorId: {
//     type: String,
//   },
//   ip: String,
//   userAgent: String,
//   screenResolution: String,
//   timezone: String,
//   language: String,
//   hardwareConcurrency: Number,
//   platform: String,
//   createdAt: {
//     type: Date,
//     default: Date.now,
//   },
//   lastSeen: {
//     type: Date,
//     default: Date.now,
//   },
// });

// // Indexes for faster matching
// deviceSchema.index({ fingerprint: 1 });
// deviceSchema.index({ visitorId: 1 });
// deviceSchema.index({ ip: 1, userAgent: 1 });
// deviceSchema.index({ platform: 1, hardwareConcurrency: 1 });

// module.exports = mongoose.model("Device", deviceSchema);


// DeviceSchema.js
const mongoose = require("mongoose");

const deviceSchema = new mongoose.Schema({
  deviceUUID: {
    type: String,
    required: true,
    unique: true,
  },
  fingerprint: {
    type: String,
  },
  visitorId: {
    type: String,
  },
  ip: String,
  userAgent: String,
  screenResolution: String,
  timezone: String,
  language: String,
  hardwareConcurrency: Number,
  platform: String,

  timerValue: {
  type: Number,
  default: 0,
},
timerLastUpdated: {
  type: Date,
},

  createdAt: {
    type: Date,
    default: Date.now,
  },
  lastSeen: {
    type: Date,
    default: Date.now,
  },
});

// Indexes for fast lookups
deviceSchema.index({ fingerprint: 1 });
deviceSchema.index({ visitorId: 1 });
deviceSchema.index({ ip: 1, userAgent: 1 });
// deviceSchema.index({ deviceUUID: 1 }, { unique: true });

module.exports = mongoose.model("Device", deviceSchema);
