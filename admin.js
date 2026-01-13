// Firebase configuration (same as app.js)
const firebaseConfig = {
    apiKey: "AIzaSyB2lMtOpxbSGd9dulS5IGUdWN6_hSzoe9w",
    authDomain: "rsapassport.firebaseapp.com",
    projectId: "rsapassport",
    storageBucket: "rsapassport.firebasestorage.app",
    messagingSenderId: "346221600974",
    appId: "1:346221600974:web:b35722e12a85947109f09f",
    databaseURL: "https://rsapassport-default-rtdb.asia-southeast1.firebasedatabase.app"
};

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
    getDocs,
    deleteDoc,
    serverTimestamp,
    addDoc
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import { 
    getDatabase, 
    ref, 
    get,
    set,
    update,
    remove
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js';
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

let currentUser = null;
let isCheckingAuth = false;
let lastCheckedUid = null;
let currentTab = 'add';

// Generic Alert Modal Functions
function showAlert(title, message, type = 'info') {
    const modal = document.getElementById('alert-modal');
    const modalContent = document.getElementById('alert-modal-content');
    const iconContainer = document.getElementById('alert-icon-container');
    const icon = document.getElementById('alert-icon');
    const titleEl = document.getElementById('alert-title');
    const messageEl = document.getElementById('alert-message');
    const okBtn = document.getElementById('alert-ok-btn');
    
    if (!modal || !modalContent) return;
    
    // Set icon and colors based on type
    const configs = {
        success: {
            icon: 'check_circle',
            iconColor: 'text-green-400',
            bgColor: 'bg-green-500/20',
            borderColor: 'border-green-500/30',
            btnColor: 'bg-green-500/20 hover:bg-green-500/30 text-green-400 border border-green-500/30'
        },
        error: {
            icon: 'error',
            iconColor: 'text-red-400',
            bgColor: 'bg-red-500/20',
            borderColor: 'border-red-500/30',
            btnColor: 'bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30'
        },
        warning: {
            icon: 'warning',
            iconColor: 'text-yellow-400',
            bgColor: 'bg-yellow-500/20',
            borderColor: 'border-yellow-500/30',
            btnColor: 'bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 border border-yellow-500/30'
        },
        info: {
            icon: 'info',
            iconColor: 'text-primary',
            bgColor: 'bg-primary/20',
            borderColor: 'border-primary/30',
            btnColor: 'bg-primary/20 hover:bg-primary/30 text-primary border border-primary/30'
        }
    };
    
    const config = configs[type] || configs.info;
    
    // Set content
    icon.textContent = config.icon;
    icon.className = `material-symbols-outlined ${config.iconColor} text-4xl`;
    iconContainer.className = `w-16 h-16 rounded-full flex items-center justify-center border-2 ${config.bgColor} ${config.borderColor}`;
    titleEl.textContent = title;
    messageEl.textContent = message;
    okBtn.className = `w-full px-4 py-3 rounded-xl font-semibold transition-colors active:scale-95 mt-2 ${config.btnColor}`;
    
    // Show modal
    modal.classList.remove('hidden');
    modalContent.classList.remove('scale-100', 'opacity-100', 'scale-95', 'opacity-0');
    
    setTimeout(() => {
        modalContent.classList.add('scale-100', 'opacity-100');
    }, 10);
}

function hideAlert() {
    const modal = document.getElementById('alert-modal');
    const modalContent = document.getElementById('alert-modal-content');
    if (!modal) return;
    
    if (modalContent) {
        modalContent.classList.add('scale-95', 'opacity-0');
        modalContent.classList.remove('scale-100', 'opacity-100');
    }
    
    setTimeout(() => {
        modal.classList.add('hidden');
    }, 200);
}

// Confirmation Modal Functions
let confirmCallback = null;

function showConfirm(message, callback) {
    const modal = document.getElementById('confirm-modal');
    const modalContent = document.getElementById('confirm-modal-content');
    const messageEl = document.getElementById('confirm-message');
    
    if (!modal || !modalContent) {
        // Fallback to browser confirm if modal not available
        if (callback) {
            callback(confirm(message));
        }
        return;
    }
    
    confirmCallback = callback;
    messageEl.textContent = message;
    
    modal.classList.remove('hidden');
    modalContent.classList.remove('scale-100', 'opacity-100', 'scale-95', 'opacity-0');
    
    setTimeout(() => {
        modalContent.classList.add('scale-100', 'opacity-100');
    }, 10);
}

function hideConfirm() {
    const modal = document.getElementById('confirm-modal');
    const modalContent = document.getElementById('confirm-modal-content');
    if (!modal) return;
    
    if (modalContent) {
        modalContent.classList.add('scale-95', 'opacity-0');
        modalContent.classList.remove('scale-100', 'opacity-100');
    }
    
    setTimeout(() => {
        modal.classList.add('hidden');
        confirmCallback = null;
    }, 200);
}

function handleConfirm(result) {
    if (confirmCallback) {
        confirmCallback(result);
    }
    hideConfirm();
}

// Initialize alert modal event listeners
document.addEventListener('DOMContentLoaded', () => {
    const alertOkBtn = document.getElementById('alert-ok-btn');
    const alertModal = document.getElementById('alert-modal');
    
    if (alertOkBtn) {
        alertOkBtn.addEventListener('click', hideAlert);
    }
    
    if (alertModal) {
        alertModal.addEventListener('click', (e) => {
            if (e.target === alertModal) {
                hideAlert();
            }
        });
        
        // Close on ESC key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !alertModal.classList.contains('hidden')) {
                hideAlert();
            }
        });
    }
    
    // Initialize confirmation modal event listeners
    const confirmOkBtn = document.getElementById('confirm-ok-btn');
    const confirmCancelBtn = document.getElementById('confirm-cancel-btn');
    const confirmModal = document.getElementById('confirm-modal');
    
    if (confirmOkBtn) {
        confirmOkBtn.addEventListener('click', () => handleConfirm(true));
    }
    
    if (confirmCancelBtn) {
        confirmCancelBtn.addEventListener('click', () => handleConfirm(false));
    }
    
    if (confirmModal) {
        confirmModal.addEventListener('click', (e) => {
            if (e.target === confirmModal) {
                handleConfirm(false);
            }
        });
        
        // Close on ESC key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !confirmModal.classList.contains('hidden')) {
                handleConfirm(false);
            }
        });
    }
});

