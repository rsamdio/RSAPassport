// Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyB2lMtOpxbSGd9dulS5IGUdWN6_hSzoe9w",
    authDomain: "rsapassport.firebaseapp.com",
    projectId: "rsapassport",
    storageBucket: "rsapassport.firebasestorage.app",
    messagingSenderId: "346221600974",
    appId: "1:346221600974:web:b35722e12a85947109f09f",
    databaseURL: "https://rsapassport-default-rtdb.asia-southeast1.firebasedatabase.app"
};

// Initialize Firebase
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { 
    getAuth, 
    GoogleAuthProvider, 
    signInWithPopup, 
    onAuthStateChanged,
    signOut 
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import { 
    getFirestore, 
    doc, 
    getDoc, 
    setDoc, 
    updateDoc, 
    collection, 
    query as firestoreQuery, 
    where,
    orderBy, 
    limit, 
    getDocs,
    addDoc,
    getDocs as getCollectionDocs,
    runTransaction,
    serverTimestamp,
    increment,
    arrayUnion
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import { 
    getDatabase, 
    ref, 
    get, 
    set,
    update,
    remove,
    query,
    orderByKey,
    orderByChild,
    limitToLast,
    limitToFirst,
    startAt,
    endAt
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js';
import { deleteDoc } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import { 
    getFunctions, 
    httpsCallable 
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth();
const db = getFirestore();
const rtdb = getDatabase(app);
const functions = getFunctions(app);
const googleProvider = new GoogleAuthProvider();

// View management
const views = {
    login: document.getElementById('login-view'),
    passport: document.getElementById('passport-view'),
    scanner: document.getElementById('scanner-view'),
    leaderboard: document.getElementById('leaderboard-view'),
    history: document.getElementById('history-view')
};

async function showView(viewName) {
    // CRITICAL: Stop scanner FIRST if leaving scanner view
    if (viewName !== 'scanner' && scannerActive) {
        await stopScanner();
    }
    
    Object.values(views).forEach(view => {
        if (view) view.classList.add('hidden');
    });
    if (views[viewName]) {
        views[viewName].classList.remove('hidden');
    }
    
    // Auto-start scanner when scanner view is shown
    if (viewName === 'scanner' && currentUser) {
        // Small delay to ensure view is rendered
        setTimeout(() => {
            ensureScannerActive();
        }, 100);
    }
    
    // Load recent connections when passport view is shown
    if (viewName === 'passport' && currentUser) {
        // Small delay to ensure view is rendered
        setTimeout(() => {
            loadRecentConnections().catch(err => console.error('Error loading recent connections:', err));
        }, 100);
    }
}

// Current user state
let currentUser = null;
let html5QrCode = null;

// Auth state listener
onAuthStateChanged(auth, async (user) => {
    try {
    if (user) {
        // Check if user is registered and migrate from pendingUsers if needed
        const isParticipant = await checkIfParticipant(user.uid, user.email);
        
        if (!isParticipant) {
            showAccessDeniedModal();
            await signOut(auth);
            showView('login');
            return;
        }
        
        currentUser = user;
            
            // CRITICAL: Verify user exists in RTDB after migration
            // If migration happened, wait a moment for RTDB to propagate
            const userRTDBRef = ref(rtdb, `users/${user.uid}`);
            let userRTDBSnap = await get(userRTDBRef);
            
            if (!userRTDBSnap.exists()) {
                // Wait a bit longer for RTDB to propagate
                await new Promise(resolve => setTimeout(resolve, 500));
                userRTDBSnap = await get(userRTDBRef);
            }
            
            // Update user data immediately - photoURL and displayName from Firebase Auth
            // RTDB triggers will automatically update admin cache in real-time
        await updateUserOnLogin(user);
        
            // Check if this is a new user and aggressively clear connection history
            // This ensures deleted users who are re-added don't have old connection history
            // Re-read to get fresh data after updateUserOnLogin
            userRTDBSnap = await get(userRTDBRef);
            let shouldClearHistory = false;
            
            if (userRTDBSnap.exists()) {
                const userData = userRTDBSnap.val();
                const score = userData.score || 0;
                const firstLoginAt = userData.firstLoginAt;
                
                // Clear history if:
                // 1. User has score 0 (new user with no scans yet) - most reliable indicator
                // 2. OR user was created very recently (within 60 seconds)
                if (score === 0) {
                    shouldClearHistory = true;
                } else if (firstLoginAt && (Date.now() - firstLoginAt) < 60000) {
                    shouldClearHistory = true;
                }
            }
            
            // Aggressively clear connection history for new/fresh users
            if (shouldClearHistory) {
                try {
                    // Force clear RTDB connection history
                    await set(ref(rtdb, `scans/recent/${user.uid}`), []);
                    
                    // Clear localStorage cache for connection history
                    localStorage.removeItem(`user_${user.uid}_recentConnections`);
                } catch (historyError) {
                    // Non-critical - continue even if history clearing fails
                }
            }
            
            // Update localStorage cache
        await updateRTDBUserData(user);
            
            // Validate and fix stale QR codes (Zombie Token fix)
            await validateLocalSession();
        
        await loadUserProfile();
            
            // Ensure view is shown before UI updates
        showView('passport');
            
            // Force UI update after view is shown (in case elements weren't ready)
            setTimeout(() => {
                loadUserProfile().catch(() => {});
            }, 100);
    } else {
        currentUser = null;
        showView('login');
        }
    } catch (error) {
        // Show error to user
        const userNameEl = document.getElementById('user-name');
        if (userNameEl) {
            userNameEl.textContent = 'Error loading profile';
        }
        
        // Still show login if no user
        if (!user) {
            currentUser = null;
            showView('login');
        }
    }
});

/**
 * Validates that the displayed QR code matches the current token in RTDB
 * Auto-heals stale QR codes by regenerating from current token
 * Fixes: Zombie Token Bug (C1)
 */
async function validateLocalSession() {
    if (!currentUser) return;
    
    const uid = currentUser.uid;
    
    try {
        // 1. Get current qrToken from RTDB (source of truth)
        const userRef = ref(rtdb, `users/${uid}`);
        const userSnap = await get(userRef);
        
        if (!userSnap.exists()) {
            // User doesn't exist, clear all cache
            clearAllLocalCache(uid);
            return;
        }
        
        const userData = userSnap.val();
        const currentToken = userData.qrToken;
        
        if (!currentToken) {
            return;
        }
        
        // 2. Check localStorage cache for stored token
        const cacheKey = `user_${uid}_qr`;
        const cachedQR = localStorage.getItem(cacheKey);
        
        let cachedToken = null;
        if (cachedQR) {
            try {
                const parsed = JSON.parse(cachedQR);
                cachedToken = parsed.token || parsed.qrToken;
            } catch (e) {
                // Invalid cache, clear it
                localStorage.removeItem(cacheKey);
            }
        }
        
        // 3. Validate token matches
        if (cachedToken && cachedToken !== currentToken) {
            // STALE TOKEN DETECTED - Auto-heal
            // Clear stale QR code cache
            localStorage.removeItem(cacheKey);
            
            // Regenerate QR code with current token
            const canvas = document.getElementById('qr-code-canvas');
            if (canvas) {
                await generateQRCode(currentToken);
            }
            
            // Also clear any other stale caches
            clearStaleCaches(uid, currentToken);
        }
        
        // 4. Validate QR code in RTDB exists and matches
        const qrCodeRef = ref(rtdb, `qrcodes/${currentToken}`);
        const qrCodeSnap = await get(qrCodeRef);
        
        if (!qrCodeSnap.exists()) {
            // QR code missing - recreate it
            try {
                const qrCodeData = {
                    uid: uid,
                    name: userData.profile?.fullName || userData.profile?.displayName || 'User',
                    photo: userData.profile?.photoURL || null,
                    email: userData.email || null,
                    district: userData.profile?.district || null,
                    phone: userData.profile?.phone || null,
                    profession: userData.profile?.profession || null,
                };
                
                await set(qrCodeRef, qrCodeData);
            } catch (recreateError) {
                // Failed to recreate QR code - non-critical
            }
        } else {
            // Validate QR code UID matches current user
            const qrCodeData = qrCodeSnap.val();
            if (qrCodeData.uid !== uid) {
                // Update QR code with correct UID (handles migration edge case)
                try {
                    await update(qrCodeRef, { uid: uid });
                } catch (updateError) {
                    // Failed to update QR code UID - non-critical
                }
            }
        }
        
        // 5. Update cache with current token (for future validation)
        try {
            localStorage.setItem(cacheKey, JSON.stringify({
                token: currentToken,
                timestamp: Date.now(),
                validated: true
            }));
        } catch (e) {
            // localStorage might be disabled
        }
        
    } catch (error) {
        // Error validating local session - non-critical, continue with app
    }
}

/**
 * Clears all stale caches for a user
 */
function clearStaleCaches(uid, currentToken) {
    try {
        // Clear QR code cache
        localStorage.removeItem(`user_${uid}_qr`);
        
        // Clear user data cache (might have stale score/rank)
        localStorage.removeItem(`user_${uid}_data`);
        
        // Note: We keep recentConnections cache as it's less critical
    } catch (e) {
        // localStorage might be disabled
    }
}

/**
 * Clears all local cache for a user (used on logout/deletion)
 */
function clearAllLocalCache(uid) {
    try {
        localStorage.removeItem(`user_${uid}_qr`);
        localStorage.removeItem(`user_${uid}_data`);
        localStorage.removeItem(`user_${uid}_recentConnections`);
        localStorage.removeItem(`leaderboardRank_${uid}`);
    } catch (e) {
        // localStorage might be disabled
    }
}

// Update localStorage cache with user data
// Note: RTDB updates are handled automatically by Cloud Functions
async function updateRTDBUserData(user) {
    try {
        const userRef = doc(db, 'users', user.uid);
        const userSnap = await getDoc(userRef);
        
        if (!userSnap.exists() || !userSnap.data().qrToken) {
            return;
        }
        
        const userData = userSnap.data();
        
        // Note: RTDB updates are handled by Cloud Functions automatically
        // when Firestore user documents are updated
        
        // Update localStorage cache (instant, no network)
        const score = userData.score || 0;
        const rank = userData.rank || await calculateRank(score);
        try {
            localStorage.setItem(`user_${user.uid}_data`, JSON.stringify({
                score: score,
                rank: rank,
                timestamp: Date.now()
            }));
        } catch (localError) {
            // localStorage might be disabled, ignore
        }
    } catch (error) {
        // Non-critical errors are ignored
    }
}

// Generate cryptographically secure random 32-char hex token
function generateQRToken() {
    const array = new Uint8Array(16); // 16 bytes = 32 hex chars
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

// Encode email for RTDB path (replaces invalid characters)
function encodeEmailForPath(email) {
    if (!email) return null;
    // RTDB paths can't contain: . # $ [ ] @
    // Use base64 encoding and replace invalid chars
    const base64 = btoa(email.toLowerCase().trim());
    return base64.replace(/[/+=]/g, (m) => {
        const map = {'/': '_', '+': '-', '=': ''};
        return map[m] || '';
    });
}

// Check if user is a registered participant and migrate from pendingUsers if needed
// RTDB-first: Check RTDB first, then Firestore as fallback
async function checkIfParticipant(uid, email) {
    try {
        if (!email) {
            return false;
        }
        
        // First check if user already exists in RTDB users
        const userRTDBRef = ref(rtdb, `users/${uid}`);
        const userRTDBSnap = await get(userRTDBRef);
        
        if (userRTDBSnap.exists()) {
            return true;
        }
        
        // Also check Firestore users (for backward compatibility)
        // BUT: If user exists in Firestore but NOT in RTDB, we need to migrate them
        const userRef = doc(db, 'users', uid);
        const userSnap = await getDoc(userRef);
        
        if (userSnap.exists()) {
            // User exists in Firestore - check if they also exist in RTDB
            // If not in RTDB, we need to create them there (migrate from Firestore)
            if (!userRTDBSnap.exists()) {                const firestoreData = userSnap.data();
                // Create user in RTDB from Firestore data
                try {
                    const userRTDBRef = ref(rtdb, `users/${uid}`);
                    await set(userRTDBRef, {
                        email: firestoreData.email || normalizedEmail,
                        participantId: firestoreData.participantId || null,
                        qrToken: firestoreData.qrToken || null,
                        qrCodeBase64: firestoreData.qrCodeBase64 || null,
                        score: firestoreData.score || 0,
                        rank: firestoreData.rank || 'Rookie',
                        profile: firestoreData.profile || {},
                        firstLoginAt: firestoreData.firstLoginAt || Date.now(),
                        lastLoginAt: Date.now(),
                    });                } catch (migrateError) {
                    console.error('checkIfParticipant: Failed to migrate from Firestore:', migrateError);
                    // Continue anyway - user exists in Firestore
                }
            }
            return true;
        }
        
        // Check RTDB pendingUsers first (RTDB-first architecture)
        const normalizedEmail = email.toLowerCase().trim();
        const encodedEmail = encodeEmailForPath(normalizedEmail);
        
        // Check RTDB index first
        const emailIndexRef = ref(rtdb, `indexes/emails/${encodedEmail}`);
        const emailIndexSnap = await get(emailIndexRef);
        
        if (emailIndexSnap.exists()) {
            const indexData = emailIndexSnap.val();
            const pendingEmail = indexData.uid || encodedEmail;
            
            // Get pending user data from RTDB
            const pendingUserRTDBRef = ref(rtdb, `pendingUsers/${pendingEmail}`);
            const pendingUserRTDBSnap = await get(pendingUserRTDBRef);
            
            if (pendingUserRTDBSnap.exists()) {
                const pendingData = pendingUserRTDBSnap.val();                // Verify email matches (security check)
                if (pendingData.email && pendingData.email.toLowerCase().trim() !== normalizedEmail) {
                    console.error('checkIfParticipant: Email mismatch', {
                        pendingEmail: pendingData.email,
                        normalizedEmail: normalizedEmail
                    });
                    return false;
                }
                
                try {
                    await migratePendingUser(uid, normalizedEmail, pendingData);                    return true;
                } catch (migrationError) {
                    console.error('checkIfParticipant: Migration failed:', migrationError);
                    throw migrationError; // Re-throw to be caught by outer try-catch
                }
            }
        }
        
        // Fallback: Check Firestore pendingUsers (for backward compatibility)
        const pendingUsersRef = collection(db, 'pendingUsers');
        const emailQuery = firestoreQuery(pendingUsersRef, where('email', '==', normalizedEmail));
        let querySnapshot;
        
        try {
            querySnapshot = await getDocs(emailQuery);
        } catch (error) {
            // Fallback: try direct document access
            const pendingUserRef = doc(db, 'pendingUsers', normalizedEmail);
            try {
                const pendingUserSnap = await getDoc(pendingUserRef);
                if (pendingUserSnap.exists()) {
                    const pendingData = pendingUserSnap.data();                    try {
                    await migratePendingUser(uid, normalizedEmail, pendingData);                    return true;
                    } catch (migrationError) {
                        console.error('checkIfParticipant: Migration failed:', migrationError);
                        throw migrationError;
                    }
                }
            } catch (fallbackError) {
                // Ignore fallback errors
            }
            return false;
        }
        
        if (!querySnapshot.empty) {
            // Found pending user - migrate it
            const pendingDoc = querySnapshot.docs[0];
            const pendingData = pendingDoc.data();
            
            // Verify email matches (security check)
            if (pendingData.email && pendingData.email.toLowerCase().trim() !== normalizedEmail) {
                console.error('checkIfParticipant: Email mismatch in Firestore query', {
                    pendingEmail: pendingData.email,
                    normalizedEmail: normalizedEmail
                });
                return false;
            }
            
            try {
                await migratePendingUser(uid, normalizedEmail, pendingData);
                return true;
            } catch (migrationError) {
                console.error('checkIfParticipant: Migration failed:', migrationError);
                throw migrationError;
            }
        }
        
        return false;
    } catch (error) {
        console.error('checkIfParticipant: Error checking participant status:', error);
        
        if (error.code === 'permission-denied') {
            console.error('checkIfParticipant: Permission denied - user may not have access');
        }
        // Don't swallow migration errors - let them propagate
        if (error.message && error.message.includes('migration')) {
            throw error;
        }
        return false;
    }
}

// Helper function to migrate pending user to active user
async function migratePendingUser(uid, normalizedEmail, pendingData) {
    try {
        const qrToken = pendingData.qrToken;
        if (!qrToken) {
            console.error('migratePendingUser: qrToken missing from pendingUsers document');
            throw new Error('qrToken missing from pendingUsers document');
        }
        
        // Calculate initial rank
        const initialRank = await calculateRank(0);
        
        // Update RTDB immediately (RTDB-first architecture)
        // Firestore backup is handled by hourlyFirestoreBackup Cloud Function
        const encodedEmail = encodeEmailForPath(normalizedEmail);
        const userRTDBRef = ref(rtdb, `users/${uid}`);
        
        // Get photoURL and displayName from currentUser (from Firebase Auth)
        // For new logins, Firebase Auth might need a moment to load profile data
        let authPhotoURL = null;
        let authDisplayName = null;
        
        // Try to get from currentUser immediately
        if (currentUser) {
            authPhotoURL = currentUser.photoURL || null;
            authDisplayName = currentUser.displayName || null;
        }
        
        // If photoURL is still missing, wait and retry (Firebase Auth profile might still be loading)
        // This is especially important for OAuth providers (Google, etc.) in incognito mode
        if (!authPhotoURL && currentUser) {
            // Wait for Firebase Auth to fully load profile data
            await new Promise(resolve => setTimeout(resolve, 1000));
            // Re-check currentUser (profile data might have loaded)
            authPhotoURL = currentUser.photoURL || null;
            authDisplayName = currentUser.displayName || null;
        }
        
        // If still missing, try reloading the user to get fresh data
        if (!authPhotoURL && currentUser) {
            try {
                await currentUser.reload();
                authPhotoURL = currentUser.photoURL || null;
                authDisplayName = currentUser.displayName || null;
            } catch (reloadError) {
                // Reload failed, continue with what we have
            }
        }
        
        // Prepare profile data with explicit null values (not undefined)
        const profile = {
            fullName: pendingData.fullName || null,
            district: pendingData.district || null,
            phone: pendingData.phone || null,
            profession: pendingData.profession || null,
            photoURL: authPhotoURL !== undefined ? authPhotoURL : null,
            displayName: authDisplayName !== undefined ? authDisplayName : null,
        };
        
        // Update user in RTDB
        try {
            await set(userRTDBRef, {
                email: normalizedEmail,
                participantId: pendingData.participantId || null,
                qrToken: qrToken,
                qrCodeBase64: pendingData.qrCodeBase64 || null,
                score: 0,
                rank: initialRank,
                profile: profile,
                firstLoginAt: Date.now(),
                lastLoginAt: Date.now(),
            });
            
            // CRITICAL: Verify user was created before proceeding
            // Wait a moment for RTDB to propagate the write
            await new Promise(resolve => setTimeout(resolve, 200));
            
            // Verify the user exists
            const verifyRef = ref(rtdb, `users/${uid}`);
            const verifySnap = await get(verifyRef);
            if (!verifySnap.exists()) {
                throw new Error('User creation verification failed - user not found in RTDB after creation');
            }
        } catch (createError) {
            console.error('Error details:', {
                code: createError.code,
                message: createError.message,
            uid: uid,
                path: `users/${uid}`,
                stack: createError.stack
            });
            // Re-throw to stop migration - don't continue if user creation fails
            throw createError;
        }
        
        // REMOVED: Client cannot write to users_scores (write: false in RTDB rules)
        // This is now handled by onUserCreated trigger in Cloud Functions
        // The trigger will create users_scores entry automatically
        
        // Immediately update QR code with correct UID (don't wait for trigger)
        // This fixes race condition where QR code might be scanned before onUserCreated completes
        // The QR code currently has uid: encodedEmail, but should have uid: uid
        try {
            const qrCodeRef = ref(rtdb, `qrcodes/${qrToken}`);
            
            await update(qrCodeRef, {
            uid: uid,
                name: profile.fullName || profile.displayName || pendingData.fullName || "User",
                photo: authPhotoURL || null,
                email: normalizedEmail,
                district: profile.district || pendingData.district || null,
                phone: profile.phone || pendingData.phone || null,
                profession: profile.profession || pendingData.profession || null,
            });
        } catch (qrUpdateError) {
            // Non-critical - onUserCreated trigger will handle it
        }
        
        // onUserCreated RTDB trigger will handle:
        // - QR code creation/update (if not already done above)
        // - PhotoURL syncing from Firebase Auth (if missing)
        // - Admin cache updates
        // - Rank calculation
        // - Leaderboard updates
        
        // Clean up all scan records for new user (first login)
        // This ensures deleted users who are re-added can scan everyone again
        // We clean up scan records to prevent orphaned records from blocking scans
        try {
            // 1. Clear RTDB connection history (recent scans)
            await set(ref(rtdb, `scans/recent/${uid}`), []);
            
            // 2. Clear all scan records where this user was the scanner
            // This removes any orphaned records from previous account (if same UID)
            // or ensures clean state for new account
            await set(ref(rtdb, `scans/byScanner/${uid}`), null);
            
            // 3. Clear localStorage cache for connection history
            try {
                localStorage.removeItem(`user_${uid}_recentConnections`);
            } catch (localError) {
                // localStorage might be disabled, ignore
            }
        } catch (historyError) {
            // Non-critical - continue even if history clearing fails
        }
        
        // RTDB triggers will automatically:
        // 1. Update admin cache (pending -> active) in real-time
        // 2. Update sorted score index
        // 3. Calculate and store rank
        // 4. Update leaderboard if user is in top 10
        
        // Set initial rank in ranks cache (so it shows up immediately)
        // For new users, we'll calculate rank from all existing users
        let estimatedRank = null;
        try {
            // Try to get from sorted index first
            const indexRef = ref(rtdb, 'indexes/sortedScores');
            const indexSnap = await get(indexRef);
            if (indexSnap.exists()) {
                const sortedIndex = indexSnap.val() || [];
                // Find where this user would be inserted (score = 0)
                // Users with score 0 should be at the end
                estimatedRank = sortedIndex.length + 1;
            } else {
                // If index doesn't exist, count all users
                const usersRef = ref(rtdb, 'users');
                const usersSnap = await get(usersRef);
                if (usersSnap.exists()) {
                    const users = usersSnap.val();
                    const userCount = Object.keys(users).length;
                    estimatedRank = userCount; // This user is the last one
                }
            }
        } catch (error) {
            // Index might not exist yet, that's okay
        }
        
        const rankRef = ref(rtdb, `ranks/${uid}`);
        await set(rankRef, {
            leaderboardRank: estimatedRank, // Estimated rank, will be recalculated by Cloud Functions
            rank: initialRank,
            lastUpdated: Date.now(),
        });
        
        // REMOVED: Client should NOT update sorted index (causes duplicates)
        // The onUserCreated trigger in Cloud Functions handles this automatically
        // This prevents duplicate entries when both client and trigger update the index
        
        // Update RTDB indexes
        const indexUpdates = {};
        if (normalizedEmail) {
            indexUpdates[`indexes/emails/${encodedEmail}`] = {
                uid: uid,
                email: normalizedEmail,
                type: 'active',
                lastUpdated: Date.now(),
            };
        }
        if (pendingData.participantId) {
            indexUpdates[`indexes/participantIds/${pendingData.participantId}`] = {
                uid: uid,
                email: normalizedEmail,
                type: 'active',
                lastUpdated: Date.now(),
            };
        }
        if (qrToken) {
            indexUpdates[`indexes/qrTokens/${qrToken}`] = {
                uid: uid,
                email: normalizedEmail,
                lastUpdated: Date.now(),
            };
        }
        
        if (Object.keys(indexUpdates).length > 0) {
            await update(ref(rtdb), indexUpdates);
        }
        
        // Remove from RTDB pendingUsers
        // RTDB triggers will automatically update admin cache
        const pendingUserRTDBRef = ref(rtdb, `pendingUsers/${encodedEmail}`);
        await remove(pendingUserRTDBRef);
        
        // Also remove from Firestore pendingUsers (for backward compatibility)
        try {
            const pendingUserRef = doc(db, 'pendingUsers', normalizedEmail);
            await deleteDoc(pendingUserRef);
        } catch (deleteError) {
            // Non-critical - user is migrated, pendingUsers entry can be cleaned up later
        }
        
        // Note: Admin cache and ranks are automatically updated by RTDB triggers
        // No need for manual cache updates - triggers handle it in real-time
    } catch (error) {
        throw error; // Re-throw to let caller handle it
    }
}

// Update user document with Firebase auth data on login
async function updateUserOnLogin(user) {
    try {
        // Update RTDB immediately (RTDB-first architecture)
        // Firestore backup is handled by hourlyFirestoreBackup Cloud Function
        
        // Always update RTDB immediately if user exists (for both regular and admin users)
        // RTDB triggers will automatically update admin cache in real-time
        if (user.displayName || user.photoURL) {
            try {
                const userRTDBRef = ref(rtdb, `users/${user.uid}`);
                const userRTDBSnap = await get(userRTDBRef);
                
                if (userRTDBSnap.exists()) {
                    const userRTDBData = userRTDBSnap.val();
                    const currentProfile = userRTDBData.profile || {};
                    
                    // Always update photoURL and displayName from Firebase Auth
                    // This ensures photos are available immediately
                    const profileUpdate = {
                        ...currentProfile,
                        // Override with auth data if available (always freshest)
                        photoURL: user.photoURL || currentProfile.photoURL || null,
                        displayName: user.displayName || currentProfile.displayName || null,
                    };
                    
                    await update(ref(rtdb, `users/${user.uid}`), {
                        profile: profileUpdate,
                        lastLoginAt: Date.now(),
                    });
                }
                // If user doesn't exist in RTDB, they're not a participant yet
                // Don't create them here - they need to be added as a participant first
            } catch (rtdbError) {
                // RTDB update failed, continue
            }
        }
    } catch (error) {
        if (error.code === 'permission-denied') {
            // Permission denied - might be admin user not in users collection
            // Still try to update RTDB if they exist there
            if (user.displayName || user.photoURL) {
                try {
                    const userRTDBRef = ref(rtdb, `users/${user.uid}`);
                    const userRTDBSnap = await get(userRTDBRef);
                    
                    if (userRTDBSnap.exists()) {
                        const userRTDBData = userRTDBSnap.val();
                        const currentProfile = userRTDBData.profile || {};
                        
                        const profileUpdate = {
                            ...currentProfile
                        };
        if (user.displayName) {
                            profileUpdate.displayName = user.displayName;
        }
        if (user.photoURL) {
                            profileUpdate.photoURL = user.photoURL;
                        }
                        
                        await update(ref(rtdb, `users/${user.uid}`), {
                            profile: profileUpdate
                        });
                    }
                } catch (rtdbError) {
                    // RTDB update also failed, continue
                }
            }
        }
    }
}

// Rank cache
let ranksCache = null;
let ranksCacheTime = 0;
const RANKS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const RANKS_DOC_PATH = 'appConfig/ranks';

// Helper: Get current batch ID (5-minute intervals)
// CRITICAL: Must match server-side calculation exactly (UTC timezone)
function getCurrentBatchId() {
    const now = new Date();
    // CRITICAL: Use UTC methods to match server-side calculation
    // This ensures batch IDs are consistent across all timezones
    const minutes = Math.floor(now.getUTCMinutes() / 5) * 5;
    const batchDate = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        now.getUTCHours(),
        minutes
    ));
    return batchDate.toISOString().slice(0, 16).replace('T', '-');
}

// Helper: Calculate rank from RTDB ranges
async function calculateRankFromRTDB(score) {
    try {
        const rangesRef = ref(rtdb, 'ranks/ranges');
        const rangesSnap = await get(rangesRef);
        
        if (rangesSnap.exists()) {
            const ranges = rangesSnap.val();
            if (score >= 200) return ranges['200+']?.rank || 'Super Star';
            if (score >= 51) return ranges['51-199']?.rank || 'Connector';
            return ranges['0-50']?.rank || 'Rookie';
        }
    } catch (error) {
        // Fallback to default calculation
    }
    
    // Fallback to default ranks
    return calculateRank(score);
}

// Helper: Update recent scans cache in RTDB
async function updateRecentScansCache(scannerUid, scannedUid, qrData) {
    try {        const recentRef = ref(rtdb, `scans/recent/${scannerUid}`);
        const scanTimestamp = Date.now();
        const scanKey = `${scanTimestamp}_${scannedUid}`; // Unique key for pagination
        
        // Use object structure instead of array for efficient querying
        await update(recentRef, {
            [scanKey]: {
                scannedUid: scannedUid,
                name: qrData.name || null,
                photo: qrData.photo || null,
                district: qrData.district || null,
                email: qrData.email || null,
                phone: qrData.phone || null,
                profession: qrData.profession || null,
                scannedAt: scanTimestamp
            }
        });        // Optional: Cleanup old entries (keep last 500)
        // This prevents unbounded growth
        const recentSnap = await get(recentRef);
        if (recentSnap.exists()) {
            const recent = recentSnap.val();
            // Handle both array (legacy) and object (new) formats
            let entries;
            if (Array.isArray(recent)) {
                // Legacy format - convert to object
                entries = recent.map((conn, idx) => [`${conn.scannedAt || Date.now()}_${conn.scannedUid}_${idx}`, conn]);
            } else {
                entries = Object.entries(recent);
            }
            
            if (entries.length > 500) {
                // Sort by timestamp, keep newest 500
                entries.sort((a, b) => (b[1].scannedAt || 0) - (a[1].scannedAt || 0));
                const toKeep = entries.slice(0, 500);
                const cleanup = {};
                toKeep.forEach(([key, value]) => {
                    cleanup[key] = value;
                });
                await set(recentRef, cleanup);
            }
        }
    } catch (error) {        // Error updating recent scans cache - non-critical, ignore
    }
}

// Calculate rank based on score (dynamic from Firestore)
async function calculateRank(score) {
    try {
        // Check cache
        const now = Date.now();
        if (ranksCache && (now - ranksCacheTime) < RANKS_CACHE_TTL) {
            return findRankForScore(score, ranksCache);
        }
        
        // Fetch ranks from Firestore (single document with array)
        const ranksDocRef = doc(db, RANKS_DOC_PATH);
        const ranksDocSnap = await getDoc(ranksDocRef);
        
        let ranks = [];
        if (ranksDocSnap.exists()) {
            ranks = ranksDocSnap.data().ranks || [];
        }
        
        if (ranks.length === 0) {
            // Fallback to default ranks if none configured
            return getDefaultRank(score);
        }
        
        // Sort by order
        ranks.sort((a, b) => a.order - b.order);
        
        // Update cache
        ranksCache = ranks;
        ranksCacheTime = now;
        
        return findRankForScore(score, ranks);
    } catch (error) {
        // Fallback to default ranks on error
        return getDefaultRank(score);
    }
}

// Find rank for score from ranks array
function findRankForScore(score, ranks) {
    for (const rank of ranks) {
        if (score >= rank.minScore) {
            // If maxScore is null, it's the highest rank
            if (rank.maxScore === null || rank.maxScore === undefined || score <= rank.maxScore) {
                return rank.rankName;
            }
        }
    }
    
    // If no rank found, return the highest rank or default
    if (ranks.length > 0) {
        return ranks[ranks.length - 1].rankName;
    }
    
    return getDefaultRank(score);
}

// Get rank details (minScore, maxScore) for a given rank name
function getRankDetails(rankName, ranks) {
    if (!ranks || ranks.length === 0) {
        // Fallback to default ranks
        if (rankName === 'Super Star') {
            return { minScore: 200, maxScore: null };
        } else if (rankName === 'Connector') {
            return { minScore: 51, maxScore: 199 };
        } else {
            return { minScore: 0, maxScore: 50 };
        }
    }
    
    const rank = ranks.find(r => r.rankName === rankName);
    if (rank) {
        return { minScore: rank.minScore || 0, maxScore: rank.maxScore };
    }
    
    // If rank not found, return default for Rookie
    return { minScore: 0, maxScore: 50 };
}

// Calculate progress percentage within current rank
async function calculateRankProgress(score, rankName) {
    // Get ranks from cache or use default
    let ranks = ranksCache;
    
    // If cache is empty or stale, try to fetch or use default ranks
    if (!ranks || ranks.length === 0) {
        try {
            // Try to fetch ranks from Firestore
            const ranksDocRef = doc(db, RANKS_DOC_PATH);
            const ranksDocSnap = await getDoc(ranksDocRef);
            
            if (ranksDocSnap.exists()) {
                ranks = ranksDocSnap.data().ranks || [];
                if (ranks.length > 0) {
                    ranks.sort((a, b) => a.order - b.order);
                    ranksCache = ranks;
                    ranksCacheTime = Date.now();
                }
            }
        } catch (error) {
            // If fetch fails, use default ranks
        }
        
        // If still empty, use default ranks
        if (!ranks || ranks.length === 0) {
            ranks = [
                { rankName: 'Rookie', minScore: 0, maxScore: 50 },
                { rankName: 'Connector', minScore: 51, maxScore: 199 },
                { rankName: 'Super Star', minScore: 200, maxScore: null }
            ];
        }
    }
    
    const rankDetails = getRankDetails(rankName, ranks);
    const minScore = rankDetails.minScore;
    const maxScore = rankDetails.maxScore;
    
    // If maxScore is null, it's the highest rank - show 100% if score >= minScore
    if (maxScore === null || maxScore === undefined) {
        return score >= minScore ? 100 : 0;
    }
    
    // Calculate progress within the rank range
    const range = maxScore - minScore;
    if (range <= 0) {
        return 100; // If min and max are the same, show 100%
    }
    
    const progress = ((score - minScore) / range) * 100;
    return Math.min(100, Math.max(0, progress));
}

// Default rank calculation (fallback)
function getDefaultRank(score) {
    if (score >= 200) {
        return 'Super Star';
    } else if (score >= 51) {
        return 'Connector';
    } else {
        return 'Rookie';
    }
}

// Cache TTL constants (in milliseconds)
const CACHE_TTL = {
    PROFILE: 5 * 60 * 1000,      // 5 minutes
    QR_CODE: 30 * 60 * 1000,     // 30 minutes (QR codes rarely change)
    LEADERBOARD: 2 * 60 * 1000,  // 2 minutes
    RECENT_CONNECTIONS: 3 * 60 * 1000, // 3 minutes
};

// Load user profile (RTDB-first with expanded caching)
async function loadUserProfile() {
    if (!currentUser) {
        console.error('loadUserProfile: No current user');
        return;
    }    // CRITICAL: Only switch to passport view if we're not on scanner view
    // This prevents switching away from scanner after a successful scan
    // If we're on scanner, just update UI elements without changing view
    const isOnScannerView = views.scanner && !views.scanner.classList.contains('hidden');
    const isOnPassportView = views.passport && !views.passport.classList.contains('hidden');
    
    if (!isOnScannerView && !isOnPassportView && views.passport && views.passport.classList.contains('hidden')) {
        // Only switch to passport if we're not on scanner and not already on passport
        showView('passport');
        // Wait a moment for DOM to update
        await new Promise(resolve => setTimeout(resolve, 50));
    } else if (isOnScannerView) {
        // We're on scanner view - don't switch, just ensure UI elements exist
    }
    
    try {
        // Try to get full profile from localStorage cache first
        let cachedProfile = null;
        let cachedQRCode = null;
        
        try {
            const cachedData = localStorage.getItem(`user_${currentUser.uid}_data`);
            const cachedQR = localStorage.getItem(`user_${currentUser.uid}_qr`);
            
            if (cachedData) {
                const parsed = JSON.parse(cachedData);
                // Check if cache is recent (less than 5 minutes old)
                if (parsed.timestamp && (Date.now() - parsed.timestamp) < CACHE_TTL.PROFILE) {
                    cachedProfile = parsed;
                }
            }
            
            if (cachedQR) {
                const parsed = JSON.parse(cachedQR);
                // Check if QR cache is recent (less than 30 minutes old)
                if (parsed.timestamp && (Date.now() - parsed.timestamp) < CACHE_TTL.QR_CODE) {
                    cachedQRCode = parsed.qrCodeBase64;
                }
            }
        } catch (localError) {
            // localStorage might be disabled, continue to RTDB
        }
        
        // If we have cached profile data, use it for immediate UI update
        if (cachedProfile) {
            document.getElementById('user-name').textContent = cachedProfile.fullName || cachedProfile.displayName || 'User';
            document.getElementById('user-email').textContent = cachedProfile.district ? `RI District ${cachedProfile.district}` : 'N/A';
            document.getElementById('user-score').textContent = cachedProfile.score || 0;
            document.getElementById('user-rank').textContent = cachedProfile.rank || 'Rookie';
            
            // Set avatar from cache
            if (cachedProfile.photoURL) {
                const avatarImg = document.getElementById('user-avatar');
                const qrAvatarOverlay = document.getElementById('qr-avatar-overlay');
                if (avatarImg) {
                    avatarImg.src = cachedProfile.photoURL;
                    avatarImg.style.display = 'block';
                }
                if (qrAvatarOverlay) {
                    qrAvatarOverlay.src = cachedProfile.photoURL;
                    qrAvatarOverlay.style.display = 'block';
                }
            }
            
            // Display cached QR code if available
            if (cachedQRCode) {
                displayQRCodeFromDatabase(cachedQRCode);
            }
        }
        
        // Validate session before loading profile (fixes zombie token)
        await validateLocalSession();        // Get user data from RTDB (primary source) - always fetch for freshness
        const userRef = ref(rtdb, `users/${currentUser.uid}`);
        const userSnap = await get(userRef);        if (exists) {            const userData = userSnap.val();
            
            // Always use RTDB data as source of truth (RTDB is always fresh)
            // RTDB is the authoritative source - only use cache if RTDB data is completely missing
            // Ensure score is always a number
            const rtdbScore = (userData.score !== null && userData.score !== undefined) 
                ? Number(userData.score) 
                : null;
            const finalScore = rtdbScore !== null ? rtdbScore : (cachedProfile?.score ?? 0);
            const finalRank = userData.rank || cachedProfile?.rank || await calculateRankFromRTDB(finalScore);
            
            // Update localStorage cache with full profile (instant, no network cost)
            try {
                const profile = userData.profile || {};
                const photoURL = profile.photoURL || userData.photoURL || (currentUser && currentUser.photoURL) || null;
                
                localStorage.setItem(`user_${currentUser.uid}_data`, JSON.stringify({
                    score: finalScore,
                    rank: finalRank,
                    fullName: profile.fullName || userData.fullName,
                    displayName: profile.displayName || userData.displayName,
                    district: profile.district || userData.district,
                    photoURL: photoURL,
                    timestamp: Date.now()
                }));
            } catch (localError) {
                // localStorage might be disabled, ignore
            }
            
            // Update UI
            const profile = userData.profile || {};
            // Get photoURL - read-only (no syncing)
            // RTDB triggers handle photoURL syncing from Firebase Auth
            // Fallback to currentUser.photoURL for display only (doesn't update RTDB)
            let photoURL = profile.photoURL || userData.photoURL || 
                          (currentUser && currentUser.photoURL) || null;
            
            const userName = profile.fullName || profile.displayName || userData.fullName || userData.displayName || 'User';
            const userEmail = (profile.district || userData.district) ? `RI District ${profile.district || userData.district}` : 'N/A';            // CRITICAL: Only switch to passport view if we're not on scanner view
            // This prevents switching away from scanner after a successful scan
            const isOnScannerView = views.scanner && !views.scanner.classList.contains('hidden');
            if (!isOnScannerView && views.passport && views.passport.classList.contains('hidden')) {                showView('passport');
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            
            const userNameEl = document.getElementById('user-name');
            const userEmailEl = document.getElementById('user-email');
            const userScoreEl = document.getElementById('user-score');
            const userRankEl = document.getElementById('user-rank');            if (!userNameEl || !userEmailEl || !userScoreEl || !userRankEl) {            }
            
            if (userNameEl) {
                userNameEl.textContent = userName;            } else {            }
            
            if (userEmailEl) {
                userEmailEl.textContent = userEmail;
            }
            
            if (userScoreEl) {
                userScoreEl.textContent = finalScore;
            }
            
            if (userRankEl) {
                userRankEl.textContent = finalRank;
            }
            
            // Set avatar
            const avatarImg = document.getElementById('user-avatar');
            const qrAvatarOverlay = document.getElementById('qr-avatar-overlay');
            
            if (photoURL) {
                if (avatarImg) {
                avatarImg.src = photoURL;
                avatarImg.style.display = 'block';
                avatarImg.onerror = function() {
                    avatarImg.style.display = 'none';
                };
                }
                if (qrAvatarOverlay) {
                    qrAvatarOverlay.src = photoURL;
                    qrAvatarOverlay.style.display = 'block';
                    qrAvatarOverlay.onerror = function() {
                        qrAvatarOverlay.style.display = 'none';
                    };
                }
            } else {
                if (avatarImg) {
                avatarImg.style.display = 'none';
                }
                if (qrAvatarOverlay) {
                    qrAvatarOverlay.style.display = 'none';
                }
            }
            
            // Display QR code - use cache if available, otherwise read from RTDB
            let qrCodeBase64 = cachedQRCode || userData.qrCodeBase64 || null;
            
            // If not in cache or RTDB, try Firestore as fallback
            if (!qrCodeBase64 && userData.qrToken) {
                try {
                    const userDocRef = doc(db, 'users', currentUser.uid);
                    const userDocSnap = await getDoc(userDocRef);
                    if (userDocSnap.exists()) {
                        const firestoreData = userDocSnap.data();
                        qrCodeBase64 = firestoreData.qrCodeBase64 || null;
                        
                        // If found in Firestore, update RTDB and cache for future use
                        if (qrCodeBase64) {
                            await update(ref(rtdb, `users/${currentUser.uid}`), {
                                qrCodeBase64: qrCodeBase64
                            });
                            // Cache QR code
                            try {
                                localStorage.setItem(`user_${currentUser.uid}_qr`, JSON.stringify({
                                    qrCodeBase64: qrCodeBase64,
                                    timestamp: Date.now()
                                }));
                            } catch (localError) {
                                // localStorage might be disabled, ignore
                            }
                        }
                    }
                } catch (error) {
                    // Firestore fallback failed, continue
                }
            }
            
            // Display QR code
            if (qrCodeBase64) {
                displayQRCodeFromDatabase(qrCodeBase64);
                // Cache QR code if not already cached
                if (!cachedQRCode) {
                    try {
                        localStorage.setItem(`user_${currentUser.uid}_qr`, JSON.stringify({
                            qrCodeBase64: qrCodeBase64,
                            timestamp: Date.now()
                        }));
                    } catch (localError) {
                        // localStorage might be disabled, ignore
                    }
                }
            } else if (userData.qrToken) {
                // Fallback: try to generate using the fallback function
                const canvas = document.getElementById('qr-code-canvas');
                if (canvas) {
                    generateQRCodeFallback(userData.qrToken, canvas);
                }
            }
            
            // Load recent connections (only if passport view is visible)
            const isPassportVisible = views.passport && !views.passport.classList.contains('hidden');
            if (isPassportVisible) {
            await loadRecentConnections();
            }
        } else {
            // CRITICAL FIX: User doesn't exist in RTDB - use cached data or defaults            // Still try to load recent connections if passport view is visible
            const isPassportVisible = views.passport && !views.passport.classList.contains('hidden');
            if (isPassportVisible) {
                await loadRecentConnections();
            }
            
            // Use cached profile if available, otherwise use defaults
            const userName = cachedProfile?.fullName || cachedProfile?.displayName || currentUser?.displayName || 'User';
            const userEmail = cachedProfile?.district ? `RI District ${cachedProfile.district}` : 'N/A';
            const finalScore = cachedProfile?.score ?? 0;
            const finalRank = cachedProfile?.rank || 'Rookie';            const userNameEl = document.getElementById('user-name');
            const userEmailEl = document.getElementById('user-email');
            const userScoreEl = document.getElementById('user-score');
            const userRankEl = document.getElementById('user-rank');
            
            if (userNameEl) {
                userNameEl.textContent = userName;            }
            
            if (userEmailEl) {
                userEmailEl.textContent = userEmail;            }
            
            if (userScoreEl) {
                userScoreEl.textContent = finalScore;            }
            
            if (userRankEl) {
                userRankEl.textContent = finalRank;            }
            
            // Set avatar from cache if available
            if (cachedProfile?.photoURL) {
                const avatarImg = document.getElementById('user-avatar');
                const qrAvatarOverlay = document.getElementById('qr-avatar-overlay');
                if (avatarImg) {
                    avatarImg.src = cachedProfile.photoURL;
                    avatarImg.style.display = 'block';
                }
                if (qrAvatarOverlay) {
                    qrAvatarOverlay.src = cachedProfile.photoURL;
                    qrAvatarOverlay.style.display = 'block';
                }
            }
            
            // Display cached QR code if available
            if (cachedQRCode) {
                displayQRCodeFromDatabase(cachedQRCode);
            }
        }
    } catch (error) {
        console.error('loadUserProfile ERROR:', error);        // Update UI to show error instead of "Loading..."
        const userNameEl = document.getElementById('user-name');
        if (userNameEl) {
            userNameEl.textContent = 'Error loading profile';
        }
        
        // Only show alert for critical errors, not for non-critical operations
        if (error.code === 'permission-denied') {
            console.error('Permission denied loading profile');
            // Don't show alert - profile might still load from cache or other sources
        }
    }
}

// Display QR Code from Database (Base64)
function displayQRCodeFromDatabase(qrCodeBase64) {
    const canvas = document.getElementById('qr-code-canvas');
    if (!canvas) {
        return;
    }
    
    if (qrCodeBase64) {
        // If we have base64, display it directly
        const img = new Image();
        img.onload = function() {
            canvas.width = 192;
            canvas.height = 192;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, 192, 192);
        };
        img.onerror = async function() {
            // Fallback: try to generate from qrToken if available
            const userData = currentUser ? await getCurrentUserData() : null;
            if (userData && userData.qrToken) {
                generateQRCodeFallback(userData.qrToken, canvas);
            }
        };
        img.src = qrCodeBase64;
    } else {
        // Fallback: generate QR code if base64 is not available
        getCurrentUserData().then(userData => {
            if (userData && userData.qrToken) {
                generateQRCodeFallback(userData.qrToken, canvas);
            } else {
            }
        }).catch(() => {
            // QR code fallback failed, continue without it
        });
    }
}

// Helper to get current user data (RTDB-first)
async function getCurrentUserData() {
    if (!currentUser) return null;
    try {
        const userRef = ref(rtdb, `users/${currentUser.uid}`);
        const userSnap = await get(userRef);
        return userSnap.exists() ? userSnap.val() : null;
    } catch (error) {
        return null;
    }
}

// Fallback QR code generation (if base64 is missing)
function generateQRCodeFallback(qrToken, canvas) {
    canvas.width = 192;
    canvas.height = 192;
    
    const tryGenerate = (attempts = 0) => {
        const QRCodeLib = window.QRCode || (typeof QRCode !== 'undefined' ? QRCode : null);
        
        if (QRCodeLib && typeof QRCodeLib.toCanvas === 'function') {
            try {
                QRCodeLib.toCanvas(canvas, qrToken, {
                    width: 192,
                    margin: 2,
                    color: {
                        dark: '#000000',
                        light: '#FFFFFF'
                    }
                }, (error) => {
                    if (error) {
                        tryAlternativeQRGeneration(qrToken, canvas);
                    }
                });
            } catch (err) {
                tryAlternativeQRGeneration(qrToken, canvas);
            }
        } else if (attempts < 25) {
            setTimeout(() => tryGenerate(attempts + 1), 200);
        } else {
            tryAlternativeQRGeneration(qrToken, canvas);
        }
    };
    
    setTimeout(() => tryGenerate(0), 100);
}

// Alternative QR code generation using a different method
function tryAlternativeQRGeneration(qrToken, canvas) {
    // Try using qrcode-generator library (lowercase)
    if (typeof qrcode !== 'undefined' && typeof qrcode === 'function') {
        try {
            const typeNumber = 0;
            const errorCorrectionLevel = 'L';
            const qr = qrcode(typeNumber, errorCorrectionLevel);
            qr.addData(qrToken);
            qr.make();
            
            const ctx = canvas.getContext('2d');
            const cellSize = 4;
            const margin = 2;
            const moduleCount = qr.getModuleCount();
            const size = moduleCount * cellSize + margin * 2;
            
            canvas.width = size;
            canvas.height = size;
            
            // White background
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, size, size);
            
            // Black modules
            ctx.fillStyle = '#000000';
            for (let row = 0; row < moduleCount; row++) {
                for (let col = 0; col < moduleCount; col++) {
                    if (qr.isDark(row, col)) {
                        ctx.fillRect(
                            col * cellSize + margin,
                            row * cellSize + margin,
                            cellSize,
                            cellSize
                        );
                    }
                }
            }
            return;
        } catch (err) {
        }
    }
    
    // Last resort: Show text
    const ctx = canvas.getContext('2d');
    canvas.width = 192;
    canvas.height = 192;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 16px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('QR Code', canvas.width / 2, canvas.height / 2 - 10);
    ctx.font = '12px Arial';
    ctx.fillText('Loading...', canvas.width / 2, canvas.height / 2 + 10);
}

// Load recent connections (RTDB-first)
async function loadRecentConnections() {
    if (!currentUser) {        return;
    }
    
    const container = document.getElementById('recent-connections');
    if (!container) {        return;
    }    container.innerHTML = '';
    
    try {
        // Try localStorage cache first (instant, no network)
        let connections = [];
        
        try {
            const cachedConnections = localStorage.getItem(`user_${currentUser.uid}_recentConnections`);
            if (cachedConnections) {
                const parsed = JSON.parse(cachedConnections);
                // Check if cache is recent (less than 5 minutes old)
                if (parsed.timestamp && (Date.now() - parsed.timestamp) < 5 * 60 * 1000) {
                    connections = parsed.connections || [];
                }
            }
        } catch (localError) {
            // localStorage might be disabled or invalid, continue to RTDB
        }
        
        // If no cache, get from RTDB scans/recent
        if (connections.length === 0) {
            const recentRef = ref(rtdb, `scans/recent/${currentUser.uid}`);
            const recentSnap = await get(recentRef);
            
            if (recentSnap.exists()) {
                const recent = recentSnap.val();
                let entries = [];
                
                // Handle both array (legacy) and object (new) formats
                if (Array.isArray(recent)) {
                    // Legacy array format
                    entries = recent.map(conn => ({
                        uid: conn.scannedUid,
                        name: conn.name,
                        photo: conn.photo || null,
                        scannedAt: conn.scannedAt || 0
                    }));
                } else {
                    // New object format - convert to array
                    entries = Object.values(recent).map(conn => ({
                        uid: conn.scannedUid,
                        name: conn.name,
                        photo: conn.photo || null,
                        scannedAt: conn.scannedAt || 0
                    }));
                }
                
                // Sort by scannedAt (most recent first) and take first 3
                connections = entries
                    .sort((a, b) => (b.scannedAt || 0) - (a.scannedAt || 0))
                    .slice(0, 3);
                
                // Update localStorage cache
                try {
                    localStorage.setItem(`user_${currentUser.uid}_recentConnections`, JSON.stringify({
                        connections: connections,
                        timestamp: Date.now()
                    }));
                } catch (localError) {
                    // localStorage might be disabled, ignore
                }
            }
        }
        
        // Display connections        if (connections.length === 0) {        }
        
        connections.forEach((conn, index) => {            const initials = (conn.name || 'U').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
            const avatar = document.createElement('div');
            avatar.className = 'inline-block h-12 w-12 rounded-full ring-4 ring-background-dark shrink-0';
            
            if (conn.photo) {
                // Try to show photo, fallback to initials on error
            const img = document.createElement('img');
                img.src = conn.photo;
            img.alt = conn.name || 'User';
                img.className = 'w-full h-full rounded-full object-cover';
            img.onerror = function() {                    // Fallback to initials if image fails to load
                this.style.display = 'none';
                const fallback = document.createElement('div');
                    fallback.className = 'w-full h-full rounded-full bg-gradient-to-br from-primary to-blue-600 flex items-center justify-center text-white text-xs font-bold';
                    fallback.textContent = initials;
                    avatar.appendChild(fallback);
                };
                avatar.appendChild(img);
            } else {
                // No photo - show initials
                avatar.className += ' bg-gradient-to-br from-primary to-blue-600 flex items-center justify-center text-white text-xs font-bold';
                avatar.textContent = initials;
            }
            
            container.appendChild(avatar);        });
        
        // Show "+X more" if there are more connections
        if (connections.length === 3) {
            try {
                const recentRef = ref(rtdb, `scans/recent/${currentUser.uid}`);
                const recentSnap = await get(recentRef);
                if (recentSnap.exists()) {
                    const recent = recentSnap.val();
                    let totalConnections = 0;
                    
                    // Handle both array and object formats
                    if (Array.isArray(recent)) {
                        totalConnections = recent.length;
                    } else {
                        totalConnections = Object.keys(recent).length;
                    }
                    
                    if (totalConnections > 3) {
            const more = document.createElement('div');
                        more.className = 'h-12 w-12 rounded-full ring-4 ring-background-dark bg-gradient-to-br from-slate-700 to-slate-900 flex items-center justify-center border border-white/10 text-xs font-bold text-slate-400';
                        more.textContent = `+${totalConnections - 3}`;
            container.appendChild(more);
                    }
                }
            } catch (err) {
                // Ignore error, just don't show "+X more"
            }
        }
    } catch (error) {
        console.error('loadRecentConnections: Error loading connections:', error);
        // Don't show alert - this is a non-critical feature
    }
}

// Note: Removed RTDB cache functions for current user's data
// Using localStorage instead since we already read the full user document from Firestore

// Get user's leaderboard rank (RTDB-only)
async function getUserLeaderboardRank(uid) {
    try {
        // Try localStorage first (instant, no network)
        const cached = localStorage.getItem(`leaderboardRank_${uid}`);
        if (cached) {
            const parsed = JSON.parse(cached);
            // Cache valid for 5 minutes
            if (parsed.timestamp && (Date.now() - parsed.timestamp) < 5 * 60 * 1000) {
                return parsed.rank;
            }
        }

        // Read from RTDB (pre-computed)
        const rankRef = ref(rtdb, `ranks/${uid}`);
        let rankSnap;
        let retryCount = 0;
        const maxRetries = 3;
        
        // Retry logic: attempt up to 3 times with exponential backoff
        while (retryCount < maxRetries) {
            try {
                rankSnap = await get(rankRef);
                if (rankSnap.exists()) {
                    break; // Success, exit retry loop
                }
                
                // If cache is empty, wait and retry (might be updating)
                if (retryCount < maxRetries - 1) {
                    await new Promise(resolve => setTimeout(resolve, 100 * (retryCount + 1)));
                }
                retryCount++;
            } catch (error) {
                if (retryCount === maxRetries - 1) {
                    throw error; // Last attempt failed, throw error
                }
                await new Promise(resolve => setTimeout(resolve, 100 * (retryCount + 1)));
                retryCount++;
            }
        }
        
        if (rankSnap && rankSnap.exists()) {
            const rankData = rankSnap.val();
            const rank = rankData.leaderboardRank;
            
            // Cache in localStorage
            try {
                localStorage.setItem(`leaderboardRank_${uid}`, JSON.stringify({
                    rank: rank,
                    timestamp: Date.now()
                }));
            } catch (localError) {
                // localStorage might be disabled, ignore
            }
            
            return rank;
        }
        
        // If RTDB cache doesn't exist, return null
        // Cloud Functions should have pre-computed it during migration
        return null;
    } catch (error) {
        return null;
    }
}

// Google Sign-In
document.getElementById('google-signin-btn').addEventListener('click', async () => {
    try {
        await signInWithPopup(auth, googleProvider);
    } catch (error) {
        alert('Failed to sign in. Please try again.');
    }
});

// Show logout confirmation modal
function showLogoutModal() {
    const modal = document.getElementById('logout-modal');
    const modalContent = document.getElementById('logout-modal-content');
    if (!modal || !modalContent) return;
    
    modal.classList.remove('hidden');
    // Reset classes
    modalContent.classList.remove('scale-100', 'opacity-100', 'scale-95', 'opacity-0');
    // Trigger animation
    setTimeout(() => {
        modalContent.classList.add('scale-100', 'opacity-100');
    }, 10);
}

// Hide logout confirmation modal
function hideLogoutModal() {
    const modal = document.getElementById('logout-modal');
    const modalContent = document.getElementById('logout-modal-content');
    if (!modal) return;
    
    if (modalContent) {
        modalContent.classList.add('scale-95', 'opacity-0');
        modalContent.classList.remove('scale-100', 'opacity-100');
    }
    
    setTimeout(() => {
        modal.classList.add('hidden');
    }, 200);
}

// Show access denied modal
function showAccessDeniedModal() {
    const modal = document.getElementById('access-denied-modal');
    const modalContent = document.getElementById('access-denied-modal-content');
    if (!modal || !modalContent) return;
    
    modal.classList.remove('hidden');
    // Reset classes
    modalContent.classList.remove('scale-100', 'opacity-100', 'scale-95', 'opacity-0');
    // Trigger animation
    setTimeout(() => {
        modalContent.classList.add('scale-100', 'opacity-100');
    }, 10);
}

// Hide access denied modal
function hideAccessDeniedModal() {
    const modal = document.getElementById('access-denied-modal');
    const modalContent = document.getElementById('access-denied-modal-content');
    if (!modal) return;
    
    if (modalContent) {
        modalContent.classList.add('scale-95', 'opacity-0');
        modalContent.classList.remove('scale-100', 'opacity-100');
    }
    
    setTimeout(() => {
        modal.classList.add('hidden');
    }, 200);
}

// Logout function
async function handleLogout() {
    showLogoutModal();
}

// Perform actual logout
async function performLogout() {
    hideLogoutModal();
    
    try {
        // Stop scanner if active
        if (html5QrCode && scannerActive) {
            await stopScanner();
        }
        await signOut(auth);
        // Auth state change will handle redirect to login
    } catch (error) {
        showToast('error', 'Failed to logout. Please try again.', 'error');
    }
}

// Logout buttons
const logoutBtn = document.getElementById('logout-btn');
if (logoutBtn) {
    logoutBtn.addEventListener('click', handleLogout);
}

const logoutBtnLeaderboard = document.getElementById('logout-btn-leaderboard');
if (logoutBtnLeaderboard) {
    logoutBtnLeaderboard.addEventListener('click', handleLogout);
}

const logoutBtnHistory = document.getElementById('logout-btn-history');
if (logoutBtnHistory) {
    logoutBtnHistory.addEventListener('click', handleLogout);
}

// Logout modal buttons
const logoutConfirmBtn = document.getElementById('logout-confirm-btn');
if (logoutConfirmBtn) {
    logoutConfirmBtn.addEventListener('click', performLogout);
}

const logoutCancelBtn = document.getElementById('logout-cancel-btn');
if (logoutCancelBtn) {
    logoutCancelBtn.addEventListener('click', hideLogoutModal);
}

// Close logout modal when clicking outside or pressing ESC
const logoutModal = document.getElementById('logout-modal');
if (logoutModal) {
    logoutModal.addEventListener('click', (e) => {
        if (e.target === logoutModal) {
            hideLogoutModal();
        }
    });
    
    // Close on ESC key (for logout modal)
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !logoutModal.classList.contains('hidden')) {
            hideLogoutModal();
        }
    });
}

