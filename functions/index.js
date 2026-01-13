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
const {
  onValueCreated,
  onValueUpdated,
  onValueDeleted,
} = require("firebase-functions/v2/database");
const admin = require("firebase-admin");

admin.initializeApp();

const region = "us-central1";
const rtdb = admin.database();
const db = admin.firestore();

/**
 * Get current batch ID (5-minute intervals)
 * Format: "2025-01-15-10:30"
 * @return {string} Batch ID in format YYYY-MM-DD-HH:MM
 */
function getCurrentBatchId() {
  const now = new Date();
  const minutes = Math.floor(now.getMinutes() / 5) * 5;
  const batchDate = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      now.getHours(),
      minutes,
  );
  return batchDate.toISOString().slice(0, 16).replace("T", "-");
}

/**
 * Calculate rank from score
 * @param {number} score User score
 * @return {string} Rank name
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

      // Update sorted score index (for efficient rank/leaderboard queries)
      // Include all affected users in the index
      if (affectedUids.size > 0) {
        await updateSortedScoreIndex(Array.from(affectedUids));
      }

      // Incremental rank updates (only affected users) - uses sorted index
      if (affectedUids.size > 0) {
        await updateRanksIncremental(Array.from(affectedUids));
      } else {
        // If no affected users but we processed scores, update all ranks
        // This handles edge cases where index might be out of sync
        const usersRef = rtdb.ref("users");
        const usersSnap = await usersRef.once("value");
        const allUids = [];
        usersSnap.forEach((child) => {
          allUids.push(child.key);
        });
        if (allUids.length > 0) {
          await updateRanksIncremental(allUids);
        }
      }

      // Incremental leaderboard updates - uses sorted index
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
    },
);

/**
 * Update sorted score index for efficient queries
 * Maintains a sorted list of user UIDs by score (desc) for O(1) rank lookups
 * @param {Array<string>} affectedUids Array of user UIDs that changed
 * @param {boolean} rebuildAll If true, rebuilds index from all users
 */
async function updateSortedScoreIndex(affectedUids, rebuildAll = false) {
  const indexRef = rtdb.ref("indexes/sortedScores");

  // If rebuilding all, get all users and rebuild index from scratch
  if (rebuildAll) {
    const usersRef = rtdb.ref("users");
    const usersSnap = await usersRef.once("value");
    const allUsers = [];

    usersSnap.forEach((child) => {
      const userData = child.val();
      allUsers.push({
        uid: child.key,
        score: userData.score || 0,
        firstLoginAt: userData.firstLoginAt || 0,
      });
    });

    // Sort by score (desc), then firstLoginAt (asc) for tie-breaking
    allUsers.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.firstLoginAt - b.firstLoginAt;
    });

    // Update index (limit to top 1000 for efficiency)
    const limitedIndex = allUsers.slice(0, 1000);
    await indexRef.set(limitedIndex);
    return;
  }

  // Get current sorted index
  const indexSnap = await indexRef.once("value");
  let sortedIndex = indexSnap.exists() ? indexSnap.val() : [];

  // Get affected users' current scores
  const userScores = {};
  for (const uid of affectedUids) {
    const userRef = rtdb.ref(`users/${uid}`);
    const userSnap = await userRef.once("value");
    if (userSnap.exists()) {
      const userData = userSnap.val();
      userScores[uid] = {
        score: userData.score || 0,
        firstLoginAt: userData.firstLoginAt || 0,
      };
    }
  }

  // Remove affected users from index
  sortedIndex = sortedIndex.filter(
      (entry) => !affectedUids.includes(entry.uid),
  );

  // Re-insert affected users in correct position
  for (const uid of affectedUids) {
    if (!userScores[uid]) continue;

    const newEntry = {
      uid: uid,
      score: userScores[uid].score,
      firstLoginAt: userScores[uid].firstLoginAt,
    };

    // Find insertion point (maintain descending score order)
    let insertIndex = sortedIndex.length;
    for (let i = 0; i < sortedIndex.length; i++) {
      if (
        newEntry.score > sortedIndex[i].score ||
        (newEntry.score === sortedIndex[i].score &&
          newEntry.firstLoginAt < sortedIndex[i].firstLoginAt)
      ) {
        insertIndex = i;
        break;
      }
    }

    sortedIndex.splice(insertIndex, 0, newEntry);
  }

  // Update index (limit to top 1000 for efficiency)
  const limitedIndex = sortedIndex.slice(0, 1000);
  await indexRef.set(limitedIndex);
}

