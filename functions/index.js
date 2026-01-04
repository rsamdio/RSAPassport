/**
 * Firebase Cloud Functions for RSA Passport
 *
 * These functions keep RTDB caches in sync with Firestore data changes
 * This ensures data consistency and reduces client-side write permissions
 */

const {onDocumentUpdated, onDocumentCreated, onDocumentDeleted} =
  require("firebase-functions/v2/firestore");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
admin.initializeApp();

// Use us-central1 (default, most reliable region)
const region = "us-central1";

const db = admin.firestore();
const rtdb = admin.database();

/**
 * Update RTDB caches when a user's score changes
 * Triggers: Firestore write to users/{uid} when score field changes
 */
exports.onUserScoreUpdate = onDocumentUpdated(
    {
      document: "users/{uid}",
      region: region,
    },
    async (event) => {
      const before = event.data.before.data();
      const after = event.data.after.data();
      const uid = event.params.uid;

      // Only process if score actually changed
      if (before.score === after.score && before.rank === after.rank) {
        return null;
      }

      const updates = {};

      // Update QR code data if name or photo changed
      if (before.fullName !== after.fullName ||
          before.photoURL !== after.photoURL) {
        if (after.qrToken) {
          updates[`qrcodes/${after.qrToken}`] = {
            uid: uid,
            name: after.fullName || after.displayName || "User",
            photo: after.photoURL || null,
          };
        }
      }

      // Update leaderboard cache if score changed
      // Note: We don't cache current user's score/connections in RTDB anymore
      // Those are handled via localStorage since we already read the full user
      // document
      if (before.score !== after.score) {
        await updateLeaderboardCache();
        // Also update all user ranks (for leaderboard position)
        await updateAllUserRanks();
      }

      // Apply all updates
      if (Object.keys(updates).length > 0) {
        await rtdb.ref().update(updates);
        console.log(`Updated RTDB caches for user ${uid}`);
      }

      return null;
    });

/**
 * Update RTDB caches when a new user is created
 */
exports.onUserCreate = onDocumentCreated(
    {
      document: "users/{uid}",
      region: region,
    },
    async (event) => {
      const userData = event.data.data();
      const uid = event.params.uid;

      const updates = {};

      // Create QR code entry if qrToken exists
      if (userData.qrToken) {
        updates[`qrcodes/${userData.qrToken}`] = {
          uid: uid,
          name: userData.fullName || userData.displayName || "User",
          photo: userData.photoURL || null,
        };
      }

      // Note: We don't cache current user's score/connections in RTDB anymore
      // Those are handled via localStorage since we already read the full user
      // document

      // Update leaderboard cache
      await updateLeaderboardCache();
      // Also update all user ranks (for leaderboard position)
      await updateAllUserRanks();

      // Apply updates
      if (Object.keys(updates).length > 0) {
        await rtdb.ref().update(updates);
        console.log(`Created RTDB caches for new user ${uid}`);
      }

      return null;
    });

/**
 * Clean up RTDB caches when a user is deleted
 */
exports.onUserDelete = onDocumentDeleted(
    {
      document: "users/{uid}",
      region: region,
    },
    async (event) => {
      const userData = event.data.data();
      const uid = event.params.uid;

      const updates = {};

      // Remove QR code entry
      if (userData.qrToken) {
        updates[`qrcodes/${userData.qrToken}`] = null;
      }

      // Note: We don't cache current user's score/connections in RTDB anymore

      // Update leaderboard cache
      await updateLeaderboardCache();
      // Also update all user ranks (for leaderboard position)
      await updateAllUserRanks();

      // Apply updates
      await rtdb.ref().update(updates);
      console.log(`Cleaned up RTDB caches for deleted user ${uid}`);

      return null;
    });

/**
 * Update leaderboard cache in RTDB
 * Fetches top 10 users from Firestore and caches them
 */
async function updateLeaderboardCache() {
  try {
    const usersSnapshot = await db.collection("users")
        .orderBy("score", "desc")
        .limit(10)
        .get();

    const leaderboardData = {};
    let index = 0;

    usersSnapshot.forEach((doc) => {
      const data = doc.data();
      leaderboardData[index] = {
        uid: doc.id,
        name: data.fullName || data.displayName || data.name || "User",
        score: data.score || 0,
        rank: data.rank || "Rookie",
        photo: data.photoURL || null,
        email: data.email || null,
        district: data.district || null,
      };
      index++;
    });

    // Fill remaining slots with null if less than 10
    for (let i = index; i < 10; i++) {
      leaderboardData[i] = null;
    }

    await rtdb.ref("leaderboard/top10").set(leaderboardData);
    console.log("Updated leaderboard cache in RTDB");
  } catch (error) {
    console.error("Error updating leaderboard cache:", error);
    throw error;
  }
}