// Access denied modal button
const accessDeniedOkBtn = document.getElementById('access-denied-ok-btn');
if (accessDeniedOkBtn) {
    accessDeniedOkBtn.addEventListener('click', () => {
        hideAccessDeniedModal();
    });
}

// Close access denied modal when clicking outside or pressing ESC
const accessDeniedModal = document.getElementById('access-denied-modal');
if (accessDeniedModal) {
    accessDeniedModal.addEventListener('click', (e) => {
        if (e.target === accessDeniedModal) {
            hideAccessDeniedModal();
        }
    });
    
    // Close on ESC key (for access denied modal)
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !accessDeniedModal.classList.contains('hidden')) {
            hideAccessDeniedModal();
        }
    });
}

// Scanner functionality
let scannerActive = false;
let isProcessingScan = false; // Flag to prevent multiple simultaneous scans
let lastScannedToken = null; // Track last scanned token to prevent duplicate scans
let lastScanTime = 0; // Track last scan time for debouncing

// Legacy scanner button (keep for backward compatibility)
const scannerBtn = document.getElementById('scanner-btn');
if (scannerBtn) {
    scannerBtn.addEventListener('click', () => {
        showView('scanner');
        startScanner();
    });
}

document.getElementById('close-scanner-btn').addEventListener('click', async () => {
    await stopScanner();
    await showView('passport');
});

