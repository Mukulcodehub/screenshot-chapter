# Google Drive OAuth Setup Guide

## Step 1: Create OAuth Credentials in Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select your project (or create a new one)
3. Navigate to **APIs & Services** → **Credentials**
4. Click **+ CREATE CREDENTIALS** → **OAuth client ID**
5. If prompted, configure the OAuth consent screen first:
   - Choose **External** (unless you have Workspace)
   - Fill in required fields (App name, User support email, Developer contact)
   - Add scopes: `https://www.googleapis.com/auth/drive.file`
   - Save and continue
6. Back to creating OAuth client:
   - Application type: **Web application**
   - Name: `Screenshot App` (or any name)
   - Authorized redirect URIs: `http://localhost:5000/api/drive/oauth2callback`
   - Click **Create**
7. Copy the **Client ID** and **Client Secret**

## Step 2: Update .env File

Add these to your `backend/.env` file:

```env
# Google OAuth2 Credentials (REPLACE WITH YOUR VALUES)
GOOGLE_CLIENT_ID='your-client-id-here.apps.googleusercontent.com'
GOOGLE_CLIENT_SECRET='your-client-secret-here'
GOOGLE_REDIRECT_URI='http://localhost:5000/api/drive/oauth2callback'

# Google Drive Folder ID (your folder where screenshots will be saved)
GOOGLE_FOLDER_ID='12bTAIladQb-S5nZ4q-ZqBfrLZO_9EQW9'
```

## Step 3: Remove Service Account Credentials (Optional)

You can remove these from .env (no longer needed):
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `GOOGLE_CREDENTIALS_PATH`
- `GOOGLE_PROJECT_ID`

You can also delete `credentials.json` file if you want.

## Step 4: Restart Backend Server

```powershell
cd backend
npm run dev
```

## Step 5: Connect Google Drive in Frontend

1. Start your frontend: `npm start`
2. Open http://localhost:3000
3. Click **"Connect Google Drive"** button
4. Sign in with your Google account
5. Grant permissions
6. The window will close automatically
7. Status will show "✅ Connected"

## How It Works

- **First time**: User clicks "Connect Google Drive" → Signs in → Grants permission
- **After that**: Token is saved automatically, uploads work without re-authentication
- **Token refresh**: Automatically refreshes expired tokens
- **Storage**: Files are saved to YOUR Google Drive (uses your storage quota)

## Troubleshooting

### "Google Drive not connected" error
- Make sure you clicked "Connect Google Drive" and completed the sign-in
- Check that `token.json` file exists in `backend/` folder
- Try disconnecting and reconnecting

### "Invalid client" error
- Check that `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are correct in `.env`
- Make sure redirect URI matches: `http://localhost:5000/api/drive/oauth2callback`

### "Folder not found" error
- Verify `GOOGLE_FOLDER_ID` in `.env` is correct
- Make sure the folder exists in your Google Drive
- The folder should be in YOUR Drive (not shared from service account)

## Notes

- Token is stored in `backend/token.json` (keep this secure, don't commit to git)
- Add `token.json` to `.gitignore` if not already there
- Token automatically refreshes when expired
- One-time setup: After first connection, it works automatically