/**
 * Incremental rank update - only updates affected users
 * Uses sorted score index for efficient lookups
 * @param {Array<string>} affectedUids Array of user UIDs to update
 *   If empty array, updates all users in sorted index
 */
async function updateRanksIncremental(affectedUids) {
  // Get sorted score index (much faster than reading all users)
  const indexRef = rtdb.ref("indexes/sortedScores");
  const indexSnap = await indexRef.once("value");

  if (!indexSnap.exists()) {
    // Fallback: rebuild index from all users
    await updateSortedScoreIndex([], true);
    // Retry after rebuilding
    const retrySnap = await indexRef.once("value");
    if (!retrySnap.exists()) {
      // Still doesn't exist, return early
      return;
    }
  }

  const sortedIndex = indexSnap.exists() ? indexSnap.val() : [];
  if (sortedIndex.length === 0) {
    return;
  }

  // Calculate ranks for affected users (or all users if affectedUids is empty)
  const rankCacheUpdates = {};
  const affectedSet = affectedUids.length > 0 ? new Set(affectedUids) : null;

  sortedIndex.forEach((entry, index) => {
    // If affectedSet is null, update all users.
    // Otherwise, only update affected users
    if (affectedSet === null || affectedSet.has(entry.uid)) {
      // Calculate rank considering ties
      let rank = index + 1;
      for (let i = index - 1; i >= 0; i--) {
        if (sortedIndex[i].score === entry.score) {
          rank = i + 1;
        } else {
          break;
        }
      }

      rankCacheUpdates[`ranks/${entry.uid}`] = {
        leaderboardRank: rank,
        rank: calculateRank(entry.score),
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
 * Uses sorted score index for efficient top 10 lookup
 * @param {Array<string>} affectedUids Array of user UIDs that changed
 */
async function updateLeaderboardIncremental(affectedUids) {
  // Get sorted score index (much faster than reading all users)
  const indexRef = rtdb.ref("indexes/sortedScores");
  const indexSnap = await indexRef.once("value");

  if (!indexSnap.exists()) {
    // Fallback: rebuild index from all users
    await updateSortedScoreIndex(affectedUids);
    return updateLeaderboardIncremental(affectedUids);
  }

  const sortedIndex = indexSnap.val() || [];
  const top10Index = sortedIndex.slice(0, 10);

  // Get user details for top 10 only (much fewer reads)
  const allUsers = [];
  for (const entry of top10Index) {
    const userRef = rtdb.ref(`users/${entry.uid}`);
    const userSnap = await userRef.once("value");
    if (userSnap.exists()) {
      const data = userSnap.val();
      const profile = data.profile || {};
      let photoURL = profile.photoURL || data.photoURL || null;

      // If photoURL is missing, try multiple fallbacks
      if (!photoURL) {
        // Try Firebase Auth first (most reliable source)
        try {
          const authUser = await admin.auth()
              .getUser(entry.uid).catch(() => null);
          if (authUser && authUser.photoURL) {
            photoURL = authUser.photoURL;
          }
        } catch (error) {
          // Auth read failed, try other sources
        }

        // If still missing, try admin cache (fastest)
        if (!photoURL) {
          try {
            const adminCacheRef = rtdb.ref("adminCache/participants");
            const adminCacheSnap = await adminCacheRef.once("value");
            if (adminCacheSnap.exists()) {
              const cache = adminCacheSnap.val();
              const activeUsers = cache.active || [];
              const userInCache = activeUsers.find((p) => p.id === entry.uid);
              if (userInCache && userInCache.photoURL) {
                photoURL = userInCache.photoURL;
              }
            }
          } catch (error) {
            // Admin cache read failed, try Firestore
          }
        }

        // If still missing, try Firestore (for admin users)
        if (!photoURL) {
          try {
            const userDoc = await db.collection("users").doc(entry.uid).get();
            if (userDoc.exists()) {
              const firestoreData = userDoc.data();
              photoURL = firestoreData.photoURL ||
                         (firestoreData.profile &&
                          firestoreData.profile.photoURL) || null;
            }
          } catch (error) {
            // Firestore read failed, continue with null photo
          }
        }

        // If we found a photoURL from any source, update RTDB for future use
        if (photoURL) {
          try {
            const profileUpdate = {...profile};
            profileUpdate.photoURL = photoURL;
            await rtdb.ref(`users/${entry.uid}`).update({
              profile: profileUpdate,
            });
          } catch (error) {
            // RTDB update failed, continue with photoURL we found
          }
        }
      }

      allUsers.push({
        uid: entry.uid,
        score: entry.score,
        rank: data.rank || "Rookie",
        name: profile.fullName || profile.displayName || data.fullName ||
              data.displayName || "User",
        photo: photoURL,
        district: profile.district || data.district || null,
        email: data.email || null,
      });
    }
  }

  // Update leaderboard
  const leaderboardData = {};
  allUsers.forEach((user, index) => {
    leaderboardData[index] = {
      uid: user.uid,
      name: user.name,
      score: user.score,
      rank: user.rank,
      photo: user.photo,
      district: user.district,
      email: user.email,
    };
  });

  // Fill remaining slots with null
  for (let i = allUsers.length; i < 10; i++) {
    leaderboardData[i] = null;
  }

  await rtdb.ref("leaderboard/top10").set(leaderboardData);
  await rtdb.ref("leaderboard/metadata").update({
    lastUpdated: Date.now(),
    totalUsers: allUsers.length,
  });
}

/**
 * Firestore backup (disaster recovery)
 * Runs every 6 hours to reduce write costs by 83%
 */
exports.hourlyFirestoreBackup = onSchedule(
    {
      schedule: "every 6 hours",
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

        // Ensure profile.photoURL is included in backup
        const profile = userData.profile || {};
        const backupProfile = {
          fullName: profile.fullName || null,
          district: profile.district || null,
          phone: profile.phone || null,
          profession: profile.profession || null,
          photoURL: profile.photoURL || userData.photoURL || null,
          displayName: profile.displayName || null,
        };

        // Also at root level for backward compatibility
        const rootPhotoURL = profile.photoURL || userData.photoURL || null;

        batch.set(
            userRef,
            {
              email: userData.email,
              participantId: userData.participantId,
              qrToken: userData.qrToken,
              score: userData.score,
              rank: userData.rank,
              profile: backupProfile,
              photoURL: rootPhotoURL,
              firstLoginAt: admin.firestore.Timestamp.fromMillis(
                  userData.firstLoginAt || Date.now(),
              ),
              lastLoginAt: admin.firestore.Timestamp.fromMillis(
                  userData.lastLoginAt || Date.now(),
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
    },
);

/**
 * Incrementally update admin cache (callable from admin panel)
 */
exports.updateAdminCacheIncremental = onCall(
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
            "Only admins can update cache",
        );
      }

      const {uid, type, userData} = request.data;
      if (!uid || !type || !userData) {
        throw new HttpsError(
            "invalid-argument",
            "Missing required parameters: uid, type, userData",
        );
      }

      try {
        await updateAdminCacheIncremental(uid, type, userData);
        return {success: true};
      } catch (error) {
        throw new HttpsError("internal", "Failed to update cache");
      }
    },
);

/**
 * Remove from admin cache (callable from admin panel)
 */
exports.removeFromAdminCache = onCall(
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
            "Only admins can update cache",
        );
      }

      const {uid, type} = request.data;
      if (!uid || !type) {
        throw new HttpsError(
            "invalid-argument",
            "Missing required parameters: uid, type",
        );
      }

      try {
        await removeFromAdminCache(uid, type);
        return {success: true};
      } catch (error) {
        throw new HttpsError("internal", "Failed to update cache");
      }
    },
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
            "Only admins can refresh caches",
        );
      }

      try {
        // Rebuild sorted score index from all users
        await updateSortedScoreIndex([], true);

        // Refresh leaderboard (uses sorted index)
        await updateLeaderboardIncremental([]);

        // Refresh all ranks (uses sorted index)
        // Get all UIDs after index is rebuilt
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
        throw new HttpsError("internal", "Failed to refresh caches");
      }
    },
);

