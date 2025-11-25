
const express = require("express");
const Screenshot = require("../ScreenshotSchema");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const router = express.Router();


router.post("/macname", async (req, res) => {
  try {
    const { serverMac } = req.body;

    if (!serverMac) {
      return res.status(400).json({
        success: false,
        message: "serverMac is required"
      });
    }

    // Update all records by setting macname = null
    const updated = await Screenshot.updateMany(
      { serverMac },
      { $set: { macname: null } }
    );

    if (updated.matchedCount === 0) {
      return res.json({
        success: false,
        message: "No records found for this serverMac"
      });
    }

    return res.json({
      success: true,
      message: "macname removed from all matching records",
      matched: updated.matchedCount,
      modified: updated.modifiedCount
    });

  } catch (err) {
    console.error("Delete Error:", err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});



module.exports = router
