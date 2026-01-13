/**
 * Migration Script: Current Architecture → Optimized Architecture
 * 
 * This script migrates data from the current Firestore-centric architecture
 * to the new RTDB-first optimized architecture.
 * 
 * Run: node migrate-to-optimized.js
 */

const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

// Try to use service account key if available, otherwise use default credentials
let credential;
const serviceAccountPath = path.join(__dirname, "serviceAccountKey.json");

if (fs.existsSync(serviceAccountPath)) {
  const serviceAccount = require(serviceAccountPath);
  credential = admin.credential.cert(serviceAccount);
} else {
  // Use Application Default Credentials (requires: gcloud auth application-default login)
  credential = admin.credential.applicationDefault();
}

admin.initializeApp({
  credential: credential,
  projectId: "rsapassport",
  databaseURL: "https://rsapassport-default-rtdb.asia-southeast1.firebasedatabase.app",
});

const db = admin.firestore();
const rtdb = admin.database();

/**
 * Normalize email
 */
function normalizeEmail(email) {
  if (!email) return null;
  return email.toLowerCase().trim();
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
 * Main migration function
 */
async function migrate() {
  console.log("Starting migration...");

  try {
    // Step 1: Migrate users from Firestore to RTDB
    console.log("Step 1: Migrating users...");
    await migrateUsers();

    // Step 2: Migrate scan history
    console.log("Step 2: Migrating scan history...");
    await migrateScanHistory();

    // Step 3: Build indexes
    console.log("Step 3: Building indexes...");
    await buildIndexes();

    // Step 4: Pre-compute leaderboard
    console.log("Step 4: Pre-computing leaderboard...");
    await precomputeLeaderboard();

    // Step 5: Pre-compute ranks
    console.log("Step 5: Pre-computing ranks...");
    await precomputeRanks();

    // Step 6: Migrate pending users
    console.log("Step 6: Migrating pending users...");
    await migratePendingUsers();

    // Step 7: Initialize metadata
    console.log("Step 7: Initializing metadata...");
    await initializeMetadata();

    console.log("Migration completed successfully!");
  } catch (error) {
    console.error("Migration failed:", error);
    throw error;
  }
}

/**
 * Migrate users from Firestore to RTDB
 */
async function migrateUsers() {
  const usersSnapshot = await db.collection("users").get();
  const updates = {};
  let count = 0;

  usersSnapshot.forEach((doc) => {
    const uid = doc.id;
    const data = doc.data();

    updates[`users/${uid}`] = {
      email: data.email || null,
      participantId: data.participantId || null,
      qrToken: data.qrToken || null,
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

  // Batch update in chunks of 100
  const updateKeys = Object.keys(updates);
  for (let i = 0; i < updateKeys.length; i += 100) {
    const chunk = {};
    updateKeys.slice(i, i + 100).forEach((key) => {
      chunk[key] = updates[key];
    });
    await rtdb.ref().update(chunk);
    console.log(`  Migrated ${Math.min(i + 100, updateKeys.length)}/${updateKeys.length} users...`);
  }

  console.log(`  Total users migrated: ${count}`);
}

/**
 * Migrate scan history from Firestore to RTDB
 */
async function migrateScanHistory() {
  const usersSnapshot = await db.collection("users").get();
  const scanUpdates = {};
  let totalScans = 0;

  usersSnapshot.forEach((doc) => {
    const scannerUid = doc.id;
    const scanHistory = doc.data().scanHistory || [];

    scanHistory.forEach((scan) => {
      const scannedUid = scan.uid || scan.scannedUid;
      if (!scannedUid) return;

      const scannedAt = scan.scannedAt?.toMillis?.() ||
                        new Date(scan.scannedAt).getTime() ||
                        Date.now();

      scanUpdates[`scans/byScanner/${scannerUid}/${scannedUid}`] = {
        scannedAt: scannedAt,
        points: 10,
        metadata: {
          name: scan.name || null,
          photo: scan.photo || null,
          district: scan.district || null,
        },
      };

      totalScans++;
    });
  });

  // Batch update scans
  if (Object.keys(scanUpdates).length > 0) {
    await rtdb.ref().update(scanUpdates);
  }

  console.log(`  Total scans migrated: ${totalScans}`);
}

/**
 * Build indexes for efficient lookups
 */
async function buildIndexes() {
  const usersSnapshot = await db.collection("users").get();
  const pendingUsersSnapshot = await db.collection("pendingUsers").get();
  const indexUpdates = {};

  // Index active users
  usersSnapshot.forEach((doc) => {
    const uid = doc.id;
    const data = doc.data();

    if (data.email) {
      const normalizedEmail = normalizeEmail(data.email);
      indexUpdates[`indexes/emails/${normalizedEmail}`] = {
        uid: uid,
        type: "active",
        lastUpdated: Date.now(),
      };
    }

    if (data.participantId) {
      indexUpdates[`indexes/participantIds/${data.participantId}`] = {
        uid: uid,
        type: "active",
        lastUpdated: Date.now(),
      };
    }

    if (data.qrToken) {
      indexUpdates[`indexes/qrTokens/${data.qrToken}`] = {
        uid: uid,
        lastUpdated: Date.now(),
      };
    }
  });

  // Index pending users
  pendingUsersSnapshot.forEach((doc) => {
    const email = doc.id;
    const data = doc.data();

    const normalizedEmail = normalizeEmail(email);
    indexUpdates[`indexes/emails/${normalizedEmail}`] = {
      uid: email,
      type: "pending",
      lastUpdated: Date.now(),
    };

    if (data.participantId) {
      indexUpdates[`indexes/participantIds/${data.participantId}`] = {
        uid: email,
        type: "pending",
        lastUpdated: Date.now(),
      };
    }

    if (data.qrToken) {
      indexUpdates[`indexes/qrTokens/${data.qrToken}`] = {
        uid: email,
        lastUpdated: Date.now(),
      };
    }
  });

  // Batch update indexes
  if (Object.keys(indexUpdates).length > 0) {
    await rtdb.ref().update(indexUpdates);
  }

  console.log(`  Indexes built: ${Object.keys(indexUpdates).length}`);
}

/**
 * Pre-compute leaderboard
 */
async function precomputeLeaderboard() {
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

  // Sort by score (desc)
  allUsers.sort((a, b) => b.score - a.score);

  // Top 10
  const top10 = {};
  allUsers.slice(0, 10).forEach((user, index) => {
    top10[index] = {
      uid: user.uid,
      name: user.name,
      score: user.score,
      rank: user.rank,
      photo: user.photo,
      district: user.district,
    };
  });

  // Fill remaining slots
  for (let i = allUsers.length; i < 10; i++) {
    top10[i] = null;
  }

  await rtdb.ref("leaderboard/top10").set(top10);
  await rtdb.ref("leaderboard/metadata").set({
    lastUpdated: Date.now(),
    totalUsers: allUsers.length,
    version: 1,
  });

  console.log(`  Leaderboard pre-computed: ${allUsers.length} users`);
}

/**
 * Pre-compute ranks
 */
async function precomputeRanks() {
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

  const rankUpdates = {};
  allUsers.forEach((user, index) => {
    // Calculate rank considering ties
    let rank = index + 1;
    for (let i = index - 1; i >= 0; i--) {
      if (allUsers[i].score === user.score) {
        rank = i + 1;
      } else {
        break;
      }
    }

    rankUpdates[`ranks/${user.uid}`] = {
      leaderboardRank: rank,
      rank: calculateRank(user.score),
      lastUpdated: Date.now(),
    };
  });

  // Batch update ranks
  if (Object.keys(rankUpdates).length > 0) {
    await rtdb.ref().update(rankUpdates);
  }

  console.log(`  Ranks pre-computed: ${allUsers.length} users`);
}

/**
 * Migrate pending users
 */
async function migratePendingUsers() {
  const pendingUsersSnapshot = await db.collection("pendingUsers").get();
  const updates = {};
  let count = 0;

  pendingUsersSnapshot.forEach((doc) => {
    const email = doc.id;
    const data = doc.data();

    updates[`pendingUsers/${email}`] = {
      participantId: data.participantId || null,
      fullName: data.fullName || null,
      district: data.district || null,
      phone: data.phone || null,
      profession: data.profession || null,
      qrToken: data.qrToken || null,
      qrCodeBase64: data.qrCodeBase64 || null,
      createdAt: data.createdAt?.toMillis() || Date.now(),
      status: "pending",
    };

    count++;
  });

  if (Object.keys(updates).length > 0) {
    await rtdb.ref().update(updates);
  }

  console.log(`  Pending users migrated: ${count}`);
}

/**
 * Initialize metadata
 */
async function initializeMetadata() {
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

  console.log("  Metadata initialized");
}

// Run migration
migrate()
    .then(() => {
      console.log("Migration completed successfully!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Migration failed:", error);
      process.exit(1);
    });