/**
 * Incrementally update admin cache - add/update a single participant
 * @param {string} uid User ID or encoded email
 * @param {string} type "pending" or "active"
 * @param {Object} userData User data to add/update
 */
async function updateAdminCacheIncremental(uid, type, userData) {
  try {
    const cacheRef = rtdb.ref("adminCache/participants");
    const cacheSnap = await cacheRef.once("value");

    if (!cacheSnap.exists()) {
      // Cache doesn't exist, do full refresh
      await updateAdminCache();
      return;
    }

    const cache = cacheSnap.val();
    const participants = cache[type] || [];

    // Find existing participant
    const existingIndex = participants.findIndex((p) => p.id === uid);

    // Flatten profile data for admin cache
    const profile = userData.profile || {};
    const participant = {
      id: uid,
      type: type,
      email: userData.email || null,
      participantId: userData.participantId || null,
      score: userData.score || 0,
      rank: userData.rank || "Rookie",
      qrToken: userData.qrToken || null,
      firstLoginAt: userData.firstLoginAt || null,
      lastLoginAt: userData.lastLoginAt || null,
      // Flatten profile fields to top level
      fullName: profile.fullName || userData.fullName || null,
      displayName: profile.displayName || userData.displayName || null,
      district: profile.district || userData.district || null,
      phone: profile.phone || userData.phone || null,
      profession: profile.profession || userData.profession || null,
      photoURL: profile.photoURL || userData.photoURL || null,
    };

    if (existingIndex >= 0) {
      // Update existing participant
      participants[existingIndex] = participant;
    } else {
      // Add new participant
      participants.push(participant);
    }

    // Update cache
    await cacheRef.update({
      [type]: participants,
      lastUpdated: Date.now(),
    });
  } catch (error) {
    // Fallback to full refresh on error
    await updateAdminCache();
  }
}

