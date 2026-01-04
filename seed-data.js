/**
 * Data Seeding Script for Networking App
 * 
 * This script uses firebase-admin to batch upload dummy users to Firestore and RTDB.
 * 
 * Prerequisites:
 * 1. Install firebase-admin: npm install firebase-admin
 * 2. Create a service account key in Firebase Console:
 *    - Go to Project Settings > Service Accounts
 *    - Click "Generate New Private Key"
 *    - Save the JSON file as serviceAccountKey.json
 * 3. Update the path to your service account key below
 * 
 * Usage:
 * node seed-data.js
 */

const admin = require('firebase-admin');
const path = require('path');

// Initialize Firebase Admin with service account
// Update this path to your service account key file
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://eventpasstest-default-rtdb.firebaseio.com' // Update with your RTDB URL
});

const db = admin.firestore();
const rtdb = admin.database();

// Generate cryptographically secure random 32-char hex token
function generateQRToken() {
  const crypto = require('crypto');
  return crypto.randomBytes(16).toString('hex'); // 16 bytes = 32 hex chars
}

// Generate QR code base64 (simplified - in production, use a QR library)
async function generateQRCodeBase64(token) {
  // For seeding, we'll create a simple placeholder
  // In production, use qrcode library: const QRCode = require('qrcode');
  // return await QRCode.toDataURL(token);
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='; // 1x1 transparent PNG
}

// Dummy user data
const dummyUsers = [
  { name: 'Alice Johnson', email: 'alice@example.com' },
  { name: 'Bob Smith', email: 'bob@example.com' },
  { name: 'Charlie Brown', email: 'charlie@example.com' },
  { name: 'Diana Prince', email: 'diana@example.com' },
  { name: 'Eve Wilson', email: 'eve@example.com' },
  { name: 'Frank Miller', email: 'frank@example.com' },
  { name: 'Grace Lee', email: 'grace@example.com' },
  { name: 'Henry Davis', email: 'henry@example.com' },
  { name: 'Ivy Chen', email: 'ivy@example.com' },
  { name: 'Jack Taylor', email: 'jack@example.com' }
];

async function seedData() {
  console.log('Starting data seeding...\n');

  try {
    for (const user of dummyUsers) {
      const email = user.email.toLowerCase().trim();
      const qrToken = generateQRToken();
      const qrCodeBase64 = await generateQRCodeBase64(qrToken);

      console.log(`Processing ${user.name} (${email})...`);

      // Create pending user in Firestore
      await db.collection('pendingUsers').doc(email).set({
        name: user.name,
        email: email,
        qrToken: qrToken,
        qrCodeBase64: qrCodeBase64,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'active'
      });

      console.log(`  ✓ Created pending user in Firestore`);
      console.log(`  ✓ QR Token: ${qrToken}`);

      // Note: RTDB entry will be created on first login when user document is migrated
      // For seeding, we can optionally create placeholder entries in RTDB
      // but they won't have UIDs until users log in
      
      console.log(`  ✓ Completed ${user.name}\n`);
    }

    console.log('✅ Data seeding completed successfully!');
    console.log('\nNote: Users will be migrated to users/{uid} collection on first login.');
    console.log('RTDB entries will be created with UID when users log in for the first time.');

  } catch (error) {
    console.error('❌ Error seeding data:', error);
    process.exit(1);
  }
}

// Run the seeding
seedData()
  .then(() => {
    console.log('\nSeeding script finished.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