document.getElementById('show-my-qr-btn').addEventListener('click', async () => {
    await stopScanner();
    await showView('passport');
});

async function startScanner() {
    if (scannerActive) return;
    if (isProcessingScan) return; // Don't start if a scan is being processed
    
    const qrReader = document.getElementById('qr-reader');
    if (!qrReader) return;
    
    // Clear any existing scanner instance
    if (html5QrCode) {
        try {
            await html5QrCode.stop();
            html5QrCode.clear();
        } catch (e) {
            // Ignore errors when clearing
        }
        html5QrCode = null;
    }
    
    html5QrCode = new Html5Qrcode(qrReader.id);
    
    try {
        await html5QrCode.start(
            { facingMode: "environment" },
            {
                fps: 10,
                qrbox: { width: 250, height: 250 },
                aspectRatio: 1.0,
                disableFlip: true // Prevent mirroring
            },
            onScanSuccess,
            onScanError
        );
        
        // Fix any duplicate video elements after scanner starts
        setTimeout(() => {
            const videos = qrReader.querySelectorAll('video');
            if (videos.length > 1) {
                // Keep only the first video, hide others
                for (let i = 1; i < videos.length; i++) {
                    videos[i].style.display = 'none';
                }
            }
        }, 500);
        scannerActive = true;
    } catch (err) {
        scannerActive = false;
        html5QrCode = null;
        alert('Failed to start camera. Please check permissions.');
    }
}