// Note: Removed updateRecentConnectionsCache function
// Recent connections are now cached in localStorage since we already read the
// full user document

/**
 * Update all user leaderboard ranks in RTDB
 * Called when any score changes - recalculates all ranks
 */
async function updateAllUserRanks() {
  try {
    // Get all users ordered by score (desc), then firstLoginAt (asc) for
    // tie-breaking
    const usersSnapshot = await db.collection("users")
        .orderBy("score", "desc")
        .orderBy("firstLoginAt", "asc")
        .get();

    const rankUpdates = {};
    let currentRank = 1;
    let previousScore = null;
    let rankForCurrentScore = 1;

    usersSnapshot.forEach((doc) => {
      const data = doc.data();
      const score = data.score || 0;
      const uid = doc.id;

      // Handle ties: users with same score get same rank
      // Next rank = current position
      if (previousScore !== null && score !== previousScore) {
        rankForCurrentScore = currentRank;
      }

      rankUpdates[`ranks/${uid}`] = {
        leaderboardRank: rankForCurrentScore,
        lastUpdated: Date.now(),
      };

      previousScore = score;
      currentRank++;
    });

    // Batch update all ranks
    if (Object.keys(rankUpdates).length > 0) {
      await rtdb.ref().update(rankUpdates);
      console.log(
          `Updated ${Object.keys(rankUpdates).length} user ranks in RTDB`);
    }
  } catch (error) {
    console.error("Error updating all user ranks:", error);
    // Non-critical, don't throw
  }
}

/**
 * Manual trigger to refresh leaderboard cache
 * Can be called via HTTP or from admin panel
 */
exports.refreshLeaderboard = onCall(
    {region: region},
    async (request) => {
      // Check if user is admin
      if (!request.auth) {
        throw new HttpsError(
            "unauthenticated", "User must be authenticated");
      }

      const adminDoc = await db.collection("admins")
          .doc(request.auth.uid).get();
      if (!adminDoc.exists) {
        throw new HttpsError(
            "permission-denied", "Only admins can refresh leaderboard");
      }

      try {
        await updateLeaderboardCache();
        await updateAllUserRanks();
        return {
          success: true,
          message: "Leaderboard cache and ranks refreshed",
        };
      } catch (error) {
        console.error("Error refreshing leaderboard:", error);
        throw new HttpsError(
            "internal", "Failed to refresh leaderboard cache");
      }
    });

/**
 * Manual trigger to refresh all user caches
 * Useful for migration or fixing inconsistencies
 */
exports.refreshAllCaches = onCall(
    {region: region},
    async (request) => {
      // Check if user is admin
      if (!request.auth) {
        throw new HttpsError(
            "unauthenticated", "User must be authenticated");
      }

      const adminDoc = await db.collection("admins")
          .doc(request.auth.uid).get();
      if (!adminDoc.exists) {
        throw new HttpsError(
            "permission-denied", "Only admins can refresh all caches");
      }

      try {
        // Refresh leaderboard
        await updateLeaderboardCache();
        // Refresh all user ranks
        await updateAllUserRanks();

        // Refresh all user caches
        const usersSnapshot = await db.collection("users").get();
        const updates = {};

        usersSnapshot.forEach((doc) => {
          const data = doc.data();
          const uid = doc.id;

          // Update QR code entry
          if (data.qrToken) {
            updates[`qrcodes/${data.qrToken}`] = {
              uid: uid,
              name: data.fullName || data.displayName || "User",
              photo: data.photoURL || null,
            };
          }

          // Note: We don't cache current user's score/connections in RTDB
          // anymore. Those are handled via localStorage since we already read
          // the full user document
        });

        // Apply all updates
        await rtdb.ref().update(updates);

        return {
          success: true,
          message: `Refreshed caches for ${usersSnapshot.size} users`,
        };
      } catch (error) {
        console.error("Error refreshing all caches:", error);
        throw new HttpsError(
            "internal", "Failed to refresh all caches");
      }
    });

