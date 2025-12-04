
const express = require("express");
const Screenshot = require("../ScreenshotSchema");

const router = express.Router();


router.post("/deviceUUID", async (req, res) => {
    try {
        const { deviceUUID } = req.body;

        if (!deviceUUID) {
            return res.status(400).json({
                success: false,
                message: "deviceUUID is required"
            });
        }

        // Update all records by setting deviceUUIDname = null
        const updated = await Screenshot.updateMany(
            { deviceUUID },
            { $set: { deviceUUIDname: null } }
        );

        if (updated.matchedCount === 0) {
            return res.json({
                success: false,
                message: "No records found for this deviceUUI"
            });
        }

        return res.json({
            success: true,
            message: "deviceUUIDname removed from all matching records",
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