async function stopScanner() {
    if (html5QrCode && scannerActive) {
        try {
            await html5QrCode.stop();
            html5QrCode.clear();
        } catch (err) {
        }
        scannerActive = false;
        html5QrCode = null; // Clear the reference
    }
}

// Ensure scanner is active when on scanner view
async function ensureScannerActive() {
    // CRITICAL: Double-check scanner view is still visible before starting
    if (!views.scanner || views.scanner.classList.contains('hidden')) {
        // View was switched away, stop scanner if it's running
        if (scannerActive) {
            await stopScanner();
        }
        return; // Not on scanner view, don't start
    }
    
    // Check if already active
    if (scannerActive) {
        return; // Already running
    }
    
    // Check if processing (wait a bit if so)
    if (isProcessingScan) {
        // Re-check view visibility after delay
        setTimeout(() => {
            if (views.scanner && !views.scanner.classList.contains('hidden')) {
                ensureScannerActive();
            } else if (scannerActive) {
                // View was switched away, stop scanner
                stopScanner();
            }
        }, 500);
        return;
    }
    
    // Final check before starting
    if (!views.scanner || views.scanner.classList.contains('hidden')) {
        return;
    }
    
    // Start scanner
    await startScanner();
}

/**
 * Process a QR code scan using RTDB-first architecture
 * @param {string} qrToken - The 32-character hex token from the scanned QR code
 */