/**
 * Incrementally remove a participant from admin cache
 * @param {string} uid User ID or encoded email
 * @param {string} type "pending" or "active"
 */
async function removeFromAdminCache(uid, type) {
  try {
    const cacheRef = rtdb.ref("adminCache/participants");
    const cacheSnap = await cacheRef.once("value");

    if (!cacheSnap.exists()) {
      return; // Cache doesn't exist, nothing to remove
    }

    const cache = cacheSnap.val();
    const participants = cache[type] || [];

    // Remove participant
    const filtered = participants.filter((p) => p.id !== uid);

    // Update cache
    await cacheRef.update({
      [type]: filtered,
      lastUpdated: Date.now(),
    });
  } catch (error) {
    // Fallback to full refresh on error
    await updateAdminCache();
  }
}

/**
 * Update admin cache (full refresh - fallback)
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
      const data = child.val();
      const profile = data.profile || {};
      // Flatten profile data for admin cache
      activeUsers.push({
        id: child.key,
        type: "active",
        email: data.email,
        participantId: data.participantId,
        score: data.score,
        rank: data.rank,
        qrToken: data.qrToken,
        firstLoginAt: data.firstLoginAt,
        lastLoginAt: data.lastLoginAt,
        // Flatten profile fields to top level
        fullName: profile.fullName || data.fullName || null,
        displayName: profile.displayName || data.displayName || null,
        district: profile.district || data.district || null,
        phone: profile.phone || data.phone || null,
        profession: profile.profession || data.profession || null,
        photoURL: profile.photoURL || data.photoURL || null,
      });
    });

    // Update admin cache
    await rtdb.ref("adminCache/participants").set({
      pending: pendingUsers,
      active: activeUsers,
      lastUpdated: Date.now(),
    });
  } catch (error) {
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
            "Only admins can initialize RTDB",
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
        throw new HttpsError("internal", "Failed to initialize RTDB");
      }
    },
);

/**
 * Sync existing Firestore users to RTDB
 * Call this once to migrate existing users
 */
