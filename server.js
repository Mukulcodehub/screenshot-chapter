
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

dotenv.config();
const app = express();

// JSON + CORS
app.use(express.json({ limit: "20mb" }));
app.use(
  cors({
    origin: ["http://localhost:3000"],
    methods: ["GET", "POST"],
    credentials: true,
  })
);

// Connect DB
connectDB();
app.use("/api/auth", require("./routes/authRoutes.js"));

// Multer Memory Storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// -------- GOOGLE DRIVE OAUTH2 SETUP ----------
// OAuth2 credentials from .env
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "http://localhost:5000/api/drive/oauth2callback";

// OAuth2 Client
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
      // Only migrate if DB doesn't have token
      if (!dbToken) {
        const fileToken = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
        await saveToken(fileToken);
        console.log("✅ Migrated token.json to database");
        // Optionally delete old file (uncomment if you want)
        // fs.unlinkSync(TOKEN_PATH);
      }
    }
  } catch (err) {
    console.warn("⚠️ Token migration skipped:", err.message);
  }
}

// Check if we have valid credentials
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error("❌ ERROR: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env file");
  console.error("Get these from: https://console.cloud.google.com/apis/credentials");
}

// On startup: Migrate old token.json to DB, then load from DB
(async () => {
  // Wait for DB connection
  await new Promise(resolve => setTimeout(resolve, 2000));
  await migrateTokenFromFile();
  const dbToken = await loadToken();
  if (dbToken) {
    oauth2Client.setCredentials(dbToken);
    console.log("✅ Google Drive token loaded from database");
  } else {
    console.log("ℹ️ No Google Drive token found. Please connect via /api/drive/auth-url");
  }
})();