// Generate cryptographically secure random 32-char hex token
function generateQRToken() {
    const array = new Uint8Array(16); // 16 bytes = 32 hex chars
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

// Verify QRCode library is ready
function verifyQRCodeLibrary() {
    const qrcodeLib = window.qrcodeGenerator || (typeof qrcode !== 'undefined' ? qrcode : null);
    return qrcodeLib && typeof qrcodeLib === 'function';
}

// Check library on page load and update UI
if (typeof window !== 'undefined') {
    window.addEventListener('load', () => {
        setTimeout(() => {
            const isReady = verifyQRCodeLibrary();
            const btn = document.getElementById('add-participant-btn');
            const btnText = document.getElementById('btn-text');
            const statusText = document.getElementById('library-status');
            
            if (isReady) {
                if (btn) {
                    btn.disabled = false;
                    if (btnText) btnText.textContent = 'Add Participant';
                }
                if (statusText) {
                    statusText.textContent = '✓ QR Code library ready';
                    statusText.className = 'text-xs text-green-400 mt-2';
                }
            } else {
                if (btn) {
                    btn.disabled = true;
                    if (btnText) btnText.textContent = 'Loading QR Code Library...';
                }
                if (statusText) {
                    statusText.textContent = '⏳ Waiting for QR Code library to load...';
                    statusText.className = 'text-xs text-yellow-400 mt-2';
                }
                // Retry check
                setTimeout(() => {
                    const retryReady = verifyQRCodeLibrary();
                    if (retryReady && btn && btnText && statusText) {
                        btn.disabled = false;
                        btnText.textContent = 'Add Participant';
                        statusText.textContent = '✓ QR Code library ready';
                        statusText.className = 'text-xs text-green-400 mt-2';
                    }
                }, 1000);
            }
        }, 300);
    });
}

// Tab Navigation
function switchTab(tabName) {
    currentTab = tabName;
    
    // Update tab buttons
    document.querySelectorAll('.tab-button').forEach(btn => {
        btn.classList.remove('active');
    });
    document.getElementById(`tab-${tabName}`).classList.add('active');
    
    // Update tab content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById(`tab-content-${tabName}`).classList.add('active');
    
    // Load data for the tab
    if (tabName === 'manage') {
        loadParticipants();
    } else if (tabName === 'leaderboard') {
        loadLeaderboard();
    } else if (tabName === 'ranks') {
        loadRanks();
    }
}

// Initialize tab navigation
document.getElementById('tab-add').addEventListener('click', () => switchTab('add'));
document.getElementById('tab-manage').addEventListener('click', () => switchTab('manage'));
document.getElementById('tab-ranks').addEventListener('click', () => switchTab('ranks'));
document.getElementById('tab-leaderboard').addEventListener('click', () => switchTab('leaderboard'));

// Show/hide UI elements
function showLoading() {
    const loadingScreen = document.getElementById('loading-screen');
    const mainContent = document.getElementById('main-content');
    const loginPrompt = document.getElementById('login-prompt');
    
    if (loadingScreen) loadingScreen.classList.remove('hidden');
    if (mainContent) mainContent.classList.add('hidden');
    if (loginPrompt) loginPrompt.classList.add('hidden');
}

function showMainContent() {
    const loadingScreen = document.getElementById('loading-screen');
    const mainContent = document.getElementById('main-content');
    const loginPrompt = document.getElementById('login-prompt');
    
    if (loadingScreen) loadingScreen.classList.add('hidden');
    if (mainContent) mainContent.classList.remove('hidden');
    if (loginPrompt) loginPrompt.classList.add('hidden');
}

function showLoginPrompt() {
    const loadingScreen = document.getElementById('loading-screen');
    const mainContent = document.getElementById('main-content');
    const loginPrompt = document.getElementById('login-prompt');
    
    if (loadingScreen) loadingScreen.classList.add('hidden');
    if (mainContent) mainContent.classList.add('hidden');
    if (loginPrompt) loginPrompt.classList.remove('hidden');
}

// Initialize: Start with loading screen
showLoading();

// Check if user is admin
onAuthStateChanged(auth, async (user) => {
    // Prevent checking the same user multiple times
    if (isCheckingAuth) return;
    if (user && user.uid === lastCheckedUid) return;
    
    isCheckingAuth = true;
    showLoading();
    
    // Wait a bit for auth state to stabilize
    await new Promise(resolve => setTimeout(resolve, 200));
    
    if (user) {
        currentUser = user;
        lastCheckedUid = user.uid;
        
        try {
            // Check if user is admin via Firestore (secure method)
            const isAdmin = await checkIfAdmin(user.uid);
            if (isAdmin) {
                showMainContent();
                // Load data based on current tab
                if (currentTab === 'ranks') {
                    loadRanks();
                } else if (currentTab === 'manage') {
                    loadParticipants();
                } else if (currentTab === 'leaderboard') {
                    loadLeaderboard();
                }
            } else {
                showLoginPrompt();
            }
        } catch (error) {
            // On error, show login prompt instead of redirecting
            showLoginPrompt();
        }
    } else {
        // Not signed in
        lastCheckedUid = null;
        showLoginPrompt();
    }
    
    isCheckingAuth = false;
});

// Google Sign-In for admin page
const adminSignInBtn = document.getElementById('admin-signin-btn');
if (adminSignInBtn) {
    adminSignInBtn.addEventListener('click', async () => {
        try {
            showLoading();
            lastCheckedUid = null; // Reset to allow re-check after sign in
            await signInWithPopup(auth, googleProvider);
            // onAuthStateChanged will handle the rest
        } catch (error) {
            showAlert('Sign In Failed', 'Failed to sign in. Please try again.', 'error');
            showLoginPrompt();
        }
    });
}

async function checkIfAdmin(uid) {
    try {
        const adminRef = doc(db, 'admins', uid);
        const adminSnap = await getDoc(adminRef);
        return adminSnap.exists();
    } catch (error) {
        return false;
    }
}

// Helper function to normalize email for cache lookup
function normalizeEmail(email) {
    if (!email) return null;
    return email.toLowerCase().trim();
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

// Decode email from RTDB path
function decodeEmailFromPath(encoded) {
    if (!encoded) return null;
    try {
        const base64 = encoded.replace(/_/g, '/').replace(/-/g, '+');
        return atob(base64);
    } catch (e) {
        return null;
    }
}

// Check if email exists in RTDB indexes (RTDB-only, no Firestore fallback)
async function checkEmailInCache(email) {
    try {
        const normalizedEmail = normalizeEmail(email);
        if (!normalizedEmail) return { exists: false, type: null };
        
        const encodedEmail = encodeEmailForPath(normalizedEmail);
        const emailRef = ref(rtdb, `indexes/emails/${encodedEmail}`);
        const emailSnap = await get(emailRef);
        
        if (emailSnap.exists()) {
            const data = emailSnap.val();
            return { exists: true, type: data.type || null };
        }
        return { exists: false, type: null };
    } catch (error) {
        // Return false on error - trust RTDB index
        return { exists: false, type: null };
    }
}

// Check if participantId exists in RTDB indexes (RTDB-only, no Firestore fallback)
async function checkParticipantIdInCache(participantId) {
    try {
        if (!participantId) return { exists: false, type: null };
        const normalizedId = participantId.trim();
        if (!normalizedId) return { exists: false, type: null };
        
        const participantIdRef = ref(rtdb, `indexes/participantIds/${normalizedId}`);
        const participantIdSnap = await get(participantIdRef);
        
        if (participantIdSnap.exists()) {
            const data = participantIdSnap.val();
            return { exists: true, type: data.type || null };
        }
        return { exists: false, type: null };
    } catch (error) {
        // Return false on error - trust RTDB index
        return { exists: false, type: null };
    }
}

// Generate QR Code as Base64 using qrcode-generator library
function generateQRCodeBase64(qrToken) {
    return new Promise((resolve, reject) => {
        try {
            // Wait for library to load
            const tryGenerate = (attempts = 0) => {
                const qrcodeLib = window.qrcodeGenerator || (typeof qrcode !== 'undefined' ? qrcode : null);
                
                if (qrcodeLib && typeof qrcodeLib === 'function') {
                    try {
                        // Create QR code using qrcode-generator
                        const typeNumber = 0; // Auto-detect type
                        const errorCorrectionLevel = 'M'; // Medium error correction
                        const qr = qrcodeLib(typeNumber, errorCorrectionLevel);
                        qr.addData(qrToken);
                        qr.make();
                        
                        // Create canvas to convert to base64
                        const canvas = document.createElement('canvas');
                        const moduleCount = qr.getModuleCount();
                        const cellSize = 8; // Size of each QR code cell
                        const margin = 4;
                        const size = moduleCount * cellSize + margin * 2;
                        
                        canvas.width = size;
                        canvas.height = size;
                        
                        const ctx = canvas.getContext('2d');
                        
                        // Fill white background
                        ctx.fillStyle = '#FFFFFF';
                        ctx.fillRect(0, 0, size, size);
                        
                        // Draw QR code modules
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
                        
                        // Convert canvas to base64
                        const base64 = canvas.toDataURL('image/png');
                        resolve(base64);
                    } catch (err) {
                        reject(new Error('Error generating QR code: ' + err.message));
                    }
                } else if (attempts < 50) {
                    // Retry for up to 5 seconds (50 * 100ms)
                    setTimeout(() => tryGenerate(attempts + 1), 100);
                } else {
                    reject(new Error('QRCode library failed to load after 5 seconds. The library script may have failed to load. Please check your internet connection and refresh the page.'));
                }
            };
            
            tryGenerate(0);
        } catch (error) {
            reject(error);
        }
    });
}

// Add Participant (Enhanced Fields)
document.getElementById('add-participant-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const submitButton = document.getElementById('add-participant-btn');
    const btnText = document.getElementById('btn-text');
    const originalButtonText = btnText ? btnText.textContent : submitButton.textContent;
    
    const participantId = document.getElementById('participant-id').value.trim();
    const fullName = document.getElementById('participant-fullname').value.trim();
    const district = document.getElementById('participant-district').value.trim();
    const email = document.getElementById('participant-email').value.trim().toLowerCase();
    const phone = document.getElementById('participant-phone').value.trim();
    const profession = document.getElementById('participant-profession').value.trim();
    
    if (!participantId || !fullName || !district || !email || !phone || !profession) {
        showAlert('Validation Error', 'Please fill in all fields', 'warning');
        return;
    }
    
    try {
        // Disable button and show loading
        submitButton.disabled = true;
        if (btnText) {
            btnText.textContent = 'Adding...';
        } else {
            submitButton.textContent = 'Adding...';
        }
        
        // Check duplicates using RTDB indexes (RTDB-only, no Firestore fallback)
        const normalizedEmail = email.toLowerCase().trim();
        const emailCheck = await checkEmailInCache(normalizedEmail);
        const participantIdCheck = await checkParticipantIdInCache(participantId);
        
        // Show errors if duplicates found
        if (emailCheck.exists) {
            const typeText = emailCheck.type === 'pending' ? 'pending' : 'active';
            showAlert('Duplicate Email', `This email is already registered to a ${typeText} user.`, 'warning');
            submitButton.disabled = false;
            if (btnText) btnText.textContent = originalButtonText;
            return;
        }
        
        if (participantIdCheck.exists) {
            const typeText = participantIdCheck.type === 'pending' ? 'pending' : 'active';
            showAlert('Duplicate Participant ID', `This Participant ID is already registered to a ${typeText} user.`, 'warning');
            submitButton.disabled = false;
            if (btnText) btnText.textContent = originalButtonText;
            return;
        }
        
        // Verify library is ready before generating
        if (!verifyQRCodeLibrary()) {
            showAlert('Library Loading', 'QR Code library is still loading. Please wait a moment and try again.', 'warning');
            submitButton.disabled = false;
            if (btnText) btnText.textContent = originalButtonText;
            return;
        }
        
        // Generate random 32-char QR token
        const qrToken = generateQRToken();
        
        // Generate QR code with the token
        if (btnText) {
            btnText.textContent = 'Generating QR Code...';
        } else {
            submitButton.textContent = 'Generating QR Code...';
        }
        const qrCodeBase64 = await generateQRCodeBase64(qrToken);
        
        // Encode email for RTDB path
        const encodedEmail = encodeEmailForPath(normalizedEmail);
        
        // Write to RTDB pendingUsers and update indexes
        const pendingUserRef = ref(rtdb, `pendingUsers/${encodedEmail}`);
        await set(pendingUserRef, {
            participantId: participantId,
            fullName: fullName,
            district: district,
            email: normalizedEmail,
            phone: phone,
            profession: profession,
            qrToken: qrToken,
            qrCodeBase64: qrCodeBase64,
            createdAt: Date.now(),
            status: 'pending'
        });
        
        // Update indexes (use encoded email in path)
        await update(ref(rtdb), {
            [`indexes/emails/${encodedEmail}`]: {
                uid: encodedEmail,
                email: normalizedEmail,
                type: 'pending',
                lastUpdated: Date.now()
            },
            [`indexes/participantIds/${participantId}`]: {
                uid: encodedEmail,
                email: normalizedEmail,
                type: 'pending',
                lastUpdated: Date.now()
            },
            [`indexes/qrTokens/${qrToken}`]: {
                uid: encodedEmail,
                email: normalizedEmail,
                lastUpdated: Date.now()
            }
        });
        
        // Update QR code cache
        await set(ref(rtdb, `qrcodes/${qrToken}`), {
            uid: normalizedEmail,
            name: fullName,
            photo: null,
            email: normalizedEmail,
            district: district,
            phone: phone,
            profession: profession
        });
        
        // Step 4: Wait for RTDB trigger (onPendingUserCreated) to complete
        // This ensures admin cache is updated before showing success
        // RTDB triggers (onPendingUserCreated) will automatically update admin cache
        await new Promise(resolve => setTimeout(resolve, 800));
        
        // Optional: Verify admin cache was updated
        try {
            const adminCacheRef = ref(rtdb, 'adminCache/participants');
            const adminCacheSnap = await get(adminCacheRef);
            if (adminCacheSnap.exists()) {
                const cache = adminCacheSnap.val();
                const pendingUsers = cache.pending || [];
                const userInCache = pendingUsers.find(p => p.id === encodedEmail);
                if (!userInCache) {
                    // Cache might not be updated yet, wait a bit more
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
        } catch (cacheCheckError) {
            // Non-critical - cache check failed, but continue
        }
        
        showAlert('Success', 'Participant added successfully!', 'success');
        
        // Reset form
        document.getElementById('add-participant-form').reset();
        
        // Reload participants list if on manage tab
        // Additional wait to ensure cache is fully updated
        if (currentTab === 'manage') {
            await loadParticipants(true);
        }
        
        // Re-enable button
        submitButton.disabled = false;
        if (btnText) {
            btnText.textContent = originalButtonText;
        } else {
            submitButton.textContent = originalButtonText;
        }
        
    } catch (error) {
        
        // Re-enable button
        submitButton.disabled = false;
        if (btnText) {
            btnText.textContent = originalButtonText;
        } else {
            submitButton.textContent = originalButtonText;
        }
        
        let errorMessage = 'Error adding participant: ' + error.message;
        if (error.message.includes('QRCode')) {
            errorMessage = 'QR Code library is still loading. Please wait a moment and try again, or refresh the page.';
        }
        showAlert('Error', errorMessage, 'error');
    }
});

// CSV Template Download
document.getElementById('download-template-btn').addEventListener('click', () => {
    const csvContent = 'ParticipantID,FullName,District,Email,Phone,Profession\nP001,John Doe,North District,john@example.com,+1234567890,Engineer';
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', 'participants_template.csv');
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
});

// CSV File Upload
document.getElementById('csv-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    const uploadBtn = document.getElementById('upload-csv-btn');
    if (file) {
        uploadBtn.disabled = false;
    } else {
        uploadBtn.disabled = true;
    }
});

// Parse CSV File (simple CSV parser - handles basic cases)
function parseCSVFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const text = e.target.result;
                const lines = text.split('\n').filter(line => line.trim());
                
                if (lines.length < 2) {
                    reject(new Error('CSV file must have at least a header row and one data row'));
                    return;
                }
                
                // Parse headers
                const headers = lines[0].split(',').map(h => h.trim());
                
                // Validate headers
                const expectedHeaders = ['ParticipantID', 'FullName', 'District', 'Email', 'Phone', 'Profession'];
                const headersMatch = expectedHeaders.every(h => headers.includes(h));
                
                if (!headersMatch) {
                    reject(new Error('CSV headers do not match expected format. Please use the template. Expected: ' + expectedHeaders.join(', ')));
                    return;
                }
                
                const participants = [];
                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue; // Skip empty lines
                    
                    // Simple CSV parsing (split by comma, trim each value)
                    // Note: This won't handle commas within quoted fields, but works for most cases
                    const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
                    
                    if (values.length === headers.length) {
                        const participant = {};
                        headers.forEach((header, index) => {
                            participant[header] = values[index] || '';
                        });
                        
                        // Only add if at least one field has a value
                        if (Object.values(participant).some(v => v)) {
                            participants.push(participant);
                        }
                    }
                    // Skip rows with incorrect column count
                }
                
                if (participants.length === 0) {
                    reject(new Error('No valid participants found in CSV file'));
                    return;
                }
                
                resolve(participants);
            } catch (error) {
                reject(new Error('Error parsing CSV: ' + error.message));
            }
        };
        reader.onerror = () => reject(new Error('Error reading file'));
        reader.readAsText(file);
    });
}

