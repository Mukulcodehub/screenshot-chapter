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
const Device = require("./DeviceSchema.js");
const crypto = require("crypto");

dotenv.config();
const app = express();

// JSON + CORS
app.use(express.json({ limit: "20mb" }));
app.use(
  cors({
    origin: [
      "https://extensions-screen.vercel.app",'https://screen-shot-new.vercel.app',
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
app.use("/Deviceupdate", require("./deviceuuidroute/Deviceuuidroute.js"));
app.use("/Deviceclear", require("./deviceclearuuidroute/deviceclearuuidroute.js"));
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

async function loadToken() {
  try {
    const t = await Token.findOne({ key: "google_oauth_token" });
    return t ? t.value : null;
  } catch (err) {
    console.warn("⚠️ Could not load stored token from DB:", err.message);
    return null;
  }
}

async function migrateTokenFromFile() {
  const TOKEN_PATH = path.join(__dirname, "token.json");
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      const dbToken = await loadToken();
      if (!dbToken) {
        const fileToken = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
        await saveToken(fileToken);
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
// 📌 CORE: DEVICE IDENTIFICATION (SAME DEVICE = SAME UUID)
// =========================================================
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

// Generate DEVICE-SPECIFIC fingerprint (not browser-specific)
function generateDeviceFingerprint(deviceInfo, clientIP) {
  const normTz = normalizeTimezone(deviceInfo.timezone);
  const normIP = normalizeIP(clientIP);

  const deviceComponents = [
    deviceInfo.hardwareConcurrency || "unknown",
    deviceInfo.deviceMemory || "unknown",
    deviceInfo.cpuThreads || "unknown",

    deviceInfo.screenResolution
      ? `${deviceInfo.screenResolution.width}x${deviceInfo.screenResolution.height}`
      : "unknown",
    deviceInfo.colorDepth || "unknown",
    deviceInfo.pixelDepth || "unknown",

    deviceInfo.os || deviceInfo.platform || "unknown",
    deviceInfo.platform || "unknown",

    normIP || "unknown",
    normTz || "unknown",

    deviceInfo.language || "unknown",

    deviceInfo.maxTouchPoints || "unknown",
    deviceInfo.devicePixelRatio || "unknown",
  ];

  const fingerprintString = deviceComponents.join("::");
  const hash = crypto.createHash("sha256").update(fingerprintString).digest("hex");

  console.log("🖥️ Device Fingerprint Components:");
  console.log("   Hardware Cores:", deviceInfo.hardwareConcurrency);
  console.log(
    "   Screen:",
    deviceInfo.screenResolution
      ? `${deviceInfo.screenResolution.width}x${deviceInfo.screenResolution.height}`
      : "unknown"
  );
  console.log("   OS/Platform:", deviceInfo.os || deviceInfo.platform);
  console.log("   IP:", normIP);
  console.log("   Fingerprint Hash:", hash.substring(0, 32) + "...");

  return hash;
}

// =========================================================
// 📌 FIND DEVICE BY MULTIPLE CRITERIA
// =========================================================
async function findDeviceByHardware({
  visitorId,
  frontendUUID,
  clientIP,
  deviceInfo,
}) {
  try {
    console.log("\n🔍 Searching for existing device...");

    const normIP = normalizeIP(clientIP);
    const deviceFingerprint = generateDeviceFingerprint(deviceInfo, clientIP);

    // 1. FIRST: Check by Visitor ID (FingerprintJS)
    if (visitorId) {
      console.log("👤 Searching by Visitor ID:", visitorId);
      const byVisitorId = await Device.findOne({ visitorId });
      if (byVisitorId) {
        console.log("✅ Found by Visitor ID");
        return {
          device: byVisitorId,
          matchType: "visitor_id",
          confidence: "HIGH",
        };
      }
    }

    // 2. Check by frontend UUID
    if (frontendUUID) {
      console.log("📱 Searching by UUID:", frontendUUID);
      const byUUID = await Device.findOne({ deviceUUID: frontendUUID });
      if (byUUID) {
        console.log("✅ Found by UUID");
        return {
          device: byUUID,
          matchType: "uuid",
          confidence: "HIGH",
        };
      }
    }

    // 3. Check by Device Fingerprint
    console.log("🔑 Searching by Device Fingerprint...");
    const byFingerprint = await Device.findOne({
      fingerprint: deviceFingerprint,
    });
    if (byFingerprint) {
      console.log("✅ Found by Device Fingerprint");
      console.log("   Same Device, Different Browser");
      return {
        device: byFingerprint,
        matchType: "device_fingerprint",
        confidence: "HIGH",
      };
    }

    // 4. Check by IP + Hardware Combination
    if (normIP && deviceInfo.hardwareConcurrency && deviceInfo.screenResolution) {
      const screenRes = `${deviceInfo.screenResolution.width}x${deviceInfo.screenResolution.height}`;

      console.log("🖥️ Searching by IP + Hardware...");
      const byHardware = await Device.findOne({
        $or: [{ ip: normIP }, { ip: { $regex: normIP, $options: "i" } }],
        hardwareConcurrency: deviceInfo.hardwareConcurrency,
        screenResolution: screenRes,
      });

      if (byHardware) {
        console.log("✅ Found by IP + Hardware");
        console.log("   Same Machine, Maybe Different Browser");
        return {
          device: byHardware,
          matchType: "hardware",
          confidence: "MEDIUM",
        };
      }
    }

    // 5. Check by Screen Resolution + OS
    if (deviceInfo.screenResolution && deviceInfo.os) {
      const screenRes = `${deviceInfo.screenResolution.width}x${deviceInfo.screenResolution.height}`;

      console.log("🖥️ Searching by Screen + OS...");
      const byScreenOS = await Device.findOne({
        screenResolution: screenRes,
        $or: [{ os: deviceInfo.os }, { platform: deviceInfo.platform }],
      });

      if (byScreenOS) {
        console.log("✅ Found by Screen + OS");
        return {
          device: byScreenOS,
          matchType: "screen_os",
          confidence: "MEDIUM",
        };
      }
    }

    console.log("🔍 No existing device found");
    return null;
  } catch (error) {
    console.error("Error finding device:", error);
    return null;
  }
}

// =========================================================
// 📌 GET OR CREATE DEVICE UUID (SAME DEVICE = SAME UUID)
// =========================================================
async function getOrCreateDeviceUUID({
  frontendUUID,
  visitorId,
  clientIP,
  deviceInfo,
}) {
  try {
    console.log("\n🔍 DEVICE IDENTIFICATION ===================");
    console.log("📱 Frontend UUID:", frontendUUID || "Not provided");
    console.log("👤 Visitor ID:", visitorId || "Not provided");
    console.log("🌐 Client IP:", clientIP);
    console.log("🖥️ OS:", deviceInfo.os || deviceInfo.platform || "unknown");
    console.log(
      "💻 Hardware Cores:",
      deviceInfo.hardwareConcurrency || "unknown"
    );
    console.log(
      "🖥️ Screen:",
      deviceInfo.screenResolution
        ? `${deviceInfo.screenResolution.width}x${deviceInfo.screenResolution.height}`
        : "unknown"
    );

    const deviceFingerprint = generateDeviceFingerprint(deviceInfo, clientIP);

    // Step 1: Try to find existing device
    const foundDevice = await findDeviceByHardware({
      visitorId,
      frontendUUID,
      clientIP,
      deviceInfo,
    });

    if (foundDevice && foundDevice.device) {
      console.log("\n✅ FOUND EXISTING DEVICE");
      console.log("   UUID:", foundDevice.device.deviceUUID);
      console.log("   Match Type:", foundDevice.matchType);
      console.log("   Confidence:", foundDevice.confidence);
      console.log(
        "   Browser on this device:",
        deviceInfo.browser || "unknown"
      );

      // Update device info (especially if using different browser)
      foundDevice.device.lastSeen = new Date();
      foundDevice.device.visitorId = visitorId || foundDevice.device.visitorId;

      // ✅ FIX: IP ko hamesha STRING ke roop me hi store karna
      let existingIpStr = "";

      if (Array.isArray(foundDevice.device.ip)) {
        // Purane galat data ko normalize karo
        existingIpStr = foundDevice.device.ip.join(", ");
      } else if (typeof foundDevice.device.ip === "string") {
        existingIpStr = foundDevice.device.ip;
      } else if (!foundDevice.device.ip) {
        existingIpStr = "";
      }

      if (!existingIpStr) {
        foundDevice.device.ip = clientIP;
      } else if (!existingIpStr.includes(clientIP)) {
        foundDevice.device.ip = `${existingIpStr}, ${clientIP}`;
      }

      // Update fingerprint
      foundDevice.device.fingerprint = deviceFingerprint;

      // Update browser info (track all browsers used on this device)
      if (deviceInfo.browser) {
        if (!foundDevice.device.browsers) foundDevice.device.browsers = [];
        if (!foundDevice.device.browsers.includes(deviceInfo.browser)) {
          foundDevice.device.browsers.push(deviceInfo.browser);
        }
      }

      await foundDevice.device.save();

      return {
        deviceUUID: foundDevice.device.deviceUUID,
        source: foundDevice.matchType,
        isExisting: true,
        deviceInfo: {
          os: foundDevice.device.os,
          platform: foundDevice.device.platform,
          hardwareCores: foundDevice.device.hardwareConcurrency,
          screen: foundDevice.device.screenResolution,
          browsers: foundDevice.device.browsers || [],
        },
      };
    }

    // Step 2: NO EXISTING DEVICE FOUND - CREATE NEW ONE
    console.log("\n🆕 NO EXISTING DEVICE FOUND - CREATING NEW");

    const newUUID = frontendUUID || require("uuid").v4();

    // Detect browser from userAgent
    let browserType = "unknown";
    const userAgent = deviceInfo.userAgent || "";
    if (userAgent.includes("Firefox")) browserType = "firefox";
    else if (userAgent.includes("Chrome") && !userAgent.includes("Edg"))
      browserType = "chrome";
    else if (userAgent.includes("Safari") && !userAgent.includes("Chrome"))
      browserType = "safari";
    else if (userAgent.includes("Edg")) browserType = "edge";

    console.log("✨ Creating new device with UUID:", newUUID);
    console.log("📝 Device Fingerprint:", deviceFingerprint.substring(0, 32) + "...");
    console.log("🌐 First Browser on this device:", browserType);

    const newDevice = await Device.create({
      deviceUUID: newUUID,
      visitorId: visitorId,
      fingerprint: deviceFingerprint,
      ip: clientIP, // ✅ string
      userAgent: deviceInfo.userAgent || "",
      screenResolution: deviceInfo.screenResolution
        ? `${deviceInfo.screenResolution.width}x${deviceInfo.screenResolution.height}`
        : "",
      timezone: deviceInfo.timezone || "",
      language: deviceInfo.language || "",
      hardwareConcurrency: deviceInfo.hardwareConcurrency || "",
      os: deviceInfo.os || "",
      platform: deviceInfo.platform || "",
      browser: browserType,
      browsers: [browserType],
      lastSeen: new Date(),
      createdAt: new Date(),
    });

    console.log("✅ New device created successfully");

    return {
      deviceUUID: newDevice.deviceUUID,
      source: "new_device",
      isExisting: false,
      deviceInfo: {
        os: newDevice.os,
        platform: newDevice.platform,
        hardwareCores: newDevice.hardwareConcurrency,
        screen: newDevice.screenResolution,
        browser: browserType,
        browsers: newDevice.browsers || [browserType],
      },
    };
  } catch (error) {
    console.error("❌ Device identification error:", error);
    // ❌ NO RANDOM FALLBACK UUID – let caller handle the error
    throw error;
  }
}

// =========================================================
// 📌 UPLOAD SCREENSHOT ROUTE (FINAL VERSION)
// =========================================================
app.post("/upload-screenshot", upload.single("image"), async (req, res) => {
  try {
    const { deviceInfo, visitorId, deviceUUID: frontendUUID } = req.body;

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

    if (!deviceInfoObj.browser) {
      const userAgent = deviceInfoObj.userAgent || "";
      if (userAgent.includes("Firefox")) deviceInfoObj.browser = "firefox";
      else if (userAgent.includes("Chrome") && !userAgent.includes("Edg"))
        deviceInfoObj.browser = "chrome";
      else if (userAgent.includes("Safari") && !userAgent.includes("Chrome"))
        deviceInfoObj.browser = "safari";
      else if (userAgent.includes("Edg")) deviceInfoObj.browser = "edge";
      else deviceInfoObj.browser = "other";
    }

    deviceInfoObj.timezone = normalizeTimezone(deviceInfoObj.timezone);

    // Step 1: Get or Create Device UUID (SAME DEVICE = SAME UUID)
    const deviceResult = await getOrCreateDeviceUUID({
      frontendUUID,
      visitorId,
      clientIP,
      deviceInfo: deviceInfoObj,
    });

    let finalDeviceUUID = deviceResult.deviceUUID;

    // ✅ EXTRA SAFETY: ensure Device doc exists for this UUID
    let deviceDoc = await Device.findOne({ deviceUUID: finalDeviceUUID });

    if (!deviceDoc) {
      console.warn(
        "⚠️ No Device doc found for UUID from deviceResult. Creating one..."
      );
      const deviceFingerprint = generateDeviceFingerprint(
        deviceInfoObj,
        clientIP
      );

      deviceDoc = await Device.create({
        deviceUUID: finalDeviceUUID,
        visitorId,
        fingerprint: deviceFingerprint,
        ip: clientIP,
        userAgent: deviceInfoObj.userAgent || "",
        screenResolution: deviceInfoObj.screenResolution
          ? `${deviceInfoObj.screenResolution.width}x${deviceInfoObj.screenResolution.height}`
          : "",
        timezone: deviceInfoObj.timezone || "",
        language: deviceInfoObj.language || "",
        hardwareConcurrency: deviceInfoObj.hardwareConcurrency || "",
        os: deviceInfoObj.os || "",
        platform: deviceInfoObj.platform || "",
        browsers: [deviceInfoObj.browser || "unknown"],
        lastSeen: new Date(),
        createdAt: new Date(),
      });

      finalDeviceUUID = deviceDoc.deviceUUID;
    }

    console.log("\n✅ FINAL DEVICE DECISION:");
    console.log("   UUID:", finalDeviceUUID);
    console.log("   Source:", deviceResult.source);
    console.log("   Is Existing Device:", deviceResult.isExisting);
    console.log("   Current Browser:", deviceInfoObj.browser);
    console.log(
      "   Same Physical Device:",
      deviceResult.isExisting ? "YES ✅" : "NO (new device)"
    );

    // Step 2: Set LONG-TERM COOKIE (10 YEAR)
    res.cookie("deviceUUID", finalDeviceUUID, {
      maxAge: 10 * 365 * 24 * 60 * 60 * 1000,
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });

    // Step 3: Upload to Google Drive
    const fileName = `screenshot_${Date.now()}_${finalDeviceUUID}.png`;
    const serverMac = getServerMAC();
    const uploaded = await uploadToDrive(req.file.buffer, fileName);

    // Step 4: Save screenshot record
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

    // Step 5: Send response
    res.json({
      success: true,
      screenshot: {
        fileName: screenshot.fileName,
        deviceUUID: screenshot.deviceUUID,
        createdAt: screenshot.createdAt,
      },
      viewLink: uploaded.url,
      serverMac: serverMac,
      deviceUUID: finalDeviceUUID,
      visitorId: visitorId,
      isExistingDevice: deviceResult.isExisting,
      deviceMatchInfo: {
        uuid: finalDeviceUUID,
        source: deviceResult.source,
        physicalDeviceMatch: deviceResult.isExisting,
        currentBrowser: deviceInfoObj.browser,
        allBrowsersOnDevice:
          deviceResult.deviceInfo?.browsers || [deviceInfoObj.browser],
        hardwareInfo: {
          os: deviceResult.deviceInfo?.os || deviceDoc.os,
          platform: deviceResult.deviceInfo?.platform || deviceDoc.platform,
          cores:
            deviceResult.deviceInfo?.hardwareCores ||
            deviceDoc.hardwareConcurrency,
          screen: deviceResult.deviceInfo?.screen || deviceDoc.screenResolution,
        },
      },
      message: `Screenshot captured successfully`,
    });
  } catch (err) {
    console.error("❌ UPLOAD ROUTE ERROR:", err);
    res.status(500).json({
      success: false,
      error: err.message,
      details: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
});

// =========================================================
// 📌 TEST ENDPOINTS
// =========================================================
app.post("/api/test-device-match", async (req, res) => {
  try {
    const { deviceInfo, visitorId, deviceUUID } = req.body;
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

    deviceInfoObj.timezone = normalizeTimezone(deviceInfoObj.timezone);

    const deviceFingerprint = generateDeviceFingerprint(
      deviceInfoObj,
      clientIP
    );

    const matchingDevices = await Device.find({
      $or: [
        { fingerprint: deviceFingerprint },
        { visitorId: visitorId },
        { deviceUUID: deviceUUID },
      ],
    });

    res.json({
      success: true,
      deviceFingerprint: deviceFingerprint,
      totalMatches: matchingDevices.length,
      matches: matchingDevices.map((d) => ({
        deviceUUID: d.deviceUUID,
        visitorId: d.visitorId,
        fingerprintMatch: d.fingerprint === deviceFingerprint,
        os: d.os,
        platform: d.platform,
        hardwareCores: d.hardwareConcurrency,
        screen: d.screenResolution,
        browsers: d.browsers || [],
        lastSeen: d.lastSeen,
        createdAt: d.createdAt,
      })),
      currentDeviceInfo: {
        browser: deviceInfoObj.browser,
        os: deviceInfoObj.os,
        platform: deviceInfoObj.platform,
        hardwareCores: deviceInfoObj.hardwareConcurrency,
        screen: deviceInfoObj.screenResolution,
        ip: clientIP,
        timezone: deviceInfoObj.timezone,
      },
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
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

// =========================================================
// 📌 GET DEVICE DETAILS
// =========================================================
app.get("/api/device/:uuid", async (req, res) => {
  try {
    const { uuid } = req.params;

    const device = await Device.findOne({ deviceUUID: uuid });
    if (!device) {
      return res.status(404).json({
        success: false,
        error: "Device not found",
      });
    }

    const screenshots = await Screenshot.find({ deviceUUID: uuid })
      .sort({ createdAt: -1 })
      .limit(20);

    res.json({
      success: true,
      device: {
        deviceUUID: device.deviceUUID,
        visitorId: device.visitorId,
        fingerprint: device.fingerprint?.substring(0, 32) + "...",
        ip: device.ip,
        os: device.os,
        platform: device.platform,
        hardwareConcurrency: device.hardwareConcurrency,
        screenResolution: device.screenResolution,
        browsers: device.browsers || [],
        timezone: device.timezone,
        createdAt: device.createdAt,
        lastSeen: device.lastSeen,
        totalScreenshots: screenshots.length,
      },
      recentScreenshots: screenshots.map((s) => ({
        fileName: s.fileName,
        createdAt: s.createdAt,
        driveURL: s.driveURL,
      })),
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// =========================================================
// 📌 GET ALL DEVICES
// =========================================================
app.get("/api/devices", async (req, res) => {
  try {
    const devices = await Device.find().sort({ lastSeen: -1 });

    res.json({
      success: true,
      totalDevices: devices.length,
      devices: devices.map((d) => ({
        deviceUUID: d.deviceUUID,
        visitorId: d.visitorId,
        os: d.os,
        platform: d.platform,
        hardwareCores: d.hardwareConcurrency,
        screen: d.screenResolution,
        browsers: d.browsers || [],
        ip: d.ip,
        lastSeen: d.lastSeen,
        createdAt: d.createdAt,
      })),
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
    message: "Server running - Same Device = Same UUID System",
    time: new Date().toISOString(),
    system: "Device-based identification (browser independent)",
  });
});

const PORT = 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