exports.syncFirestoreToRTDB = onCall(
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
            "Only admins can sync data",
        );
      }

      try {
        const usersSnapshot = await db.collection("users").get();
        const updates = {};
        let count = 0;

        usersSnapshot.forEach((doc) => {
          const uid = doc.id;
          const data = doc.data();

          // Migrate user to RTDB
          updates[`users/${uid}`] = {
            email: data.email || null,
            participantId: data.participantId || null,
            qrToken: data.qrToken || null,
            qrCodeBase64: data.qrCodeBase64 || null, // Include QR code base64
            score: data.score || 0,
            rank: data.rank || calculateRank(data.score || 0),
            profile: {
              fullName: data.fullName || null,
              district: data.district || null,
              phone: data.phone || null,
              profession: data.profession || null,
              photoURL: data.photoURL || null,
              displayName: data.displayName || null,
            },
            firstLoginAt: data.firstLoginAt?.toMillis() || Date.now(),
            lastLoginAt: data.lastLoginAt?.toMillis() || Date.now(),
          };

          // Update QR code cache
          if (data.qrToken) {
            updates[`qrcodes/${data.qrToken}`] = {
              uid: uid,
              name: data.fullName || data.displayName || "User",
              photo: data.photoURL || null,
              email: data.email || null,
              district: data.district || null,
              phone: data.phone || null,
              profession: data.profession || null,
            };
          }

          count++;
        });

        // Batch update
        if (Object.keys(updates).length > 0) {
          await rtdb.ref().update(updates);
        }

        // Update indexes
        const indexUpdates = {};
        usersSnapshot.forEach((doc) => {
          const uid = doc.id;
          const data = doc.data();

          if (data.email) {
            // Encode email for RTDB path
            const normalizedEmail = data.email.toLowerCase().trim();
            const encodedEmail = Buffer.from(normalizedEmail)
                .toString("base64")
                .replace(/[/+=]/g, (m) => {
                  const map = {"/": "_", "+": "-", "=": ""};
                  return map[m] || "";
                });

            indexUpdates[`indexes/emails/${encodedEmail}`] = {
              uid: uid,
              email: normalizedEmail,
              type: "active",
              lastUpdated: Date.now(),
            };
          }

          if (data.participantId) {
            indexUpdates[`indexes/participantIds/${data.participantId}`] = {
              uid: uid,
              email: data.email || null,
              type: "active",
              lastUpdated: Date.now(),
            };
          }

          if (data.qrToken) {
            indexUpdates[`indexes/qrTokens/${data.qrToken}`] = {
              uid: uid,
              email: data.email || null,
              lastUpdated: Date.now(),
            };
          }
        });

        if (Object.keys(indexUpdates).length > 0) {
          await rtdb.ref().update(indexUpdates);
        }

        // Rebuild sorted score index from all users in RTDB
        await updateSortedScoreIndex([], true);

        // Refresh caches
        await updateAdminCache();
        await updateLeaderboardIncremental([]);

        // Get all UIDs from RTDB for rank calculation
        const usersRef = rtdb.ref("users");
        const usersSnap = await usersRef.once("value");
        const allUids = [];
        usersSnap.forEach((child) => {
          allUids.push(child.key);
        });
        await updateRanksIncremental(allUids);

        return {
          success: true,
          message: `Synced ${count} users to RTDB`,
          count: count,
        };
      } catch (error) {
        throw new HttpsError("internal", "Failed to sync data");
      }
    },
);

/**
 * RTDB Database Trigger: Automatically update admin cache when user is created
 * This ensures real-time updates without client-side cache management
 * Note: Database is in asia-southeast1, so trigger must be in same region
 */
exports.onUserCreated = onValueCreated(
    {
      ref: "users/{uid}",
      region: "asia-southeast1",
      databaseInstance: "rsapassport-default-rtdb",
    },
    async (event) => {
      const uid = event.params.uid;
      const userData = event.data.val();

      try {
        // Create/update QR code entry in RTDB if qrToken exists
        if (userData.qrToken) {
          const profile = userData.profile || {};
          const qrCodeRef = rtdb.ref(`qrcodes/${userData.qrToken}`);
          await qrCodeRef.set({
            uid: uid,
            name: profile.fullName || profile.displayName ||
                  userData.fullName || userData.displayName || "User",
            photo: profile.photoURL || userData.photoURL || null,
            email: userData.email || null,
            district: profile.district || userData.district || null,
            phone: profile.phone || userData.phone || null,
            profession: profile.profession || userData.profession || null,
          });
        }

        // Add user to active cache
        await updateAdminCacheIncremental(uid, "active", userData);

        // Update sorted score index
        await updateSortedScoreIndex([uid]);

        // Update ranks for this user
        await updateRanksIncremental([uid]);

        // Update leaderboard if user is in top 10
        await updateLeaderboardIncremental([uid]);
      } catch (error) {
        // Non-critical, don't throw
      }
    },
);