// Validate CSV Row
function validateCSVRow(row, index) {
    const errors = [];
    
    if (!row.ParticipantID || !row.ParticipantID.trim()) {
        errors.push(`Row ${index + 2}: ParticipantID is required`);
    }
    
    if (!row.FullName || !row.FullName.trim()) {
        errors.push(`Row ${index + 2}: FullName is required`);
    }
    
    if (!row.District || !row.District.trim()) {
        errors.push(`Row ${index + 2}: District is required`);
    }
    
    if (!row.Email || !row.Email.trim()) {
        errors.push(`Row ${index + 2}: Email is required`);
    } else {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(row.Email.trim())) {
            errors.push(`Row ${index + 2}: Invalid email format`);
        }
    }
    
    if (!row.Phone || !row.Phone.trim()) {
        errors.push(`Row ${index + 2}: Phone is required`);
    }
    
    if (!row.Profession || !row.Profession.trim()) {
        errors.push(`Row ${index + 2}: Profession is required`);
    }
    
    return errors;
}

// Check Existing Participants
async function checkExistingParticipants(participants) {
    const errors = [];
    const emails = participants.map(p => p.Email.trim().toLowerCase());
    const participantIds = participants.map(p => p.ParticipantID.trim());
    
    // Check for duplicates in CSV
    const emailDuplicates = emails.filter((email, index) => emails.indexOf(email) !== index);
    const idDuplicates = participantIds.filter((id, index) => participantIds.indexOf(id) !== index);
    
    if (emailDuplicates.length > 0) {
        errors.push(`Duplicate emails in CSV: ${emailDuplicates.join(', ')}`);
    }
    
    if (idDuplicates.length > 0) {
        errors.push(`Duplicate Participant IDs in CSV: ${idDuplicates.join(', ')}`);
    }
    
    // Check against database using RTDB indexes (RTDB-only, no Firestore fallback)
    // Batch read all emails from RTDB indexes in parallel
    const emailChecks = await Promise.all(
        emails.map(email => checkEmailInCache(email))
    );
    
    // Batch read all participantIds from RTDB indexes in parallel
    const participantIdChecks = await Promise.all(
        participantIds.map(id => checkParticipantIdInCache(id))
    );
    
    // Check results - trust RTDB indexes completely
    for (let i = 0; i < emails.length; i++) {
        const email = emails[i];
        const emailCheck = emailChecks[i];
        
        if (emailCheck.exists) {
            const typeText = emailCheck.type === 'pending' ? 'pendingUsers' : 'users';
            errors.push(`Email ${email} already exists in ${typeText}`);
        }
    }
    
    for (let i = 0; i < participantIds.length; i++) {
        const participantId = participantIds[i];
        const participantIdCheck = participantIdChecks[i];
        
        if (participantIdCheck.exists) {
            const typeText = participantIdCheck.type === 'pending' ? 'pendingUsers' : 'users';
            errors.push(`Participant ID ${participantId} already exists in ${typeText}`);
        }
    }
    
    return errors;
}

