

const express = require("express");
const { google } = require("googleapis");
const multer = require("multer");
const dotenv = require("dotenv");
const cors = require("cors");
const connectDB = require("./connectDB");
const Screenshot = require("./ScreenshotSchema.js");
const fs = require("fs");
const path = require("path");
const getServerMAC = require("./utils/getMac");
const Token = require("./TokenModel");
const cookieParser = require("cookie-parser");
const Device = require("./DeviceSchema.js"); // Device model

dotenv.config();
const app = express();

// JSON + CORS
app.use(express.json({ limit: "20mb" }));
app.use(
  cors({
    origin: [
      "https://screen-shot-new.vercel.app",
      "http://localhost:3000",
    ],
    methods: ["GET", "POST"],
    credentials: true,
  })
);
app.use(cookieParser());

// Connect DB
connectDB();
app.use("/api/auth", require("./routes/authRoutes.js"));
app.use("/update", require("./updateroutes/updateroutes.js"));
app.use("/clear", require("./clearmac/clearmacroutes.js"));

// Multer Memory Storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// -------- GOOGLE DRIVE OAUTH2 SETUP ----------
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ||
  "http://localhost:5000/api/drive/oauth2callback";

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

// Async DB: Save token
async function saveToken(token) {
  try {
    await Token.findOneAndUpdate(
      { key: "google_oauth_token" },
      { value: token },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.error("❌ Failed to save token to DB:", err.message);
  }
}

// Async DB: Load token
async function loadToken() {
  try {
    const t = await Token.findOne({ key: "google_oauth_token" });
    return t ? t.value : null;
  } catch (err) {
    console.warn("⚠️ Could not load stored token from DB:", err.message);
    return null;
  }
}

// Migrate old token.json to DB (one-time migration)
async function migrateTokenFromFile() {
  const TOKEN_PATH = path.join(__dirname, "token.json");
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      const dbToken = await loadToken();
      if (!dbToken) {
        const fileToken = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
        await saveToken(fileToken);
        console.log("✅ Migrated token.json to database");
        // fs.unlinkSync(TOKEN_PATH);
      }
    }
  } catch (err) {
    console.warn("⚠️ Token migration skipped:", err.message);
  }
}

// Check creds
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error(
    "❌ ERROR: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env file"
  );
  console.error(
    "Get these from: https://console.cloud.google.com/apis/credentials"
  );
}

// On startup: Migrate + load token
(async () => {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await migrateTokenFromFile();
  const dbToken = await loadToken();
  if (dbToken) {
    oauth2Client.setCredentials(dbToken);
    console.log("✅ Google Drive token loaded from database");
  } else {
    console.log(
      "ℹ️ No Google Drive token found. Please connect via /api/drive/auth-url"
    );
  }
})();

// =========================================================
// 📌 VERIFY FOLDER ACCESS
// =========================================================
async function verifyFolderAccess(folderId, drive) {
  try {
    const folder = await drive.files.get({
      fileId: folderId,
      fields: "id, name, mimeType, owners, shared",
      supportsAllDrives: true,
    });

    if (folder.data.mimeType !== "application/vnd.google-apps.folder") {
      throw new Error("The provided ID is not a folder");
    }

    if (folder.data.owners && folder.data.owners.length > 0) {
      const ownerEmail = folder.data.owners[0].emailAddress;
      // console.log("Folder owner:", ownerEmail);
    }

    return true;
  } catch (err) {
    console.error("Folder access error details:", {
      code: err.code,
      message: err.message,
      response: err.response?.data,
      status: err.response?.status,
    });

    if (err.code === 404 || err.response?.status === 404) {
      throw new Error(
        `Folder not found. Please check the folder ID: ${folderId}. Make sure the folder exists in your Google Drive and you have access to it.`
      );
    } else if (err.code === 403 || err.response?.status === 403) {
      throw new Error(
        `Access denied to folder. The OAuth token may not have permission to access this folder. Try reconnecting Google Drive.`
      );
    } else if (err.message) {
      throw new Error(`Failed to access folder: ${err.message}`);
    }
    throw err;
  }
}

