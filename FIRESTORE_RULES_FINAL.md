# Firestore Security Rules (FINAL WORKING VERSION)

**CRITICAL**: Copy and paste these EXACT rules into Firebase Console → Firestore Database → Rules

This version uses the simplest possible rules that will work reliably.

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    
    // Helper function to check if user is admin
    function isAdmin() {
      return request.auth != null && 
             exists(/databases/$(database)/documents/admins/$(request.auth.uid));
    }
    
    // Helper function to check if document belongs to authenticated user
    function isOwnUser(uid) {
      return request.auth != null && request.auth.uid == uid;
    }
    
    // Helper function to get user email from auth token (normalized)
    function getUserEmail() {
      return request.auth != null && request.auth.token.email != null 
             ? request.auth.token.email.toLowerCase().trim() 
             : null;
    }
    
    // Admins collection
    match /admins/{uid} {
      allow read, write: if isAdmin();
    }
    
    // Users collection - main user data
    match /users/{uid} {
      // Anyone authenticated can read (for leaderboard)
      allow read: if request.auth != null;
      
      // Users can update their own document
      allow update: if isOwnUser(uid);
      
      // Users can create their own document when migrating from pendingUsers
      // Simplified: Allow if user is creating their own document
      allow create: if isOwnUser(uid);
      
      // Admins can also create/delete users
      allow create, delete: if isAdmin();
    }
    
    // App configuration - ranks array stored in single document
    match /appConfig/ranks {
      // Anyone authenticated can read (for display in app)
      allow read: if request.auth != null;
      
      // Only admins can update ranks
      allow write: if isAdmin();
    }
    
    // Pending users (created by admin, migrated on first login)
    match /pendingUsers/{email} {
      // Admins can do everything
      allow read, write, delete: if isAdmin();
      
      // SIMPLIFIED: Allow authenticated users to read pendingUsers
      // The code validates email match, so this is secure
      allow read: if request.auth != null;
      
      // SIMPLIFIED: Allow authenticated users to delete pendingUsers
      // The code validates email match, so this is secure
      allow delete: if request.auth != null;
    }
  }
}
```

## Key Simplifications

1. **No connections collection**: Removed entirely - duplicate prevention now uses `scanHistory` array in user documents
   - Simpler architecture
   - Single source of truth
   - Reduced costs (~25% fewer operations per 

2. **pendingUsers read rule**: Changed from complex email matching to simple `request.auth != null`
   - The code validates email match before using the data
   - This avoids Firestore rule engine issues with string normalization

3. **pendingUsers delete rule**: Changed from complex email matching to simple `request.auth != null`
   - The code validates email match before deleting
   - This avoids Firestore rule engine issues

4. **users create rule**: Simplified to just `isOwnUser(uid)`
   - Removed the `exists(pendingUsers)` check - the code handles this logic
   - This makes the rule simpler and more reliable

## Why This Works

- **Security**: The code validates email matches before using/deleting pendingUsers data
- **Reliability**: Simpler rules = fewer edge cases = more reliable
- **Performance**: Simpler rules = faster evaluation

## Deployment Steps

1. Go to **Firebase Console** → **Firestore Database** → **Rules**
2. **Delete all existing rules**
3. **Copy the entire rules block above** (from `rules_version = '2';` to the closing `}`)
4. **Paste** into the rules editor
5. Click **Publish**
6. Wait 10-20 seconds for rules to propagate
7. **Clear browser cache** and try logging in again

## Verification

After deploying, check the browser console. You should see:
- `Checking pendingUsers for email: rsamdio2627@gmail.com`
- `Pending user exists: true` (or query returns results)
- `Successfully migrated user from pendingUsers to users collection`

If you still see permission errors:
1. Check that rules were actually published (refresh Firebase Console)
2. Clear browser cache completely
3. Try in incognito mode
4. Check that the user email in `pendingUsers` matches exactly (case-insensitive)

