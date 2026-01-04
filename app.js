// TODO: Replace with your actual Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyCdSrZlsg6e7lGMEShA0mqGkNBSggfHBCA",
    authDomain: "eventpasstest.firebaseapp.com",
    projectId: "eventpasstest",
    storageBucket: "eventpasstest.firebasestorage.app",
    messagingSenderId: "935026705122",
    appId: "1:935026705122:web:310e95131223b09938d4bb",
    databaseURL: "https://eventpasstest-default-rtdb.asia-southeast1.firebasedatabase.app"
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
    query, 
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
    update as rtdbUpdate
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js';
import { deleteDoc } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth();
const db = getFirestore();
const rtdb = getDatabase(app);
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
}

// Current user state
let currentUser = null;
let html5QrCode = null;

// Auth state listener
onAuthStateChanged(auth, async (user) => {
    if (user) {
        console.log('User authenticated:', {
            uid: user.uid,
            email: user.email,
            displayName: user.displayName
        });
        
        // Check if user is registered and migrate from pendingUsers if needed
        const isParticipant = await checkIfParticipant(user.uid, user.email);
        
        console.log('Is participant:', isParticipant);
        
        if (!isParticipant) {
            console.error('Access denied for user:', {
                uid: user.uid,
                email: user.email,
                normalizedEmail: user.email ? user.email.toLowerCase().trim() : null
            });
            showAccessDeniedModal();
            await signOut(auth);
            showView('login');
            return;
        }
        
        currentUser = user;
        await updateUserOnLogin(user);
        
        // Update RTDB with current user's name and photo
        await updateRTDBUserData(user);
        
        await loadUserProfile();
        showView('passport');
    } else {
        currentUser = null;
        showView('login');
    }
});

// Update RTDB with user's name and photo from auth
async function updateRTDBUserData(user) {
    try {
        const userRef = doc(db, 'users', user.uid);
        const userSnap = await getDoc(userRef);
        
        if (!userSnap.exists()) {
            console.warn('User document does not exist when trying to update RTDB');
            return;
        }
        
        const userData = userSnap.data();
        
        // qrToken should always exist after migration, but check just in case
        if (!userData.qrToken) {
            console.warn('qrToken not found in user document, skipping RTDB update');
            return;
        }
        
        // Update RTDB with current auth data
        const qrTokenRef = ref(rtdb, `qrcodes/${userData.qrToken}`);
        await set(qrTokenRef, {
            uid: user.uid,
            name: userData.fullName || user.displayName || userData.displayName || 'User',
            photo: user.photoURL || null
        });
        
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
        
        console.log('RTDB updated successfully for user:', user.uid);
    } catch (error) {
        console.error('Error updating RTDB user data:', error);
        // Don't throw - RTDB update failure shouldn't block login
        if (error.code === 'PERMISSION_DENIED') {
            console.error('RTDB permission denied - check RTDB security rules');
        }
    }
}