// =========================================================
// 📌 UPLOAD FILE TO GOOGLE DRIVE
// =========================================================
async function uploadToDrive(buffer, fileName) {
  let tempPath = null;
  try {
    if (!buffer || buffer.length === 0) {
      throw new Error("Invalid or empty buffer");
    }

    tempPath = path.join(__dirname, `temp_${fileName}`);
    fs.writeFileSync(tempPath, buffer);

    const token = await loadToken();
    if (!token) {
      throw new Error(
        "Google Drive not connected. Please connect your Google account first by visiting /api/drive/auth-url"
      );
    }
    oauth2Client.setCredentials(token);

    if (token.expiry_date && Date.now() >= token.expiry_date) {
      const refreshed = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(refreshed.credentials);
      await saveToken(refreshed.credentials);
    }

    const drive = google.drive({ version: "v3", auth: oauth2Client });
    const FOLDER_ID = process.env.GOOGLE_FOLDER_ID;

    if (!FOLDER_ID || FOLDER_ID === "YOUR_SHARED_DRIVE_FOLDER_ID_HERE") {
      throw new Error(
        "Google Drive folder ID not configured. Please set GOOGLE_FOLDER_ID in .env file"
      );
    }

    await verifyFolderAccess(FOLDER_ID, drive);

    const file = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [FOLDER_ID],
      },
      media: {
        mimeType: "image/png",
        body: fs.createReadStream(tempPath),
      },
      fields: "id, webViewLink",
      supportsAllDrives: true,
    });

    await drive.permissions.create({
      fileId: file.data.id,
      requestBody: {
        role: "reader",
        type: "anyone",
      },
      supportsAllDrives: true,
    });

    if (tempPath && fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }

    return {
      success: true,
      id: file.data.id,
      url: `https://drive.google.com/uc?id=${file.data.id}`,
      webViewLink: file.data.webViewLink,
    };
  } catch (err) {
    if (tempPath && fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch (cleanupErr) {
        console.error("Failed to cleanup temp file:", cleanupErr);
      }
    }

    console.error("❌ GOOGLE DRIVE UPLOAD ERROR:");
    console.error("Error Message:", err.message);
    console.error("Error Code:", err.code);
    console.error(
      "Error Details:",
      err.response?.data || err.errors || "No additional details"
    );

    let errorMessage = "Drive Upload Failed";
    if (
      err.message.includes("not connected") ||
      err.message.includes("OAuth token")
    ) {
      errorMessage = err.message;
    } else if (
      err.code === 401 ||
      err.message.includes("invalid_grant") ||
      err.message.includes("token")
    ) {
      errorMessage =
        "Google Drive authentication expired. Please reconnect your Google account by visiting /api/drive/auth-url";
    } else if (err.code === 403) {
      if (err.message.includes("permission")) {
        errorMessage =
          "Permission denied. Make sure you have access to the folder and it exists in your Google Drive.";
      } else {
        errorMessage =
          "Permission denied. Please check folder access and try again.";
      }
    } else if (err.code === 404 || err.message.includes("not found")) {
      errorMessage =
        "Folder not found. Please check the FOLDER_ID in your .env file";
    } else if (err.message) {
      errorMessage = `Drive Upload Failed: ${err.message}`;
    }

    throw new Error(errorMessage);
  }
}