// Bulk Import Participants
async function bulkImportParticipants(participants) {
    const results = {
        success: [],
        errors: []
    };
    
    const progressDiv = document.getElementById('csv-upload-progress');
    const progressBar = document.getElementById('csv-progress-bar');
    const progressText = document.getElementById('csv-progress-text');
    const resultsDiv = document.getElementById('csv-upload-results');
    const resultsText = document.getElementById('csv-results-text');
    
    progressDiv.classList.remove('hidden');
    resultsDiv.classList.add('hidden');
    
    const total = participants.length;
    
    // Process participants sequentially (one at a time) to ensure each completes fully
    // This matches the individual add flow and ensures RTDB triggers complete
    for (let i = 0; i < participants.length; i++) {
        const participant = participants[i];
        const progress = ((i + 1) / total) * 100;
        
        progressBar.style.width = progress + '%';
        progressText.textContent = `${i + 1} of ${total}`;
        
        try {
            // Step 1: Validate row
            const rowErrors = validateCSVRow(participant, i);
            if (rowErrors.length > 0) {
                results.errors.push({
                    row: i + 2,
                    participant: participant,
                    errors: rowErrors
                });
                continue; // Skip to next participant
            }
            
            // Step 2: Validate and normalize data
            const email = participant.Email.trim().toLowerCase();
            const normalizedEmail = normalizeEmail(email);
            const encodedEmail = encodeEmailForPath(normalizedEmail);
            const participantId = participant.ParticipantID.trim();
            const fullName = participant.FullName.trim();
            const district = participant.District.trim();
            const phone = participant.Phone.trim();
            const profession = participant.Profession.trim();
            
            // Validate all fields are present after trimming
            if (!participantId || !fullName || !district || !normalizedEmail || !phone || !profession) {
                throw new Error('One or more required fields are empty after trimming');
            }
            
            // Step 3: Generate QR token and code
            const qrToken = generateQRToken();
            if (!qrToken || qrToken.length !== 32) {
                throw new Error('Failed to generate valid QR token');
            }
            
            const qrCodeBase64 = await generateQRCodeBase64(qrToken);
            if (!qrCodeBase64) {
                throw new Error('Failed to generate QR code');
            }
            
            // Step 4: Create pending user in RTDB
            // This triggers onPendingUserCreated which updates admin cache
            const pendingUserRef = ref(rtdb, `pendingUsers/${encodedEmail}`);
            await set(pendingUserRef, {
                participantId: participantId,
                fullName: fullName,
                district: district,
                email: normalizedEmail,
                phone: phone,
                profession: profession,
                qrToken: qrToken,
                qrCodeBase64: qrCodeBase64,
                createdAt: Date.now(),
                status: 'pending'
            });
            
            // Step 5: Update indexes (use encoded email in path)
            await update(ref(rtdb), {
                [`indexes/emails/${encodedEmail}`]: {
                    uid: encodedEmail,
                    email: normalizedEmail,
                    type: 'pending',
                    lastUpdated: Date.now()
                },
                [`indexes/participantIds/${participantId}`]: {
                    uid: encodedEmail,
                    email: normalizedEmail,
                    type: 'pending',
                    lastUpdated: Date.now()
                },
                [`indexes/qrTokens/${qrToken}`]: {
                    uid: encodedEmail,
                    email: normalizedEmail,
                    lastUpdated: Date.now()
                }
            });
            
            // Step 6: Update QR code cache - ensure all fields are explicitly set (null, not undefined)
            await set(ref(rtdb, `qrcodes/${qrToken}`), {
                uid: normalizedEmail,
                name: fullName,
                photo: null, // Explicitly null for pending users (no photo until login)
                email: normalizedEmail,
                district: district,
                phone: phone,
                profession: profession
            });
            
            // Step 7: Verify QR code was created successfully
            const qrCodeVerifyRef = ref(rtdb, `qrcodes/${qrToken}`);
            const qrCodeVerifySnap = await get(qrCodeVerifyRef);
            if (!qrCodeVerifySnap.exists()) {
                throw new Error('QR code cache verification failed');
            }
            
            // Step 8: Wait for RTDB trigger (onPendingUserCreated) to complete
            // This ensures admin cache is updated before moving to next participant
            // Wait a bit for the trigger to process (triggers are async but usually fast)
            await new Promise(resolve => setTimeout(resolve, 800));
            
            // Step 9: Verify admin cache was updated (optional verification)
            // Check if participant appears in admin cache
            try {
                const adminCacheRef = ref(rtdb, 'adminCache/participants');
                const adminCacheSnap = await get(adminCacheRef);
                if (adminCacheSnap.exists()) {
                    const cache = adminCacheSnap.val();
                    const pendingUsers = cache.pending || [];
                    const userInCache = pendingUsers.find(p => p.id === encodedEmail);
                    if (!userInCache) {
                        // Cache might not be updated yet, wait a bit more
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }
            } catch (cacheCheckError) {
                // Non-critical - cache check failed, but continue
                // RTDB trigger will eventually update it
            }
            
            // Step 10: Mark as successful
            results.success.push({
                row: i + 2,
                participant: participant
            });
            
        } catch (error) {
            // Provide more detailed error messages
            let errorMessage = error.message;
            if (error.code) {
                errorMessage += ` (Code: ${error.code})`;
            }
            if (error.stack && error.message.includes('RTDB')) {
                errorMessage += ' - Database operation failed';
            }
            
            results.errors.push({
                row: i + 2,
                participant: participant,
                errors: [errorMessage]
            });
        }
    }
    
    // RTDB triggers (onPendingUserCreated) will automatically update admin cache
    // No need for client-side cache updates - triggers handle this
    
    // Show results
    progressDiv.classList.add('hidden');
    resultsDiv.classList.remove('hidden');
    
    let resultsMessage = `Import complete!\n\n`;
    resultsMessage += `Successfully imported: ${results.success.length}\n`;
    resultsMessage += `Errors: ${results.errors.length}\n\n`;
    
    if (results.errors.length > 0) {
        resultsMessage += `Errors:\n`;
        results.errors.forEach(err => {
            resultsMessage += `Row ${err.row}: ${err.errors.join(', ')}\n`;
        });
    }
    
    resultsText.textContent = resultsMessage;
    
    // Reload participants if on manage tab
    // Wait a bit for RTDB triggers to process before refreshing
    if (currentTab === 'manage') {
        // Wait for RTDB triggers to process (they run asynchronously)
        await new Promise(resolve => setTimeout(resolve, 1500));
        await loadParticipants(true);
    }
    
    return results;
}

// CSV Upload Handler
document.getElementById('upload-csv-btn').addEventListener('click', async () => {
    const fileInput = document.getElementById('csv-file-input');
    const file = fileInput.files[0];
    
    if (!file) {
        showAlert('No File Selected', 'Please select a CSV file', 'warning');
        return;
    }
    
    try {
        // Parse CSV
        const participants = await parseCSVFile(file);
        
        if (participants.length === 0) {
            showAlert('No Valid Data', 'No valid participants found in CSV file', 'warning');
            return;
        }
        
        // Validate all rows
        const validationErrors = [];
        participants.forEach((participant, index) => {
            const rowErrors = validateCSVRow(participant, index);
            validationErrors.push(...rowErrors);
        });
        
        if (validationErrors.length > 0) {
            showAlert('Validation Errors', 'Validation errors found:\n\n' + validationErrors.join('\n'), 'error');
            return;
        }
        
        // Check existing participants
        const existingErrors = await checkExistingParticipants(participants);
        
        if (existingErrors.length > 0) {
            showAlert('Duplicate Errors', 'Duplicate check errors:\n\n' + existingErrors.join('\n'), 'error');
            return;
        }
        
        // Confirm import
        showConfirm(`Import ${participants.length} participants?`, (confirmed) => {
            if (!confirmed) return;
            
            // Import
            bulkImportParticipants(participants).catch(error => {
                showAlert('Import Error', 'Error importing participants: ' + error.message, 'error');
            });
        });
        return;
        
        // Import
        await bulkImportParticipants(participants);
        
    } catch (error) {
        showAlert('Upload Error', 'Error uploading CSV: ' + error.message, 'error');
    }
});

// Rank Management Functions (using single document with array)
const RANKS_DOC_PATH = 'appConfig/ranks';

// Validate rank configuration for overlaps and gaps
function validateRankConfiguration(ranks) {
    if (ranks.length === 0) {
        return null; // Empty is valid
    }
    
    // Sort by minScore for validation
    const sortedRanks = [...ranks].sort((a, b) => a.minScore - b.minScore);
    
    // Check that first rank starts at 0
    if (sortedRanks[0].minScore !== 0) {
        return 'First rank must start at score 0';
    }
    
    // Check for overlaps and gaps
    for (let i = 0; i < sortedRanks.length; i++) {
        const current = sortedRanks[i];
        const next = sortedRanks[i + 1];
        
        // Validate current rank
        if (current.maxScore !== null && current.maxScore < current.minScore) {
            return `Rank "${current.rankName}": Max score (${current.maxScore}) must be greater than or equal to min score (${current.minScore})`;
        }
        
        // If there's a next rank, check for gaps and overlaps
        if (next) {
            const currentMax = current.maxScore !== null ? current.maxScore : Infinity;
            const nextMin = next.minScore;
            
            // Check for gap
            if (currentMax < nextMin - 1) {
                return `Gap found between "${current.rankName}" (max: ${current.maxScore}) and "${next.rankName}" (min: ${nextMin})`;
            }
            
            // Check for overlap
            if (currentMax >= nextMin) {
                return `Overlap found between "${current.rankName}" (max: ${current.maxScore}) and "${next.rankName}" (min: ${nextMin})`;
            }
        }
        // If this is the last rank, allow it to have any maxScore (or unlimited)
        // Users can add more ranks later, so we don't require unlimited maxScore
    }
    
    return null; // Valid configuration
}

async function loadRanks() {
    const ranksList = document.getElementById('ranks-list');
    if (!ranksList) return;
    
    ranksList.innerHTML = '<tr><td colspan="5" class="text-center py-8 text-slate-400">Loading ranks...</td></tr>';
    
    try {
        const ranksDocRef = doc(db, RANKS_DOC_PATH);
        const ranksDocSnap = await getDoc(ranksDocRef);
        
        let ranks = [];
        if (ranksDocSnap.exists()) {
            ranks = ranksDocSnap.data().ranks || [];
        }
        
        // Sort by order
        ranks.sort((a, b) => a.order - b.order);
        
        if (ranks.length === 0) {
            ranksList.innerHTML = '<tr><td colspan="5" class="text-center py-8 text-slate-400">No ranks configured. Add your first rank!</td></tr>';
            return;
        }
        
        ranksList.innerHTML = ranks.map((rank, index) => {
            const maxScoreDisplay = rank.maxScore !== null && rank.maxScore !== undefined ? rank.maxScore : '∞';
            return `
            <tr class="border-b border-white/5 hover:bg-white/5 transition-colors">
                <td class="py-3 px-4">${rank.order}</td>
                <td class="py-3 px-4 font-semibold">${rank.rankName}</td>
                <td class="py-3 px-4">${rank.minScore}</td>
                <td class="py-3 px-4">${maxScoreDisplay}</td>
                <td class="py-3 px-4">
                    <button onclick="editRank(${index})" 
                        class="px-3 py-1 bg-primary/20 hover:bg-primary/30 text-primary rounded-lg text-sm transition-colors mr-2">
                        Edit
                    </button>
                    <button onclick="deleteRank(${index})" 
                        class="px-3 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg text-sm transition-colors">
                        Delete
                    </button>
                </td>
            </tr>
        `;
        }).join('');
        
    } catch (error) {
        ranksList.innerHTML = '<tr><td colspan="5" class="text-center py-8 text-red-400">Error loading ranks: ' + error.message + '</td></tr>';
    }
}

// Add Rank
const addRankBtn = document.getElementById('add-rank-btn');
if (addRankBtn) {
    addRankBtn.addEventListener('click', () => {
        document.getElementById('rank-modal-title').textContent = 'Add Rank';
        document.getElementById('rank-form').reset();
        document.getElementById('rank-index').value = '';
        document.getElementById('rank-modal').classList.remove('hidden');
    });
}

// Edit Rank
window.editRank = async function(index) {
    try {
        const ranksDocRef = doc(db, RANKS_DOC_PATH);
        const ranksDocSnap = await getDoc(ranksDocRef);
        
        if (!ranksDocSnap.exists()) {
            showAlert('Not Found', 'Ranks document not found', 'error');
            return;
        }
        
        const ranks = ranksDocSnap.data().ranks || [];
        if (index < 0 || index >= ranks.length) {
            showAlert('Invalid Index', 'Invalid rank index', 'error');
            return;
        }
        
        const rankData = ranks[index];
        document.getElementById('rank-modal-title').textContent = 'Edit Rank';
        document.getElementById('rank-index').value = index;
        document.getElementById('rank-name').value = rankData.rankName;
        document.getElementById('rank-min-score').value = rankData.minScore;
        document.getElementById('rank-max-score').value = rankData.maxScore || '';
        document.getElementById('rank-order').value = rankData.order;
        document.getElementById('rank-modal').classList.remove('hidden');
    } catch (error) {
        showAlert('Error', 'Error loading rank: ' + error.message, 'error');
    }
};

// Delete Rank
window.deleteRank = async function(index) {
    showConfirm('Are you sure you want to delete this rank?', async (confirmed) => {
        if (!confirmed) return;
        
        try {
            const ranksDocRef = doc(db, RANKS_DOC_PATH);
            const ranksDocSnap = await getDoc(ranksDocRef);
            
            if (!ranksDocSnap.exists()) {
                showAlert('Not Found', 'Ranks document not found', 'error');
                return;
            }
            
            const ranks = ranksDocSnap.data().ranks || [];
            if (index < 0 || index >= ranks.length) {
                showAlert('Invalid Index', 'Invalid rank index', 'error');
                return;
            }
            
            // Remove rank at index
            ranks.splice(index, 1);
            
            // Update document
            await setDoc(ranksDocRef, {
                ranks: ranks,
                updatedAt: serverTimestamp()
            }, { merge: true });
            
            showAlert('Success', 'Rank deleted successfully', 'success');
            loadRanks();
        } catch (error) {
            showAlert('Error', 'Error deleting rank: ' + error.message, 'error');
        }
    });
};

// Rank Form Submit
document.getElementById('rank-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const rankIndex = document.getElementById('rank-index').value;
    const rankName = document.getElementById('rank-name').value.trim();
    const minScore = parseInt(document.getElementById('rank-min-score').value);
    const maxScoreInput = document.getElementById('rank-max-score').value.trim();
    const maxScore = maxScoreInput === '' ? null : parseInt(maxScoreInput);
    const order = parseInt(document.getElementById('rank-order').value);
    
    if (!rankName || isNaN(minScore) || isNaN(order)) {
        showAlert('Validation Error', 'Please fill in all required fields', 'warning');
        return;
    }
    
    if (maxScore !== null && maxScore <= minScore) {
        showAlert('Validation Error', 'Max score must be greater than min score', 'warning');
        return;
    }
    
    try {
        const ranksDocRef = doc(db, RANKS_DOC_PATH);
        const ranksDocSnap = await getDoc(ranksDocRef);
        
        let ranks = [];
        if (ranksDocSnap.exists()) {
            ranks = ranksDocSnap.data().ranks || [];
        }
        
        const rankData = {
            rankName: rankName,
            minScore: minScore,
            maxScore: maxScore,
            order: order
        };
        
        if (rankIndex !== '' && !isNaN(parseInt(rankIndex))) {
            // Update existing rank
            const index = parseInt(rankIndex);
            if (index >= 0 && index < ranks.length) {
                ranks[index] = rankData;
            } else {
                showAlert('Invalid Index', 'Invalid rank index', 'error');
                return;
            }
        } else {
            // Add new rank
            ranks.push(rankData);
        }
        
        // Sort by order
        ranks.sort((a, b) => a.order - b.order);
        
        // Validate rank configuration (check for overlaps and gaps)
        const validationError = validateRankConfiguration(ranks);
        if (validationError) {
            showAlert('Validation Error', validationError, 'error');
            return;
        }
        
        // Update document
        const updateData = {
            ranks: ranks,
            updatedAt: serverTimestamp()
        };
        
        if (!ranksDocSnap.exists()) {
            updateData.createdAt = serverTimestamp();
        }
        
        await setDoc(ranksDocRef, updateData, { merge: true });
        
        showAlert('Success', 'Rank saved successfully', 'success');
        document.getElementById('rank-modal').classList.add('hidden');
        loadRanks();
    } catch (error) {
        showAlert('Error', 'Error saving rank: ' + error.message, 'error');
    }
});

