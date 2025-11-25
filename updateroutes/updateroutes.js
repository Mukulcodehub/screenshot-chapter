const express = require("express");
const Screenshot = require("../ScreenshotSchema");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const router = express.Router();


router.post("/macname", async (req, res) => {
  try {
    const { serverMac, macname } = req.body;

    if (!serverMac) {
      return res.status(400).json({
        success: false,
        message: "serverMac is required"
      });
    }

    // Update all records with same MAC
    const updated = await Screenshot.updateMany(
      { serverMac },              // match all documents with this MAC
      { $set: { macname } }       // set new macname
    );

    // If no document exists → create a new one
    if (updated.matchedCount === 0) {
      const newRecord = await Screenshot.create({
        serverMac,
        macname: macname || null
      });

      return res.json({
        success: true,
        message: "MAC not found, new record created",
        created: newRecord
      });
    }

    return res.json({
      success: true,
      message: "macname updated for all matching records",
      matched: updated.matchedCount,
      modified: updated.modifiedCount
    });

  } catch (err) {
    console.error("Update Error:", err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});


module.exports = router;
