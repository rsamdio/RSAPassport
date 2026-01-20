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
  const minutes = Math.floor(now.getUTCMinutes() / 5) * 5;
  // CRITICAL: Use UTC methods to match client-side calculation
  // This ensures batch IDs are consistent across all timezones
  const batchDate = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      minutes,
  ));
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
 * Idempotent batch processing with catch-all for offline batches
 * Processes current batch + any expired batches (offline scans)
 * Fixes: Double-count race condition (C2) and Offline scan loss (C3)
 */
exports.batchProcessScores = onSchedule(
    {
      schedule: "every 5 minutes",
      timeZone: "UTC",
      region: region,
      timeoutSeconds: 540, // 9 minutes (allow time for catch-up)
    },
    async (event) => {
      const currentBatchId = getCurrentBatchId();
      const processedBatches = new Set();
      try {
        // 1. Process current batch first (most common case)
        const currentResult =
            await processBatchIdempotent(currentBatchId);
        if (currentResult.processed) {
          processedBatches.add(currentBatchId);
        }

        // 2. Catch-up: Process any expired batches (offline scans)
        // Look for batches from last 2 hours (24 batches = 2 hours)
        const expiredBatches = await findExpiredBatches(24);

        for (const batchId of expiredBatches) {
          if (batchId === currentBatchId) continue; // Already processed

          const result = await processBatchIdempotent(batchId);
          if (result.processed) {
            processedBatches.add(batchId);
          }
        }

        return {
          processedBatches: Array.from(processedBatches),
          totalProcessed: processedBatches.size,
        };
      } catch (error) {
        console.error("Batch processing error:", error);
        // Don't throw - let scheduler retry
        return {error: error.message};
      }
    },
);

/**
 * Idempotent batch processing - safe to retry
 * Uses processing lock to prevent double-counting
 * @param {string} batchId - The batch ID to process
 */