// Close Rank Modal
document.getElementById('rank-modal-cancel').addEventListener('click', () => {
    document.getElementById('rank-modal').classList.add('hidden');
});

// Load Participants (Enhanced)
// @param {boolean} forceRefresh - If true, bypass cache and load directly from RTDB
async function loadParticipants(forceRefresh = false) {
    const participantsList = document.getElementById('participants-list');
    if (!participantsList) return;
    
    participantsList.innerHTML = '<tr><td colspan="6" class="text-center py-8 text-slate-400">Loading...</td></tr>';
    
    try {
        let participants = [];
        let useCache = false;
        
        // Try to load from RTDB cache first (unless force refresh)
        if (!forceRefresh) {
            try {
                const participantsRef = ref(rtdb, 'adminCache/participants');
                const participantsSnap = await get(participantsRef);
                
                if (participantsSnap.exists()) {
                    const cacheData = participantsSnap.val();
                    const lastUpdated = cacheData.lastUpdated || 0;
                    const now = Date.now();
                    const staleThreshold = 5 * 60 * 1000; // 5 minutes
                    
                    // Use cache if it's not stale
                    if (now - lastUpdated < staleThreshold && cacheData.pending && cacheData.active) {
                        // Process pending users from cache - ensure identifier is encoded email
                        const pendingUsers = (cacheData.pending || []).map(user => {
                            // For pending users, id should be encoded email
                            // If it's not encoded, encode it
                            let identifier = user.id;
                            if (user.email && !identifier.includes('_')) {
                                // If identifier doesn't look encoded (no underscores), encode it
                                const normalizedEmail = normalizeEmail(user.email);
                                identifier = encodeEmailForPath(normalizedEmail);
                            }
                            return {
                                ...user,
                                identifier: identifier || user.id, // Use encoded email as identifier
                                type: 'pending',
                                rank: user.rank || 'Rookie' // Ensure rank defaults to 'Rookie' for pending users
                            };
                        });
                        
                        // Flatten profile data for active users in cache
                        const activeUsers = (cacheData.active || []).map(user => {
                            const profile = user.profile || {};
                            return {
                                ...user,
                                identifier: user.id, // uid for active users
                                type: 'active',
                                fullName: profile.fullName || user.fullName || null,
                                displayName: profile.displayName || user.displayName || null,
                                district: profile.district || user.district || null,
                                phone: profile.phone || user.phone || null,
                                profession: profile.profession || user.profession || null,
                                photoURL: profile.photoURL || user.photoURL || null
                            };
                        });
                        participants = [
                            ...pendingUsers,
                            ...activeUsers
                        ];
                        useCache = true;
                    }
                }
            } catch (error) {
                // Fallback to RTDB direct read
            }
        }
        
        // If cache is stale, read directly from RTDB (no Firestore fallback)
        if (!useCache) {
            const pendingUsersRef = ref(rtdb, 'pendingUsers');
            const usersRef = ref(rtdb, 'users');
            
            const [pendingSnap, usersSnap] = await Promise.all([
                get(pendingUsersRef),
                get(usersRef)
            ]);
            
            // Add pending users (child.key is encoded email)
            if (pendingSnap.exists()) {
                pendingSnap.forEach((child) => {
                    const data = child.val();
                    participants.push({
                        id: child.key, // encoded email
                        type: 'pending',
                        identifier: child.key, // encoded email (for delete/view operations)
                        email: data.email || decodeEmailFromPath(child.key), // actual email
                        sortDate: data.createdAt || 0,
                        rank: data.rank || 'Rookie', // Default to 'Rookie' for pending users
                        score: data.score || 0,
                        ...data
                    });
                });
            }
            
            // Add active users
            if (usersSnap.exists()) {
                usersSnap.forEach((child) => {
                    const data = child.val();
                    const profile = data.profile || {};
                    participants.push({
                        id: child.key,
                        type: 'active',
                        identifier: child.key, // uid
                        uid: child.key,
                        sortDate: data.firstLoginAt || data.lastLoginAt || 0,
                        // Flatten profile data for compatibility
                        fullName: profile.fullName || data.fullName || null,
                        displayName: profile.displayName || data.displayName || null,
                        district: profile.district || data.district || null,
                        phone: profile.phone || data.phone || null,
                        profession: profile.profession || data.profession || null,
                        photoURL: profile.photoURL || data.photoURL || null,
                        // Keep other fields
                        email: data.email,
                        participantId: data.participantId,
                        score: data.score,
                        rank: data.rank,
                        qrToken: data.qrToken,
                        firstLoginAt: data.firstLoginAt,
                        lastLoginAt: data.lastLoginAt
                    });
                });
            }
        }
        
        // Sort all participants by date (newest first)
        participants.sort((a, b) => b.sortDate - a.sortDate);
        
        const countElement = document.getElementById('participant-count');
        if (countElement) {
            countElement.textContent = participants.length;
        }
        
        if (participants.length === 0) {
            participantsList.innerHTML = '<tr><td colspan="6" class="text-center py-8 text-slate-400">No participants yet</td></tr>';
            return;
        }
        
        participantsList.innerHTML = participants.map(participant => {
            // Ensure identifier is set - use id if identifier is missing
            let identifier = participant.identifier || participant.id;
            
            // For pending users, ensure identifier is encoded email
            if (participant.type === 'pending' && !identifier) {
                // Fallback: encode email if available
                if (participant.email) {
                    const normalizedEmail = normalizeEmail(participant.email);
                    identifier = encodeEmailForPath(normalizedEmail);
                }
            }
            
            // If still no identifier, skip this participant (shouldn't happen)
            if (!identifier) {
                return '';
            }
            
            const statusText = participant.type === 'pending' ? 'Pending Login' : 'Active';
            const statusClass = participant.type === 'pending' ? 'bg-yellow-500/20 text-yellow-400' : 'bg-green-500/20 text-green-400';
            const rank = participant.rank || 'N/A';
            const score = participant.score || 0;
            
            return `
            <tr class="border-b border-white/5 hover:bg-white/5 transition-colors">
                <td class="py-3 px-4">${participant.participantId || 'N/A'}</td>
                <td class="py-3 px-4">${participant.fullName || participant.displayName || 'N/A'}</td>
                <td class="py-3 px-4 text-slate-300">${participant.email || 'N/A'}</td>
                <td class="py-3 px-4">
                    <span class="px-2 py-1 rounded-full text-xs font-semibold ${statusClass}">
                        ${statusText}
                    </span>
                </td>
                <td class="py-3 px-4">
                    <div class="flex flex-col">
                        <span class="font-semibold">${rank}</span>
                        <span class="text-xs text-slate-400">${score} pts</span>
                    </div>
                </td>
                <td class="py-3 px-4">
                    <button onclick="viewQRCode('${identifier}', '${participant.type}')" 
                        class="px-3 py-1 bg-primary/20 hover:bg-primary/30 text-primary rounded-lg text-sm transition-colors mr-2">
                        View QR
                    </button>
                    <button onclick="deleteParticipant('${identifier}', '${participant.type}')" 
                        class="px-3 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg text-sm transition-colors">
                        Delete
                    </button>
                </td>
            </tr>
        `;
        }).join('');
        
    } catch (error) {
        participantsList.innerHTML = '<tr><td colspan="6" class="text-center py-8 text-red-400">Error loading participants: ' + error.message + '</td></tr>';
    }
}