// Generate cryptographically secure random 32-char hex token
function generateQRToken() {
    const array = new Uint8Array(16); // 16 bytes = 32 hex chars
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

// Check if user is a registered participant and migrate from pendingUsers if needed
async function checkIfParticipant(uid, email) {
    try {
        if (!email) {
            console.error('No email provided for user:', uid);
            return false;
        }
        
        // First check if user already exists in users collection
        const userRef = doc(db, 'users', uid);
        let userSnap;
        try {
            userSnap = await getDoc(userRef);
        } catch (error) {
            console.error('Error reading users collection:', error);
            throw error;
        }
        
        if (userSnap.exists()) {
            console.log('User already exists in users collection:', uid);
            return true;
        }
        
        // Check pendingUsers using query approach (more reliable with rules)
        const normalizedEmail = email.toLowerCase().trim();
        console.log('Checking pendingUsers for email:', normalizedEmail);
        console.log('User UID:', uid);
        
        // Use query instead of getDoc - queries sometimes work better with security rules
        const pendingUsersRef = collection(db, 'pendingUsers');
        const emailQuery = query(pendingUsersRef, where('email', '==', normalizedEmail));
        let querySnapshot;
        
        try {
            querySnapshot = await getDocs(emailQuery);
        } catch (error) {
            console.error('Error querying pendingUsers:', error);
            // Fallback: try direct document access
            console.log('Trying fallback: direct document access');
            const pendingUserRef = doc(db, 'pendingUsers', normalizedEmail);
            try {
                const pendingUserSnap = await getDoc(pendingUserRef);
                if (pendingUserSnap.exists()) {
                    const pendingData = pendingUserSnap.data();
                    await migratePendingUser(uid, normalizedEmail, pendingData);
                    return true;
                }
            } catch (fallbackError) {
                console.error('Fallback also failed:', fallbackError);
                throw error; // Throw original error
            }
            return false;
        }
        
        if (!querySnapshot.empty) {
            // Found pending user - migrate it
            const pendingDoc = querySnapshot.docs[0];
            const pendingData = pendingDoc.data();
            
            // Verify email matches (security check)
            if (pendingData.email && pendingData.email.toLowerCase().trim() !== normalizedEmail) {
                console.error('Email mismatch in pendingUsers document');
                return false;
            }
            
            await migratePendingUser(uid, normalizedEmail, pendingData);
            return true;
        }
        
        console.log('User not found in pendingUsers. Email checked:', normalizedEmail);
        return false;
    } catch (error) {
        console.error('Error checking participant status:', error);
        console.error('Error details:', {
            code: error.code,
            message: error.message,
            uid: uid,
            email: email,
            normalizedEmail: email ? email.toLowerCase().trim() : null
        });
        
        if (error.code === 'permission-denied') {
            console.error('PERMISSION DENIED - Check Firestore rules!');
            console.error('Current user email:', email);
            console.error('Normalized email:', email ? email.toLowerCase().trim() : null);
            console.error('Make sure rules allow authenticated users to:');
            console.error('1. Query pendingUsers collection where email matches');
            console.error('2. Read pendingUsers documents');
            console.error('3. Create users/{uid} documents');
            console.error('4. Delete pendingUsers documents');
        }
        return false;
    }
}

// Helper function to migrate pending user to active user
async function migratePendingUser(uid, normalizedEmail, pendingData) {
    try {
        console.log('Migrating pending user to users collection...');
        
        const qrToken = pendingData.qrToken;
        if (!qrToken) {
            throw new Error('qrToken missing from pendingUsers document');
        }
        
        const userRef = doc(db, 'users', uid);
        
        // Calculate initial rank
        const initialRank = await calculateRank(0);
        
        // Create user document with all fields
        await setDoc(userRef, {
            email: normalizedEmail,
            participantId: pendingData.participantId || null,
            fullName: pendingData.fullName || null,
            district: pendingData.district || null,
            phone: pendingData.phone || null,
            profession: pendingData.profession || null,
            displayName: null, // Will be updated from auth
            photoURL: null, // Will be updated from auth
            score: 0,
            rank: initialRank,
            scanHistory: [],
            qrCodeBase64: pendingData.qrCodeBase64 || null,
            qrToken: qrToken, // Store for RTDB updates
            firstLoginAt: serverTimestamp()
        });
        console.log('Created user document in Firestore');
        
        // Write to RTDB
        const qrTokenRef = ref(rtdb, `qrcodes/${qrToken}`);
        await set(qrTokenRef, {
            uid: uid,
            name: pendingData.fullName || pendingData.name || 'User',
            photo: null // Will be updated after auth
        });
        console.log('Wrote QR token to RTDB');
        
        // Delete from pendingUsers (try by document ID first, then by query result)
        try {
            const pendingUserRef = doc(db, 'pendingUsers', normalizedEmail);
            await deleteDoc(pendingUserRef);
            console.log('Deleted pendingUsers document');
        } catch (deleteError) {
            console.warn('Could not delete pendingUsers document:', deleteError);
            // Non-critical - user is migrated, pendingUsers entry can be cleaned up later
        }
        
        console.log('Successfully migrated user from pendingUsers to users collection');
    } catch (error) {
        console.error('Error during migration:', error);
        throw error;
    }
}

// Update user document with Firebase auth data on login
async function updateUserOnLogin(user) {
    try {
        const userRef = doc(db, 'users', user.uid);
        const userSnap = await getDoc(userRef);
        
        if (!userSnap.exists()) {
            throw new Error('User not found. UID: ' + user.uid);
        }
        
        const userData = userSnap.data();
        const updateData = {};
        
        // Always update displayName and photoURL if available from auth
        if (user.displayName) {
            updateData.displayName = user.displayName;
        }
        if (user.photoURL) {
            updateData.photoURL = user.photoURL;
        }
        
        // Set firstLoginAt if not exists, otherwise update lastLoginAt
        if (!userData.firstLoginAt) {
            updateData.firstLoginAt = serverTimestamp();
        } else {
            updateData.lastLoginAt = serverTimestamp();
        }
        
        if (Object.keys(updateData).length > 0) {
            await updateDoc(userRef, updateData);
        }
    } catch (error) {
        console.error('Error updating user on login:', error);
        if (error.code === 'permission-denied') {
            console.error('PERMISSION DENIED - Check Firestore rules!');
        }
    }
}

// Rank cache
let ranksCache = null;
let ranksCacheTime = 0;
const RANKS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const RANKS_DOC_PATH = 'appConfig/ranks';

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
            console.warn('No ranks configured, using default');
            return getDefaultRank(score);
        }
        
        // Sort by order
        ranks.sort((a, b) => a.order - b.order);
        
        // Update cache
        ranksCache = ranks;
        ranksCacheTime = now;
        
        return findRankForScore(score, ranks);
    } catch (error) {
        console.error('Error calculating rank:', error);
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

// Load user profile (using localStorage for current user's data)
async function loadUserProfile() {
    if (!currentUser) return;
    
    try {
        // Try to get score/rank from localStorage first (instant, no network)
        let score = null;
        let rank = null;
        
        try {
            const cachedData = localStorage.getItem(`user_${currentUser.uid}_data`);
            if (cachedData) {
                const parsed = JSON.parse(cachedData);
                // Check if cache is recent (less than 5 minutes old)
                if (parsed.timestamp && (Date.now() - parsed.timestamp) < 5 * 60 * 1000) {
                    score = parsed.score;
                    rank = parsed.rank;
                    console.log('Loaded score/rank from localStorage cache');
                }
            }
        } catch (localError) {
            console.log('localStorage cache not available, will use Firestore');
        }
        
        // Get user data using UID as document ID
        const userRef = doc(db, 'users', currentUser.uid);
        const userSnap = await getDoc(userRef);
        
        if (userSnap.exists()) {
            const userData = userSnap.data();
            
            // Use cached score/rank if available, otherwise use Firestore data
            const finalScore = score !== null ? score : (userData.score || 0);
            const finalRank = rank || userData.rank || await calculateRank(finalScore);
            
            // Update localStorage cache (instant, no network cost)
            try {
                localStorage.setItem(`user_${currentUser.uid}_data`, JSON.stringify({
                    score: finalScore,
                    rank: finalRank,
                    timestamp: Date.now()
                }));
            } catch (localError) {
                // localStorage might be disabled, ignore
            }
            
            // Update UI
            document.getElementById('user-name').textContent = userData.fullName || userData.displayName || 'User';
            document.getElementById('user-email').textContent = userData.district ? `RI District ${userData.district}` : 'N/A';
            document.getElementById('user-score').textContent = finalScore;
            document.getElementById('user-rank').textContent = finalRank;
            
            // Set avatar
            const avatarImg = document.getElementById('user-avatar');
            const qrAvatarOverlay = document.getElementById('qr-avatar-overlay');
            
            const photoURL = userData.photoURL || (currentUser && currentUser.photoURL) || null;
            
            if (photoURL) {
                avatarImg.src = photoURL;
                avatarImg.style.display = 'block';
                avatarImg.onerror = function() {
                    console.warn('Failed to load profile image:', photoURL);
                    avatarImg.style.display = 'none';
                };
                if (qrAvatarOverlay) {
                    qrAvatarOverlay.src = photoURL;
                    qrAvatarOverlay.style.display = 'block';
                    qrAvatarOverlay.onerror = function() {
                        qrAvatarOverlay.style.display = 'none';
                    };
                }
            } else {
                avatarImg.style.display = 'none';
                if (qrAvatarOverlay) {
                    qrAvatarOverlay.style.display = 'none';
                }
            }
            
            // Display QR code from database
            displayQRCodeFromDatabase(userData.qrCodeBase64);
            
            // Load recent connections
            await loadRecentConnections();
        }
    } catch (error) {
        console.error('Error loading user profile:', error);
        // Only show alert for critical errors, not for non-critical operations
        if (error.code === 'permission-denied') {
            // Check if it's a critical error (user document read) vs non-critical (fallback operations)
            console.warn('Permission denied - this may be from a fallback operation. Check console for details.');
            // Don't show alert - profile might still load from cache or other sources
        }
    }
}

// Display QR Code from Database (Base64)
function displayQRCodeFromDatabase(qrCodeBase64) {
    const canvas = document.getElementById('qr-code-canvas');
    if (!canvas) {
        console.error('QR code canvas not found');
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
            console.error('Error loading QR code image');
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
                console.warn('No QR code data available');
            }
        }).catch(error => {
            console.warn('Could not load user data for QR fallback:', error);
        });
    }
}

