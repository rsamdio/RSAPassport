/**
 * Optimized Firebase Cloud Functions for RSA Passport
 * 
 * Architecture: RTDB-First with Batch Processing
 * - All user operations use RTDB (primary database)
 * - Firestore used only for hourly backup
 * - Batch processing reduces function invocations
 * - Incremental updates minimize reads
 */

const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();

const region = "us-central1";
const rtdb = admin.database();
const db = admin.firestore();

/**
 * Get current batch ID (5-minute intervals)
 * Format: "2025-01-15-10:30"
 */
function getCurrentBatchId() {
  const now = new Date();
  const minutes = Math.floor(now.getMinutes() / 5) * 5;
  const batchDate = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      now.getHours(),
      minutes
  );
  return batchDate.toISOString().slice(0, 16).replace("T", "-");
}

/**
 * Calculate rank from score
 */
function calculateRank(score) {
  if (score >= 200) return "Super Star";
  if (score >= 51) return "Connector";
  return "Rookie";
}

/**
 * Batch process pending scores every 5 minutes
 * Aggregates all score changes and processes them together
 */
exports.batchProcessScores = onSchedule(
    {
      schedule: "every 5 minutes",
      timeZone: "UTC",
      region: region,
    },
    async (event) => {
      const batchId = getCurrentBatchId();
      const pendingScoresRef = rtdb.ref(`pendingScores/${batchId}`);
      const pendingScoresSnap = await pendingScoresRef.once("value");

      if (!pendingScoresSnap.exists()) {
        return {message: "No pending scores to process"};
      }

      const pendingScores = pendingScoresSnap.val();
      const scoreUpdates = {};
      const affectedUids = new Set();

      // Aggregate score changes
      for (const [uid, scoreData] of Object.entries(pendingScores)) {
        const delta = scoreData.delta || 0;
        if (delta === 0) continue;

        // Get current user data
        const userRef = rtdb.ref(`users/${uid}`);
        const userSnap = await userRef.once("value");

        if (!userSnap.exists()) continue;

        const userData = userSnap.val();
        const currentScore = userData.score || 0;
        const newScore = currentScore + delta;
        const newRank = calculateRank(newScore);

        // Update user score and rank
        scoreUpdates[`users/${uid}/score`] = newScore;
        scoreUpdates[`users/${uid}/rank`] = newRank;

        affectedUids.add(uid);
      }

      // Batch update all scores
      if (Object.keys(scoreUpdates).length > 0) {
        await rtdb.ref().update(scoreUpdates);
      }

      // Incremental rank updates (only affected users)
      if (affectedUids.size > 0) {
        await updateRanksIncremental(Array.from(affectedUids));
      }

      // Incremental leaderboard updates
      if (affectedUids.size > 0) {
        await updateLeaderboardIncremental(Array.from(affectedUids));
      }

      // Cleanup pending scores
      await pendingScoresRef.remove();

      // Cleanup pending scans
      const pendingScansRef = rtdb.ref(`scans/pending/${batchId}`);
      await pendingScansRef.remove();

      return {
        processed: Object.keys(pendingScores).length,
        scoreUpdates: Object.keys(scoreUpdates).length,
      };
    }
);

/**
 * Incremental rank update - only updates affected users
 */
async function updateRanksIncremental(affectedUids) {
  // Get all users ordered by score
  const usersRef = rtdb.ref("users");
  const usersSnap = await usersRef.orderByChild("score").once("value");

  const allUsers = [];
  usersSnap.forEach((child) => {
    allUsers.push({
      uid: child.key,
      score: child.val().score || 0,
      firstLoginAt: child.val().firstLoginAt || 0,
    });
  });

  // Sort by score (desc), then firstLoginAt (asc) for tie-breaking
  allUsers.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.firstLoginAt - b.firstLoginAt;
  });

  // Calculate ranks only for affected users
  const rankCacheUpdates = {};
  const affectedSet = new Set(affectedUids);

  allUsers.forEach((user, index) => {
    if (affectedSet.has(user.uid)) {
      // Calculate rank considering ties
      let rank = index + 1;
      for (let i = index - 1; i >= 0; i--) {
        if (allUsers[i].score === user.score) {
          rank = i + 1;
        } else {
          break;
        }
      }

      rankCacheUpdates[`ranks/${user.uid}`] = {
        leaderboardRank: rank,
        rank: calculateRank(user.score),
        lastUpdated: Date.now(),
      };
    }
  });

  // Batch update ranks
  if (Object.keys(rankCacheUpdates).length > 0) {
    await rtdb.ref().update(rankCacheUpdates);
  }
}

/**
 * Incremental leaderboard update
 */