// Export All Participants
async function exportAllParticipants() {
    try {
        // Show loading state
        const exportBtn = document.getElementById('export-participants-btn');
        const originalText = exportBtn.textContent;
        exportBtn.disabled = true;
        exportBtn.textContent = 'Exporting...';
        
        let participants = [];
        let useCache = false;
        
        // Try to load from RTDB cache first
        try {
            const participantsRef = ref(rtdb, 'adminCache/participants');
            const participantsSnap = await get(participantsRef);
            
            if (participantsSnap.exists()) {
                const cacheData = participantsSnap.val();
                if (cacheData.pending && cacheData.active) {
                    // Use cache data directly
                    const allParticipants = [
                        ...(cacheData.pending || []),
                        ...(cacheData.active || [])
                    ];
                    
                    // Convert to export format
                    participants = allParticipants.map(p => {
                        const isPending = p.type === 'pending';
                        return {
                            participantId: p.participantId || 'N/A',
                            fullName: p.fullName || p.displayName || 'N/A',
                            district: p.district || 'N/A',
                            email: p.email || 'N/A',
                            phone: p.phone || 'N/A',
                            profession: p.profession || 'N/A',
                            status: isPending ? 'Pending Login' : 'Active',
                            rank: isPending ? 'N/A' : (p.rank || 'N/A'),
                            score: isPending ? 0 : (p.score || 0),
                            date: isPending 
                                ? (p.createdAt ? new Date(p.createdAt.toMillis ? p.createdAt.toMillis() : p.createdAt).toLocaleDateString() : 'N/A')
                                : (p.lastLoginAt ? new Date(p.lastLoginAt.toMillis ? p.lastLoginAt.toMillis() : p.lastLoginAt).toLocaleDateString() : 
                                   p.firstLoginAt ? new Date(p.firstLoginAt.toMillis ? p.firstLoginAt.toMillis() : p.firstLoginAt).toLocaleDateString() : 'N/A'),
                            type: p.type
                        };
                    });
                    useCache = true;
                }
            }
        } catch (error) {
            // Continue to read directly from RTDB
        }
        
        // If cache is stale, read directly from RTDB (no Firestore fallback)
        if (!useCache) {
            const pendingUsersRef = ref(rtdb, 'pendingUsers');
            const usersRef = ref(rtdb, 'users');
            
            const [pendingSnap, usersSnap] = await Promise.all([
                get(pendingUsersRef),
                get(usersRef)
            ]);
            
            // Add pending users
            if (pendingSnap.exists()) {
                pendingSnap.forEach((child) => {
                    const data = child.val();
                    participants.push({
                        participantId: data.participantId || 'N/A',
                        fullName: data.fullName || 'N/A',
                        district: data.district || 'N/A',
                        email: data.email || 'N/A',
                        phone: data.phone || 'N/A',
                        profession: data.profession || 'N/A',
                        status: 'Pending Login',
                        rank: 'N/A',
                        score: 0,
                        date: data.createdAt ? new Date(data.createdAt).toLocaleDateString() : 'N/A',
                        type: 'pending'
                    });
                });
            }
            
            // Add active users
            if (usersSnap.exists()) {
                usersSnap.forEach((child) => {
                    const data = child.val();
                    const profile = data.profile || {};
                    participants.push({
                        participantId: data.participantId || 'N/A',
                        fullName: profile.fullName || profile.displayName || 'N/A',
                        district: profile.district || 'N/A',
                        email: data.email || 'N/A',
                        phone: profile.phone || 'N/A',
                        profession: profile.profession || 'N/A',
                        status: 'Active',
                        rank: data.rank || 'N/A',
                        score: data.score || 0,
                        date: data.lastLoginAt ? new Date(data.lastLoginAt).toLocaleDateString() : 
                              data.firstLoginAt ? new Date(data.firstLoginAt).toLocaleDateString() : 'N/A',
                        type: 'active'
                    });
                });
            }
        }
        
        // Sort by date (newest first)
        participants.sort((a, b) => {
            const dateA = a.date === 'N/A' ? 0 : new Date(a.date).getTime();
            const dateB = b.date === 'N/A' ? 0 : new Date(b.date).getTime();
            return dateB - dateA;
        });
        
        // Convert to CSV
        const headers = ['Participant ID', 'Full Name', 'District', 'Email', 'Phone', 'Profession', 'Status', 'Rank', 'Score', 'Date'];
        const csvRows = [headers.join(',')];
        
        participants.forEach(participant => {
            const row = [
                `"${participant.participantId}"`,
                `"${participant.fullName}"`,
                `"${participant.district}"`,
                `"${participant.email}"`,
                `"${participant.phone}"`,
                `"${participant.profession}"`,
                `"${participant.status}"`,
                `"${participant.rank}"`,
                participant.score,
                `"${participant.date}"`
            ];
            csvRows.push(row.join(','));
        });
        
        const csvContent = csvRows.join('\n');
        
        // Create download link
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', `participants_export_${new Date().toISOString().split('T')[0]}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        // Reset button
        exportBtn.disabled = false;
        exportBtn.textContent = originalText;
        
        showAlert('Export Successful', `Successfully exported ${participants.length} participants!`, 'success');
        
    } catch (error) {
        showAlert('Export Error', 'Error exporting participants: ' + error.message, 'error');
        
        // Reset button
        const exportBtn = document.getElementById('export-participants-btn');
        exportBtn.disabled = false;
        exportBtn.textContent = 'Export All';
    }
}