// Helper to get current user data (updated for new architecture)
async function getCurrentUserData() {
    if (!currentUser) return null;
    try {
        const userRef = doc(db, 'users', currentUser.uid);
        const userSnap = await getDoc(userRef);
        return userSnap.exists() ? userSnap.data() : null;
    } catch (error) {
        console.error('Error getting user data:', error);
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
                        console.error('Error generating QR code:', error);
                        tryAlternativeQRGeneration(qrToken, canvas);
                    }
                });
            } catch (err) {
                console.error('Error in QRCode.toCanvas:', err);
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
            console.error('Alternative QR generation failed:', err);
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

// Load recent connections (using localStorage - we already have scanHistory from user document)
async function loadRecentConnections() {
    if (!currentUser) return;
    
    const container = document.getElementById('recent-connections');
    if (!container) return;
    
    container.innerHTML = '';
    
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
                    console.log('Loaded recent connections from localStorage cache');
                }
            }
        } catch (localError) {
            // localStorage might be disabled or invalid, continue to Firestore
        }
        
        // If no cache, get from user document (which we already read in loadUserProfile)
        // But we'll get it from the userData we already have if available
        if (connections.length === 0) {
            const userRef = doc(db, 'users', currentUser.uid);
            const userSnap = await getDoc(userRef);
            
            if (!userSnap.exists()) return;
            
            const userData = userSnap.data();
            const scanHistory = userData.scanHistory || [];
            
            // Sort by timestamp (most recent first)
            connections = [...scanHistory].sort((a, b) => {
                const timeA = a.scannedAt ? (typeof a.scannedAt === 'string' ? new Date(a.scannedAt).getTime() : a.scannedAt.toMillis()) : 0;
                const timeB = b.scannedAt ? (typeof b.scannedAt === 'string' ? new Date(b.scannedAt).getTime() : b.scannedAt.toMillis()) : 0;
                return timeB - timeA;
            }).slice(0, 3);
            
            // Update localStorage cache (instant, no network cost)
            try {
                localStorage.setItem(`user_${currentUser.uid}_recentConnections`, JSON.stringify({
                    connections: connections,
                    timestamp: Date.now()
                }));
            } catch (localError) {
                // localStorage might be disabled, ignore
            }
        }
        
        // Display connections
        connections.forEach(conn => {
            const img = document.createElement('img');
            img.src = conn.photo || '';
            img.alt = conn.name || 'User';
            img.className = 'inline-block h-12 w-12 rounded-full ring-4 ring-background-dark object-cover';
            img.onerror = function() {
                // Fallback to initials if image fails
                this.style.display = 'none';
                const fallback = document.createElement('div');
                fallback.className = 'inline-block h-12 w-12 rounded-full ring-4 ring-background-dark bg-surface-dark flex items-center justify-center border border-white/10 text-xs font-bold text-slate-400';
                fallback.textContent = (conn.name || 'U').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
                container.appendChild(fallback);
            };
            container.appendChild(img);
        });
        
        // Show "+X more" if there are more connections
        if (connections.length === 3) {
            try {
                const userRef = doc(db, 'users', currentUser.uid);
                const userSnap = await getDoc(userRef);
                if (userSnap.exists()) {
                    const userData = userSnap.data();
                    const totalConnections = (userData.scanHistory || []).length;
                    if (totalConnections > 3) {
                        const more = document.createElement('div');
                        more.className = 'h-12 w-12 rounded-full ring-4 ring-background-dark bg-surface-dark flex items-center justify-center border border-white/10 text-xs font-bold text-slate-400';
                        more.textContent = `+${totalConnections - 3}`;
                        container.appendChild(more);
                    }
                }
            } catch (err) {
                // Ignore error, just don't show "+X more"
            }
        }
    } catch (error) {
        console.error('Error loading recent connections:', error);
        // Don't show alert - this is a non-critical feature
    }
}

