const mongoose = require('mongoose');

const TokenSchema = new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  value: { type: Object, required: true }
});

const Token = mongoose.model('Token', TokenSchema);
module.exports = Token;
