const mongoose = require("mongoose");

// const ScreenshotSchema = new mongoose.Schema({
//   userId: String,
//   fileName: String,
//   deviceInfo: Object,
//   createdAt: {
//     type: Date,
//     default: Date.now
//   }
// });
const ScreenshotSchema = new mongoose.Schema({
  userId: String,
  fileName: String,
  deviceInfo: Object,
  driveURL: String,
  driveFileId: String,
  serverMac: String,
  createdAt: {
    type: Date,
    default: Date.now
  },
    macname: {
  type: String,
  required: false,
  default: null,
},
});

module.exports = mongoose.model("Screenshot", ScreenshotSchema);