// =========================================================
// 📌 OAUTH2 ROUTES
// =========================================================
app.get("/api/drive/auth-url", (req, res) => {
  try {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res.status(500).json({
        success: false,
        error:
          "Google OAuth credentials not configured. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env file",
      });
    }

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: ["https://www.googleapis.com/auth/drive"],
      prompt: "consent",
    });

    res.json({
      success: true,
      authUrl: authUrl,
      message: "Visit this URL to authorize Google Drive access",
    });
  } catch (err) {
    console.error("Error generating auth URL:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

app.get("/api/drive/oauth2callback", async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) {
      return res.status(400).send("Error: No authorization code provided");
    }

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    await saveToken(tokens);

    res.send(`
      <html>
        <head><title>Google Drive Connected</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1 style="color: #4CAF50;">✅ Google Drive Connected Successfully!</h1>
          <p>You can now close this window and return to your application.</p>
          <p style="color: #666; margin-top: 30px;">This window will close automatically in 3 seconds...</p>
          <script>
            setTimeout(() => window.close(), 3000);
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send(`
      <html>
        <head><title>Connection Error</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1 style="color: #f44336;">❌ Connection Error</h1>
          <p>${err.message}</p>
          <p>Please try again.</p>
        </body>
      </html>
    `);
  }
});

app.get("/api/drive/list-folders", async (req, res) => {
  try {
    const token = await loadToken();
    if (!token) {
      return res.status(400).json({
        success: false,
        error: "Google Drive not connected. Please connect first.",
      });
    }

    oauth2Client.setCredentials(token);
    const drive = google.drive({ version: "v3", auth: oauth2Client });

    const response = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: "files(id, name, owners)",
      pageSize: 20,
      orderBy: "modifiedTime desc",
    });

    res.json({
      success: true,
      folders: response.data.files,
      count: response.data.files.length,
    });
  } catch (err) {
    console.error("List folders error:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

app.get("/api/drive/status", async (req, res) => {
  try {
    const token = await loadToken();
    let isConnected = false,
      tokenInfo = null;

    if (token) {
      oauth2Client.setCredentials(token);
      isConnected = !!token.refresh_token || !!token.access_token;
      tokenInfo = {
        hasRefreshToken: !!token.refresh_token,
        hasAccessToken: !!token.access_token,
        expiresAt: token.expiry_date
          ? new Date(token.expiry_date).toISOString()
          : null,
      };
    }

    res.json({
      success: true,
      connected: isConnected,
      hasToken: !!token,
      tokenInfo: tokenInfo,
      needsAuth: !isConnected,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// =========================================================
// 📌 DEVICE MATCHING HELPERS (UPDATED)
// =========================================================
function extractBrowserVersion(userAgent) {
  const matches = userAgent.match(/(Chrome|Firefox|Safari|Edge)\/([0-9.]+)/);
  return matches ? `${matches[1]}/${matches[2]}` : userAgent.substring(0, 50);
}

function normalizeTimezone(tz) {
  if (!tz) return tz;
  if (tz === "Asia/Calcutta") return "Asia/Kolkata";
  return tz;
}

function normalizeIP(ip) {
  if (!ip) return ip;
  if (ip === "::1") return "127.0.0.1";
  if (ip.startsWith("::ffff:")) return ip.replace("::ffff:", "");
  return ip;
}

function generateEnhancedFingerprint(deviceInfo, req, clientIP) {
  const normTz = normalizeTimezone(deviceInfo.timezone);
  const normIP = normalizeIP(clientIP);

  const components = [
    deviceInfo.screenResolution
      ? `${deviceInfo.screenResolution.width}x${deviceInfo.screenResolution.height}`
      : "",
    deviceInfo.cpuThreads || deviceInfo.hardwareConcurrency || "",
    deviceInfo.deviceMemory || "",
    normTz || "",
    deviceInfo.language || "",
    deviceInfo.os || deviceInfo.platform || "",
    deviceInfo.userAgent ? extractBrowserVersion(deviceInfo.userAgent) : "",
    normIP || clientIP,
    deviceInfo.colorDepth || "",
    deviceInfo.pixelDepth || "",
    deviceInfo.maxTouchPoints || "",
  ];

  return components.filter((val) => val && val !== "").join("|");
}

async function findDeviceByMultipleCriteria({
  visitorId,
  deviceUUID,
  fingerprint,
  clientIP,
  deviceInfo,
}) {
  try {
    const normIP = normalizeIP(clientIP);
    const normTz = normalizeTimezone(deviceInfo.timezone);
    const hardwareThreads =
      deviceInfo.cpuThreads || deviceInfo.hardwareConcurrency;
    const platform = deviceInfo.os || deviceInfo.platform || "unknown";

    // 1️⃣ Sabse pehle UUID se
    if (deviceUUID) {
      const byDeviceUUID = await Device.findOne({ deviceUUID });
      if (byDeviceUUID) {
        console.log("📍 Found device by deviceUUID (primary)");
        return byDeviceUUID;
      }
    }

    // 2️⃣ Phir visitorId
    if (visitorId) {
      const byVisitorId = await Device.findOne({ visitorId });
      if (byVisitorId) {
        console.log("📍 Found device by visitorId");
        return byVisitorId;
      }
    }

    // 3️⃣ Fingerprint
    if (fingerprint) {
      const byFingerprint = await Device.findOne({ fingerprint });
      if (byFingerprint) {
        console.log("📍 Found device by fingerprint");
        return byFingerprint;
      }
    }

    // 4️⃣ IP + UserAgent
    if (normIP && deviceInfo.userAgent) {
      const byIPAndUA = await Device.findOne({
        ip: { $in: [normIP, clientIP] },
        userAgent: {
          $regex: deviceInfo.userAgent.substring(0, 80),
          $options: "i",
        },
      });
      if (byIPAndUA) {
        console.log("📍 Found device by IP + UserAgent");
        return byIPAndUA;
      }
    }

    // 5️⃣ Hardware characteristics (strict)
    if (deviceInfo.screenResolution && normTz) {
      const screenRes = `${deviceInfo.screenResolution.width}x${deviceInfo.screenResolution.height}`;

      const hardwareQuery = {
        screenResolution: screenRes,
        timezone: normTz,
      };

      if (hardwareThreads) {
        hardwareQuery.hardwareConcurrency = hardwareThreads;
      }

      const byHardware = await Device.findOne(hardwareQuery);
      if (byHardware) {
        console.log("📍 Found device by hardware characteristics (strict)");
        return byHardware;
      }
    }

    // 6️⃣ Loose hardware match (just in case)
    if (hardwareThreads && platform !== "unknown") {
      const looseQuery = {
        platform: platform,
        hardwareConcurrency: hardwareThreads,
      };

      if (normIP === "127.0.0.1") {
        const byLooseHardware = await Device.findOne(looseQuery);
        if (byLooseHardware) {
          console.log(
            "📍 Found device by loose hardware (platform + threads, local dev)"
          );
          return byLooseHardware;
        }
      } else {
        const byLooseHardware = await Device.findOne({
          ...looseQuery,
          ip: normIP,
        });
        if (byLooseHardware) {
          console.log(
            "📍 Found device by loose hardware (platform + threads + ip)"
          );
          return byLooseHardware;
        }
      }
    }

    console.log("🔍 No existing device found in matcher");
    return null;
  } catch (error) {
    console.error("Error in device finding:", error);
    return null;
  }
}

// =========================================================
// 📌 ROUTE: Upload Screenshot (WITH DEVICE MATCHING)
// =========================================================
app.post("/upload-screenshot", upload.single("image"), async (req, res) => {
  try {
    const { deviceInfo, visitorId, deviceUUID } = req.body;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "Missing image or file",
      });
    }

    const rawIP =
      req.headers["x-forwarded-for"] || req.connection.remoteAddress;
    const clientIP = normalizeIP(rawIP);

    let deviceInfoObj = {};
    if (deviceInfo) {
      try {
        deviceInfoObj =
          typeof deviceInfo === "string" ? JSON.parse(deviceInfo) : deviceInfo;
      } catch (e) {
        console.warn("Failed to parse deviceInfo:", e.message);
      }
    }

    // normalize timezone in object
    deviceInfoObj.timezone = normalizeTimezone(deviceInfoObj.timezone);

    const fingerprint = generateEnhancedFingerprint(
      deviceInfoObj,
      req,
      clientIP
    );

    console.log("🔍 Device Identification Debug:");
    console.log("Visitor ID:", visitorId);
    console.log("Device UUID from frontend:", deviceUUID);
    console.log("Generated Fingerprint:", fingerprint.substring(0, 60) + "...");
    console.log("IP:", clientIP);
    console.log(
      "User Agent:",
      deviceInfoObj.userAgent?.substring(0, 60) + "..."
    );

    // 1) Try normal matcher
    let deviceRecord = await findDeviceByMultipleCriteria({
      visitorId,
      deviceUUID,
      fingerprint,
      clientIP,
      deviceInfo: deviceInfoObj,
    });

    // 2) EXTRA: last-chance fallback BEFORE create → same machine by hardware
    if (!deviceRecord) {
      const hardwareThreads =
        deviceInfoObj.cpuThreads || deviceInfoObj.hardwareConcurrency;
      const platform = deviceInfoObj.os || deviceInfoObj.platform || "unknown";

      if (hardwareThreads && platform !== "unknown") {
        const looseQuery = {
          platform: platform,
          hardwareConcurrency: hardwareThreads,
        };

        console.log("🪪 Fallback hardware search with:", looseQuery);

        const existingByHardware = await Device.findOne(looseQuery);
        if (existingByHardware) {
          console.log(
            "✅ Reusing existing device from fallback hardware match:",
            existingByHardware.deviceUUID
          );
          deviceRecord = existingByHardware;
        }
      }
    }

    if (!deviceRecord) {
      console.log("🆕 Creating new device record");
      const finalDeviceUUID =
        deviceUUID || visitorId || require("uuid").v4(); 
      deviceRecord = await Device.create({
        deviceUUID: finalDeviceUUID,
        visitorId: visitorId,
        fingerprint: fingerprint,
        ip: clientIP,
        userAgent: deviceInfoObj.userAgent || req.headers["user-agent"],
        screenResolution: deviceInfoObj.screenResolution
          ? `${deviceInfoObj.screenResolution.width}x${deviceInfoObj.screenResolution.height}`
          : "",
        timezone: deviceInfoObj.timezone || "",
        language: deviceInfoObj.language || "",
        hardwareConcurrency:
          deviceInfoObj.cpuThreads || deviceInfoObj.hardwareConcurrency,
        platform: deviceInfoObj.os || "",
        lastSeen: new Date(),
      });
    } else {
      console.log("✅ Found existing device:", deviceRecord.deviceUUID);
      deviceRecord.lastSeen = new Date();
      deviceRecord.visitorId = visitorId || deviceRecord.visitorId;
      deviceRecord.fingerprint = fingerprint;
      deviceRecord.ip = clientIP;
      deviceRecord.timezone =
        deviceInfoObj.timezone || deviceRecord.timezone;
      await deviceRecord.save();
    }

    const finalDeviceUUID = deviceRecord.deviceUUID;

    res.cookie("deviceUUID", finalDeviceUUID, {
      maxAge: 365 * 24 * 60 * 60 * 1000,
      path: "/",
      httpOnly: true,
      sameSite: "lax",
    });

    const fileName = `screenshot_${Date.now()}_${finalDeviceUUID}.png`;

    const serverMac = getServerMAC();
    const uploaded = await uploadToDrive(req.file.buffer, fileName);

    const screenshot = await Screenshot.create({
      fileName,
      deviceUUID: finalDeviceUUID,
      deviceInfo: deviceInfoObj,
      driveFileId: uploaded.id,
      driveURL: uploaded.url,
      serverMac: serverMac,
      macname: null,
      createdAt: new Date(),
    });

    console.log("📸 Screenshot saved for device:", finalDeviceUUID);

    res.json({
      success: true,
      screenshot,
      viewLink: uploaded.url,
      serverMac: serverMac,
      deviceUUID: finalDeviceUUID,
      visitorId: visitorId,
      message: `Screenshot captured for device ${finalDeviceUUID.substring(
        0,
        16
      )}...`,
    });
  } catch (err) {
    console.error("❌ UPLOAD ROUTE ERROR:", err);
    res.status(500).json({
      success: false,
      error: err.message,
      details:
        process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
});

// =========================================================
// 📌 GET ALL SCREENSHOTS
// =========================================================
app.get("/screenshots", async (req, res) => {
  try {
    const data = await Screenshot.find().sort({ createdAt: -1 });
    res.json({ success: true, screenshots: data });
  } catch (err) {
    console.error("GET ERROR:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Debug route
app.get("/api/debug-devices", async (req, res) => {
  try {
    const devices = await Device.find().sort({ lastSeen: -1 }).limit(10);

    const debugInfo = devices.map((device) => ({
      deviceUUID: device.deviceUUID,
      visitorId: device.visitorId,
      fingerprint: device.fingerprint?.substring(0, 50) + "...",
      ip: device.ip,
      userAgent: device.userAgent?.substring(0, 50) + "...",
      screenResolution: device.screenResolution,
      timezone: device.timezone,
      hardwareConcurrency: device.hardwareConcurrency,
      platform: device.platform,
      lastSeen: device.lastSeen,
    }));

    res.json({
      success: true,
      totalDevices: await Device.countDocuments(),
      recentDevices: debugInfo,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Health Check
app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "Server running",
    time: new Date().toISOString(),
  });
});

const PORT = 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));











