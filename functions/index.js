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
 * Helper function to normalize email for cache key
 * @param {string} email - Email to normalize
 * @return {string|null} Normalized email or null
 */
function normalizeEmail(email) {
  if (!email) return null;
  return email.toLowerCase().trim();
}

/**
 * Update admin email cache in RTDB
 * @param {string} email - Email address
 * @param {string} uid - User ID
 * @param {string} type - Type: "pending" or "active"
 * @param {boolean} isDelete - Whether to delete the cache entry
 */
async function updateAdminEmailCache(email, uid, type, isDelete = false) {
  if (!email) return;
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return;

  try {
    if (isDelete) {
      await rtdb.ref(`adminCache/emails/${normalizedEmail}`).remove();
    } else {
      await rtdb.ref(`adminCache/emails/${normalizedEmail}`).set({
        uid: uid,
        type: type,
        lastUpdated: Date.now(),
      });
    }
  } catch (error) {
    console.error(`Error updating admin email cache:`, error);
    // Non-critical, don't throw
  }
}

/**
 * Update admin participantId cache in RTDB
 * @param {string} participantId - Participant ID
 * @param {string} uid - User ID
 * @param {string} type - Type: "pending" or "active"
 * @param {boolean} isDelete - Whether to delete the cache entry
 */
async function updateAdminParticipantIdCache(
    participantId, uid, type, isDelete = false) {
  if (!participantId) return;
  const normalizedId = participantId.trim();
  if (!normalizedId) return;

  try {
    if (isDelete) {
      await rtdb.ref(`adminCache/participantIds/${normalizedId}`).remove();
    } else {
      await rtdb.ref(`adminCache/participantIds/${normalizedId}`).set({
        uid: uid,
        type: type,
        lastUpdated: Date.now(),
      });
    }
  } catch (error) {
    console.error(`Error updating admin participantId cache:`, error);
    // Non-critical, don't throw
  }
}

/**
 * Update admin participants list cache in RTDB
 * Fetches all pending and active users from Firestore
 */
async function updateAdminParticipantsCache() {
  try {
    // Fetch pending users
    const pendingUsersSnapshot = await db.collection("pendingUsers").get();
    const pendingUsers = [];
    pendingUsersSnapshot.forEach((doc) => {
      const data = doc.data();
      pendingUsers.push({
        id: doc.id,
        type: "pending",
        identifier: doc.id, // email
        sortDate: data.createdAt ? data.createdAt.toMillis() : 0,
        ...data,
      });
    });

    // Fetch active users
    const usersSnapshot = await db.collection("users").get();
    const activeUsers = [];
    usersSnapshot.forEach((doc) => {
      const data = doc.data();
      activeUsers.push({
        id: doc.id,
        type: "active",
        identifier: doc.id, // uid
        uid: doc.id,
        sortDate: data.firstLoginAt ? data.firstLoginAt.toMillis() :
                 data.lastLoginAt ? data.lastLoginAt.toMillis() : 0,
        ...data,
      });
    });

    // Update RTDB cache
    await rtdb.ref("adminCache/participants").set({
      pending: pendingUsers,
      active: activeUsers,
      lastUpdated: Date.now(),
    });
  } catch (error) {
    console.error("Error updating admin participants cache:", error);
    // Non-critical, don't throw
  }
}

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

      // Update QR code data if name, photo, or contact info changed
      if (before.fullName !== after.fullName ||
          before.photoURL !== after.photoURL ||
          before.email !== after.email ||
          before.phone !== after.phone ||
          before.district !== after.district ||
          before.profession !== after.profession) {
        if (after.qrToken) {
          updates[`qrcodes/${after.qrToken}`] = {
            uid: uid,
            name: after.fullName || after.displayName || "User",
            photo: after.photoURL || null,
            email: after.email || null,
            phone: after.phone || null,
            district: after.district || null,
            profession: after.profession || null,
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

      // Update admin caches if email or participantId changed
      const emailChanged = before.email !== after.email;
      const participantIdChanged =
          before.participantId !== after.participantId;
      const userDataChanged = emailChanged || participantIdChanged ||
          before.fullName !== after.fullName ||
          before.district !== after.district ||
          before.phone !== after.phone ||
          before.profession !== after.profession;

      if (emailChanged) {
        // Remove old email from cache
        if (before.email) {
          await updateAdminEmailCache(before.email, uid, "active", true);
        }
        // Add new email to cache
        if (after.email) {
          await updateAdminEmailCache(after.email, uid, "active");
        }
      } else if (after.email) {
        // Email didn't change, but ensure it's in cache
        await updateAdminEmailCache(after.email, uid, "active");
      }

      if (participantIdChanged) {
        // Remove old participantId from cache
        if (before.participantId) {
          await updateAdminParticipantIdCache(
              before.participantId, uid, "active", true);
        }
        // Add new participantId to cache
        if (after.participantId) {
          await updateAdminParticipantIdCache(
              after.participantId, uid, "active");
        }
      } else if (after.participantId) {
        // ParticipantId didn't change, but ensure it's in cache
        await updateAdminParticipantIdCache(after.participantId, uid, "active");
      }

      // Update participants list if user data changed
      if (userDataChanged) {
        await updateAdminParticipantsCache();
      }

      // Apply all updates
      if (Object.keys(updates).length > 0) {
        await rtdb.ref().update(updates);
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
          email: userData.email || null,
          phone: userData.phone || null,
          district: userData.district || null,
          profession: userData.profession || null,
        };
      }

      // Note: We don't cache current user's score/connections in RTDB anymore
      // Those are handled via localStorage since we already read the full user
      // document

      // Update leaderboard cache
      await updateLeaderboardCache();
      // Also update all user ranks (for leaderboard position)
      await updateAllUserRanks();

      // Update admin caches
      if (userData.email) {
        await updateAdminEmailCache(userData.email, uid, "active");
      }
      if (userData.participantId) {
        await updateAdminParticipantIdCache(
            userData.participantId, uid, "active");
      }
      await updateAdminParticipantsCache();

      // Apply updates
      if (Object.keys(updates).length > 0) {
        await rtdb.ref().update(updates);
      }

      return null;
    });