async function processScan(qrToken) {    if (!currentUser) {
        throw new Error('User not authenticated');
    }
    
    const scannerUid = currentUser.uid;    try {        // Step 1: Lookup target user from RTDB
        const qrTokenRef = ref(rtdb, `qrcodes/${qrToken}`);
        const qrTokenSnap = await get(qrTokenRef);        if (!qrTokenSnap.exists()) {
            throw new Error('Invalid QR code');
        }
        
        const targetData = qrTokenSnap.val();        // Validate targetData has required fields
        if (!targetData || !targetData.uid) {
            throw new Error('Invalid QR code data');
        }
        
        let targetUid = targetData.uid;
        
        // Step 2: Check if scanning self (before resolving encoded email)
        // If targetUid is an encoded email, we'll resolve it first, then check self-scan
        let isEncodedEmail = targetUid.includes('_') && targetUid.length > 20;
        
        // Step 3: Verify target user exists in users collection
        // This handles race conditions where QR code is updated but user migration isn't complete
        let targetUserRef = ref(rtdb, `users/${targetUid}`);
        let targetUserSnap = await get(targetUserRef);
        
        if (!targetUserSnap.exists()) {
            // Check if uid is actually an encoded email (user hasn't migrated yet)
            if (isEncodedEmail) {
                const encodedEmail = targetUid;
                const pendingUserRef = ref(rtdb, `pendingUsers/${encodedEmail}`);
                const pendingUserSnap = await get(pendingUserRef);
                
                if (pendingUserSnap.exists()) {
                    throw new Error('User has not completed registration yet');
                }
            }
            
            // If QR code has encoded email but user has migrated, try to find user by email
            // This handles race condition where QR code wasn't updated yet after migration
            if (isEncodedEmail && targetData.email) {
                // Try to find user by email using the email index
                const emailIndexRef = ref(rtdb, `indexes/emails/${encodeEmailForPath(targetData.email)}`);
                const emailIndexSnap = await get(emailIndexRef);
                
                if (emailIndexSnap.exists()) {
                    const indexData = emailIndexSnap.val();
                    const actualUid = indexData.uid;
                    
                    // If index points to a UID (not encoded email), user has migrated
                    if (actualUid && !actualUid.includes('_')) {
                        // User exists in users collection with this UID
                        targetUserRef = ref(rtdb, `users/${actualUid}`);
                        targetUserSnap = await get(targetUserRef);
                        
                        if (targetUserSnap.exists()) {
                            // Update QR code with correct UID to fix it for future scans
                            try {
                                await update(ref(rtdb, `qrcodes/${qrToken}`), {
                                    uid: actualUid
                                });
                            } catch (updateError) {
                                // Non-critical - continue with scan
                            }
                            
                            // Use the actual UID for the rest of the scan
                            targetUid = actualUid;
                        }
                    }
                }
            }
            
            // If still not found, throw error
            if (!targetUserSnap.exists()) {
                throw new Error('Target user not found');
            }
        }
        
        // Step 4: Check if scanning self (after resolving encoded email to actual UID)
        if (targetUid === scannerUid) {
            throw new Error("You can't scan your own QR code!");
        }
        
        // Step 5: Check duplicate scan (handle both UID formats for migration)
        const scanCheckRef = ref(rtdb, `scans/byScanner/${scannerUid}/${targetUid}`);
        const scanCheck = await get(scanCheckRef);
        
        if (scanCheck.exists()) {
            throw new Error('ALREADY_SCANNED');
        }
        
        // Also check encoded email if we resolved UID (migration edge case)
        // This handles scans made when user was in pending state
        if (isEncodedEmail && targetData.email) {
            const originalEncodedEmail = targetData.uid; // Original encoded email from QR code
            // Only check if we actually resolved to a different UID
            if (originalEncodedEmail !== targetUid && originalEncodedEmail.includes('_')) {
                const oldScanCheckRef = ref(rtdb, `scans/byScanner/${scannerUid}/${originalEncodedEmail}`);
                const oldScanCheck = await get(oldScanCheckRef);
                
                if (oldScanCheck.exists()) {
                    // User was already scanned when in pending state
                    // Migrate the old scan record to new UID format
                    try {
                        const oldScanData = oldScanCheck.val();
                        
                        // Copy scan to new UID location
                        await set(scanCheckRef, oldScanData);
                        
                        // Remove old scan record
                        await remove(oldScanCheckRef);
                        
                        // Also update recent scans cache
                        const recentScanRef = ref(rtdb, `scans/recent/${scannerUid}/${originalEncodedEmail}`);
                        const recentScanSnap = await get(recentScanRef);
                        
                        if (recentScanSnap.exists()) {
                            const recentScanData = recentScanSnap.val();
                            await set(ref(rtdb, `scans/recent/${scannerUid}/${targetUid}`), recentScanData);
                            await remove(recentScanRef);
                        }
                    } catch (migrateError) {
                        // Error migrating scan record - continue with scan, migration is non-critical
                    }
                    
                throw new Error('ALREADY_SCANNED');
                }
            }
        }
        
        // Step 6: Get scanner user data (for validation only)
        // Step 6: Get scanner user data (for validation only)
        const scannerUserRef = ref(rtdb, `users/${scannerUid}`);
        const scannerUserSnap = await get(scannerUserRef);
        
        if (!scannerUserSnap.exists()) {
            throw new Error('User not found');
        }
        
        const scanTimestamp = Date.now();
        const batchId = getCurrentBatchId();        // Step 6: Record scan in RTDB (atomic batch update)
        // NOTE: Score/rank updates are handled by batch processor only (prevents race conditions)
        // Ensure all metadata fields are null (not undefined) - RTDB doesn't allow undefined
        
        // CRITICAL FIX: Read current pending score and accumulate delta to handle multiple scans in same batch
        const pendingScoreRef = ref(rtdb, `pendingScores/${batchId}/${scannerUid}`);
        const pendingScoreSnap = await get(pendingScoreRef);
        const currentDelta = pendingScoreSnap.exists() ? (pendingScoreSnap.val().delta || 0) : 0;
        const newDelta = currentDelta + 10; // Accumulate instead of overwrite
        
        const updates = {
            [`scans/byScanner/${scannerUid}/${targetUid}`]: {
                scannedAt: scanTimestamp,
                points: 10,
                metadata: {
                    name: targetData.name || null,
                    photo: targetData.photo !== undefined ? targetData.photo : null,
                    district: targetData.district || null
                }
            },
            // Add to pending scores for batch processing (accumulate delta for multiple scans)
            [`pendingScores/${batchId}/${scannerUid}`]: {
                delta: newDelta,
                timestamp: scanTimestamp
            }
            // REMOVED: Immediate score/rank update (handled by batch processor only)
        };
        
        // CRITICAL FIX: Write paths separately to identify which one fails
        // This helps debug permission issues
        try {
            // Verify auth state before writing
            const authUser = auth.currentUser;            if (!authUser || authUser.uid !== scannerUid) {
                throw new Error('Authentication mismatch: auth.uid=' + (authUser?.uid || 'null') + ', scannerUid=' + scannerUid);
            }
            
            // Write scan record first
            const scanPath = `scans/byScanner/${scannerUid}/${targetUid}`;            await set(ref(rtdb, scanPath), {
                scannedAt: scanTimestamp,
                points: 10,
                metadata: {
                    name: targetData.name || null,
                    photo: targetData.photo !== undefined ? targetData.photo : null,
                    district: targetData.district || null
                }
            });            // REAL-TIME: Immediately update user score and rank in RTDB
            // This provides instant feedback to users (RTDB-first approach)
            // Batch processor will still run for idempotency and index updates
            const userRef = ref(rtdb, `users/${scannerUid}`);
            const userSnap = await get(userRef);
            
            if (userSnap.exists()) {
                const userData = userSnap.val();
                const currentScore = userData.score || 0;
                const newScore = currentScore + 10; // Add 10 points immediately
                
                // Calculate new rank (match server-side logic)
                let newRank = 'Rookie';
                if (newScore >= 200) {
                    newRank = 'Super Star';
                } else if (newScore >= 51) {
                    newRank = 'Connector';
                }
                
                // Update score and rank immediately
                // Also mark this batch as processed to prevent double-counting
                const lastProcessedBatch = userData._lastProcessedBatch || {};
                const updatedLastProcessed = {
                    ...lastProcessedBatch,
                    [batchId]: true
                };
                
                await update(userRef, {
                    score: newScore,
                    rank: newRank,
                    _lastProcessedBatch: updatedLastProcessed
                });                // Update UI immediately
                updateLocalStorageAfterScan(scannerUid, newScore, newRank, {
                    uid: targetUid,
                    name: targetData.name || null,
                    photo: targetData.photo !== undefined ? targetData.photo : null
                });
            }
            
            // Write pending score for batch processor (idempotency check)
            // Batch processor will skip if score already updated (via _lastProcessedBatch)
            const pendingScorePath = `pendingScores/${batchId}/${scannerUid}`;            await set(ref(rtdb, pendingScorePath), {
                delta: newDelta,
                timestamp: scanTimestamp
            });            // Note: Score is already updated in real-time above
            // Batch processor will run every 5 minutes to:
            // 1. Update indexes (sortedScores, leaderboard)
            // 2. Update ranks for all users
            // 3. Ensure idempotency (skip if already processed)
        } catch (updateError) {            throw updateError;
        }
        
        // Step 7: Update recent scans cache (optimistic)
        // Ensure targetData has all required fields with null fallbacks
        // If photo is missing from QR code, try to get it from user profile
        let photoURL = targetData.photo !== undefined ? targetData.photo : null;
        
        // If photo is missing, try to fetch from user profile in RTDB
        // Re-read targetUserSnap to ensure we have the latest data (might have been updated during migration)
        if (!photoURL) {
            const latestTargetUserRef = ref(rtdb, `users/${targetUid}`);
            const latestTargetUserSnap = await get(latestTargetUserRef);
            if (latestTargetUserSnap.exists()) {
                const targetUserData = latestTargetUserSnap.val();
                const targetProfile = targetUserData.profile || {};
                photoURL = targetProfile.photoURL || targetUserData.photoURL || null;
            }
        }
        
        const safeTargetData = {
            name: targetData.name || null,
            photo: photoURL,
            district: targetData.district || null,
            email: targetData.email || null,
            phone: targetData.phone || null,
            profession: targetData.profession || null
        };        await updateRecentScansCache(scannerUid, targetUid, safeTargetData);        // Note: Score and localStorage already updated above in real-time
        
        // Show subtle success notification
        showToast('check_circle', 'You earned 10 points!', 'success');
        
        // Don't call loadUserProfile() here - it would switch to passport view
        // The score is already updated in RTDB and UI elements are updated via updateLocalStorageAfterScan()
        // User stays on scanner view to continue scanning
        
        // Clear the last scanned token after a delay to allow re-scanning different codes
        setTimeout(() => {
            lastScannedToken = null;
        }, 3000);
        
        // Reset processing flag immediately so scanner can continue scanning
        isProcessingScan = false;
        
        // Ensure scanner stays active ONLY if still on scanner view
        setTimeout(() => {
            if (views.scanner && !views.scanner.classList.contains('hidden')) {
                ensureScannerActive();
            }
        }, 500);
        
    } catch (error) {
        // Error handling below
        // Don't stop scanner - keep it running for better UX
        // The processing flag and debouncing will prevent duplicate scans
        
        if (error.message === 'ALREADY_SCANNED') {
            showToast('error', 'Already connected with this person', 'error');
        } else if (error.code === 'permission-denied') {
            showToast('error', 'Permission denied: ' + (error.message || 'Check RTDB rules'), 'error');
        } else if (error.message.includes("can't scan your own")) {
            showToast('error', "Can't scan your own QR code", 'error');
        } else if (error.message === 'Invalid QR code' || error.message === 'Invalid QR code data') {
            showToast('error', 'Invalid QR code', 'error');
        } else if (error.message === 'User not found' || error.message === 'Target user not found') {
            showToast('error', 'User not found', 'error');
        } else if (error.message.includes('not completed registration')) {
            showToast('error', 'User has not completed registration yet', 'error');
        } else {
            showToast('error', 'Scan failed: ' + (error.message || error.code || 'Unknown error'), 'error');
        }
        
        // Clear the last scanned token after error
        setTimeout(() => {
            lastScannedToken = null;
        }, 2000);
        
        // Reset processing flag immediately so scanner can continue
        isProcessingScan = false;
        
        // Ensure scanner stays active ONLY if still on scanner view
        setTimeout(() => {
            if (views.scanner && !views.scanner.classList.contains('hidden')) {
                ensureScannerActive();
            }
        }, 500);
    }
}

