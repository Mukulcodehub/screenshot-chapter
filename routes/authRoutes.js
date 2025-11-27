const express = require("express");
const User = require("../userSchema");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const router = express.Router();

router.post("/auth", async (req, res) => {
  try {
    const { email, password } = req.body;

    // --Validation
    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email & Password required" });
    }

    // Check if user exists
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({ success: false, message: "User does not exist" });
    }

    // Compare Password
    const matchPass = await bcrypt.compare(password, user.password);
    if (!matchPass) {
      return res.status(400).json({ success: false, message: "Invalid password" });
    }

    // Role check: only admin allowed
    if (user.role !== "admin") {
      return res.status(403).json({ success: false, message: "You are not admin" });
    }

    // Create JWT Token
    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    return res.status(200).json({
      success: true,
      message: "Admin login successful",
      token,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });

  } catch (error) {
    console.log("AUTH ERROR:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