// Export button event listener
const exportParticipantsBtn = document.getElementById('export-participants-btn');
if (exportParticipantsBtn) {
    exportParticipantsBtn.addEventListener('click', exportAllParticipants);
}

// View QR Code (RTDB-first)
window.viewQRCode = async function(identifier, type) {
    try {
        let participant = null;
        let qrToken = null;
        
        // Read from RTDB
        if (type === 'pending') {
            const pendingUserRef = ref(rtdb, `pendingUsers/${identifier}`);
            const pendingSnap = await get(pendingUserRef);
            if (pendingSnap.exists()) {
                participant = pendingSnap.val();
                qrToken = participant.qrToken;
            }
        } else {
            const userRef = ref(rtdb, `users/${identifier}`);
            const userSnap = await get(userRef);
            if (userSnap.exists()) {
                const userData = userSnap.val();
                qrToken = userData.qrToken;
                const profile = userData.profile || {};
                participant = {
                    qrCodeBase64: userData.qrCodeBase64 || null, // Read from RTDB user document
                    qrToken: qrToken,
                    fullName: profile.fullName || userData.fullName,
                    displayName: profile.displayName || userData.displayName
                };
                
                // If qrCodeBase64 is not in RTDB, try to get from Firestore as fallback
                if (!participant.qrCodeBase64 && qrToken) {
                    try {
                        const userDocRef = doc(db, 'users', identifier);
                        const userDocSnap = await getDoc(userDocRef);
                        if (userDocSnap.exists()) {
                            const firestoreData = userDocSnap.data();
                            participant.qrCodeBase64 = firestoreData.qrCodeBase64 || null;
                            
                            // If found in Firestore, update RTDB for future use
                            if (participant.qrCodeBase64) {
                                await update(ref(rtdb, `users/${identifier}`), {
                                    qrCodeBase64: participant.qrCodeBase64
                                });
                            }
                        }
                    } catch (error) {
                        // Firestore fallback failed, continue without it
                    }
                }
            }
        }
        
        if (participant) {
            // Get QR code base64 - for pending users it's in the document, for active users we may need to generate
            let qrCodeBase64 = participant.qrCodeBase64;
            const name = participant.fullName || participant.displayName || 'User';
            
            // If no base64, try to get from pendingUsers (for pending) or generate from qrToken
            if (!qrCodeBase64 && type === 'pending') {
                qrCodeBase64 = participant.qrCodeBase64;
            }
            
            // If still no QR code, try to generate it from token
            if (!qrCodeBase64 && qrToken) {
                try {
                    if (verifyQRCodeLibrary()) {
                        qrCodeBase64 = await generateQRCodeBase64(qrToken);
                        // Save to RTDB for future use
                        if (type === 'pending') {
                            await update(ref(rtdb, `pendingUsers/${identifier}`), {
                                qrCodeBase64: qrCodeBase64
                            });
                        } else {
                            await update(ref(rtdb, `users/${identifier}`), {
                                qrCodeBase64: qrCodeBase64
                            });
                        }
                    } else {
                        showAlert('Error', 'QR code library not loaded. Please refresh the page and try again.', 'error');
                        return;
                    }
                } catch (genError) {
                    showAlert('Error', 'Could not generate QR code. QR Token: ' + (qrToken ? qrToken.substring(0, 16) + '...' : 'N/A'), 'warning');
                    return;
                }
            }
            
            if (!qrCodeBase64) {
                showAlert('Error', 'QR code not found for this participant', 'error');
                return;
            }
            
            // Open QR code in new window
            const newWindow = window.open('', '_blank', 'width=400,height=400');
            newWindow.document.write(`
                <html>
                    <head>
                        <title>QR Code - ${name}</title>
                        <style>
                            body {
                                display: flex;
                                flex-direction: column;
                                align-items: center;
                                justify-content: center;
                                height: 100vh;
                                margin: 0;
                                background: #1a2c32;
                                color: white;
                                font-family: Arial, sans-serif;
                            }
                            img {
                                max-width: 90%;
                                border: 4px solid white;
                                border-radius: 8px;
                            }
                            h2 {
                                margin-top: 20px;
                            }
                        </style>
                    </head>
                    <body>
                        <h2>${name}</h2>
                        <img src="${qrCodeBase64}" alt="QR Code">
                        <p style="margin-top: 20px; color: #90bccb;">QR Token: ${participant.qrToken ? participant.qrToken.substring(0, 16) + '...' : 'N/A'}</p>
                    </body>
                </html>
            `);
        } else {
            showAlert('Error', 'Participant not found', 'error');
        }
    } catch (error) {
        showAlert('Error', 'Error loading QR code', 'error');
    }
};