// Update localStorage cache after a successful scan (instant, no network)
// Also updates UI immediately if score/rank provided (real-time feedback)
function updateLocalStorageAfterScan(uid, newScore, newRank, scanEntry) {
    try {
        // Update score/rank cache and UI immediately if provided
        if (newScore !== null && newRank !== null) {
            localStorage.setItem(`user_${uid}_data`, JSON.stringify({
                score: newScore,
                rank: newRank,
                timestamp: Date.now()
            }));
            
            // Update UI immediately for real-time feedback
            const scoreEl = document.getElementById('user-score');
            const rankEl = document.getElementById('user-rank');
            
            if (scoreEl) {
                scoreEl.textContent = newScore;
            }
            if (rankEl) {
                rankEl.textContent = newRank;
            }
        }
        
        // Update recent connections cache
        if (scanEntry) {
            try {
                const cachedConnections = localStorage.getItem(`user_${uid}_recentConnections`);
                let connections = [];
                
                if (cachedConnections) {
                    const parsed = JSON.parse(cachedConnections);
                    connections = parsed.connections || [];
                }
                
                // Add new connection at the beginning
                connections.unshift({
                    uid: scanEntry.uid,
                    name: scanEntry.name,
                    photo: scanEntry.photo || null
                });
                
                // Keep only last 3
                connections = connections.slice(0, 3);
                
                localStorage.setItem(`user_${uid}_recentConnections`, JSON.stringify({
                    connections: connections,
                    timestamp: Date.now()
                }));
            } catch (connError) {
                // If we can't update connections cache, that's okay
            }
        }
    } catch (error) {
        // Non-critical, don't throw
    }
}

// Refresh leaderboard cache from Firestore
// Note: refreshLeaderboardCache() function removed
// Cloud Functions now handle all leaderboard cache updates automatically
// This ensures better security (no client write permissions) and consistency

// Subtle toast notification system
function showToast(iconName, message, type = 'info') {
    // Try scanner view toast first, then history view toast
    let toast = document.getElementById('toast-notification');
    let toastIcon = document.getElementById('toast-icon');
    let toastMessage = document.getElementById('toast-message');
    let toastContent = document.getElementById('toast-content');
    
    // If not in scanner view, try history view
    if (!toast || !toastIcon) {
        toast = document.getElementById('toast-notification-history');
        toastIcon = document.getElementById('toast-icon-history');
        toastMessage = document.getElementById('toast-message-history');
        toastContent = document.getElementById('toast-content-history');
    }
    
    if (!toast || !toastIcon || !toastMessage) return;
    
    // Set icon and message
    toastIcon.textContent = iconName;
    toastMessage.textContent = message;
    
    // Set colors based on type
    if (type === 'success') {
        toastIcon.className = 'material-symbols-outlined text-xl flex-shrink-0 text-primary';
        toastContent.className = 'bg-[#1a2c32]/95 backdrop-blur-md rounded-lg shadow-xl border border-primary/20 px-4 py-3 flex items-center gap-3';
    } else if (type === 'error') {
        toastIcon.className = 'material-symbols-outlined text-xl flex-shrink-0 text-red-400';
        toastContent.className = 'bg-[#1a2c32]/95 backdrop-blur-md rounded-lg shadow-xl border border-red-500/20 px-4 py-3 flex items-center gap-3';
    } else {
        toastIcon.className = 'material-symbols-outlined text-xl flex-shrink-0 text-white/70';
        toastContent.className = 'bg-[#1a2c32]/95 backdrop-blur-md rounded-lg shadow-xl border border-white/10 px-4 py-3 flex items-center gap-3';
    }
    
    // Show toast
    toast.classList.remove('hidden', 'toast-hide');
    toast.classList.add('toast-show');
    
    // Auto-hide after 2 seconds
    setTimeout(() => {
        toast.classList.remove('toast-show');
        toast.classList.add('toast-hide');
        setTimeout(() => {
            toast.classList.add('hidden');
            toast.classList.remove('toast-hide');
        }, 150);
    }, 2000);
}

// Updated scan success handler
async function onScanSuccess(decodedText, decodedResult) {
    if (!currentUser) return;
    
    // Prevent multiple simultaneous scans
    if (isProcessingScan) {
        return;
    }
    
    // The QR code contains the 32-char token
    const qrToken = decodedText.trim();
    
    // Validate token format (32 hex characters)
    if (!/^[a-f0-9]{32}$/i.test(qrToken)) {
        showToast('error', 'Invalid QR code format', 'error');
        return;
    }
    
    // Debounce: Prevent scanning the same token within 3 seconds
    const now = Date.now();
    if (qrToken === lastScannedToken && (now - lastScanTime) < 3000) {
        return;
    }
    
    // Mark as processing and update tracking
    isProcessingScan = true;
    lastScannedToken = qrToken;
    lastScanTime = now;
    
    try {
        await processScan(qrToken);
    } catch (error) {
        // Error is already handled in processScan
        // Reset processing flag so scanner can restart
        isProcessingScan = false;
    }
    // Note: isProcessingScan is reset in processScan after success/error
}

function onScanError(errorMessage) {
    // Ignore scan errors (they're frequent during scanning)
}

// Navigation
// Header history button (replaces leaderboard icon)
const historyBtnHeader = document.getElementById('history-btn-header');
if (historyBtnHeader) {
    historyBtnHeader.addEventListener('click', async () => {
        await showView('history');
        await loadHistory(0, true); // Reset pagination
    });
}

// Footer navigation buttons
// Home button (all views)
['footer-home-btn', 'footer-home-btn-scanner', 'footer-home-btn-leaderboard', 'footer-home-btn-history'].forEach(btnId => {
    const btn = document.getElementById(btnId);
    if (btn) {
        btn.addEventListener('click', async () => {
            await showView('passport');
        });
    }
});

// Scanner button (all views)
['footer-scanner-btn', 'footer-scanner-btn-scanner', 'footer-scanner-btn-leaderboard', 'footer-scanner-btn-history'].forEach(btnId => {
    const btn = document.getElementById(btnId);
    if (btn) {
        btn.addEventListener('click', async () => {
            await showView('scanner');
            // Scanner will auto-start via showView logic
        });
    }
});

// Leaderboard button (all views)
['footer-leaderboard-btn', 'footer-leaderboard-btn-scanner', 'footer-leaderboard-btn-leaderboard', 'footer-leaderboard-btn-history'].forEach(btnId => {
    const btn = document.getElementById(btnId);
    if (btn) {
        btn.addEventListener('click', async () => {
            await showView('leaderboard');
            await loadLeaderboard();
        });
    }
});

// Legacy navigation (keep for backward compatibility)
const leaderboardBtn = document.getElementById('leaderboard-btn');
if (leaderboardBtn) {
    leaderboardBtn.addEventListener('click', async () => {
        await showView('leaderboard');
        await loadLeaderboard();
    });
}

document.getElementById('back-to-passport-btn').addEventListener('click', async () => {
    await showView('passport');
});

document.getElementById('view-history-btn').addEventListener('click', async () => {
    await showView('history');
    await loadHistory(0, true); // Reset pagination
});

document.getElementById('back-from-history-btn').addEventListener('click', async () => {
    await showView('passport');
});

// Stop scanner when page/tab becomes hidden (battery and privacy)
document.addEventListener('visibilitychange', async () => {
    if (document.hidden && scannerActive) {
        await stopScanner();
    }
});

// Stop scanner when page is about to unload
window.addEventListener('beforeunload', async () => {
    if (scannerActive) {
        await stopScanner();
    }
});