/**
 * RTDB Database Trigger: Automatically update admin cache when user is updated
 */
exports.onUserUpdated = onValueUpdated(
    {
      ref: "users/{uid}",
      region: "asia-southeast1",
      databaseInstance: "rsapassport-default-rtdb",
    },
    async (event) => {
      const uid = event.params.uid;
      const userData = event.data.after.val();
      const previousData = event.data.before.val();

      try {
        // Update QR code entry if qrToken exists and profile data changed
        if (userData.qrToken) {
          const profile = userData.profile || {};
          const previousProfile = previousData.profile || {};
          const profileChanged = (
            profile.fullName !== previousProfile.fullName ||
            profile.displayName !== previousProfile.displayName ||
            profile.photoURL !== previousProfile.photoURL ||
            profile.district !== previousProfile.district ||
            profile.phone !== previousProfile.phone ||
            profile.profession !== previousProfile.profession
          );

          if (profileChanged) {
            const qrCodeRef = rtdb.ref(`qrcodes/${userData.qrToken}`);
            await qrCodeRef.update({
              uid: uid,
              name: profile.fullName || profile.displayName ||
                    userData.fullName || userData.displayName || "User",
              photo: profile.photoURL || userData.photoURL || null,
              email: userData.email || null,
              district: profile.district || userData.district || null,
              phone: profile.phone || userData.phone || null,
              profession: profile.profession || userData.profession || null,
            });
          }
        }

        // Update admin cache
        await updateAdminCacheIncremental(uid, "active", userData);

        // If score changed, update ranks and leaderboard
        const scoreChanged = (userData.score || 0) !==
          (previousData.score || 0);
        if (scoreChanged) {
          await updateSortedScoreIndex([uid]);
          await updateRanksIncremental([uid]);
          await updateLeaderboardIncremental([uid]);
        }
      } catch (error) {
        // Non-critical, don't throw
      }
    },
);

/**
 * RTDB Database Trigger: Automatically update admin cache when user is deleted
 */
exports.onUserDeleted = onValueDeleted(
    {
      ref: "users/{uid}",
      region: "asia-southeast1",
      databaseInstance: "rsapassport-default-rtdb",
    },
    async (event) => {
      const uid = event.params.uid;

      try {
        // Remove from admin cache
        await removeFromAdminCache(uid, "active");

        // Update sorted score index
        await updateSortedScoreIndex([], true);

        // Refresh ranks and leaderboard
        const usersRef = rtdb.ref("users");
        const usersSnap = await usersRef.once("value");
        const allUids = [];
        usersSnap.forEach((child) => {
          allUids.push(child.key);
        });
        await updateRanksIncremental(allUids);
        await updateLeaderboardIncremental([]);
      } catch (error) {
        // Non-critical, don't throw
      }
    },
);

/**
 * RTDB Database Trigger: Automatically update admin cache when pending user is
 * created
 */
exports.onPendingUserCreated = onValueCreated(
    {
      ref: "pendingUsers/{encodedEmail}",
      region: "asia-southeast1",
      databaseInstance: "rsapassport-default-rtdb",
    },
    async (event) => {
      const encodedEmail = event.params.encodedEmail;
      const userData = event.data.val();

      try {
        // Add to pending cache
        await updateAdminCacheIncremental(encodedEmail, "pending", userData);
      } catch (error) {
        // Non-critical, don't throw
      }
    },
);

/**
 * RTDB Database Trigger: Automatically update admin cache when pending user is
 * updated
 */
