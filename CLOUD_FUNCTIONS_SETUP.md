# Cloud Functions Setup for RTDB Cache Synchronization

## Overview

Cloud Functions automatically keep RTDB caches in sync with Firestore data changes. This ensures:
- **Data Consistency**: RTDB always reflects current Firestore state
- **Security**: Only server-side code can update caches
- **Reliability**: Automatic updates on all data changes
- **Performance**: No client-side cache update overhead

## Setup Instructions

### 1. Install Firebase CLI

```bash
npm install -g firebase-tools
```

### 2. Initialize Functions (if not already done)

```bash
cd functions
npm install
```

### 3. Deploy Functions

```bash
# Deploy all functions
firebase deploy --only functions

# Or deploy specific functions
firebase deploy --only functions:onUserScoreUpdate
firebase deploy --only functions:onUserCreate
firebase deploy --only functions:onUserDelete
firebase deploy --only functions:refreshLeaderboard
firebase deploy --only functions:refreshAllCaches
```

## Available Functions

### Automatic Triggers

#### `onUserScoreUpdate`
- **Trigger**: Firestore document update in `users/{uid}`
- **Purpose**: Updates RTDB caches when user data changes
- **Updates**:
  - User score cache (`scores/{uid}`)
  - QR code data (`qrcodes/{qrToken}`) if name/photo changed
  - Leaderboard cache if score changed
  - Recent connections cache if scanHistory changed

#### `onUserCreate`
- **Trigger**: New document created in `users/{uid}`
- **Purpose**: Initialize RTDB caches for new users
- **Creates**:
  - Score cache
  - QR code entry
  - Recent connections cache
  - Updates leaderboard cache

#### `onUserDelete`
- **Trigger**: Document deleted from `users/{uid}`
- **Purpose**: Clean up RTDB caches when user is deleted
- **Removes**:
  - Score cache
  - QR code entry
  - Recent connections cache
  - Updates leaderboard cache

### Manual Triggers (Callable Functions)

#### `refreshLeaderboard`
- **Type**: HTTPS Callable
- **Access**: Admin only
- **Purpose**: Manually refresh leaderboard cache
- **Usage**:
```javascript
const refreshLeaderboard = firebase.functions().httpsCallable('refreshLeaderboard');
await refreshLeaderboard();
```

#### `refreshAllCaches`
- **Type**: HTTPS Callable
- **Access**: Admin only
- **Purpose**: Refresh all RTDB caches (useful for migration/fixing inconsistencies)
- **Usage**:
```javascript
const refreshAllCaches = firebase.functions().httpsCallable('refreshAllCaches');
await refreshAllCaches();
```

## Client-Side Changes

After deploying Cloud Functions, you can **remove** client-side cache updates from `app.js`:

### Functions to Remove/Simplify:

1. **`updateRTDBCachesAfterScan()`** - Can be simplified or removed
   - Cloud Functions will handle updates automatically
   - Keep only if you want immediate UI updates

2. **`updateLeaderboardCache()`** - Can be removed
   - Cloud Functions handle this automatically

3. **`updateUserScoreCache()`** - Can be removed
   - Cloud Functions handle this automatically

4. **`updateRecentConnectionsCache()`** - Can be removed
   - Cloud Functions handle this automatically

### Recommended Approach:

**Option 1: Full Cloud Functions (Recommended)**
- Remove all client-side cache update functions
- Keep only cache reads (which already have Firestore fallbacks)
- Let Cloud Functions handle all writes

**Option 2: Hybrid Approach**
- Keep client-side updates for immediate UI feedback
- Cloud Functions ensure consistency in background
- Provides best user experience

## RTDB Security Rules Update

With Cloud Functions handling writes, you can tighten RTDB security rules:

```json
{
  "rules": {
    "qrcodes": {
      "$token": {
        ".read": "auth != null",
        ".write": false  // Only Cloud Functions can write
      }
    },
    "leaderboard": {
      "top10": {
        ".read": "auth != null",
        ".write": false  // Only Cloud Functions can write
      }
    },
    "scores": {
      "$uid": {
        ".read": "auth != null",
        ".write": false  // Only Cloud Functions can write
      }
    },
    "recentConnections": {
      "$uid": {
        ".read": "auth != null && $uid == auth.uid",
        ".write": false  // Only Cloud Functions can write
      }
    }
  }
}
```

## Testing

### Test Automatic Triggers

1. **Test Score Update**:
   ```javascript
   // In Firestore console or admin panel
   // Update a user's score
   // Check RTDB: scores/{uid} should update automatically
   ```

2. **Test New User**:
   ```javascript
   // Create a new user in Firestore
   // Check RTDB: All caches should be created automatically
   ```

3. **Test User Delete**:
   ```javascript
   // Delete a user from Firestore
   // Check RTDB: All caches should be removed automatically
   ```

### Test Manual Triggers

```javascript
// In browser console or admin panel
const functions = firebase.functions();
const refreshLeaderboard = functions.httpsCallable('refreshLeaderboard');
await refreshLeaderboard();
```

## Monitoring

View function logs:
```bash
firebase functions:log
```

View specific function logs:
```bash
firebase functions:log --only onUserScoreUpdate
```

## Cost Considerations

- **Function Invocations**: ~1 per user update (very cheap)
- **Firestore Reads**: ~1-2 per function invocation (for leaderboard updates)
- **RTDB Writes**: Included in function execution
- **Overall**: Minimal cost, significant reliability improvement

## Troubleshooting

### Functions Not Triggering

1. Check function deployment:
   ```bash
   firebase functions:list
   ```

2. Check function logs:
   ```bash
   firebase functions:log
   ```

3. Verify Firestore triggers are enabled in Firebase Console

### Cache Not Updating

1. Check RTDB security rules allow Cloud Functions to write
2. Check function logs for errors
3. Verify function has proper permissions

### Performance Issues

- Functions run in parallel where possible
- Leaderboard updates are batched
- Consider increasing function timeout if needed

## Migration Strategy

1. **Deploy Cloud Functions** (they won't interfere with existing code)
2. **Test thoroughly** in staging environment
3. **Update RTDB security rules** to restrict client writes
4. **Remove client-side cache updates** from app.js
5. **Monitor** function logs for any issues