// Load leaderboard (RTDB-only with caching)
async function loadLeaderboard() {
    let participants = [];
    
    try {
        // Check localStorage cache first
        let cachedLeaderboard = null;
        try {
            const cached = localStorage.getItem('leaderboard_cache');
            if (cached) {
                const parsed = JSON.parse(cached);
                // Check if cache is recent (less than 2 minutes old)
                if (parsed.timestamp && (Date.now() - parsed.timestamp) < CACHE_TTL.LEADERBOARD) {
                    cachedLeaderboard = parsed.data;
                }
            }
        } catch (localError) {
            // localStorage might be disabled, continue to RTDB
        }
        
        // Always read from RTDB (pre-computed) for freshness
        const leaderboardRef = ref(rtdb, 'leaderboard/top10');
        let leaderboardSnap;
        let retryCount = 0;
        const maxRetries = 3;
        
        // Retry logic: attempt up to 3 times with exponential backoff
        while (retryCount < maxRetries) {
            try {
                leaderboardSnap = await get(leaderboardRef);
                if (leaderboardSnap.exists()) {
                    break; // Success, exit retry loop
                }
                
                // If cache is empty, wait and retry (might be updating)
                if (retryCount < maxRetries - 1) {
                    await new Promise(resolve => setTimeout(resolve, 100 * (retryCount + 1)));
                }
                retryCount++;
            } catch (error) {
                if (retryCount === maxRetries - 1) {
                    throw error; // Last attempt failed, throw error
                }
                await new Promise(resolve => setTimeout(resolve, 100 * (retryCount + 1)));
                retryCount++;
            }
        }
        
        if (leaderboardSnap && leaderboardSnap.exists()) {
            const leaderboardData = leaderboardSnap.val();
            // Convert object to array, maintaining order
            participants = Object.keys(leaderboardData)
                .sort((a, b) => parseInt(a) - parseInt(b))
                .map(key => leaderboardData[key])
                .filter(p => p !== null); // Filter out null entries
            
            // Cache leaderboard for future use
            try {
                localStorage.setItem('leaderboard_cache', JSON.stringify({
                    data: participants,
                    timestamp: Date.now()
                }));
            } catch (localError) {
                // localStorage might be disabled, ignore
            }
        } else {
            // If RTDB cache doesn't exist, use cached data if available
            if (cachedLeaderboard && cachedLeaderboard.length > 0) {
                participants = cachedLeaderboard;
            } else {
                // Cloud Functions should have pre-computed it during migration
                participants = [];
            }
        }
    } catch (error) {
        // Use cached data if available on error
        if (cachedLeaderboard && cachedLeaderboard.length > 0) {
            participants = cachedLeaderboard;
        } else {
            participants = [];
        }
    }
    
    // Display leaderboard
    await displayLeaderboard(participants);
}

// Display leaderboard (extracted for reuse)
async function displayLeaderboard(participants) {
        // Display top 3
        const topThreeContainer = document.getElementById('top-three-container');
    if (topThreeContainer) {
        topThreeContainer.innerHTML = '';
        
        if (participants.length >= 3) {
            // Second place
            createTopThreeCard(participants[1], 2, topThreeContainer);
            // First place
            createTopThreeCard(participants[0], 1, topThreeContainer);
            // Third place
            createTopThreeCard(participants[2], 3, topThreeContainer);
        } else {
            participants.forEach((participant, index) => {
                createTopThreeCard(participant, index + 1, topThreeContainer);
            });
        }
        }
        
        // Display rest of leaderboard
        const leaderboardList = document.getElementById('leaderboard-list');
    if (leaderboardList) {
        leaderboardList.innerHTML = '';
        
        participants.slice(3).forEach((participant, index) => {
            const rank = index + 4;
            const item = createLeaderboardItem(participant, rank);
            leaderboardList.appendChild(item);
        });
    }
        
        // Display current user footer
        await loadCurrentUserFooter(participants);
}

// Update leaderboard cache in RTDB (called after score changes)
// Note: updateLeaderboardCache() function removed
// Cloud Functions now handle all leaderboard cache updates automatically
// This ensures better security (no client write permissions) and consistency

function createTopThreeCard(participant, rank, container) {
    const card = document.createElement('div');
    const isFirst = rank === 1;
    const widthClass = isFirst ? 'w-[36%]' : 'w-[30%]';
    const marginClass = isFirst ? '-mt-6 animate-float' : 'mb-4';
    
    const initials = (participant.fullName || participant.displayName || participant.name || 'U').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    const photoURL = participant.photo || participant.photoURL || null;
    const district = participant.district ? `RI District ${participant.district}` : null;
    
    card.className = `flex flex-col items-center ${widthClass} ${marginClass} group cursor-pointer`;
    
    if (isFirst) {
        card.innerHTML = `
            <div class="relative mb-3">
                <span class="absolute -top-9 left-1/2 -translate-x-1/2 text-4xl drop-shadow-xl text-yellow-400 material-symbols-outlined z-20" style="font-variation-settings: 'FILL' 1;">crown</span>
                <div class="w-24 h-24 rounded-full border-4 border-primary bg-gradient-to-br from-yellow-300 via-orange-400 to-red-500 shadow-[0_0_30px_rgba(13,185,242,0.3)] flex items-center justify-center text-white text-3xl font-black relative overflow-hidden">
                    ${photoURL ? 
                        `<img src="${photoURL}" alt="${participant.fullName || participant.displayName || participant.name || 'User'}" class="w-full h-full object-cover rounded-full" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                         <div class="absolute inset-0 bg-gradient-to-br from-yellow-300 via-orange-400 to-red-500 flex items-center justify-center text-white text-3xl font-black" style="display: none;">
                    <div class="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] opacity-20"></div>
                    <span class="relative z-10">${initials}</span>
                         </div>` :
                        `<div class="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] opacity-20"></div>
                         <span class="relative z-10">${initials}</span>`
                    }
                </div>
                <div class="absolute -bottom-3 left-1/2 -translate-x-1/2 bg-gradient-to-r from-primary to-blue-600 text-white text-xs font-black px-3 py-0.5 rounded-full shadow-lg shadow-primary/30 border border-white/20">
                    1st Place
                </div>
            </div>
            <p class="text-base font-extrabold text-center leading-tight mb-0.5 truncate w-full px-1 text-white">${participant.fullName || participant.displayName || participant.name || 'User'}</p>
            ${district ? `<p class="text-[10px] text-white/70 text-center mb-0.5 truncate w-full px-1">${district}</p>` : ''}
            <p class="text-xs text-primary font-black bg-primary/20 px-2 py-0.5 rounded-full text-white">${participant.score || 0} pts</p>
        `;
    } else {
        // Use inline styles for dynamic colors since Tailwind doesn't support dynamic class names
        const rankColor = rank === 2 ? '#3b82f6' : '#f97316'; // blue-500 or orange-500
        const rankColorLight = rank === 2 ? '#60a5fa' : '#fb923c'; // blue-400 or orange-400
        card.innerHTML = `
            <div class="relative mb-2 transition-transform group-hover:-translate-y-1">
                <div class="w-[4.5rem] h-[4.5rem] rounded-full border-4 border-white dark:border-[#1e293b] shadow-lg flex items-center justify-center text-white text-xl font-black overflow-hidden" style="background: linear-gradient(to bottom right, ${rankColorLight}, ${rankColor});">
                    ${photoURL ? 
                        `<img src="${photoURL}" alt="${participant.fullName || participant.displayName || participant.name || 'User'}" class="w-full h-full object-cover rounded-full" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                         <div class="absolute inset-0 flex items-center justify-center text-white text-xl font-black" style="background: linear-gradient(to bottom right, ${rankColorLight}, ${rankColor}); display: none;">${initials}</div>` :
                        initials
                    }
                </div>
                <div class="absolute -bottom-2 left-1/2 -translate-x-1/2 bg-white dark:bg-[#1e293b] text-slate-700 dark:text-white text-[10px] font-bold px-2 py-0.5 rounded-full border border-gray-200 dark:border-gray-700 shadow-md flex items-center gap-1">
                    <span style="color: ${rankColor};">#</span>${rank}
                </div>
            </div>
            <p class="text-sm font-bold text-center leading-tight mb-0.5 truncate w-full px-1 text-white">${participant.fullName || participant.displayName || participant.name || 'User'}</p>
            ${district ? `<p class="text-[9px] text-white/60 text-center mb-0.5 truncate w-full px-1">${district}</p>` : ''}
            <p class="text-[10px] text-white/80 font-bold bg-white/10 px-2 py-0.5 rounded-full">${participant.score || 0} pts</p>
        `;
    }
    
    container.appendChild(card);
}

function createLeaderboardItem(participant, rank) {
    const item = document.createElement('button');
    item.className = 'group flex items-center gap-3 bg-[#1a2c32] hover:bg-[#1e3540] border border-white/10 p-3 rounded-2xl transition-all active:scale-[0.99]';
    
    const initials = (participant.fullName || participant.displayName || participant.name || 'U').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    const photoURL = participant.photo || participant.photoURL || null;
    const district = participant.district ? `RI District ${participant.district}` : 'N/A';
    
    // Color gradients for avatars (fallback when no photo)
    const colorGradients = [
        { from: '#a855f7', to: '#9333ea' }, // fuchsia to purple
        { from: '#8b5cf6', to: '#7c3aed' }, // violet to indigo
        { from: '#14b8a6', to: '#0d9488' }, // teal to emerald
        { from: '#3b82f6', to: '#2563eb' }, // blue
        { from: '#f43f5e', to: '#e11d48' }  // rose to red
    ];
    const colorIndex = (rank - 1) % colorGradients.length;
    const gradient = colorGradients[colorIndex];
    
    item.innerHTML = `
        <div class="w-8 flex justify-center">
            <span class="text-sm font-bold text-white/70 group-hover:text-white">#${rank}</span>
        </div>
        <div class="relative shrink-0">
            ${photoURL ? 
                `<img src="${photoURL}" alt="${participant.fullName || participant.displayName || participant.name || 'User'}" class="w-10 h-10 rounded-full object-cover border-2 border-white/20 shadow-sm" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                 <div class="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-bold shadow-sm" style="background: linear-gradient(to bottom right, ${gradient.from}, ${gradient.to}); display: none;">${initials}</div>` :
                `<div class="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-bold shadow-sm" style="background: linear-gradient(to bottom right, ${gradient.from}, ${gradient.to});">${initials}</div>`
            }
        </div>
        <div class="flex flex-col flex-1 items-start min-w-0">
            <div class="flex items-center gap-1.5 w-full">
                <p class="text-white text-sm font-bold truncate">${participant.fullName || participant.displayName || participant.name || 'User'}</p>
            </div>
            <p class="text-white/60 text-[10px] truncate">${district}</p>
        </div>
        <div class="shrink-0 text-right bg-white/10 px-2 py-1 rounded-lg">
            <p class="text-white font-bold text-sm">${participant.score || 0}</p>
        </div>
    `;
    
    return item;
}

async function loadCurrentUserFooter(leaderboardParticipants) {
    if (!currentUser) return;
    
    try {
        // Get current user data
        const userData = await getCurrentUserData();
        if (!userData) return;
        
        // Find user's rank
        let userRank = null;
        
        // Check if user is in top 10
        const userIndex = leaderboardParticipants.findIndex(p => p.uid === currentUser.uid);
        if (userIndex !== -1) {
            userRank = userIndex + 1;
        } else {
            // User is not in top 10, get rank from RTDB cache (much cheaper than reading all users)
            userRank = await getUserLeaderboardRank(currentUser.uid);
            
            // If rank is still null, try to calculate it from sorted index or set a default
            if (userRank === null) {
                // Try to get from sorted score index
                try {
                    const indexRef = ref(rtdb, 'indexes/sortedScores');
                    const indexSnap = await get(indexRef);
                    if (indexSnap.exists()) {
                        const sortedIndex = indexSnap.val() || [];
                        const userIndex = sortedIndex.findIndex(entry => entry.uid === currentUser.uid);
                        if (userIndex !== -1) {
                            // Calculate rank considering ties
                            let rank = userIndex + 1;
                            const userScore = sortedIndex[userIndex].score;
                            for (let i = userIndex - 1; i >= 0; i--) {
                                if (sortedIndex[i].score === userScore) {
                                    rank = i + 1;
                                } else {
                    break;
                }
                            }
                            userRank = rank;
                        }
                    }
                } catch (error) {
                    // If all else fails, show "--" (already handled by the template)
                }
            }
        }
        
        const profile = userData.profile || {};
        const initials = (profile.fullName || profile.displayName || 'U').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
        
        // Get photoURL - read-only (no syncing)
        // RTDB triggers handle photoURL syncing from Firebase Auth
        // Fallback to currentUser.photoURL for display only (doesn't update RTDB)
        const photoURL = profile.photoURL || userData.photoURL || 
                        (currentUser && currentUser.photoURL) || null;
        const footer = document.getElementById('current-user-footer');
        if (!footer) return;
        
        // Calculate progress within current rank
        const currentRank = userData.rank || 'Rookie';
        const currentScore = userData.score || 0;
        const rankProgress = await calculateRankProgress(currentScore, currentRank);
        
        footer.innerHTML = `
        <div class="relative overflow-hidden bg-[#1a2c32]/95 backdrop-blur-xl rounded-2xl shadow-2xl border border-white/10 p-1">
            <div class="absolute inset-0 bg-gradient-to-r from-primary/10 to-purple-500/10 opacity-50"></div>
            <div class="relative flex items-center gap-3 p-3 rounded-xl bg-white/5">
                <div class="flex flex-col items-center justify-center w-10 shrink-0">
                    <span class="text-[9px] text-white/70 font-bold uppercase tracking-wider mb-0.5">Rank</span>
                    <span class="text-xl font-black text-white leading-none">${userRank || '--'}</span>
                </div>
                <div class="relative shrink-0">
                    <div class="w-12 h-12 rounded-full border-2 border-primary bg-gradient-to-br from-slate-700 to-slate-900 flex items-center justify-center text-white text-lg font-bold shadow-[0_0_15px_rgba(13,185,242,0.3)] overflow-hidden">
                        ${photoURL ? 
                            `<img src="${photoURL}" alt="${profile.fullName || profile.displayName || 'User'}" class="w-full h-full object-cover rounded-full" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                             <div class="absolute inset-0 bg-gradient-to-br from-slate-700 to-slate-900 flex items-center justify-center text-white text-lg font-bold" style="display: none;">
                        <span class="text-primary">${initials}</span>
                             </div>` :
                            `<span class="text-primary">${initials}</span>`
                        }
                    </div>
                    <div class="absolute -bottom-1 -right-1 bg-primary text-white text-[8px] font-bold px-1.5 py-0.5 rounded-full border border-slate-900">YOU</div>
                </div>
                <div class="flex flex-col flex-1 min-w-0 justify-center">
                    <div class="flex items-center justify-between mb-1">
                        <p class="text-white text-sm font-bold truncate">Current Score</p>
                        <span class="text-primary font-black text-base">${userData.score || 0}</span>
                    </div>
                    <div class="flex items-center gap-2">
                        <div class="h-2 flex-1 bg-slate-700/50 rounded-full overflow-hidden backdrop-blur-sm">
                            <div class="h-full bg-gradient-to-r from-primary to-blue-500 rounded-full shadow-[0_0_10px_rgba(13,185,242,0.5)]" style="width: ${rankProgress}%"></div>
                        </div>
                    </div>
                    <p class="text-[9px] text-white/70 mt-1">
                        <span class="text-white font-bold">${userData.rank || 'Rookie'}</span>
                    </p>
                </div>
            </div>
        </div>
    `;
    } catch (error) {
        // Don't show alert - this is a non-critical feature
    }
}