async function processBatchIdempotent(batchId) {
  const pendingScoresRef = rtdb.ref(`pendingScores/${batchId}`);
  const lockRef = rtdb.ref(`pendingScores/${batchId}/_processing`);
  try {
    // 1. Check if batch exists
    const pendingScoresSnap = await pendingScoresRef.once("value");
    if (!pendingScoresSnap.exists()) {
      return {processed: false, message: "Batch does not exist"};
    }

    // 2. Check processing lock (idempotency check)
    const lockSnap = await lockRef.once("value");
    if (lockSnap.exists()) {
      const lockData = lockSnap.val();
      const lockTime = lockData.timestamp || 0;
      const lockAge = Date.now() - lockTime;

      // If lock is older than 10 minutes, assume previous process crashed
      // Release lock and continue
      if (lockAge > 600000) {
        console.warn(
            `Stale lock detected for batch ${batchId}, age: ${lockAge}ms`,
        );
        await lockRef.remove();
      } else {
        // Lock is fresh, another process is handling this batch
        return {processed: false, message: "Batch is being processed"};
      }
    }

    // 3. Acquire processing lock (atomic using transaction)
    const lockData = {
      timestamp: Date.now(),
      processId: `${Date.now()}-${Math.random()}`,
    };

    // Use transaction to atomically acquire lock
    const transactionResult = await lockRef.transaction((current) => {
      if (current === null) {
        return lockData;
      }
      // Lock already exists, abort transaction
      return; // undefined = abort
    });

    // Check if transaction succeeded
    if (!transactionResult.committed) {
      // Another process got the lock
      return {processed: false, message: "Could not acquire lock"};
    }

    // Verify lock was acquired with our processId
    const verifyLock = await lockRef.once("value");
    const lockProcessId = verifyLock.val()?.processId;
    if (!verifyLock.exists() || lockProcessId !== lockData.processId) {
      // Another process got the lock
      return {processed: false, message: "Could not acquire lock"};
    }

    // 4. Read pending scores (with lock held)
    const pendingScores = pendingScoresSnap.val();
    const scoreUpdates = {};
    const affectedUids = new Set();
    // 5. Aggregate score changes (idempotent: read current score, add delta)
    for (const [uid, scoreData] of Object.entries(pendingScores)) {
      // Skip lock entry
      if (uid === "_processing") continue;

      const delta = scoreData.delta || 0;
      if (delta === 0) continue;

      // Get current user score (lightweight read - optimization)
      // Use users_scores if available, fallback to users
      let currentScore = 0;
      let lastProcessedBatch = {};
      const scoreRef = rtdb.ref(`users_scores/${uid}`);
      const scoreSnap = await scoreRef.once("value");

      if (scoreSnap.exists()) {
        const scoreData = scoreSnap.val();
        currentScore = scoreData.score || 0;
        // Note: _lastProcessedBatch is stored in users/{uid}, not users_scores
      } else {
        // Fallback: read from users (for backward compatibility)
        const userRef = rtdb.ref(`users/${uid}`);
        const userSnap = await userRef.once("value");

        if (!userSnap.exists()) {
          continue;
        }

        const userData = userSnap.val();
        currentScore = userData.score || 0;
        lastProcessedBatch = userData._lastProcessedBatch || {};
      }

      // Get _lastProcessedBatch from users/{uid} (always stored there)
      const userRef = rtdb.ref(`users/${uid}`);
      const userSnap = await userRef.once("value");
      if (userSnap.exists()) {
        const userData = userSnap.val();
        lastProcessedBatch = userData._lastProcessedBatch || {};
      }

      // IDEMPOTENCY: Check if this batch was already processed for this user

      if (lastProcessedBatch[batchId] === true) {
        // This batch was already processed for this user
        continue;
      }

      // Calculate new score
      const newScore = currentScore + delta;
      const newRank = calculateRank(newScore);

      // Mark this batch as processed for this user
      const updatedLastProcessed = {
        ...lastProcessedBatch,
        [batchId]: true,
      };

      // Update user score, rank, and processing marker
      // Update both users (backward compat) and users_scores (optimized)
      scoreUpdates[`users/${uid}/score`] = newScore;
      scoreUpdates[`users/${uid}/rank`] = newRank;
      scoreUpdates[`users/${uid}/_lastProcessedBatch`] = updatedLastProcessed;
      // Also update users_scores (lightweight path for future reads)
      scoreUpdates[`users_scores/${uid}/score`] = newScore;
      scoreUpdates[`users_scores/${uid}/rank`] = newRank;
      scoreUpdates[`users_scores/${uid}/lastUpdated`] = Date.now();

      affectedUids.add(uid);
    }

    // 6. Batch update all scores (atomic)
    if (Object.keys(scoreUpdates).length > 0) {
      await rtdb.ref().update(scoreUpdates);
    }

    // 7. Update indexes and caches
    if (affectedUids.size > 0) {
      await updateSortedScoreIndex(Array.from(affectedUids));
      await updateRanksIncremental(Array.from(affectedUids));
      await updateLeaderboardIncremental(Array.from(affectedUids));
    }

    // 8. Delete batch and lock (atomic - both or neither)
    await rtdb.ref().update({
      [`pendingScores/${batchId}`]: null,
    });

    return {
      processed: true,
      processedUsers: affectedUids.size,
      batchId: batchId,
    };
  } catch (error) {
    // Release lock on error
    try {
      await lockRef.remove();
    } catch (lockError) {
      // Ignore lock release errors
    }

    throw error;
  }
}

/**
 * Find expired batches that need processing (offline scans)
 * Returns array of batch IDs from last N batches
 * @param {number} lookbackBatches - Number of batches to look back
 */