async function updateLeaderboardIncremental(affectedUids) {
  // Get all users ordered by score
  const usersRef = rtdb.ref("users");
  const usersSnap = await usersRef.orderByChild("score").once("value");

  const allUsers = [];
  usersSnap.forEach((child) => {
    const data = child.val();
    allUsers.push({
      uid: child.key,
      score: data.score || 0,
      rank: data.rank || "Rookie",
      name: data.profile?.fullName || data.profile?.displayName || "User",
      photo: data.profile?.photoURL || null,
      district: data.profile?.district || null,
    });
  });

  // Sort and get top 10
  allUsers.sort((a, b) => b.score - a.score);
  const top10 = allUsers.slice(0, 10);

  // Update leaderboard
  const leaderboardData = {};
  top10.forEach((user, index) => {
    leaderboardData[index] = {
      uid: user.uid,
      name: user.name,
      score: user.score,
      rank: user.rank,
      photo: user.photo,
      district: user.district,
    };
  });

  // Fill remaining slots with null
  for (let i = top10.length; i < 10; i++) {
    leaderboardData[i] = null;
  }

  await rtdb.ref("leaderboard/top10").set(leaderboardData);
  await rtdb.ref("leaderboard/metadata").update({
    lastUpdated: Date.now(),
    totalUsers: allUsers.length,
  });
}

/**
 * Hourly Firestore backup (disaster recovery)
 */
exports.hourlyFirestoreBackup = onSchedule(
    {
      schedule: "every 1 hours",
      timeZone: "UTC",
      region: region,
    },
    async (event) => {
      const usersRef = rtdb.ref("users");
      const usersSnap = await usersRef.once("value");

      let batch = db.batch();
      let count = 0;

      const users = [];
      usersSnap.forEach((child) => {
        users.push({
          uid: child.key,
          data: child.val(),
        });
      });

      for (const {uid, data: userData} of users) {
        const userRef = db.collection("users").doc(uid);
        batch.set(
            userRef,
            {
              email: userData.email,
              participantId: userData.participantId,
              qrToken: userData.qrToken,
              score: userData.score,
              rank: userData.rank,
              profile: userData.profile,
              firstLoginAt: admin.firestore.Timestamp.fromMillis(
                  userData.firstLoginAt || Date.now()
              ),
              lastLoginAt: admin.firestore.Timestamp.fromMillis(
                  userData.lastLoginAt || Date.now()
              ),
              backupAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            {merge: true},
        );

        count++;

        // Firestore batch limit is 500
        if (count % 500 === 0) {
          await batch.commit();
          batch = db.batch();
        }
      }

      if (count % 500 !== 0) {
        await batch.commit();
      }

      return {backedUp: count};
    }
);

/**
 * Manual trigger to refresh all caches
 */
exports.refreshAllCaches = onCall(
    {region: region},
    async (request) => {
      // Check if user is admin
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated");
      }

      const adminDoc = await db.collection("admins")
          .doc(request.auth.uid).get();
      if (!adminDoc.exists) {
        throw new HttpsError(
            "permission-denied",
            "Only admins can refresh caches"
        );
      }

      try {
        // Refresh leaderboard
        await updateLeaderboardIncremental([]);

        // Refresh all ranks
        const usersRef = rtdb.ref("users");
        const usersSnap = await usersRef.once("value");
        const allUids = [];
        usersSnap.forEach((child) => {
          allUids.push(child.key);
        });
        await updateRanksIncremental(allUids);

        // Refresh admin cache
        await updateAdminCache();

        return {
          success: true,
          message: "All caches refreshed successfully",
        };
      } catch (error) {
        console.error("Error refreshing caches:", error);
        throw new HttpsError("internal", "Failed to refresh caches");
      }
    }
);

/**
 * Update admin cache
 */
async function updateAdminCache() {
  try {
    // Get pending users from RTDB
    const pendingRef = rtdb.ref("pendingUsers");
    const pendingSnap = await pendingRef.once("value");
    const pendingUsers = [];
    pendingSnap.forEach((child) => {
      pendingUsers.push({
        id: child.key,
        type: "pending",
        ...child.val(),
      });
    });

    // Get active users from RTDB
    const usersRef = rtdb.ref("users");
    const usersSnap = await usersRef.once("value");
    const activeUsers = [];
    usersSnap.forEach((child) => {
      activeUsers.push({
        id: child.key,
        type: "active",
        ...child.val(),
      });
    });

    // Update admin cache
    await rtdb.ref("adminCache/participants").set({
      pending: pendingUsers,
      active: activeUsers,
      lastUpdated: Date.now(),
    });
  } catch (error) {
    console.error("Error updating admin cache:", error);
  }
}

/**
 * Initialize RTDB structure on first deployment
 * Run this once to set up the initial structure
 */
exports.initializeRTDB = onCall(
    {region: region},
    async (request) => {
      // Check if user is admin
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated");
      }

      const adminDoc = await db.collection("admins")
          .doc(request.auth.uid).get();
      if (!adminDoc.exists) {
        throw new HttpsError(
            "permission-denied",
            "Only admins can initialize RTDB"
        );
      }

      try {
        // Initialize metadata
        await rtdb.ref("leaderboard/metadata").set({
          lastUpdated: Date.now(),
          totalUsers: 0,
          version: 1,
        });

        // Initialize rank ranges
        await rtdb.ref("ranks/ranges").set({
          "0-50": {
            rank: "Rookie",
            count: 0,
          },
          "51-199": {
            rank: "Connector",
            count: 0,
          },
          "200+": {
            rank: "Super Star",
            count: 0,
          },
        });

        return {
          success: true,
          message: "RTDB initialized successfully",
        };
      } catch (error) {
        console.error("Error initializing RTDB:", error);
        throw new HttpsError("internal", "Failed to initialize RTDB");
      }
    }
);
