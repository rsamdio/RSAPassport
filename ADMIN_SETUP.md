# Admin System Setup Guide

## Overview

The application now uses an admin-controlled participant system where:
- Only participants added by admin can login
- QR codes are pre-generated and stored as base64 strings in Firestore
- QR codes are displayed directly from the database (no client-side generation issues)

## Setup Steps

### 1. Set Up Admin Access

**IMPORTANT**: Admin access is controlled exclusively through Firestore for security. Never hardcode admin credentials in client-side code.

1. Go to Firebase Console → Firestore Database → Data
2. Create a collection named `admins` (if it doesn't exist)
3. Add a document with your Firebase UID as the document ID
   - To find your UID: Sign in to the app, open browser console, and check `firebase.auth().currentUser.uid`
   - Or use Firebase Console → Authentication → Users to find UIDs
4. The document can be empty (or add `email: "your-email@example.com"` for reference only)

**Security Note**: The Firestore security rules enforce that only users whose UID exists in the `admins` collection can access admin functions. This is the only secure way to manage admin access.

### 2. Configure Firestore Security Rules

See `FIRESTORE_RULES.md` for the complete security rules. The rules include:
- Admin-only access to `admins` and `participants` collections
- User access to their own data and read access for leaderboard

### 3. Access Admin Panel

1. Sign in with your Google account (must be the admin account)
2. Navigate to `admin.html`
3. You'll be able to:
   - Add new participants
   - View all participants
   - View QR codes
   - Delete participants

## How It Works

### Adding Participants

1. Admin fills out the form with:
   - **Participant ID**: Unique identifier for the participant (e.g., P001, ATTENDEE_123)
   - **Name**: Participant's display name
   - **Email**: Email address (used for both contact and Google account login)

2. System automatically:
   - Validates the participant ID is unique
   - Creates a QR code containing the `participantId`
   - Converts QR code to base64 string
   - Saves everything to Firestore

### Participant Login Flow

1. Participant tries to sign in with Google
2. System checks if their email exists in `participants` collection (using email as document ID)
3. If found → Allow login and update participant document with Firebase auth data (uid, displayName, photoURL)
4. If not found → Deny access with error message

### QR Code Display

1. QR codes are pre-generated when admin adds participant
2. QR code is stored as `qrCodeBase64` in the participant document
3. Passport view displays the QR code directly from the database
4. No client-side QR generation needed!

### Scanning Process

1. Scanner reads QR code (contains `participantId`)
2. System checks if this `participantId` has been scanned before
3. If new → Award 10 points and add to connections
4. Connections are stored using `participantId` as the document ID

## Database Structure

### Collections

**`participants`** - All participant data (single source of truth)
```
participants/{email}  // Email is used as document ID for fast lookups
  // Admin-created fields
  - name: string
  - email: string
  - googleEmail: string
  - participantId: string (unique identifier for QR codes)
  - qrCodeBase64: string (base64 image)
  - createdAt: timestamp
  - status: string ("active")
  
  // User data (added on first login)
  - uid: string (Firebase UID)
  - displayName: string (from Google)
  - photoURL: string (from Google)
  - firstLoginAt: timestamp
  
  // Game data (updated during gameplay)
  - score: number (default: 0)
  - rank: string ("Rookie", "Connector", "Super Star")
  - lastLoginAt: timestamp
  
  // Connections subcollection (uses email as document ID)
  - connections/{scannedParticipantEmail}
    - timestamp: timestamp
```

**`admins`** - Admin access control
```
admins/{uid}
  - (can be empty or contain email for reference)
```

**Note**: The `users` collection has been removed. All data is now stored in the `participants` collection for simplicity and efficiency.

## Benefits

✅ **Reliable QR Codes**: Pre-generated, no client-side library issues
✅ **Access Control**: Only registered participants can login
✅ **Efficient**: QR codes loaded instantly from database
✅ **Scalable**: Admin can manage participants easily
✅ **Error-Free**: No QR generation failures

## Troubleshooting

**"Access denied" when trying to login as participant**
- Make sure the participant was added via admin panel
- Verify the Google email matches exactly (case-insensitive)

**"Access denied" when accessing admin panel**
- Check that your UID is in the `admins` collection
- Or set `adminEmail` in `admin.js`

**QR code not displaying**
- Check that `qrCodeBase64` exists in participant document
- Verify Firestore security rules allow read access

