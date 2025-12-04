const express = require("express");
const Screenshot = require("../ScreenshotSchema");
const router = express.Router();


router.post("/deviceUUID", async (req, res) => {
  try {
    const { deviceUUID, deviceUUIDname } = req.body;

    if (!deviceUUID) {
      return res.status(400).json({
        success: false,
        message: "deviceUUID is required"
      });
    }

    // Update all records with same uuid
    const updated = await Screenshot.updateMany(
      { deviceUUID },              // match all documents with this uuid
      { $set: { deviceUUIDname } }       // set new deviceUUIDname
    );

    // If no document exists → create a new one
    if (updated.matchedCount === 0) {
      const newRecord = await Screenshot.create({
        deviceUUID,
        deviceUUIDname: deviceUUIDname || null
      });

      return res.json({
        success: true,
        message: "uuid not found, new record created",
        created: newRecord
      });
    }

    return res.json({
      success: true,
      message: " deviceUUIDname for all matching records",
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
