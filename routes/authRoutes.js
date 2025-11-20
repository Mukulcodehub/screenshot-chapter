const express = require("express");
const User = require("../userSchema");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const router = express.Router();

// ------------------ AUTH (Login or Register) ------------------
router.post("/auth", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email & Password required" });
    }

    // Check if user exists
    let user = await User.findOne({ email });

    if (user) {
      // ✅ User exists → LOGIN
      const matchPass = await bcrypt.compare(password, user.password);
      if (!matchPass) {
        return res.status(400).json({ success: false, message: "Invalid credentials" });
      }

    } else {
      // ✅ User does not exist → REGISTER
      if (!name) {
        return res.status(400).json({ success: false, message: "Name is required for registration" });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      user = await User.create({
        name,
        email,
        password: hashedPassword,
        role:"user"
      });
    }

    // Create JWT Token
    const token = jwt.sign(
      { id: user._id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      success: true,
      message: "Authentication successful",
      token,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role:user.role
      }
    });

  } catch (error) {
    console.log("AUTH ERROR:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;