// Note: Removed RTDB cache functions for current user's data
// Using localStorage instead since we already read the full user document from Firestore

// Get user's leaderboard rank (position in leaderboard: 1st, 2nd, 3rd, etc.)
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

        // Try RTDB cache (cheap, 1 read)
        const rankRef = ref(rtdb, `ranks/${uid}`);
        const rankSnap = await get(rankRef);
        
        if (rankSnap.exists()) {
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

        // Fallback: Calculate from Firestore (expensive - reads all users)
        // This should rarely happen if Cloud Functions are working
        console.warn('RTDB rank cache not found, falling back to Firestore calculation');
        const allUsersRef = collection(db, 'users');
        const allUsersQuery = query(allUsersRef, orderBy('score', 'desc'));
        const allUsersSnap = await getDocs(allUsersQuery);
        
        let rank = 1;
        for (const doc of allUsersSnap.docs) {
            if (doc.id === uid) {
                return rank;
            }
            rank++;
        }
        
        return null; // User not found
    } catch (error) {
        console.error('Error getting user leaderboard rank:', error);
        return null;
    }
}

// Google Sign-In
document.getElementById('google-signin-btn').addEventListener('click', async () => {
    try {
        await signInWithPopup(auth, googleProvider);
    } catch (error) {
        console.error('Sign-in error:', error);
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
        console.error('Logout error:', error);
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
        console.error('Scanner start error:', err);
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
            console.error('Scanner stop error:', err);
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
 * Process a QR code scan using hybrid architecture (RTDB + Firestore)
 * @param {string} qrToken - The 32-character hex token from the scanned QR code
 */
async function processScan(qrToken) {
    if (!currentUser) {
        throw new Error('User not authenticated');
    }
    
    const scannerUid = currentUser.uid;
    
    try {
        // Step 1: Lookup target user from RTDB
        const qrTokenRef = ref(rtdb, `qrcodes/${qrToken}`);
        const qrTokenSnap = await get(qrTokenRef);
        
        if (!qrTokenSnap.exists()) {
            throw new Error('Invalid QR code');
        }
        
        const targetData = qrTokenSnap.val();
        const targetUid = targetData.uid;
        
        // Fetch full user data from Firestore to get email, phone, district, profession
        const targetUserRef = doc(db, 'users', targetUid);
        const targetUserSnap = await getDoc(targetUserRef);
        const targetUserData = targetUserSnap.exists() ? targetUserSnap.data() : {};
        
        // Step 2: Check if scanning self
        if (targetUid === scannerUid) {
            throw new Error("You can't scan your own QR code!");
        }
        
        // Step 3: Get current user data to calculate expected new score and rank BEFORE transaction
        const scannerUserRef = doc(db, 'users', scannerUid);
        const currentUserDoc = await getDoc(scannerUserRef);
        
        if (!currentUserDoc.exists()) {
            throw new Error("Current user document does not exist!");
        }
        
        const currentUserData = currentUserDoc.data();
        const currentScore = currentUserData.score || 0;
        const expectedNewScore = currentScore + 10;
        
        // Pre-calculate rank (using cache if available, otherwise will use default)
        const newRank = await calculateRank(expectedNewScore);
        
        // Prepare scan entry data (before transaction to ensure consistency)
        const scanEntry = {
            uid: targetData.uid,
            name: targetUserData.fullName || targetData.name || 'Unknown',
            photo: targetUserData.photoURL || targetData.photo || null,
            email: targetUserData.email || null,
            phone: targetUserData.phone || null,
            district: targetUserData.district || null,
            profession: targetUserData.profession || null,
            scannedAt: new Date().toISOString() // Use ISO string for consistency
        };
        
        // Step 4: Transaction to check scanHistory, update score, and add to scanHistory atomically
        // This ensures NO duplicates can occur even with concurrent scans
        await runTransaction(db, async (transaction) => {
            // Re-read user document within transaction to get latest state
            const scannerUserDoc = await transaction.get(scannerUserRef);
            
            if (!scannerUserDoc.exists()) {
                throw new Error("Current user document does not exist!");
            }
            
            const userData = scannerUserDoc.data();
            const scanHistory = userData.scanHistory || [];
            
            // CRITICAL: Check if already scanned by looking in scanHistory array
            // This check MUST be inside the transaction to prevent race conditions
            // We check by uid (primary check) and also by exact match (defensive check)
            const alreadyScanned = scanHistory.some(entry => {
                // Primary check: by uid
                const entryUid = entry.uid || entry.scannedUid || null;
                if (entryUid === targetUid) {
                    return true;
                }
                // Defensive check: exact match (in case uid format differs)
                // Compare all fields except scannedAt (which will always differ)
                return entry.uid === scanEntry.uid &&
                       entry.email === scanEntry.email &&
                       entry.phone === scanEntry.phone;
            });
            
            if (alreadyScanned) {
                throw new Error('ALREADY_SCANNED');
            }
            
            // Verify score hasn't changed (defensive check)
            const transactionScore = userData.score || 0;
            
            // Calculate rank synchronously using cache (no async Firestore reads in transaction)
            let finalRank = newRank;
            if (transactionScore !== currentScore) {
                // Score changed, use cached ranks or default
                if (ranksCache) {
                    finalRank = findRankForScore(transactionScore + 10, ranksCache);
                } else {
                    finalRank = getDefaultRank(transactionScore + 10);
                }
            }
            
            // Update user: increment score, add to scanHistory, and update rank ALL ATOMICALLY
            // This is the critical fix - scanHistory update is now inside the transaction
            transaction.update(scannerUserRef, {
                score: increment(10),
                scanHistory: arrayUnion(scanEntry),
                rank: finalRank
            });
        });
        
        // Update localStorage cache after successful scan (instant, no network)
        updateLocalStorageAfterScan(scannerUid, expectedNewScore, finalRank, scanEntry);
        
        // Show subtle success notification
        showToast('check_circle', 'You earned 10 points!', 'success');
        
        // Reload profile to show updated score (don't await to keep scanner responsive)
        loadUserProfile();
        
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
        console.error('Scan error:', error);
        
        // Don't stop scanner - keep it running for better UX
        // The processing flag and debouncing will prevent duplicate scans
        
        if (error.message === 'ALREADY_SCANNED') {
            showToast('error', 'Already scanned this person', 'error');
        } else if (error.code === 'permission-denied') {
            showToast('error', 'Permission denied', 'error');
        } else if (error.message.includes("can't scan your own")) {
            showToast('error', "Can't scan your own QR code", 'error');
        } else if (error.message === 'Invalid QR code') {
            showToast('error', 'Invalid QR code', 'error');
        } else {
            showToast('error', 'Scan failed', 'error');
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
function updateLocalStorageAfterScan(uid, newScore, newRank, scanEntry) {
    try {
        // Update score/rank cache
        localStorage.setItem(`user_${uid}_data`, JSON.stringify({
            score: newScore,
            rank: newRank,
            timestamp: Date.now()
        }));
        
        // Update recent connections cache
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
            console.warn('Could not update connections cache:', connError);
        }
        
        console.log('Updated localStorage cache after scan');
    } catch (error) {
        console.warn('Error updating localStorage cache after scan:', error);
        // Non-critical, don't throw
    }
}

// Refresh leaderboard cache from Firestore
async function refreshLeaderboardCache() {
    try {
        const usersRef = collection(db, 'users');
        const q = query(usersRef, orderBy('score', 'desc'), limit(10));
        const querySnapshot = await getDocs(q);
        
        const participants = [];
        querySnapshot.forEach((doc) => {
            const data = doc.data();
            participants.push({
                uid: doc.id,
                ...data
            });
        });
        
        await updateLeaderboardCache(participants);
    } catch (error) {
        console.warn('Error refreshing leaderboard cache:', error);
        // Non-critical
    }
}

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
        await loadHistory();
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
    await loadHistory();
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

// Load leaderboard (optimized with RTDB cache)
async function loadLeaderboard() {
    let participants = [];
    
    try {
        // Try RTDB cache first (cost-effective)
        const leaderboardRef = ref(rtdb, 'leaderboard/top10');
        const leaderboardSnap = await get(leaderboardRef);
        
        if (leaderboardSnap.exists()) {
            const leaderboardData = leaderboardSnap.val();
            // Convert object to array, maintaining order
            participants = Object.keys(leaderboardData)
                .sort((a, b) => parseInt(a) - parseInt(b))
                .map(key => leaderboardData[key])
                .filter(p => p !== null); // Filter out null entries
            
            console.log('Loaded leaderboard from RTDB cache');
        } else {
            // Fallback to Firestore if RTDB cache doesn't exist
            console.log('RTDB cache not found, falling back to Firestore');
            throw new Error('RTDB_CACHE_MISS');
        }
    } catch (error) {
        // Fallback to Firestore query
        if (error.message === 'RTDB_CACHE_MISS' || error.code === 'PERMISSION_DENIED') {
            try {
                console.log('Loading leaderboard from Firestore (fallback)');
                const usersRef = collection(db, 'users');
                const q = query(usersRef, orderBy('score', 'desc'), limit(10));
                const querySnapshot = await getDocs(q);
                
                participants = [];
                querySnapshot.forEach((doc) => {
                    const data = doc.data();
                    participants.push({
                        uid: doc.id,
                        ...data
                    });
                });
                
                // Update RTDB cache for next time (non-blocking)
                updateLeaderboardCache(participants).catch(err => {
                    console.warn('Failed to update RTDB cache:', err);
                });
            } catch (firestoreError) {
                console.error('Error loading leaderboard from Firestore:', firestoreError);
                return;
            }
        } else {
            console.error('Error loading leaderboard:', error);
            return;
        }
    }
    
    // Display top 3
    const topThreeContainer = document.getElementById('top-three-container');
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
    
    // Display rest of leaderboard
    const leaderboardList = document.getElementById('leaderboard-list');
    leaderboardList.innerHTML = '';
    
    participants.slice(3).forEach((participant, index) => {
        const rank = index + 4;
        const item = createLeaderboardItem(participant, rank);
        leaderboardList.appendChild(item);
    });
    
    // Display current user footer
    await loadCurrentUserFooter(participants);
}

// Update leaderboard cache in RTDB (called after score changes)
async function updateLeaderboardCache(participants) {
    try {
        const leaderboardRef = ref(rtdb, 'leaderboard/top10');
        const cacheData = {};
        
        // Store top 10 in indexed format
        participants.slice(0, 10).forEach((participant, index) => {
            cacheData[index] = {
                uid: participant.uid,
                name: participant.fullName || participant.displayName || participant.name || 'User',
                score: participant.score || 0,
                rank: participant.rank || 'Rookie',
                photo: participant.photo || participant.photoURL || null,
                email: participant.email || null,
                district: participant.district || null
            };
        });
        
        // Fill remaining slots with null if less than 10
        for (let i = participants.length; i < 10; i++) {
            cacheData[i] = null;
        }
        
        await set(leaderboardRef, cacheData);
        console.log('Updated leaderboard cache in RTDB');
    } catch (error) {
        console.warn('Failed to update leaderboard cache:', error);
        // Non-critical, don't throw
    }
}

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
        }
        
        const initials = (userData.fullName || userData.displayName || 'U').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
        const photoURL = userData.photoURL || (currentUser && currentUser.photoURL) || null;
        const footer = document.getElementById('current-user-footer');
        if (!footer) return;
        
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
                            `<img src="${photoURL}" alt="${userData.fullName || userData.displayName || 'User'}" class="w-full h-full object-cover rounded-full" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
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
                            <div class="h-full bg-gradient-to-r from-primary to-blue-500 rounded-full shadow-[0_0_10px_rgba(13,185,242,0.5)]" style="width: ${Math.min(100, ((userData.score || 0) / 200) * 100)}%"></div>
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
        console.error('Error loading current user footer:', error);
        // Don't show alert - this is a non-critical feature
    }
}

// Load connection history
async function loadHistory() {
    if (!currentUser) return;
    
    try {
        const userRef = doc(db, 'users', currentUser.uid);
        const userSnap = await getDoc(userRef);
        
        if (!userSnap.exists()) {
            return;
        }
        
        const userData = userSnap.data();
        const scanHistory = userData.scanHistory || [];
        
        // Sort by timestamp (newest first)
        const connections = [...scanHistory].sort((a, b) => {
            const timeA = a.scannedAt ? (typeof a.scannedAt === 'string' ? new Date(a.scannedAt).getTime() : a.scannedAt.toMillis()) : 0;
            const timeB = b.scannedAt ? (typeof b.scannedAt === 'string' ? new Date(b.scannedAt).getTime() : b.scannedAt.toMillis()) : 0;
            return timeB - timeA;
        });
    
    const historyList = document.getElementById('history-list');
    historyList.innerHTML = '';
    
    if (connections.length === 0) {
        historyList.innerHTML = `
            <div class="text-center py-12">
                <span class="material-symbols-outlined text-6xl text-white/40 mb-4">qr_code_scanner</span>
                <p class="text-white/70 text-base">No connections yet.</p>
                <p class="text-white/70 text-base mt-1">Start scanning to build your network!</p>
            </div>
        `;
        return;
    }
    
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
                : new Date(scannedAt.toMillis()).toLocaleDateString('en-US', { 
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
    } catch (error) {
        console.error('Error loading history:', error);
        const historyList = document.getElementById('history-list');
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
                console.log('Web Share API failed, falling back to download:', shareError);
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
                console.log('iOS direct open failed, using download:', iosError);
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
        console.error('Error saving contact:', error);
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