// Delete Participant (RTDB-only)
window.deleteParticipant = async function(identifier, type) {
    const confirmMessage = type === 'pending' 
        ? 'Are you sure you want to delete this pending participant? This will prevent them from logging in.'
        : 'Are you sure you want to delete this active participant? This will remove their account, score, and all connection history.';
    
    showConfirm(confirmMessage, async (confirmed) => {
        if (!confirmed) return;
        
        try {
            let participantData = null;
            let qrToken = null;
            let email = null;
            let participantId = null;
            
            // Get participant data from RTDB
            if (type === 'pending') {
                // For pending users, identifier should be encoded email
                // But handle case where it might be raw email
                let encodedIdentifier = identifier;
                
                // If identifier doesn't look encoded (contains @), encode it
                if (identifier.includes('@')) {
                    const normalizedEmail = normalizeEmail(identifier);
                    encodedIdentifier = encodeEmailForPath(normalizedEmail);
                }
                
                const pendingUserRef = ref(rtdb, `pendingUsers/${encodedIdentifier}`);
                const pendingSnap = await get(pendingUserRef);
                if (pendingSnap.exists()) {
                    participantData = pendingSnap.val();
                    qrToken = participantData.qrToken;
                    email = participantData.email || decodeEmailFromPath(encodedIdentifier);
                    participantId = participantData.participantId;
                } else {
                    // Try with raw email if encoded didn't work
                    if (identifier.includes('@')) {
                        const normalizedEmail = normalizeEmail(identifier);
                        const altEncoded = encodeEmailForPath(normalizedEmail);
                        if (altEncoded !== encodedIdentifier) {
                            const altRef = ref(rtdb, `pendingUsers/${altEncoded}`);
                            const altSnap = await get(altRef);
                            if (altSnap.exists()) {
                                participantData = altSnap.val();
                                qrToken = participantData.qrToken;
                                email = participantData.email || identifier;
                                participantId = participantData.participantId;
                                encodedIdentifier = altEncoded; // Update for deletion
                            }
                        }
                    }
                }
                
                // Update identifier to encoded version for deletion
                if (participantData) {
                    identifier = encodedIdentifier;
                }
            } else {
                const userRef = ref(rtdb, `users/${identifier}`);
                const userSnap = await get(userRef);
                if (userSnap.exists()) {
                    participantData = userSnap.val();
                    qrToken = participantData.qrToken;
                    email = participantData.email;
                    participantId = participantData.participantId;
                }
            }
            
            if (!participantData) {
                showAlert('Error', 'Participant not found', 'error');
                return;
            }
            
            // Delete via Cloud Function (admin-only, handles all cleanup)
            // RTDB triggers will automatically update admin cache
            const deleteUser = httpsCallable(functions, 'deleteUser');
            
            await deleteUser({
                uid: identifier,
                type: type
            });
            
            showAlert('Success', 'Participant deleted successfully', 'success');
            
            // Reload participants (force refresh to see changes immediately)
            await loadParticipants(true);
        } catch (error) {
            showAlert('Error', 'Error deleting participant: ' + error.message, 'error');
        }
    });
};

// Search functionality
const searchInput = document.getElementById('search-participants');
if (searchInput) {
    searchInput.addEventListener('input', (e) => {
        const searchTerm = e.target.value.toLowerCase();
        const rows = document.querySelectorAll('#participants-list tr');
        
        rows.forEach(row => {
            const text = row.textContent.toLowerCase();
            row.style.display = text.includes(searchTerm) ? '' : 'none';
        });
    });
}

// Load Leaderboard
async function loadLeaderboard() {
    const leaderboardList = document.getElementById('leaderboard-list');
    if (!leaderboardList) return;
    
    leaderboardList.innerHTML = '<tr><td colspan="6" class="text-center py-8 text-slate-400">Loading leaderboard...</td></tr>';
    
    try {
        let leaderboard = [];
        let useCache = false;
        
        // Try to load from RTDB cache first (for top 10)
        let retryCount = 0;
        const maxRetries = 3;
        
        while (retryCount < maxRetries) {
            try {
                const leaderboardRef = ref(rtdb, 'leaderboard/top10');
                const leaderboardSnap = await get(leaderboardRef);
                
                if (leaderboardSnap.exists()) {
                    const cacheData = leaderboardSnap.val();
                    // Convert cache data to leaderboard array
                    leaderboard = Object.values(cacheData)
                        .filter(p => p !== null)
                        .map(p => ({
                            uid: p.uid,
                            fullName: p.name,
                            displayName: p.name,
                            district: p.district || 'N/A',
                            email: p.email || null, // Keep null, will show 'N/A' in display
                            score: p.score || 0,
                            rank: p.rank || 'N/A'
                        }));
                    useCache = true;
                    break;
                }
                
                // If cache is empty, wait and retry (might be updating)
                if (retryCount < maxRetries - 1) {
                    await new Promise(resolve => setTimeout(resolve, 100 * (retryCount + 1)));
                }
                retryCount++;
            } catch (error) {
                if (retryCount === maxRetries - 1) {
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 100 * (retryCount + 1)));
                retryCount++;
            }
        }
        
        // If cache is empty, show empty leaderboard (no Firestore fallback)
        // Cloud Functions should have pre-computed it during migration
        if (!useCache || leaderboard.length === 0) {
            leaderboard = [];
        }
        
        if (leaderboard.length === 0) {
            leaderboardList.innerHTML = '<tr><td colspan="6" class="text-center py-8 text-slate-400">No participants yet</td></tr>';
            return;
        }
        
        leaderboardList.innerHTML = leaderboard.map((participant, index) => {
            return `
            <tr class="border-b border-white/5 hover:bg-white/5 transition-colors">
                <td class="py-3 px-4 font-bold">#${index + 1}</td>
                <td class="py-3 px-4">${participant.fullName || participant.displayName || 'N/A'}</td>
                <td class="py-3 px-4">${participant.district || 'N/A'}</td>
                <td class="py-3 px-4 text-slate-300">${participant.email || 'N/A'}</td>
                <td class="py-3 px-4 font-bold">${participant.score || 0}</td>
                <td class="py-3 px-4">
                    <span class="px-2 py-1 rounded-full text-xs font-semibold bg-primary/20 text-primary">
                        ${participant.rank || 'N/A'}
                    </span>
                </td>
            </tr>
        `;
        }).join('');
        
    } catch (error) {
        leaderboardList.innerHTML = '<tr><td colspan="6" class="text-center py-8 text-red-400">Error loading leaderboard: ' + error.message + '</td></tr>';
    }
}

// Refresh Leaderboard
const refreshLeaderboardBtn = document.getElementById('refresh-leaderboard-btn');
if (refreshLeaderboardBtn) {
    refreshLeaderboardBtn.addEventListener('click', () => {
        loadLeaderboard();
    });
}

// Refresh All Caches
// Sync Firestore to RTDB button (one-time migration)
const syncFirestoreBtn = document.getElementById('sync-firestore-btn');
if (syncFirestoreBtn) {
    syncFirestoreBtn.addEventListener('click', async () => {
        try {
            syncFirestoreBtn.disabled = true;
            syncFirestoreBtn.textContent = 'Syncing...';
            
            const syncFirestoreToRTDB = httpsCallable(functions, 'syncFirestoreToRTDB');
            const result = await syncFirestoreToRTDB();
            
            showAlert('Success', result.data.message || 'Users synced successfully!', 'success');
            
            // Reload participants
            if (currentTab === 'manage') {
                loadParticipants();
            }
        } catch (error) {
            showAlert('Error', 'Error syncing: ' + error.message, 'error');
        } finally {
            syncFirestoreBtn.disabled = false;
            syncFirestoreBtn.textContent = 'Sync Firestore to RTDB';
        }
    });
}

const refreshAllCachesBtn = document.getElementById('refresh-all-caches-btn');
if (refreshAllCachesBtn) {
    refreshAllCachesBtn.addEventListener('click', async () => {
        try {
            refreshAllCachesBtn.disabled = true;
            refreshAllCachesBtn.textContent = 'Refreshing...';
            
            const refreshAllCaches = httpsCallable(functions, 'refreshAllCaches');
            const result = await refreshAllCaches();
            
            if (result.data && result.data.success) {
                showAlert('Success', result.data.message || 'All caches refreshed successfully!', 'success');
                // Reload participants and leaderboard to show updated data
                if (currentTab === 'manage') {
                    loadParticipants();
                } else if (currentTab === 'leaderboard') {
                    loadLeaderboard();
                }
            } else {
                showAlert('Error', 'Failed to refresh caches', 'error');
            }
        } catch (error) {
            showAlert('Error', 'Error refreshing caches: ' + error.message, 'error');
        } finally {
            refreshAllCachesBtn.disabled = false;
            refreshAllCachesBtn.textContent = 'Refresh All Caches';
        }
    });
}

// Logout
document.getElementById('logout-btn').addEventListener('click', async () => {
    await signOut(auth);
    lastCheckedUid = null;
    currentUser = null;
    showLoginPrompt();
});
