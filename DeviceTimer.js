// DeviceTimer.js
const mongoose = require("mongoose");

const deviceTimerSchema = new mongoose.Schema({
  deviceUUID: {
    type: String,
    required: true,
    unique: true,
  },
  seconds: {
    type: Number,
    default: 0,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

deviceTimerSchema.index({ deviceUUID: 1 });

module.exports = mongoose.model("DeviceTimer", deviceTimerSchema);