/**
 * Update admin caches when a pending user is created
 */
exports.onPendingUserCreate = onDocumentCreated(
    {
      document: "pendingUsers/{email}",
      region: region,
    },
    async (event) => {
      const userData = event.data.data();
      const email = event.params.email;

      try {
        // Update admin email cache
        await updateAdminEmailCache(email, email, "pending");
        // Update admin participantId cache if exists
        if (userData.participantId) {
          await updateAdminParticipantIdCache(
              userData.participantId, email, "pending");
        }
        // Update participants list
        await updateAdminParticipantsCache();
      } catch (error) {
        console.error(`Error updating admin caches for pending user:`, error);
        // Non-critical, don't throw
      }

      return null;
    });

/**
 * Update admin caches when a pending user is updated
 */
exports.onPendingUserUpdate = onDocumentUpdated(
    {
      document: "pendingUsers/{email}",
      region: region,
    },
    async (event) => {
      const before = event.data.before.data();
      const after = event.data.after.data();
      const email = event.params.email;

      try {
        const participantIdChanged =
            before.participantId !== after.participantId;
        const userDataChanged = participantIdChanged ||
            before.fullName !== after.fullName ||
            before.district !== after.district ||
            before.phone !== after.phone ||
            before.profession !== after.profession;

        // Update participantId cache if changed
        if (participantIdChanged) {
          // Remove old participantId from cache
          if (before.participantId) {
            await updateAdminParticipantIdCache(
                before.participantId, email, "pending", true);
          }
          // Add new participantId to cache
          if (after.participantId) {
            await updateAdminParticipantIdCache(
                after.participantId, email, "pending");
          }
        } else if (after.participantId) {
          // ParticipantId didn't change, but ensure it's in cache
          await updateAdminParticipantIdCache(
              after.participantId, email, "pending");
        }

        // Update participants list if user data changed
        if (userDataChanged) {
          await updateAdminParticipantsCache();
        }
      } catch (error) {
        console.error(`Error updating admin caches for pending user:`, error);
        // Non-critical, don't throw
      }

      return null;
    });

/**
 * Clean up admin caches when a pending user is deleted
 */
exports.onPendingUserDelete = onDocumentDeleted(
    {
      document: "pendingUsers/{email}",
      region: region,
    },
    async (event) => {
      const userData = event.data.data();
      const email = event.params.email;

      try {
        // Remove from admin email cache
        await updateAdminEmailCache(email, email, "pending", true);
        // Remove from admin participantId cache if exists
        if (userData.participantId) {
          await updateAdminParticipantIdCache(
              userData.participantId, email, "pending", true);
        }
        // Update participants list
        await updateAdminParticipantsCache();
      } catch (error) {
        console.error(
            `Error cleaning up admin caches for pending user:`, error);
        // Non-critical, don't throw
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

      // Update admin caches (remove user)
      if (userData.email) {
        await updateAdminEmailCache(
            userData.email, uid, "active", true);
      }
      if (userData.participantId) {
        await updateAdminParticipantIdCache(
            userData.participantId, uid, "active", true);
      }
      await updateAdminParticipantsCache();

      // Apply updates
      await rtdb.ref().update(updates);

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

        // Refresh admin caches
        await updateAdminParticipantsCache();

        // Also refresh pending users admin caches
        const pendingUsersSnapshot = await db.collection("pendingUsers").get();
        const adminCacheUpdates = {};
        pendingUsersSnapshot.forEach((doc) => {
          const data = doc.data();
          const email = doc.id;
          if (email) {
            adminCacheUpdates[`adminCache/emails/${normalizeEmail(email)}`] = {
              uid: email,
              type: "pending",
              lastUpdated: Date.now(),
            };
          }
          if (data.participantId) {
            const participantIdKeyPending =
                `adminCache/participantIds/${data.participantId.trim()}`;
            adminCacheUpdates[participantIdKeyPending] = {
              uid: email,
              type: "pending",
              lastUpdated: Date.now(),
            };
          }
        });

        // Update active users admin caches
        usersSnapshot.forEach((doc) => {
          const data = doc.data();
          const uid = doc.id;
          if (data.email) {
            const normalizedEmail = normalizeEmail(data.email);
            adminCacheUpdates[`adminCache/emails/${normalizedEmail}`] = {
              uid: uid,
              type: "active",
              lastUpdated: Date.now(),
            };
          }
          if (data.participantId) {
            const participantIdKey =
                `adminCache/participantIds/${data.participantId.trim()}`;
            adminCacheUpdates[participantIdKey] = {
              uid: uid,
              type: "active",
              lastUpdated: Date.now(),
            };
          }
        });

        if (Object.keys(adminCacheUpdates).length > 0) {
          await rtdb.ref().update(adminCacheUpdates);
        }

        return {
          success: true,
          message: `Refreshed caches for ${usersSnapshot.size} users ` +
                   `and admin caches`,
        };
      } catch (error) {
        console.error("Error refreshing all caches:", error);
        throw new HttpsError(
            "internal", "Failed to refresh all caches");
      }
    });