// Pagination state for connection history
let historyPage = 0;
const HISTORY_PAGE_SIZE = 20;
let historyHasMore = true;
let historyLastKey = null;

// Load connection history with pagination (RTDB-first, optimized)
async function loadHistory(page = 0, reset = false) {
    if (!currentUser) return;    // Reset pagination state if starting fresh
    if (reset) {
        historyPage = 0;
        historyHasMore = true;
        historyLastKey = null;
    }
    
    try {
        const recentRef = ref(rtdb, `scans/recent/${currentUser.uid}`);
        let snapshot;
        
        // Handle both legacy array format and new object format
        const recentSnap = await get(recentRef);        if (!recentSnap.exists()) {
            renderHistoryConnections([], true);
            return;
        }
        
        const recent = recentSnap.val();
        let connections = [];        // Check if legacy array format
        if (Array.isArray(recent)) {
            // Legacy format - convert and handle pagination client-side
            connections = recent
                .map(conn => ({
                    uid: conn.scannedUid,
                    name: conn.name,
                    photo: conn.photo,
                    district: conn.district,
                    email: conn.email || null,
                    phone: conn.phone || null,
                    profession: conn.profession || null,
                    scannedAt: conn.scannedAt,
                    _key: `${conn.scannedAt || Date.now()}_${conn.scannedUid}`
                }))
                .sort((a, b) => (b.scannedAt || 0) - (a.scannedAt || 0));
            
            // Client-side pagination for legacy data
            const startIdx = page * HISTORY_PAGE_SIZE;
            const endIdx = startIdx + HISTORY_PAGE_SIZE;
            connections = connections.slice(startIdx, endIdx);
            historyHasMore = endIdx < recent.length;
        } else {
            // New object format - use RTDB queries for efficient pagination
            let queryRef;
            
            if (historyLastKey) {
                // Continue from last key (cursor-based pagination)
                queryRef = query(
                    recentRef,
                    orderByKey(),
                    endAt(historyLastKey),
                    limitToLast(HISTORY_PAGE_SIZE + 1) // +1 to check if more exists
                );
            } else {
                // First page - get most recent
                queryRef = query(
                    recentRef,
                    orderByKey(),
                    limitToLast(HISTORY_PAGE_SIZE + 1) // +1 to check if more exists
                );
            }
            
            snapshot = await get(queryRef);
            
            if (snapshot.exists()) {
                const recentData = snapshot.val() || {};
                const entries = Object.entries(recentData);
                
                // Sort by scannedAt (newest first) since keys are timestamp-based
                entries.sort((a, b) => (b[1].scannedAt || 0) - (a[1].scannedAt || 0));
                
                // Check if we have more pages
                if (entries.length > HISTORY_PAGE_SIZE) {
                    historyHasMore = true;
                    entries.pop(); // Remove the extra one
                } else {
                    historyHasMore = false;
                }
                
                connections = entries.map(([key, conn]) => ({
                    uid: conn.scannedUid,
                    name: conn.name,
                    photo: conn.photo,
                    district: conn.district,
                    email: conn.email || null,
                    phone: conn.phone || null,
                    profession: conn.profession || null,
                    scannedAt: conn.scannedAt,
                    _key: key // Store key for pagination
                }));
                
                // Update pagination state
                if (entries.length > 0) {
                    historyLastKey = entries[entries.length - 1][0];
                }
            } else {
                historyHasMore = false;
            }
        }
        
        // Fetch missing email/phone for connections that need it
        const connectionsNeedingData = connections.filter(conn => !conn.email && !conn.phone && conn.uid);
        if (connectionsNeedingData.length > 0) {
            await Promise.all(connectionsNeedingData.map(async (conn) => {
                try {
                    const userRef = ref(rtdb, `users/${conn.uid}`);
                    const userSnap = await get(userRef);
                    if (userSnap.exists()) {
                        const userData = userSnap.val();
                        const profile = userData.profile || {};
                        conn.email = conn.email || userData.email || profile.email || null;
                        conn.phone = conn.phone || profile.phone || null;
                        conn.profession = conn.profession || profile.profession || null;
                    }
                } catch (error) {
                    // Non-critical, continue
                }
            }));
        }        // Render connections
        renderHistoryConnections(connections, page === 0);
        
    } catch (error) {    const historyList = document.getElementById('history-list');
        if (historyList) {
            historyList.innerHTML = `
                <div class="text-center py-12">
                    <span class="material-symbols-outlined text-6xl text-white/40 mb-4">error</span>
                    <p class="text-white/70">Error loading connection history. Please try again.</p>
                </div>
            `;
        }
    }
}

function renderHistoryConnections(connections, isFirstPage) {
    const historyList = document.getElementById('history-list');
    if (!historyList) return;
    
    // Clear only if first page
    if (isFirstPage) {
    historyList.innerHTML = '';
    }
    
    if (connections.length === 0 && isFirstPage) {
        historyList.innerHTML = `
            <div class="text-center py-12">
                <span class="material-symbols-outlined text-6xl text-white/40 mb-4">qr_code_scanner</span>
                <p class="text-white/70 text-base">No connections yet.</p>
                <p class="text-white/70 text-base mt-1">Start scanning to build your network!</p>
            </div>
        `;
        return;
    }
    
    // Append connections to existing list
    connections.forEach(conn => {
        const scannedAt = conn.scannedAt;
        const date = scannedAt ? (
            typeof scannedAt === 'string' 
                ? new Date(scannedAt).toLocaleDateString('en-US', { 
                    month: 'short', 
                    day: 'numeric', 
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                })
                : new Date(scannedAt).toLocaleDateString('en-US', { 
                    month: 'short', 
                    day: 'numeric', 
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                })
        ) : 'Unknown date';
        
        const initials = (conn.name || 'U').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
        
        const item = document.createElement('div');
        item.className = 'flex items-center gap-3 bg-[#1a2c32] border border-white/10 p-4 rounded-2xl shadow-sm';
        
        // Escape connection data for use in onclick - use base64 encoding to avoid quote issues
        const connDataBase64 = btoa(JSON.stringify(conn));
        
        item.innerHTML = `
            <div class="relative shrink-0">
                ${conn.photo ? 
                    `<img src="${conn.photo}" alt="${conn.name}" class="w-12 h-12 rounded-full object-cover border-2 border-primary/20">` :
                    `<div class="w-12 h-12 rounded-full bg-gradient-to-br from-primary to-blue-600 flex items-center justify-center text-white text-sm font-bold">${initials}</div>`
                }
            </div>
            <div class="flex flex-col flex-1 min-w-0">
                <p class="text-white text-sm font-bold truncate">${conn.name || 'User'}</p>
                <p class="text-white/60 text-[10px] mt-1">Connected on ${date}</p>
            </div>
            ${(conn.email || conn.phone) ? `
            <button onclick="saveContactToPhone('${connDataBase64}')" 
                class="flex items-center justify-center w-10 h-10 rounded-full bg-primary/20 hover:bg-primary/30 text-primary transition-colors shrink-0"
                title="Save to Contacts">
                <span class="material-symbols-outlined text-lg">contacts</span>
            </button>
            ` : ''}
        `;
        
        historyList.appendChild(item);
    });
    
    // Remove existing "Load More" button if present
    const existingLoadMore = historyList.querySelector('.load-more-history-btn');
    if (existingLoadMore) {
        existingLoadMore.remove();
    }
    
    // Add "Load More" button if more pages available
    if (historyHasMore) {
        const loadMoreBtn = document.createElement('button');
        loadMoreBtn.className = 'load-more-history-btn w-full mt-4 py-3 bg-primary/20 hover:bg-primary/30 text-primary font-semibold rounded-xl transition-colors';
        loadMoreBtn.textContent = 'Load More';
        loadMoreBtn.onclick = () => {
            historyPage++;
            loadHistory(historyPage, false);
        };
        historyList.appendChild(loadMoreBtn);
    }
}

// Save contact to phone
window.saveContactToPhone = async function(connectionData) {
    try {
        // Parse connection data - handle base64 encoded string or object
        let connection;
        if (typeof connectionData === 'string') {
            try {
                // Try to decode as base64 first
                connection = JSON.parse(atob(connectionData));
            } catch (e) {
                // If base64 decode fails, try parsing as regular JSON
                try {
                    connection = JSON.parse(connectionData.replace(/&quot;/g, '"').replace(/\\'/g, "'"));
                } catch (e2) {
                    // If that also fails, treat as plain object
                    connection = connectionData;
                }
            }
        } else {
            connection = connectionData;
        }
        
        // Validate required fields
        if (!connection.name) {
            showToast('error', 'Contact name is required', 'error');
            return;
        }
        
        if (!connection.email && !connection.phone) {
            showToast('error', 'No contact info available', 'error');
            return;
        }
        
        // Generate vCard content with more complete information
        let vCard = 'BEGIN:VCARD\n';
        vCard += 'VERSION:3.0\n';
        vCard += `FN:${escapeVCardValue(connection.name)}\n`;
        vCard += `N:${escapeVCardValue(connection.name)};;;;\n`;
        
        if (connection.email) {
            vCard += `EMAIL;TYPE=INTERNET,HOME:${escapeVCardValue(connection.email)}\n`;
        }
        
        if (connection.phone) {
            // Clean phone number (remove spaces, dashes, etc.)
            const cleanPhone = connection.phone.replace(/[\s\-\(\)]/g, '');
            vCard += `TEL;TYPE=CELL:${cleanPhone}\n`;
        }
        
        // Add additional info if available
        if (connection.district) {
            vCard += `ORG:RI District ${escapeVCardValue(connection.district)}\n`;
        }
        
        if (connection.profession) {
            vCard += `TITLE:${escapeVCardValue(connection.profession)}\n`;
        }
        
        vCard += 'END:VCARD';
        
        // Create blob with proper MIME type
        const blob = new Blob([vCard], { type: 'text/vcard;charset=utf-8' });
        const fileName = `${connection.name.replace(/[^a-z0-9]/gi, '_')}.vcf`;
        const file = new File([blob], fileName, { 
            type: 'text/vcard',
            lastModified: Date.now()
        });
        
        // Try Web Share API first (mobile - opens contacts app)
        if (navigator.share) {
            try {
                // Check if we can share files
                if (navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({
                        title: `Add ${connection.name} to Contacts`,
                    text: `Save ${connection.name} to your contacts`,
                    files: [file]
                });
                    showToast('check_circle', `Opening contacts app...`, 'success');
                return;
                } else {
                    // Fallback: Share text with vCard data URI
                    const vCardDataUri = `data:text/vcard;charset=utf-8,${encodeURIComponent(vCard)}`;
                    await navigator.share({
                        title: `Add ${connection.name} to Contacts`,
                        text: `Name: ${connection.name}${connection.email ? `\nEmail: ${connection.email}` : ''}${connection.phone ? `\nPhone: ${connection.phone}` : ''}`,
                        url: vCardDataUri
                    });
                    showToast('check_circle', `Opening contacts app...`, 'success');
                    return;
                }
            } catch (shareError) {
                // If share fails or is cancelled, fall back to download
                if (shareError.name === 'AbortError') {
                    // User cancelled, don't show error
                    return;
                }
            }
        }
        
        // For iOS: Try to open vCard directly using data URI
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        if (isIOS) {
            try {
                const vCardDataUri = `data:text/vcard;charset=utf-8,${encodeURIComponent(vCard)}`;
                const link = document.createElement('a');
                link.href = vCardDataUri;
                link.download = fileName;
                link.style.display = 'none';
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                showToast('check_circle', `Opening contacts app...`, 'success');
                return;
            } catch (iosError) {
                // Fall through to download
            }
        }
        
        // Fallback: Download vCard file (will open in contacts app on mobile)
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        
        // Clean up after a short delay
        setTimeout(() => {
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        }, 100);
        
        // Show success message with instructions for desktop
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        if (isMobile) {
            showToast('check_circle', `Opening contacts app...`, 'success');
        } else {
            showToast('download', `Downloaded ${connection.name}.vcf - Open it to add to contacts`, 'success');
        }
        
    } catch (error) {
        showToast('error', 'Failed to save contact', 'error');
    }
};

// Helper function to escape vCard values
function escapeVCardValue(value) {
    if (!value) return '';
    // Escape special characters in vCard format
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/,/g, '\\,')
        .replace(/;/g, '\\;')
        .replace(/\n/g, '\\n');
}