exports.onPendingUserUpdated = onValueUpdated(
    {
      ref: "pendingUsers/{encodedEmail}",
      region: "asia-southeast1",
      databaseInstance: "rsapassport-default-rtdb",
    },
    async (event) => {
      const encodedEmail = event.params.encodedEmail;
      const userData = event.data.after.val();

      try {
        // Update pending cache
        await updateAdminCacheIncremental(encodedEmail, "pending", userData);
      } catch (error) {
        // Non-critical, don't throw
      }
    },
);

/**
 * RTDB Database Trigger: Automatically update admin cache when pending user is
 * deleted
 */
exports.onPendingUserDeleted = onValueDeleted(
    {
      ref: "pendingUsers/{encodedEmail}",
      region: "asia-southeast1",
      databaseInstance: "rsapassport-default-rtdb",
    },
    async (event) => {
      const encodedEmail = event.params.encodedEmail;

      try {
        // Remove from pending cache
        await removeFromAdminCache(encodedEmail, "pending");
      } catch (error) {
        // Non-critical, don't throw
      }
    },
);

/**
 * Delete user (admin only) - Cloud Function to handle admin deletions
 * This is needed because RTDB rules can't check Firestore for admin status
 */
exports.deleteUser = onCall(
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
            "Only admins can delete users",
        );
      }

      const {uid, type} = request.data;
      if (!uid || !type) {
        throw new HttpsError(
            "invalid-argument",
            "uid and type are required",
        );
      }

      try {
        let userData = null;
        let qrToken = null;
        let email = null;
        let participantId = null;

        // Get user data before deletion
        if (type === "pending") {
          const pendingRef = rtdb.ref(`pendingUsers/${uid}`);
          const pendingSnap = await pendingRef.once("value");
          if (pendingSnap.exists()) {
            userData = pendingSnap.val();
            qrToken = userData.qrToken;
            email = userData.email;
            participantId = userData.participantId;
          }
        } else {
          const userRef = rtdb.ref(`users/${uid}`);
          const userSnap = await userRef.once("value");
          if (userSnap.exists()) {
            userData = userSnap.val();
            qrToken = userData.qrToken;
            email = userData.email;
            participantId = userData.participantId;
          }
        }

        if (!userData) {
          throw new HttpsError("not-found", "User not found");
        }

        // Delete from RTDB
        if (type === "pending") {
          await rtdb.ref(`pendingUsers/${uid}`).remove();
        } else {
          await rtdb.ref(`users/${uid}`).remove();
          // Also delete from Firestore
          try {
            await db.collection("users").doc(uid).delete();
          } catch (firestoreError) {
            // Non-critical, continue
          }
        }

        // Delete QR code cache
        if (qrToken) {
          try {
            await rtdb.ref(`qrcodes/${qrToken}`).remove();
          } catch (qrError) {
            // Non-critical
          }
        }

        // Update indexes (remove entries)
        const updates = {};
        if (email) {
          // Decode email if needed (for pending users, uid is encoded email)
          let encodedEmail = uid;
          if (type === "active") {
            // For active users, need to encode email
            const normalizedEmail = email.toLowerCase().trim();
            encodedEmail = Buffer.from(normalizedEmail)
                .toString("base64")
                .replace(/[/+=]/g, (m) => {
                  const map = {"/": "_", "+": "-", "=": ""};
                  return map[m] || "";
                });
          }
          updates[`indexes/emails/${encodedEmail}`] = null;
        }
        if (participantId) {
          updates[`indexes/participantIds/${participantId}`] = null;
        }
        if (qrToken) {
          updates[`indexes/qrTokens/${qrToken}`] = null;
        }

        if (Object.keys(updates).length > 0) {
          await rtdb.ref().update(updates);
        }

        // Delete rank
        try {
          await rtdb.ref(`ranks/${uid}`).remove();
        } catch (rankError) {
          // Non-critical
        }

        // RTDB triggers will automatically:
        // - Remove from admin cache (onUserDeleted or onPendingUserDeleted)
        // - Update sorted score index
        // - Refresh ranks and leaderboard

        return {
          success: true,
          message: "User deleted successfully",
        };
      } catch (error) {
        throw new HttpsError("internal", "Failed to delete user");
      }
    },
);