async function findExpiredBatches(lookbackBatches = 24) {
  const expiredBatches = [];
  const now = new Date();

  // Generate batch IDs for last N batches (5-minute intervals)
  // CRITICAL: Use UTC methods to match client-side calculation
  for (let i = 1; i <= lookbackBatches; i++) {
    const batchDate = new Date(now.getTime() - (i * 5 * 60 * 1000));
    const minutes = Math.floor(batchDate.getUTCMinutes() / 5) * 5;
    const batchDateRounded = new Date(Date.UTC(
        batchDate.getUTCFullYear(),
        batchDate.getUTCMonth(),
        batchDate.getUTCDate(),
        batchDate.getUTCHours(),
        minutes,
    ));
    const batchId = batchDateRounded.toISOString()
        .slice(0, 16)
        .replace("T", "-");

    // Check if batch exists and has pending scores
    const batchRef = rtdb.ref(`pendingScores/${batchId}`);
    const batchSnap = await batchRef.once("value");

    if (batchSnap.exists()) {
      const batchData = batchSnap.val();
      // Check if batch has actual scores (not just lock)
      const hasScores = Object.keys(batchData).some((key) =>
        key !== "_processing" && batchData[key] && batchData[key].delta,
      );

      if (hasScores) {
        expiredBatches.push(batchId);
      }
    }
  }

  return expiredBatches;
}

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

  // CRITICAL FIX: If index is empty or missing, rebuild from all users
  if (sortedIndex.length === 0) {
    await updateSortedScoreIndex([], true);
    // Re-read the index after rebuild
    const rebuiltSnap = await indexRef.once("value");
    sortedIndex = rebuiltSnap.exists() ? rebuiltSnap.val() : [];
  }

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

  // Remove affected users from index (prevent duplicates)
  // CRITICAL FIX: Filter out duplicates before re-inserting
  sortedIndex = sortedIndex.filter(
      (entry) => !affectedUids.includes(entry.uid),
  ); // Re-insert affected users in correct position
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

  // Try to use query to get only top 10 (optimization)
  // Note: RTDB queries on arrays require the array to be stored as an object
  // Since sortedScores is an array, we'll read it and slice client-side
  // For future optimization, consider restructuring sortedScores as an object
  const indexSnap = await indexRef.once("value");

  if (!indexSnap.exists()) {
    // Fallback: rebuild index from all users
    await updateSortedScoreIndex(affectedUids);
    return updateLeaderboardIncremental(affectedUids);
  }

  const sortedIndex = indexSnap.val() || [];
  // Get top 10 (most efficient - only processes first 10 entries)
  // CRITICAL FIX: If there are fewer than 10 users total,
  // show all users (including 0-score users)
  const top10Index = sortedIndex.length < 10 ?
    sortedIndex :
    sortedIndex.slice(0, 10);
  // Get user details for top 10 only (much fewer reads)
  const allUsers = [];
  for (const entry of top10Index) {
    const userRef = rtdb.ref(`users/${entry.uid}`);
    const userSnap = await userRef.once("value");
    if (userSnap.exists()) {
      const data = userSnap.val();
      const profile = data.profile || {};
      let photoURL = profile.photoURL || data.photoURL || null;

      // Only fetch from Firebase Auth if photoURL is missing in RTDB
      // This reduces Auth API calls by ~90%
      if (!photoURL) {
        try {
          const authUser = await admin.auth()
              .getUser(entry.uid).catch(() => null);
          if (authUser && authUser.photoURL) {
            photoURL = authUser.photoURL;
            // Update RTDB for future use
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
        } catch (error) {
          // Auth read failed, continue with null photo
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
 * Manual trigger to process a specific batch (for testing/debugging)
 */
exports.processBatchManually = onCall(
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
            "Only admins can manually process batches",
        );
      }

      try {
        const batchId = request.data.batchId || getCurrentBatchId();
        const result = await processBatchIdempotent(batchId);
        return {
          success: true,
          batchId,
          result,
        };
      } catch (error) {
        throw new HttpsError(
            "internal",
            "Failed to process batch: " + error.message,
        );
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
    // Non-critical, continue
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
        // Only fetch photoURL from Firebase Auth if missing in RTDB
        // This reduces Auth API calls significantly
        let profile = userData.profile || {};
        let photoURL = profile.photoURL || userData.photoURL || null;

        // Only fetch from Firebase Auth if photoURL is missing
        if (!photoURL) {
          try {
            const authUser = await admin.auth().getUser(uid).catch(() => null);
            if (authUser && authUser.photoURL) {
              photoURL = authUser.photoURL;
              // Update RTDB with photoURL from Firebase Auth
              profile = {...profile, photoURL: photoURL};
              await rtdb.ref(`users/${uid}`).update({
                profile: profile,
              });
            }
          } catch (authError) {
            // Auth read failed, continue with existing data
          }
        }

        // Create/update QR code entry in RTDB if qrToken exists
        if (userData.qrToken) {
          const qrCodeRef = rtdb.ref(`qrcodes/${userData.qrToken}`);
          await qrCodeRef.set({
            uid: uid,
            name: profile.fullName || profile.displayName ||
                  userData.fullName || userData.displayName || "User",
            photo: photoURL || null,
            email: userData.email || null,
            district: profile.district || userData.district || null,
            phone: profile.phone || userData.phone || null,
            profession: profile.profession || userData.profession || null,
          });
        }

        // Update userData with synced photoURL for admin cache
        const updatedUserData = {
          ...userData,
          profile: profile,
        };

        // Create users_scores entry (lightweight path for score reads)
        const score = userData.score || 0;
        const rank = userData.rank || calculateRank(score);
        try {
          await rtdb.ref(`users_scores/${uid}`).set({
            score: score,
            rank: rank,
            lastUpdated: Date.now(),
          });
        } catch (scoreError) {
          // Non-critical, continue
        }

        // Add user to active cache
        await updateAdminCacheIncremental(uid, "active", updatedUserData);

        // CRITICAL: Remove user from pending cache if they exist there
        // Prevents duplicates when user migrates from pendingUsers to users
        // Find the encoded email from the user's email
        if (userData.email) {
          const normalizedEmail = userData.email.toLowerCase().trim();
          // Encode email the same way as in client code
          const base64 = Buffer.from(normalizedEmail).toString("base64");
          const encodedEmail = base64.replace(/[/+=]/g, (m) => {
            const map = {"/": "_", "+": "-", "=": ""};
            return map[m] || "";
          });

          // Remove from pending cache
          await removeFromAdminCache(encodedEmail, "pending");
        } // Update sorted score index
        await updateSortedScoreIndex([uid]); // Update ranks for this user
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
        // Only fetch photoURL from Firebase Auth if missing in RTDB
        // This reduces Auth API calls significantly
        let profile = userData.profile || {};
        let photoURL = profile.photoURL || userData.photoURL || null;

        // Only fetch from Firebase Auth if photoURL is missing
        if (!photoURL) {
          try {
            const authUser = await admin.auth().getUser(uid).catch(() => null);
            if (authUser && authUser.photoURL) {
              photoURL = authUser.photoURL;
              // Update RTDB with photoURL from Firebase Auth
              profile = {...profile, photoURL: photoURL};
              await rtdb.ref(`users/${uid}`).update({
                profile: profile,
              });
            }
          } catch (authError) {
            // Auth read failed, continue with existing data
          }
        }

        // Update QR code entry if qrToken exists and profile data changed
        if (userData.qrToken) {
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
              photo: photoURL || null,
              email: userData.email || null,
              district: profile.district || userData.district || null,
              phone: profile.phone || userData.phone || null,
              profession: profile.profession || userData.profession || null,
            });
          }
        }

        // Update userData with synced photoURL for admin cache
        const updatedUserData = {
          ...userData,
          profile: profile,
        };

        // Update users_scores entry (lightweight path for score reads)
        const score = userData.score || 0;
        const rank = userData.rank || calculateRank(score);
        try {
          await rtdb.ref(`users_scores/${uid}`).update({
            score: score,
            rank: rank,
            lastUpdated: Date.now(),
          });
        } catch (scoreError) {
          // Non-critical, continue
        }

        // Update admin cache
        await updateAdminCacheIncremental(uid, "active", updatedUserData);

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

        // Delete connection history
        // Only delete for active users (pending users don't have scan history)
        if (type === "active") {
          try {
            // 1. Delete user's own recent scans (their connection history)
            await rtdb.ref(`scans/recent/${uid}`).remove();

            // 2. Delete all scans where this user was the scanner
            // This deletes scans/byScanner/${uid}/* (all scans they made)
            await rtdb.ref(`scans/byScanner/${uid}`).remove();

            // 3. Delete all scans where this user was the target
            // (scanned by others)
            // Need to iterate through all scanners and remove this user
            // from their scan records
            const byScannerRef = rtdb.ref("scans/byScanner");
            const byScannerSnap = await byScannerRef.once("value");

            if (byScannerSnap.exists()) {
              const updates = {};
              byScannerSnap.forEach((scannerSnapshot) => {
                const scannerUid = scannerSnapshot.key;
                // Skip if this is the user being deleted
                // (already handled above)
                if (scannerUid !== uid) {
                  // Check if this scanner has scanned the deleted user
                  // scannerSnapshot is a DataSnapshot, check for child
                  const targetScanSnapshot = scannerSnapshot.child(uid);
                  if (targetScanSnapshot.exists()) {
                    // Add to updates to remove this scan record
                    updates[`scans/byScanner/${scannerUid}/${uid}`] = null;
                  }
                }
              });

              // Apply updates to remove this user from all other users'
              // scan records
              if (Object.keys(updates).length > 0) {
                await rtdb.ref().update(updates);
              }
            }
          } catch (scanError) {
            // Non-critical - connection history deletion failed
            // Continue with user deletion
          }
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