// =========================================================
// 📌 VERIFY FOLDER ACCESS (Helper function)
// =========================================================
async function verifyFolderAccess(folderId, drive) {
  try {
    const folder = await drive.files.get({
      fileId: folderId,
      fields: "id, name, mimeType, owners, shared",
      supportsAllDrives: true,
    });
    
    
    // Check if it's a folder
    if (folder.data.mimeType !== "application/vnd.google-apps.folder") {
      throw new Error("The provided ID is not a folder");
    }
    
    // Log folder owner (for debugging)
    if (folder.data.owners && folder.data.owners.length > 0) {
      const ownerEmail = folder.data.owners[0].emailAddress;
    }
    
    return true;
  } catch (err) {
    // Log full error for debugging
    console.error("Folder access error details:", {
      code: err.code,
      message: err.message,
      response: err.response?.data,
      status: err.response?.status
    });

    if (err.code === 404 || err.response?.status === 404) {
      throw new Error(`Folder not found. Please check the folder ID: ${folderId}. Make sure the folder exists in your Google Drive and you have access to it.`);
    } else if (err.code === 403 || err.response?.status === 403) {
      throw new Error(`Access denied to folder. The OAuth token may not have permission to access this folder. Try reconnecting Google Drive.`);
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
    // Validate buffer
    if (!buffer || buffer.length === 0) {
      throw new Error("Invalid or empty buffer");
    }

    // Create temp file
    tempPath = path.join(__dirname, `temp_${fileName}`);
    fs.writeFileSync(tempPath, buffer);

    // Load OAuth token from DB
    const token = await loadToken();
    if (!token) {
      throw new Error("Google Drive not connected. Please connect your Google account first by visiting /api/drive/auth-url");
    }
    oauth2Client.setCredentials(token);
    // Refresh token if expired
    if (token.expiry_date && Date.now() >= token.expiry_date) {
      const refreshed = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(refreshed.credentials);
      await saveToken(refreshed.credentials);
    }


    const drive = google.drive({ version: "v3", auth: oauth2Client });
    const FOLDER_ID = process.env.GOOGLE_FOLDER_ID;

    if (!FOLDER_ID || FOLDER_ID === "YOUR_SHARED_DRIVE_FOLDER_ID_HERE") {
      throw new Error("Google Drive folder ID not configured. Please set GOOGLE_FOLDER_ID in .env file");
    }

    // Verify folder access before uploading
    await verifyFolderAccess(FOLDER_ID, drive);


    // Upload file
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


    // Make file public
    await drive.permissions.create({
      fileId: file.data.id,
      requestBody: {
        role: "reader",
        type: "anyone",
      },
      supportsAllDrives: true,
    });


    // Clean up temp file
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
    // Clean up temp file on error
    if (tempPath && fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch (cleanupErr) {
        console.error("Failed to cleanup temp file:", cleanupErr);
      }
    }

    // Detailed error logging
    console.error("❌ GOOGLE DRIVE UPLOAD ERROR:");
    console.error("Error Message:", err.message);
    console.error("Error Code:", err.code);
    console.error("Error Details:", err.response?.data || err.errors || "No additional details");
    
    // More specific error messages
    let errorMessage = "Drive Upload Failed";
    if (err.message.includes("not connected") || err.message.includes("OAuth token")) {
      errorMessage = err.message;
    } else if (err.code === 401 || err.message.includes("invalid_grant") || err.message.includes("token")) {
      errorMessage = "Google Drive authentication expired. Please reconnect your Google account by visiting /api/drive/auth-url";
    } else if (err.code === 403) {
      if (err.message.includes("permission")) {
        errorMessage = "Permission denied. Make sure you have access to the folder and it exists in your Google Drive.";
      } else {
        errorMessage = "Permission denied. Please check folder access and try again.";
      }
    } else if (err.code === 404 || err.message.includes("not found")) {
      errorMessage = "Folder not found. Please check the FOLDER_ID in your .env file";
    } else if (err.message) {
      errorMessage = `Drive Upload Failed: ${err.message}`;
    }

    throw new Error(errorMessage);
  }
}


// =========================================================
// 📌 OAUTH2 ROUTES
// =========================================================

// Get OAuth2 authorization URL
app.get("/api/drive/auth-url", (req, res) => {
  try {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res.status(500).json({
        success: false,
        error: "Google OAuth credentials not configured. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env file"
      });
    }

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: ["https://www.googleapis.com/auth/drive"],
      prompt: "consent", // Force consent to get refresh token
    });

    res.json({
      success: true,
      authUrl: authUrl,
      message: "Visit this URL to authorize Google Drive access"
    });
  } catch (err) {
    console.error("Error generating auth URL:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// OAuth2 callback handler
app.get("/api/drive/oauth2callback", async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).send("Error: No authorization code provided");
    }

    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Save DB token instead of file
    await saveToken(tokens);

    // Send success response
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

// List accessible folders (for debugging)
app.get("/api/drive/list-folders", async (req, res) => {
  try {
    const token = await loadToken();
    if (!token) {
      return res.status(400).json({
        success: false,
        error: "Google Drive not connected. Please connect first."
      });
    }

    oauth2Client.setCredentials(token);

    const drive = google.drive({ version: "v3", auth: oauth2Client });

    // List folders
    const response = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: "files(id, name, owners)",
      pageSize: 20,
      orderBy: "modifiedTime desc"
    });

    res.json({
      success: true,
      folders: response.data.files,
      count: response.data.files.length
    });
  } catch (err) {
    console.error("List folders error:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// Check OAuth connection status
app.get("/api/drive/status", async (req, res) => {
  try {
    const token = await loadToken();
    let isConnected = false, tokenInfo = null;

    if (token) {
      oauth2Client.setCredentials(token);
      isConnected = !!token.refresh_token || !!token.access_token;
      tokenInfo = {
        hasRefreshToken: !!token.refresh_token,
        hasAccessToken: !!token.access_token,
        expiresAt: token.expiry_date ? new Date(token.expiry_date).toISOString() : null
      };
    }

    res.json({
      success: true,
      connected: isConnected,
      hasToken: !!token,
      tokenInfo: tokenInfo,
      needsAuth: !isConnected
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// =========================================================
// 📌 ROUTE: Upload Screenshot (WITH SERVER MAC + TIME)
// =========================================================
app.post("/upload-screenshot", upload.single("image"), async (req, res) => {
  try {
    const { userId, deviceInfo } = req.body;

    if (!req.file || !userId) {
      return res.status(400).json({
        success: false,
        error: "Missing image or userId",
      });
    }


    const fileName = `screenshot_${Date.now()}_${userId}.png`;

    let deviceInfoObj = {};
    if (deviceInfo) {
      try {
        deviceInfoObj = JSON.parse(deviceInfo);
      } catch (parseErr) {
        console.warn("⚠️ Failed to parse deviceInfo:", parseErr.message);
      }
    }

    // Get server MAC address
    const serverMac = getServerMAC();

    // Upload to Drive
    const uploaded = await uploadToDrive(req.file.buffer, fileName);
   

const screenshot = await Screenshot.create({
  userId,
  fileName,
  deviceInfo: deviceInfoObj,
  driveFileId: uploaded.id,
  driveURL: uploaded.url,
  serverMac: serverMac,
  createdAt: new Date(),
});


    res.json({
      success: true,
      screenshot,
      viewLink: uploaded.url,
      serverMac: serverMac,
    });

  } catch (err) {
    console.error("❌ UPLOAD ROUTE ERROR:");
    console.error("Error:", err.message);
    console.error("Stack:", err.stack);
    
    res.status(500).json({ 
      success: false, 
      error: err.message,
      details: process.env.NODE_ENV === "development" ? err.stack : undefined
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


