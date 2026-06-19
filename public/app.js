// API Base URL
const API_URL = '/api';

// Client debug logging (disabled by default)
// Toggle to true temporarily when debugging issues.
const DEBUG_LOGS = false;
const debugLog = (...args) => {
    if (DEBUG_LOGS) console.log(...args);
};

// Authentication state
let authState = {
    authenticated: false,
    role: null,
    authEnabled: null,
    publicReadOnly: false,
    checking: true
};

// Navigation items configuration (admin only)
const ADMIN_NAV_ITEMS = [
    { href: 'index.html', label: 'Members' },
    { href: 'member-map.html', label: '🗺️ Map' },
    { href: 'bulk-email.html', label: 'Bulk Email' },
    { href: 'email-history.html', label: 'Email History' },
    { href: 'tools.html', label: 'Tools' },
    { href: 'settings.html', label: '⚙️ Settings' },
    { href: 'roster-pdf.html', label: '📄 Roster PDF', isDynamicPdf: true }
];

// User navigation items (limited access)
const USER_NAV_ITEMS = [
    { href: 'index.html', label: 'Members' },
    { href: 'member-map.html', label: '🗺️ Map' },
    { href: 'roster-pdf.html', label: '📄 Roster PDF', isDynamicPdf: true, showIfPdfExists: true }
];

// State
let members = [];
let templates = [];
let emailLogs = [];
let currentMember = null;
let searchTimeout = null;
let activeTagFilter = null;
let config = null;
let availableFields = [];
let appVersion = null; // Fetched from server on init

// Bulk email state
let bulkRecipients = [];
let bulkSelectedIds = new Set();

// ==========================================
// AUTHENTICATION FUNCTIONS
// ==========================================

async function checkAuthentication() {
    try {
        // Check if we have a mock token in sessionStorage first
        const storedToken = sessionStorage.getItem('authToken');
        const storedRole = sessionStorage.getItem('authRole');
        
        debugLog('[AUTH CLIENT] Stored token:', storedToken || 'none');
        debugLog('[AUTH CLIENT] Stored role:', storedRole || 'none');
        
        // Add cache-busting timestamp
        const response = await fetch(`${API_URL}/auth/check?t=${Date.now()}`);
        const result = await response.json();
        
        debugLog('[AUTH CLIENT] Server response:', JSON.stringify(result));
        
        authState.authenticated = result.authenticated || false;
        authState.role = result.role || null;
        authState.authEnabled = typeof result.authEnabled === 'boolean' ? result.authEnabled : null;
        authState.publicReadOnly = !!result.publicReadOnly;
        
        debugLog('[AUTH CLIENT] Final authState:', JSON.stringify(authState));
        
        // If server says not authenticated but we have a mock token,
        // it means the user clicked "Continue Without Login" or auth is disabled
        if (!authState.authenticated && storedToken === 'mock' && result.authEnabled === false) {
            debugLog('[AUTH CLIENT] Using mock token fallback (auth disabled)');
            authState.authenticated = true;
            authState.role = storedRole || 'admin';
        }
    } catch (error) {
        console.error('[AUTH CLIENT] Auth check failed:', error);
        authState.authEnabled = null;
        authState.publicReadOnly = false;

        // Default to not authenticated on auth-check failure (safer default)
        authState.authenticated = false;
        authState.role = null;

        // If we explicitly have a mock token ("Continue Without Login"), allow it as a fallback.
        const storedToken = sessionStorage.getItem('authToken');
        const storedRole = sessionStorage.getItem('authRole');
        debugLog('[AUTH CLIENT] Error - stored token:', storedToken);
        if (storedToken === 'mock') {
            debugLog('[AUTH CLIENT] Error - using mock token fallback');
            authState.authenticated = true;
            authState.role = storedRole || 'admin';
            authState.authEnabled = false;
        }
    }
    authState.checking = false;
    return authState;
}

function handleUnauthorized() {
    // Clear any client-side auth hints
    authState.authenticated = false;
    authState.role = null;
    sessionStorage.removeItem('authRole');
    sessionStorage.removeItem('authToken');

    // Redirect to login (prevents showing partial UI with 401 data)
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    if (currentPage !== 'login.html') {
        window.location.href = 'login.html?n=' + Date.now();
    }
}

async function logout() {
    // Check if we were in public read-only mode before clearing
    const wasPublicReadOnly = authState.publicReadOnly;
    
    try {
        // Clear local state first to ensure UI updates immediately
        authState.authenticated = false;
        authState.role = null;
        authState.publicReadOnly = false;
        authState.authEnabled = null;
        sessionStorage.removeItem('authRole');
        sessionStorage.removeItem('authToken');
        
        // Call server logout
        await fetch(`${API_URL}/auth/logout`, {
            method: 'POST',
            headers: {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            }
        });
    } catch (error) {
        console.error('Logout error:', error);
    } finally {
        // Use location.replace to prevent back button from returning to authenticated page
        // In public read-only mode, redirect to home page (Members list)
        // Otherwise, redirect to login page
        const timestamp = Date.now();
        const nonce = Math.random().toString(36).substring(2, 15);
        const redirectPage = wasPublicReadOnly ? 'index.html' : 'login.html';
        location.replace(`${redirectPage}?t=${timestamp}&n=${nonce}`);
    }
}

function getAuthState() {
    return authState;
}

function isAdmin() {
    return authState.authenticated && authState.role === 'admin';
}

function isUser() {
    return authState.authenticated && (authState.role === 'user' || authState.role === 'admin');
}

// Initialize - check auth first, then load data
async function initializeApp() {
    // Check authentication first
    await checkAuthentication();
    
    // Get current page
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    
    // If not authenticated and on login page, check if auth is disabled
    if (!authState.authenticated && currentPage === 'login.html') {
        // If not authenticated on login page, just stay here
        // User can try to login or if auth is disabled, they'll get access
        return false;
    }
    
    // If not authenticated and not on login page, redirect to login
    if (!authState.authenticated && currentPage !== 'login.html') {
        // Public read-only access (Members + Map) when USER_PASSWORD is not set
        const publicPages = ['index.html', 'member-map.html', 'roster-pdf.html'];
        if (authState.publicReadOnly && publicPages.includes(currentPage)) {
            return true;
        }
        window.location.href = 'login.html';
        return false;
    }
    
    // If authenticated and on login page, redirect to members
    if (authState.authenticated && currentPage === 'login.html') {
        window.location.href = 'index.html';
        return false;
    }
    
    // Admin-only pages check
    const adminPages = [
        'bulk-email.html',
        'email-history.html',
        'tools.html',
        'settings.html',
        'csv-import.html',
        'backup-restore.html',
        'templates.html'
    ];
    
    if (adminPages.includes(currentPage) && authState.role !== 'admin') {
        console.warn('Access denied: Admin role required for this page');
        window.location.href = 'index.html';
        return false;
    }
    
    return true;
}

// Modified DOMContentLoaded to use initializeApp
document.addEventListener('DOMContentLoaded', async () => {
    // Fetch version first (before rendering header)
    await fetchVersion();
    
    // Render header immediately (before auth check to avoid flash)
    renderHeader();
    
    // Ensure hamburger is visible after header render
    ensureHamburgerVisible();
    
    const shouldContinue = await initializeApp();
    
    // If we're on login page, we still want to load config for app name
    // But we must handle the 401 if auth is enabled
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    if (currentPage === 'login.html') {
        await loadConfig();
        renderHeader(); // Re-render header with config appName
        return;
    }

    if (!shouldContinue) {
        debugLog('[INIT] initializeApp returned false, skipping navigation init');
        return;
    }
    
    debugLog('[INIT] initializeApp returned true, proceeding with navigation');
    
    // Initialize shared navigation
    initSharedNavigation();
    
    // Load data sequentially to avoid race conditions and handle errors
    try {
        if (authState.authenticated) {
            await loadConfig();
            renderHeader(); // Re-render header with config appName
            // Update email status badge after header is rendered
            await updateEmailStatusBadge();
        } else {
            // Public read-only: avoid protected config endpoint
            config = { appName: 'RosterCast' };
            applyConfig();
        }
        await loadMembers();
        
        // Check if we're on the map page
        if (document.getElementById('map')) {
            await initMemberMap();
        } else {
            // Check URL parameters for view/edit actions
            checkUrlParameters();
        }
        
        // Check which page we're on and load appropriate data
        if (document.getElementById('templatesList')) {
            await loadTemplates();
        }
        if (document.getElementById('settingsForm')) {
            await loadAvailableFields();
        }
        
        // Only admins can access templates/logs/email features
        if (isAdmin()) {
            await loadTemplates();
            await loadEmailLogs();
        }
        
        setupEventListeners();
        
        // Load footer
        await loadFooter();
    } catch (error) {
        console.error('Initialization error:', error);
    }
});

// Event Listeners
function setupEventListeners() {
    // Search input with live search
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                searchMembers(e.target.value);
            }, 300);
        });
    }
    
    // Add member button - only for admin
    const addMemberBtn = document.getElementById('addMemberBtn');
    if (addMemberBtn) {
        if (!isAdmin()) {
            addMemberBtn.style.display = 'none';
        } else {
            addMemberBtn.addEventListener('click', () => {
                showAddMemberModal();
            });
        }
    }
    
    // Clear filters button
    const clearFiltersBtn = document.getElementById('clearFiltersBtn');
    if (clearFiltersBtn) {
        clearFiltersBtn.addEventListener('click', clearFilters);
    }
    
    // Member form
    const memberForm = document.getElementById('memberForm');
    if (memberForm) {
        memberForm.addEventListener('submit', (e) => {
            e.preventDefault();
            saveMember();
        });
    }
    
    // Send email form
    const sendEmailForm = document.getElementById('sendEmailForm');
    if (sendEmailForm) {
        sendEmailForm.addEventListener('submit', (e) => {
            e.preventDefault();
            sendEmail();
        });
    }
    
    // Email template selection
    const emailTemplate = document.getElementById('emailTemplate');
    if (emailTemplate) {
        emailTemplate.addEventListener('change', updateEmailFields);
    }
    
    // Send welcome email button
    const sendWelcomeBtn = document.getElementById('sendWelcomeBtn');
    if (sendWelcomeBtn) {
        sendWelcomeBtn.addEventListener('click', () => {
            closeViewModal();
            showSendEmailModal(currentMember);
        });
    }
    
    // Sort controls
    const sortBy = document.getElementById('sortBy');
    if (sortBy) {
        sortBy.addEventListener('change', applySortAndFilter);
    }
    const sortOrder = document.getElementById('sortOrder');
    if (sortOrder) {
        sortOrder.addEventListener('change', applySortAndFilter);
    }
    
    // Approved field change - show/hide send welcome email checkbox
    const approvedField = document.getElementById('approved');
    if (approvedField) {
        approvedField.addEventListener('change', showSendWelcomeCheckbox);
    }
    
    // Email input - live check for duplicates
    const emailInput = document.getElementById('email');
    if (emailInput) {
        emailInput.addEventListener('input', handleEmailInput);
    }
    
    // Bulk email event listeners
    setupBulkEmailListeners();
}

// API Functions
async function loadMembers() {
    try {
        const response = await fetch(`${API_URL}/members`);
        if (response.status === 401) {
            console.warn('Unauthorized access to members API');
            handleUnauthorized();
            return;
        }
        const data = await response.json();
        members = Array.isArray(data) ? data : [];
        applySortAndFilter();
        renderTagFilter();
    } catch (error) {
        console.error('Error loading members:', error);
        showToast('Error loading members', 'error');
        members = [];
    }
}

function applySortAndFilter() {
    let filteredMembers = [...members];
    
    // Apply tag filter
    if (activeTagFilter) {
        filteredMembers = filteredMembers.filter(m => 
            m.tags && Array.isArray(m.tags) && m.tags.includes(activeTagFilter)
        );
    }
    
    // Apply search filter
    const searchInput = document.getElementById('searchInput');
    const searchQuery = searchInput ? searchInput.value.toLowerCase() : '';
    
    if (searchQuery) {
        filteredMembers = filteredMembers.filter(m =>
            (m.first_name && m.first_name.toLowerCase().includes(searchQuery)) ||
            (m.last_name && m.last_name.toLowerCase().includes(searchQuery)) ||
            (m.email && m.email.toLowerCase().includes(searchQuery)) ||
            (m.club && m.club.toLowerCase().includes(searchQuery)) ||
            (m.city && m.city.toLowerCase().includes(searchQuery)) ||
            (m.address && m.address.toLowerCase().includes(searchQuery)) ||
            (m.fromarea && m.fromarea.toLowerCase().includes(searchQuery)) ||
            (m.twg_subgroups && m.twg_subgroups.toLowerCase().includes(searchQuery)) ||
            (m.tags && Array.isArray(m.tags) && m.tags.some(tag => tag.toLowerCase().includes(searchQuery)))
        );
    }
    
    // Apply sort
    const sortBySelect = document.getElementById('sortBy');
    const sortOrderSelect = document.getElementById('sortOrder');
    
    if (sortBySelect && sortOrderSelect) {
        const sortBy = sortBySelect.value;
        const sortOrder = sortOrderSelect.value;
        
        filteredMembers.sort((a, b) => {
            let aVal = a[sortBy] || '';
            let bVal = b[sortBy] || '';
            
            if (typeof aVal === 'string') {
                aVal = aVal.toLowerCase();
                bVal = bVal.toLowerCase();
            }
            
            if (aVal < bVal) return sortOrder === 'asc' ? -1 : 1;
            if (aVal > bVal) return sortOrder === 'asc' ? 1 : -1;
            return 0;
        });
    }
    
    renderMembers(filteredMembers);
    updateMemberCount(filteredMembers.length);
    renderTagFilter();
}

function renderTagFilter() {
    const tagFilterContainer = document.getElementById('tagFilter');
    if (!tagFilterContainer) return; // Skip if element doesn't exist (e.g., on tools page)
    
    const allTags = new Set();
    members.forEach(m => {
        if (m.tags && Array.isArray(m.tags)) {
            m.tags.forEach(tag => allTags.add(tag));
        }
    });
    
    const sortedTags = Array.from(allTags).sort();
    
    if (sortedTags.length === 0) {
        tagFilterContainer.innerHTML = '';
        return;
    }
    
    tagFilterContainer.innerHTML = `
        <button class="tag-filter-btn ${activeTagFilter === null ? 'active' : ''}" onclick="filterByTag(null)">All</button>
        ${sortedTags.map(tag => `
            <button class="tag-filter-btn ${activeTagFilter === tag ? 'active' : ''}" onclick="filterByTag('${escapeHtml(tag)}')">${escapeHtml(tag)}</button>
        `).join('')}
    `;
}

function filterByTag(tag) {
    activeTagFilter = tag;
    applySortAndFilter();
    renderTagFilter();
}

async function loadTemplates() {
    try {
        const response = await fetch(`${API_URL}/templates`);
        if (response.status === 401) {
            handleUnauthorized();
            return;
        }
        const data = await response.json();
        templates = Array.isArray(data) ? data : [];
    } catch (error) {
        console.error('Error loading templates:', error);
        templates = [];
    }
}

async function loadEmailLogs() {
    try {
        const response = await fetch(`${API_URL}/email-logs`);
        if (response.status === 401) {
            handleUnauthorized();
            return;
        }
        const data = await response.json();
        emailLogs = Array.isArray(data) ? data : [];
    } catch (error) {
        console.error('Error loading email logs:', error);
        emailLogs = [];
    }
}

async function loadConfig() {
    try {
        const response = await fetch(`${API_URL}/config`);
        if (response.status === 401) {
            handleUnauthorized();
            return;
        }
        config = await response.json();
        applyConfig();
    } catch (error) {
        console.error('Error loading config:', error);
    }
}

async function loadAvailableFields() {
    try {
        const response = await fetch(`${API_URL}/available-fields`);
        if (response.status === 401) {
            handleUnauthorized();
            return;
        }
        const data = await response.json();
        availableFields = Array.isArray(data) ? data : [];
    } catch (error) {
        console.error('Error loading available fields:', error);
        availableFields = [];
    }
}

// ============================================
// EMAIL STATUS BADGE (ADMIN)
// ============================================

async function updateEmailStatusBadge() {
    // Only show for admins
    if (!isAdmin()) return;

    const badge = document.getElementById('emailStatusBadge');
    if (!badge) return;

    try {
        const response = await fetch(`${API_URL}/email/status`);
        if (response.status === 401) {
            handleUnauthorized();
            return;
        }
        if (!response.ok) {
            badge.style.display = 'none';
            return;
        }

        const status = await response.json();
        const enabled = !!status.enabled;

        badge.classList.remove('enabled', 'simulation');
        badge.textContent = enabled ? 'EMAIL IS ENABLED' : 'EMAIL SIMILATION MODE';
        badge.classList.add(enabled ? 'enabled' : 'simulation');
        badge.style.display = 'inline-block';
    } catch (error) {
        console.error('Error loading email status:', error);
        // Non-fatal: just hide badge
        badge.style.display = 'none';
    }
}

// Fetch app version
async function fetchVersion() {
    try {
        const response = await fetch(`${API_URL}/version`);
        const data = await response.json();
        appVersion = data.version || 'unknown';
    } catch (error) {
        console.error('Error fetching version:', error);
        appVersion = 'unknown';
    }
}

// Load footer dynamically
async function loadFooter() {
    try {
        const response = await fetch('footer.html');
        const footerHtml = await response.text();
        
        // Find the container to append the footer to
        // Look for the flex container that wraps the content
        const flexContainer = document.querySelector('body > div[style*="flex: 1"]');
        if (flexContainer) {
            flexContainer.insertAdjacentHTML('afterend', footerHtml);
        }
    } catch (error) {
        console.error('Error loading footer:', error);
    }
}

// ============================================
// CENTRALIZED HEADER/FOOTER RENDERING
// ============================================

// Get the page title based on current page
function getPageTitle() {
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    const titles = {
        'index.html': 'RosterCast',
        'backup-restore.html': 'Backup / Restore',
        'bulk-email.html': 'Bulk Email',
        'csv-import.html': 'CSV Import',
        'email-history.html': 'Email History',
        'login.html': 'Login',
        'member-map.html': 'Member Map',
        'roster-pdf.html': 'Roster PDF',
        'settings.html': 'Settings',
        'templates.html': 'Email Templates',
        'tools.html': 'Tools'
    };
    return titles[currentPage] || 'RosterCast';
}

// Check if header should have a link (all pages except index.html and member-map.html)
function headerHasLink() {
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    return currentPage !== 'index.html' && currentPage !== 'member-map.html';
}

// Render the header (app name, version, navigation placeholder)
function renderHeader() {
    const headerContainer = document.getElementById('headerContainer');
    if (!headerContainer) return;
    
    const appName = config?.appName || 'RosterCast';
    const hasLink = headerHasLink();
    const pageTitle = getPageTitle();
    
    const linkStart = hasLink ? '<a href="index.html" class="header-link">' : '';
    const linkEnd = hasLink ? '</a>' : '';
    
    // Add mobile menu overlay to body if not already present
    if (!document.getElementById('mobileMenuOverlay')) {
        const overlay = document.createElement('div');
        overlay.id = 'mobileMenuOverlay';
        overlay.className = 'mobile-menu-overlay';
        overlay.onclick = closeMobileMenu;
        document.body.appendChild(overlay);
        
        const mobileMenu = document.createElement('div');
        mobileMenu.id = 'mobileMenu';
        mobileMenu.className = 'mobile-menu';
        mobileMenu.innerHTML = `
            <div class="mobile-menu-header">
                <h3>Menu</h3>
                <button class="mobile-menu-close" onclick="closeMobileMenu()">&times;</button>
            </div>
            <div id="mobileNavLinks"></div>
        `;
        document.body.appendChild(mobileMenu);
    }
    
        const versionDisplay = appVersion ? ` <span class="app-version">v${escapeHtml(appVersion)}</span>` : '';
    
    headerContainer.innerHTML = `
        <header class="header">
            ${linkStart}
                <h1>${escapeHtml(appName)}${versionDisplay}
                    <span id="emailStatusBadge" class="email-status-badge" style="display:none"></span>
                </h1>
            ${linkEnd}
            <nav class="main-nav" id="sharedNavigation">
                <!-- Navigation rendered by app.js -->
            </nav>
        </header>
    `;

    // If the header is re-rendered after auth is known (e.g., after config load),
    // it replaces the <nav id="sharedNavigation"> element. Re-render nav to prevent it from disappearing.
    if (!authState.checking && (authState.authenticated || authState.publicReadOnly)) {
        renderNavigation();
    }
}

// Apply config settings (font, app name, etc.)
function applyConfig() {
    if (!config) return;
    
    // Set CSS custom properties on root for cascading font settings
    const root = document.documentElement;
    
    // Set font size
    const fontSize = config.fontSize || '16px';
    root.style.setProperty('--font-size', fontSize);
    
    // Set font family
    const fontFamily = config.fontFamily || 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    root.style.setProperty('--font-family', fontFamily);
    
    // Apply font settings to body which cascades to all children
    document.body.style.setProperty('font-size', fontSize, 'important');
    document.body.style.setProperty('font-family', fontFamily, 'important');
    
    // Apply to all table cells specifically
    const tableCells = document.querySelectorAll('.members-table th, .members-table td');
    tableCells.forEach(cell => {
        cell.style.fontSize = fontSize;
        cell.style.fontFamily = fontFamily;
    });
    
    // Apply to form inputs
    const inputs = document.querySelectorAll('input, select, textarea');
    inputs.forEach(input => {
        input.style.fontSize = fontSize;
        input.style.fontFamily = fontFamily;
    });
    
    // Update document title
    document.title = getPageTitle() + (config.appName ? ' - ' + config.appName : '');
}

// ============================================
// SHARED NAVIGATION FUNCTION
// ============================================

// Cache for latest PDF URL
let latestPdfUrl = null;

async function fetchLatestPdfUrl() {
    try {
        const response = await fetch('/api/roster-pdf/latest');
        const data = await response.json();
        if (data.exists) {
            latestPdfUrl = data.url;
        } else {
            latestPdfUrl = null;
        }
    } catch (error) {
        console.error('Error fetching latest PDF:', error);
        latestPdfUrl = null;
        // Don't re-throw - allow navigation to continue rendering
    }
}

function renderNavigation() {
    const container = document.getElementById('sharedNavigation');
    if (!container) {
        debugLog('[NAV] sharedNavigation element not found');
        return;
    }
    
    debugLog('[NAV] renderNavigation called, authState:', JSON.stringify(authState));

    // If not authenticated and not public read-only, don't render navigation.
    // (initializeApp should redirect, but this prevents UI flashes / bfcache artifacts.)
    if (!authState.authenticated && !authState.publicReadOnly) {
        debugLog('[NAV] Not authenticated, clearing nav');
        container.innerHTML = '';
        return;
    }
    
    // Get current page from URL
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    
    // Choose nav items based on role
    const navItems = isAdmin() ? ADMIN_NAV_ITEMS : USER_NAV_ITEMS;
    
    debugLog('[NAV] Rendering nav for page:', currentPage, 'isAdmin:', isAdmin(), 'navItems:', navItems.length);
    
    // Generate navigation HTML
    container.innerHTML = navItems.map(item => {
        // Skip items that require a PDF to exist when no PDF exists
        if (item.showIfPdfExists && !latestPdfUrl) {
            return '';
        }
        
        const isActive = currentPage === item.href || (currentPage === '' && item.href === 'index.html');
        // Only use target="_MapTab" for the map page to keep other links in same tab
        const target = item.href === 'member-map.html' ? ' target="_MapTab"' : '';
        
        return `<a href="${item.href}" class="nav-link ${isActive ? 'active' : ''}"${target}>${item.label}</a>`;
    }).join('');
    
    // Add logout button if authenticated
    if (authState.authenticated) {
        container.innerHTML += `
            <a href="#" class="nav-link" id="logoutBtn">Logout</a>
        `;
        
        // Add event listener for logout button
        const logoutBtn = document.getElementById('logoutBtn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', (e) => {
                e.preventDefault();
                logout();
            });
        }
    }

    // In public read-only mode (not logged in), provide an easy path to admin login.
    if (!authState.authenticated && authState.publicReadOnly) {
        container.innerHTML += `<a href="login.html" class="nav-link">Admin Login</a>`;
    }
    
    // Add hamburger button to header
    addHamburgerButton();
    
    // Ensure hamburger button is visible on mobile
    ensureHamburgerVisible();
    
    // Render mobile menu
    renderMobileMenu(navItems, currentPage);
    
    debugLog('[NAV] Navigation rendered, container innerHTML length:', container.innerHTML.length);
    
    // Debug: verify the HTML content
    debugLog('[NAV] Nav HTML:', container.innerHTML.substring(0, 200));
    
    // Debug: check if nav links are in the DOM
    const navLinks = container.querySelectorAll('.nav-link');
    debugLog('[NAV] Nav links found in DOM:', navLinks.length);
    navLinks.forEach((link, i) => {
        debugLog(`[NAV] Link ${i}:`, link.href, link.textContent, 'visible:', link.offsetWidth > 0 && link.offsetHeight > 0);
    });
    
    // Debug: check container dimensions
    const rect = container.getBoundingClientRect();
    debugLog('[NAV] Container dimensions:', rect.width, 'x', rect.height);
    debugLog('[NAV] Container styles:', window.getComputedStyle(container).display, window.getComputedStyle(container).visibility, window.getComputedStyle(container).opacity);
    
    // Debug: check hamburger button
    const hamburger = document.querySelector('.hamburger-btn');
    if (hamburger) {
        debugLog('[NAV] Hamburger button found, display:', window.getComputedStyle(hamburger).display);
    } else {
        debugLog('[NAV] Hamburger button NOT found');
    }
    
    // Check again after a delay - maybe something is clearing the nav
    setTimeout(() => {
        const navLinksAfter = container.querySelectorAll('.nav-link');
        debugLog('[NAV] Nav links after 1s:', navLinksAfter.length);
        if (navLinksAfter.length === 0) {
            debugLog('[NAV] WARNING: Nav was cleared! Current innerHTML:', container.innerHTML.substring(0, 100));
        }
    }, 1000);
}

function addHamburgerButton() {
    const header = document.querySelector('.header');
    if (!header) return;
    
    // Check if hamburger already exists
    if (header.querySelector('.hamburger-btn')) return;
    
    const hamburgerBtn = document.createElement('button');
    hamburgerBtn.className = 'hamburger-btn';
    hamburgerBtn.innerHTML = '<span></span><span></span><span></span>';
    hamburgerBtn.onclick = toggleMobileMenu;
    hamburgerBtn.title = 'Open menu';
    
    // Insert at the beginning of header
    header.insertBefore(hamburgerBtn, header.firstChild);
}

function ensureHamburgerVisible() {
    // Force show hamburger button on mobile by removing display: none
    const hamburgerBtn = document.querySelector('.hamburger-btn');
    if (hamburgerBtn) {
        hamburgerBtn.style.display = 'block';
    }
}

function renderMobileMenu(navItems, currentPage) {
    const mobileNavContainer = document.getElementById('mobileNavLinks');
    if (!mobileNavContainer) return;
    
    let mobileHtml = navItems.map(item => {
        if (item.showIfPdfExists && !latestPdfUrl) {
            return '';
        }
        
        const isActive = currentPage === item.href || (currentPage === '' && item.href === 'index.html');
        const target = item.href === 'member-map.html' ? ' target="_MapTab"' : '';
        
        return `<a href="${item.href}" class="mobile-nav-link ${isActive ? 'active' : ''}"${target} onclick="closeMobileMenu()">${item.label}</a>`;
    }).join('');
    
    // Add logout button if authenticated
    if (authState.authenticated) {
        mobileHtml += `<a href="#" class="mobile-nav-link" onclick="logout(); closeMobileMenu(); return false;">Logout</a>`;
    }
    
    // In public read-only mode, add admin login link
    if (!authState.authenticated && authState.publicReadOnly) {
        mobileHtml += `<a href="login.html" class="mobile-nav-link" onclick="closeMobileMenu()">Admin Login</a>`;
    }
    
    mobileNavContainer.innerHTML = mobileHtml;
}

function toggleMobileMenu() {
    const overlay = document.getElementById('mobileMenuOverlay');
    const menu = document.getElementById('mobileMenu');
    if (!overlay || !menu) return;
    
    if (overlay.classList.contains('active')) {
        closeMobileMenu();
    } else {
        overlay.classList.add('active');
        menu.classList.add('active');
    }
}

function closeMobileMenu() {
    const overlay = document.getElementById('mobileMenuOverlay');
    const menu = document.getElementById('mobileMenu');
    if (overlay) overlay.classList.remove('active');
    if (menu) menu.classList.remove('active');
}

function initSharedNavigation() {
    debugLog('[NAV] initSharedNavigation called');
    
    // Use Promise.race to ensure navigation renders even if PDF fetch is slow
    const pdfFetchPromise = fetchLatestPdfUrl();
    const timeoutPromise = new Promise(resolve => setTimeout(resolve, 1000));
    
    Promise.race([pdfFetchPromise, timeoutPromise]).then(() => {
        debugLog('[NAV] About to render navigation');
        renderNavigation();
    }).catch(() => {
        // Even if PDF fetch fails, render navigation
        debugLog('[NAV] PDF fetch failed, still rendering navigation');
        renderNavigation();
    });
}

async function saveSettings() {
    const normalizeNull = (v) => {
        if (v === null || v === undefined) return null;
        const s = String(v).trim();
        return s === '' ? null : s;
    };

    const arraysEqual = (a, b) => {
        if (a === b) return true;
        if (!Array.isArray(a) || !Array.isArray(b)) return false;
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    };

    const mergeLocal = (base, patch) => {
        const out = { ...(base || {}) };
        if (!patch || typeof patch !== 'object') return out;
        for (const [k, v] of Object.entries(patch)) {
            if (v && typeof v === 'object' && !Array.isArray(v)) {
                out[k] = mergeLocal(out[k], v);
            } else {
                out[k] = v;
            }
        }
        return out;
    };

    const patch = {};

    // Get selected table fields
    const selectedFields = [];
    document.querySelectorAll('#tableFieldsContainer input[type="checkbox"]:checked').forEach(checkbox => {
        selectedFields.push(checkbox.value);
    });
    
    // Ensure 'tags' is always included and is the last field
    if (!selectedFields.includes('tags')) {
        selectedFields.push('tags');
    } else {
        // Remove tags and add it back at the end
        const filtered = selectedFields.filter(f => f !== 'tags');
        filtered.push('tags');
        selectedFields.length = 0;
        selectedFields.push(...filtered);
    }
    
    // Get password values (only update if changed)
    const newAdminPassword = document.getElementById('configAdminPassword').value;
    const newUserPassword = document.getElementById('configUserPassword').value;
    const clearAdminPassword = document.getElementById('clearAdminPassword')?.checked;
    const clearUserPassword = document.getElementById('clearUserPassword')?.checked;
    
    // Diff-based saving: only include fields that truly changed.
    const nextAppName = (document.getElementById('configAppName').value || '').trim();
    if ((config?.appName || '') !== nextAppName) {
        patch.appName = nextAppName;
    }

    const nextFontSize = (document.getElementById('configFontSize').value || '16').toString().trim() + 'px';
    if ((config?.fontSize || '16px') !== nextFontSize) {
        patch.fontSize = nextFontSize;
    }

    const nextFontFamily = document.getElementById('configFontFamily').value;
    if ((config?.fontFamily || '') !== nextFontFamily) {
        patch.fontFamily = nextFontFamily;
    }

    const prevWelcomeTemplateId = normalizeNull(config?.welcomeTemplateId);
    const nextWelcomeTemplateId = normalizeNull(document.getElementById('configWelcomeTemplate').value);
    if (prevWelcomeTemplateId !== nextWelcomeTemplateId) {
        patch.welcomeTemplateId = nextWelcomeTemplateId;
    }

    const nextAutoSendWelcome = !!document.getElementById('configAutoSendWelcome').checked;
    if (!!config?.autoSendWelcome !== nextAutoSendWelcome) {
        patch.autoSendWelcome = nextAutoSendWelcome;
    }

    const prevTableFields = Array.isArray(config?.tableFields) ? config.tableFields : [];
    if (!arraysEqual(prevTableFields, selectedFields)) {
        patch.tableFields = selectedFields;
    }



    // Admin passwords: send ONLY when changed (never echo existing passwords back).
    const adminPasswordsPatch = {};
    if (clearAdminPassword) {
        adminPasswordsPatch.adminPassword = '';
    } else if (newAdminPassword) {
        adminPasswordsPatch.adminPassword = newAdminPassword;
    }
    if (clearUserPassword) {
        adminPasswordsPatch.userPassword = '';
    } else if (newUserPassword) {
        adminPasswordsPatch.userPassword = newUserPassword;
    }
    if (Object.keys(adminPasswordsPatch).length > 0) {
        patch.adminPasswords = adminPasswordsPatch;
    }

    // Email config: compare against what the user initially saw (may include .env values).
    // settings.html sets window.smtpFormBaseline and window.mailgunFormBaseline during load.
    const smtpBaseline = window.smtpFormBaseline || null;
    const mailgunBaseline = window.mailgunFormBaseline || null;
    const prevEmailConfig = smtpBaseline ? {
        enableEmail: !!smtpBaseline.enableEmail,
        host: smtpBaseline.host || '',
        port: Number(smtpBaseline.port || 587),
        secure: !!smtpBaseline.secure,
        user: smtpBaseline.user || '',
        from: smtpBaseline.from || '',
        provider: smtpBaseline.provider || 'smtp'
    } : (config?.emailConfig || {});

    const prevMailgunConfig = mailgunBaseline ? {
        provider: 'mailgun',
        apiKey: mailgunBaseline.apiKey || '',
        domain: mailgunBaseline.domain || '',
        from: mailgunBaseline.from || ''
    } : (config?.emailConfig?.mailgun || {});

    const emailConfigPatch = {};
    const nextEnableEmail = !!document.getElementById('configEnableEmail').checked;
    if (!!prevEmailConfig.enableEmail !== nextEnableEmail) {
        emailConfigPatch.enableEmail = nextEnableEmail;
    }

    // Get provider selection
    const nextProvider = document.getElementById('configEmailProvider')?.value || 'smtp';
    if ((prevEmailConfig.provider || 'smtp') !== nextProvider) {
        emailConfigPatch.provider = nextProvider;
    }

    // SMTP settings (only if provider is smtp)
    if (nextProvider === 'smtp') {
        const nextSmtpHost = (document.getElementById('configSmtpHost').value || '').trim();
        if ((prevEmailConfig.host || '') !== nextSmtpHost) {
            emailConfigPatch.host = nextSmtpHost;
        }

        const portRaw = (document.getElementById('configSmtpPort').value || '').toString().trim();
        const prevPort = Number(prevEmailConfig.port || 587);
        const nextPort = portRaw ? Number.parseInt(portRaw, 10) : prevPort;
        if (Number.isFinite(nextPort) && prevPort !== nextPort) {
            emailConfigPatch.port = nextPort;
        }

        const nextSmtpSecure = !!document.getElementById('configSmtpSecure').checked;
        if (!!prevEmailConfig.secure !== nextSmtpSecure) {
            emailConfigPatch.secure = nextSmtpSecure;
        }

        const nextSmtpUser = (document.getElementById('configSmtpUser').value || '').trim();
        if ((prevEmailConfig.user || '') !== nextSmtpUser) {
            emailConfigPatch.user = nextSmtpUser;
        }

        // SMTP Password handling: only save when user entered a NEW password (not masked).
        const smtpPassField = document.getElementById('configSmtpPass').value;
        const MASKED_PASSWORD = '********';
        if (smtpPassField && smtpPassField !== MASKED_PASSWORD) {
            emailConfigPatch.pass = smtpPassField;
        }
    }

    // Mailgun settings (only if provider is mailgun)
    if (nextProvider === 'mailgun') {
        const nextMailgunApiKey = (document.getElementById('configMailgunApiKey').value || '').trim();
        if ((prevMailgunConfig.apiKey || '') !== nextMailgunApiKey) {
            emailConfigPatch.mailgun = { ...emailConfigPatch.mailgun, apiKey: nextMailgunApiKey };
        }

        const nextMailgunDomain = (document.getElementById('configMailgunDomain').value || '').trim();
        if ((prevMailgunConfig.domain || '') !== nextMailgunDomain) {
            emailConfigPatch.mailgun = { ...emailConfigPatch.mailgun, domain: nextMailgunDomain };
        }

        const nextFrom = (document.getElementById('configEmailFrom').value || '').trim();
        if ((prevMailgunConfig.from || '') !== nextFrom) {
            emailConfigPatch.mailgun = { ...emailConfigPatch.mailgun, from: nextFrom };
        }
    }

    // Common: from address (used by both providers)
    const nextFrom = (document.getElementById('configEmailFrom').value || '').trim();
    if ((prevEmailConfig.from || '') !== nextFrom) {
        emailConfigPatch.from = nextFrom;
    }

    if (Object.keys(emailConfigPatch).length > 0) {
        patch.emailConfig = emailConfigPatch;
    }

    if (Object.keys(patch).length === 0) {
        showToast('No changes to save', 'info');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch)
        });
        
        if (response.ok) {
            // Update local config with new values
            config = mergeLocal(config, patch);
            applyConfig();
            applySortAndFilter(); // Re-render table with new fields
            
            // Reload email config and update badge
            if (patch.emailConfig) {
                try {
                    await fetch(`${API_URL}/email/reload`, { method: 'POST' });
                } catch (e) {
                    console.error('Error reloading email config:', e);
                }
            }
            await updateEmailStatusBadge();
            
            // Clear password fields and checkboxes after successful save
            document.getElementById('configAdminPassword').value = '';
            document.getElementById('configUserPassword').value = '';
            const clearAdminCheckbox = document.getElementById('clearAdminPassword');
            const clearUserCheckbox = document.getElementById('clearUserPassword');
            if (clearAdminCheckbox) clearAdminCheckbox.checked = false;
            if (clearUserCheckbox) clearUserCheckbox.checked = false;
            
            // If passwords were cleared, log out and redirect to home
            if (clearAdminPassword || clearUserPassword) {
                showToast('Settings saved. Logging out...', 'success');
                setTimeout(() => {
                    logout();
                }, 1000);
                return;
            }
            
            closeSettingsModal();
            showToast('Settings saved successfully. Configuration reloaded.', 'success');
            
            // Reload all configuration on server side
            try {
                await fetch(`${API_URL}/reload-config`, { method: 'POST' });
            } catch (e) {
                console.error('Error reloading config:', e);
            }
        } else {
            showToast('Error saving settings', 'error');
        }
    } catch (error) {
        console.error('Error saving settings:', error);
        showToast('Error saving settings', 'error');
    }
}

// Send a test email using the settings currently entered on the Settings page.
// Note: this does NOT save config.json.
async function sendTestEmailFromSettings() {
    // First, get the current email status from server (includes .env values)
    let emailStatus = null;
    try {
        const response = await fetch('/api/email/status');
        if (response.ok) {
            emailStatus = await response.json();
        }
    } catch (e) {
        console.error('Error fetching email status:', e);
    }
    
    const to = (document.getElementById('configTestEmailTo')?.value || '').trim();
    const from = (document.getElementById('configEmailFrom')?.value || '').trim();
    
    // Get provider from form or status
    const provider = document.getElementById('configEmailProvider')?.value || emailStatus?.provider || 'smtp';
    
    let emailConfig = {};
    
    if (provider === 'mailgun') {
        // Mailgun configuration
        const apiKey = (document.getElementById('configMailgunApiKey')?.value || '').trim();
        const domain = (document.getElementById('configMailgunDomain')?.value || '').trim();
        
        emailConfig = {
            provider: 'mailgun',
            apiKey: apiKey || emailStatus?.mailgun?.apiKey || '',
            domain: domain || emailStatus?.mailgun?.domain || '',
            from: from || emailStatus?.from || ''
        };
        
        if (!to) {
            showToast('Enter a test recipient email address', 'error');
            return;
        }
        if (!to.includes('@')) {
            showToast('Enter a valid test recipient email address', 'error');
            return;
        }
        if (!emailConfig.apiKey) {
            showToast('Mailgun API Key is required - enter it in the form or check .env', 'error');
            return;
        }
        if (!emailConfig.domain) {
            showToast('Mailgun Domain is required - enter it in the form or check .env', 'error');
            return;
        }
    } else {
        // SMTP configuration (default)
        const host = (document.getElementById('configSmtpHost')?.value || '').trim();
        const portRaw = document.getElementById('configSmtpPort')?.value;
        const port = parseInt(portRaw, 10);
        const secure = !!document.getElementById('configSmtpSecure')?.checked;
        const user = (document.getElementById('configSmtpUser')?.value || '').trim();
        const passField = document.getElementById('configSmtpPass')?.value || '';
        
        // PASSWORD HANDLING FOR TEST EMAIL:
        // If password field is masked (********) or empty, send it to server which will load from config/env
        // If user entered a new password, send that
        const MASKED_PASSWORD = '********';
        let finalPass = passField;
        
        // Server will handle masked/empty password by loading from config.json or .env
        console.log('[sendTestEmail] Password field value:', passField === MASKED_PASSWORD ? 'MASKED' : (passField ? 'USER_ENTERED' : 'EMPTY'));

        emailConfig = {
            provider: 'smtp',
            host: host || emailStatus?.emailConfig?.host || '',
            port: (port && port > 0) ? port : (emailStatus?.emailConfig?.port || 587),
            secure: secure || emailStatus?.emailConfig?.secure || false,
            user: user || emailStatus?.emailConfig?.user || '',
            pass: finalPass,
            from: from || emailStatus?.from || ''
        };
        
        if (!to) {
            showToast('Enter a test recipient email address', 'error');
            return;
        }
        if (!to.includes('@')) {
            showToast('Enter a valid test recipient email address', 'error');
            return;
        }
        if (!emailConfig.host) {
            showToast('SMTP Host is required - enter it in the form or check .env', 'error');
            return;
        }
        if (!emailConfig.user) {
            showToast('SMTP Username is required - enter it in the form or check .env', 'error');
            return;
        }
    }

    const btn = document.getElementById('sendTestEmailBtn');
    const originalText = btn?.textContent;
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Sending...';
    }

    try {
        const response = await fetch(`${API_URL}/email/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                to,
                emailConfig
            })
        });

        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            showToast(result.error || 'Test email failed', 'error');
            return;
        }

        showToast(`Test email sent to ${to}${result.messageId ? ' (id: ' + result.messageId + ')' : ''}`, 'success');
    } catch (error) {
        console.error('Error sending test email:', error);
        showToast('Error sending test email', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = originalText || 'Send Test Email';
        }
    }
}

// Reload authentication configuration from config.json
async function reloadAuthConfig() {
    const btn = document.getElementById('reloadAuthBtn');
    const originalText = btn?.textContent;
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Reloading...';
    }

    try {
        const response = await fetch(`${API_URL}/auth/reload`, {
            method: 'POST'
        });

        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            showToast(result.error || 'Failed to reload auth config', 'error');
            return;
        }

        showToast(result.message, 'success');
        
        // Re-check authentication state
        await checkAuthentication();
        renderNavigation();
    } catch (error) {
        console.error('Error reloading auth config:', error);
        showToast('Error reloading auth configuration', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = originalText || 'Reload Auth Configuration';
        }
    }
}

// Reload all configuration from config.json
async function reloadAllConfig() {
    const btn = document.getElementById('reloadAllConfigBtn');
    const originalText = btn?.textContent;
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Reloading...';
    }

    try {
        const response = await fetch(`${API_URL}/reload-config`, {
            method: 'POST'
        });

        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            showToast(result.error || 'Failed to reload configuration', 'error');
            return;
        }

        showToast(result.message || 'All configuration reloaded successfully', 'success');
        
        // Reload config and auth in sequence
        await loadConfig();
        await checkAuthentication();
        renderNavigation();
        applyConfig();
        
        // Update email status badge
        await updateEmailStatusBadge();
    } catch (error) {
        console.error('Error reloading configuration:', error);
        showToast('Error reloading configuration', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = originalText || 'Reload All Configuration';
        }
    }
}

// Load error log (admin only)
async function loadErrorLog() {
    const statusEl = document.getElementById('errorLogStatus');
    const contentEl = document.getElementById('errorLogContent');
    
    if (statusEl) statusEl.textContent = 'Loading...';
    
    try {
        const response = await fetch(`${API_URL}/error-log`);
        const result = await response.json();
        
        if (result.exists && result.content) {
            contentEl.value = result.content;
            if (statusEl) statusEl.textContent = `Showing last ${result.lineCount} log entries`;
        } else {
            contentEl.value = 'No errors logged.';
            if (statusEl) statusEl.textContent = 'No error log found';
        }
    } catch (error) {
        console.error('Error loading error log:', error);
        contentEl.value = 'Error loading error log: ' + error.message;
        if (statusEl) statusEl.textContent = 'Error loading log';
    }
}

// Clear error log (admin only)
async function clearErrorLog() {
    const statusEl = document.getElementById('errorLogStatus');
    const contentEl = document.getElementById('errorLogContent');
    
    try {
        const response = await fetch(`${API_URL}/error-log`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            contentEl.value = '';
            if (statusEl) statusEl.textContent = 'Error log cleared';
            showToast('Error log cleared', 'success');
        } else {
            showToast('Error clearing error log', 'error');
        }
    } catch (error) {
        console.error('Error clearing error log:', error);
        showToast('Error clearing error log', 'error');
    }
}

// Show error log section if admin
function showErrorLogSection() {
    const section = document.getElementById('errorLogSection');
    if (section && isAdmin()) {
        section.style.display = 'block';
    }
}

function showSettingsModal() {
    if (!config) return;
    
    document.getElementById('configAppName').value = config.appName || '';
    
    // Handle font size (remove 'px' suffix for display)
    const fontSizeValue = config.fontSize || '16px';
    document.getElementById('configFontSize').value = fontSizeValue.replace('px', '');
    
    // Set font family dropdown
    document.getElementById('configFontFamily').value = config.fontFamily || 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    

    
    // Render table fields checkboxes
    renderTableFields();
    
    openModal('settingsModal');
}

function renderTableFields() {
    const container = document.getElementById('tableFieldsContainer');
    
    if (availableFields.length === 0) return;
    
    const currentFields = config?.tableFields || [];
    
    container.innerHTML = availableFields.map(field => `
        <div class="checkbox-item">
            <input type="checkbox" id="field_${field.value}" value="${field.value}" ${currentFields.includes(field.value) ? 'checked' : ''}>
            <label for="field_${field.value}">${field.label}</label>
        </div>
    `).join('');
}

function closeSettingsModal() {
    const modal = document.getElementById('settingsModal');
    if (modal) {
        modal.classList.remove('active');
    } else {
        // On settings page, redirect to members page after save
        window.location.href = 'index.html';
    }
}

async function searchMembers(query) {
    document.getElementById('searchInput').value = query;
    applySortAndFilter();
}

async function saveMember() {
    const memberId = document.getElementById('memberId').value;
    const sendWelcomeEmail = document.getElementById('sendWelcomeEmail')?.checked || false;
    const memberData = {
        first_name: document.getElementById('first_name').value,
        last_name: document.getElementById('last_name').value,
        email: document.getElementById('email').value,
        address: document.getElementById('address').value,
        city: document.getElementById('city').value,
        state: document.getElementById('state').value,
        zip: document.getElementById('zip').value,
        phone: document.getElementById('phone').value,
        phone_2: document.getElementById('phone_2').value,
        club: document.getElementById('club').value,
        fromarea: document.getElementById('fromarea').value,
        mailing_list: document.getElementById('mailing_list').value,
        fulltime_parttime: document.getElementById('fulltime_parttime').value,
        approved: document.getElementById('approved').value,
        tags: document.getElementById('tags').value.split(',').map(t => t.trim().toLowerCase().replace(/\s+/g, '')).filter(t => t)
    };
    
    // Check if coordinates were updated via geocoding
    const coordsField = document.getElementById('coordinatesJson');
    if (coordsField && coordsField.value) {
        try {
            memberData.coordinates = JSON.parse(coordsField.value);
        } catch (e) {
            console.error('Error parsing coordinates:', e);
        }
    }
    
    try {
        let response;
        if (memberId) {
            // Update existing member
            response = await fetch(`${API_URL}/members/${memberId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(memberData)
            });
        } else {
            // Add new member
            response = await fetch(`${API_URL}/members`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(memberData)
            });
        }
        
        const result = await response.json();
        
        if (!response.ok) {
            if (result.error && result.error.includes('email')) {
                showToast('This email address already exists in the system', 'error');
                return;
            }
            throw new Error(result.error || 'Error saving member');
        }
        
        closeModal();
        loadMembers();
        
        // Reload map data if on map page
        if (document.getElementById('map')) {
            await loadMapData();
        }
        
        // Handle welcome email
        if (sendWelcomeEmail && memberData.email && config?.welcomeTemplateId) {
            await sendWelcomeEmailToMember(result, config.welcomeTemplateId);
        }
        
        showToast(memberId ? 'Member updated successfully' : 'Member added successfully', 'success');
    } catch (error) {
        console.error('Error saving member:', error);
        showToast('Error saving member', 'error');
    }
}

// Function to re-geocode a member's address in edit mode
async function regeocodeCurrentMember() {
    debugLog('regeocodeCurrentMember called');
    const address = document.getElementById('address').value;
    const city = document.getElementById('city').value;
    const state = document.getElementById('state').value;
    const zip = document.getElementById('zip').value;
    
    debugLog('Address fields:', { address, city, state, zip });
    
    if (!address || !city) {
        debugLog('Missing required fields');
        showToast('Address and City are required for geocoding', 'error');
        return;
    }
    
    showToast('Geocoding address...', 'info');
    debugLog('Making API call to /api/geocode');
    
    try {
        const response = await fetch(`${API_URL}/geocode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address, city, state, zip })
        });
        
        debugLog('API response status:', response.status);
        const result = await response.json();
        debugLog('API result:', result);
        
        if (result.success && result.coordinates) {
            // Update the coordinates display
            const coordinatesDisplay = document.getElementById('coordinatesDisplay');
            const coordinatesInfo = document.getElementById('coordinatesInfo');
            const geocodeBtnContainer = document.getElementById('geocodeBtnContainer');
            
            coordinatesDisplay.style.display = 'block';
            coordinatesInfo.innerHTML = `
                Lat: ${result.coordinates.lat.toFixed(6)}, Lng: ${result.coordinates.lng.toFixed(6)}
                <br>Geocoded: ${new Date(result.coordinates.geocoded_at).toLocaleString()} via ${result.coordinates.geocode_source}
            `;
            
            // Update button text to indicate re-geocode is available
            if (geocodeBtnContainer) {
                geocodeBtnContainer.innerHTML = `
                    <button type="button" class="btn btn-secondary btn-sm" onclick="regeocodeCurrentMember()">🔄 Re-geocode</button>
                `;
            }
            
            // Store coordinates in a hidden field for saving
            let coordsField = document.getElementById('coordinatesJson');
            if (!coordsField) {
                coordsField = document.createElement('input');
                coordsField.type = 'hidden';
                coordsField.id = 'coordinatesJson';
                document.getElementById('memberForm').appendChild(coordsField);
            }
            coordsField.value = JSON.stringify(result.coordinates);
            
            showToast('Coordinates updated! Save to apply changes.', 'success');
        } else {
            showToast(result.error || 'Geocoding failed', 'error');
        }
    } catch (error) {
        console.error('Error geocoding:', error);
        showToast('Error geocoding address', 'error');
    }
}

async function sendWelcomeEmailToMember(member, templateId) {
    const template = templates.find(t => t.id === parseInt(templateId));
    if (!template) return;
    
    let subject = template.subject;
    let body = template.body;
    
    // Replace placeholders
    body = body.replace(/{{first_name}}/g, member.first_name || '');
    body = body.replace(/{{last_name}}/g, member.last_name || '');
    body = body.replace(/{{email}}/g, member.email || '');
    body = body.replace(/{{club}}/g, member.club || '');
    subject = subject.replace(/{{first_name}}/g, member.first_name || '');
    subject = subject.replace(/{{last_name}}/g, member.last_name || '');
    
    const emailData = {
        to: member.email,
        subject,
        body,
        templateId: templateId,
        memberData: member
    };
    
    try {
        await fetch(`${API_URL}/send-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(emailData)
        });
        
        // Reload email logs
        await loadEmailLogs();
        showToast('Welcome email sent', 'success');
    } catch (error) {
        console.error('Error sending welcome email:', error);
    }
}

function showSendWelcomeCheckbox() {
    const sendWelcomeGroup = document.getElementById('sendWelcomeGroup');
    if (!sendWelcomeGroup) return;
    
    const approved = document.getElementById('approved').value;
    const sendWelcomeCheckbox = document.getElementById('sendWelcomeEmail');
    
    // Show checkbox if:
    // For new members (originalApprovedValue is null): show if approved is "yes" and auto-send is enabled
    // For existing members: show if changing from "no" to "yes" and auto-send is enabled
    const isNewMember = originalApprovedValue === null;
    const isChangingToYes = approved === 'yes' && originalApprovedValue !== 'yes';
    const shouldShow = (isNewMember || isChangingToYes) && config?.autoSendWelcome && config?.welcomeTemplateId;
    
    if (shouldShow) {
        sendWelcomeGroup.style.display = 'block';
        sendWelcomeCheckbox.checked = true;
    } else {
        sendWelcomeGroup.style.display = 'none';
        sendWelcomeCheckbox.checked = false;
    }
}

// Email input debounce timer
let emailCheckTimeout = null;

function handleEmailInput() {
    const emailInput = document.getElementById('email');
    const emailWarning = document.getElementById('emailWarning');
    const email = emailInput.value.trim();
    const memberId = document.getElementById('memberId').value;
    
    // Clear previous timeout
    if (emailCheckTimeout) {
        clearTimeout(emailCheckTimeout);
    }
    
    // Clear warning if email is empty
    if (!email) {
        emailWarning.style.display = 'none';
        emailInput.classList.remove('input-warning');
        return;
    }
    
    // Debounce the email check (wait 500ms after user stops typing)
    emailCheckTimeout = setTimeout(async () => {
        try {
            const params = new URLSearchParams();
            params.append('email', email);
            if (memberId) {
                params.append('excludeId', memberId);
            }
            
            const response = await fetch(`${API_URL}/members/check-email?${params.toString()}`);
            const result = await response.json();
            
            if (result.exists) {
                emailWarning.textContent = `⚠️ This email is already used by member: ${result.memberName}`;
                emailWarning.style.display = 'block';
                emailInput.classList.add('input-warning');
            } else {
                emailWarning.style.display = 'none';
                emailInput.classList.remove('input-warning');
            }
        } catch (error) {
            console.error('Error checking email:', error);
        }
    }, 500);
}

async function deleteMember(id) {
    if (!confirm('Are you sure you want to delete this member?')) return;
    
    try {
        await fetch(`${API_URL}/members/${id}`, { method: 'DELETE' });
        loadMembers();
        showToast('Member deleted successfully', 'success');
    } catch (error) {
        console.error('Error deleting member:', error);
        showToast('Error deleting member', 'error');
    }
}

async function importCSV() {
    const fileInput = document.getElementById('csvFile');
    const file = fileInput.files[0];
    
    if (!file) {
        showToast('Please select a CSV file', 'error');
        return;
    }
    
    const reader = new FileReader();
    reader.onload = async (e) => {
        const csvContent = e.target.result;
        
        try {
            const response = await fetch(`${API_URL}/import/csv`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ csvContent })
            });
            
            const result = await response.json();
            closeImportModal();
            loadMembers();
            showToast(result.message, 'success');
            // Redirect to members list
            window.location.href = 'index.html';
        } catch (error) {
            console.error('Error importing CSV:', error);
            showToast('Error importing CSV', 'error');
        }
    };
    
    reader.readAsText(file);
}

async function saveTemplate() {
    const templateId = document.getElementById('templateId').value;
    const templateData = {
        name: document.getElementById('templateName').value,
        subject: document.getElementById('templateSubject').value,
        body: document.getElementById('templateBody').value
    };
    
    try {
        let response;
        if (templateId) {
            response = await fetch(`${API_URL}/templates/${templateId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(templateData)
            });
        } else {
            response = await fetch(`${API_URL}/templates`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(templateData)
            });
        }
        
        await response.json();
        closeTemplateFormModal();
        loadTemplates();
        showTemplatesModal(); // Refresh templates list
        showToast(templateId ? 'Template updated' : 'Template created', 'success');
    } catch (error) {
        console.error('Error saving template:', error);
        showToast('Error saving template', 'error');
    }
}

async function deleteTemplate(id) {
    if (!confirm('Are you sure you want to delete this template?')) return;
    
    try {
        await fetch(`${API_URL}/templates/${id}`, { method: 'DELETE' });
        loadTemplates();
        showTemplatesModal(); // Refresh templates list
        showToast('Template deleted', 'success');
    } catch (error) {
        console.error('Error deleting template:', error);
        showToast('Error deleting template', 'error');
    }
}

async function sendEmail() {
    const memberId = document.getElementById('emailMemberId').value;
    const templateId = document.getElementById('emailTemplate').value;
    const to = document.getElementById('emailTo').value;
    const subject = document.getElementById('emailSubject').value;
    
    // Get body content from Quill
    let body = '';
    if (window.emailQuill) {
        body = window.emailQuill.root.innerHTML;
        if (!body || body === '<p><br></p>') {
            body = window.emailQuill.getText();
        }
    } else {
        body = document.getElementById('emailBody').value;
    }
    
    if (!to) {
        showToast('Please enter a recipient email', 'error');
        return;
    }
    
    if (!subject || !body) {
        showToast('Please enter subject and body', 'error');
        return;
    }
    
    const memberData = members.find(m => m.id === parseInt(memberId));
    
    const emailData = {
        to,
        subject,
        body,
        templateId: templateId || null,
        memberData
    };
    
    try {
        const response = await fetch(`${API_URL}/send-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(emailData)
        });
        
        const result = await response.json();
        
        // Add to local email logs
        const newLog = {
            id: Date.now(),
            to,
            subject,
            body,
            templateName: templateId ? (templates.find(t => t.id === parseInt(templateId))?.name || 'Custom') : 'Custom',
            memberName: memberData ? `${memberData.first_name} ${memberData.last_name}` : 'N/A',
            sentAt: new Date().toISOString(),
            status: 'sent'
        };
        emailLogs.unshift(newLog);
        
        closeSendEmailModal();
        showToast('Email sent successfully', 'success');
    } catch (error) {
        console.error('Error sending email:', error);
        showToast('Error sending email', 'error');
    }
}

// Render Functions
function renderMembers(membersList) {
    const container = document.getElementById('membersList');
    if (!container) return;
    
    if (membersList.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <h3>No members found</h3>
                <p>Add a new member or import from CSV</p>
            </div>
        `;
        return;
    }
    
    // Get table fields from config, with defaults
    const tableFields = config?.tableFields || ['first_name', 'last_name', 'email', 'phone', 'approved', 'fromarea', 'tags'];
    
    // Field label mapping
    const fieldLabels = {
        last_name: 'Last Name',
        first_name: 'First Name',
        address: 'Address',
        fromarea: 'From Area',
        fulltime_parttime: 'Full/Part Time',
        email: 'Email',
        phone: 'Phone',
        approved: 'Approved',
        tags: 'Tags',
        club: 'Club',
        city: 'City',
        state: 'State',
        zip: 'Zip',
        phone_2: 'Phone 2',
        mailing_list: 'Mailing List',
        twg_subgroups: 'Subgroups'
    };
    
    // Generate table headers
    const headers = tableFields.map(field => `
        <th onclick="sortTable('${field}')">${fieldLabels[field] || field}</th>
    `).join('');
    
    // Check if user is admin (can edit/delete)
    const userIsAdmin = isAdmin();
    
    // Generate table rows
    const rows = membersList.map(member => {
        const cells = tableFields.map(field => {
            if (field === 'tags') {
                return `<td>${renderClickableTags(member.tags)}</td>`;
            }
            return `<td>${escapeHtml(member[field] || '-')}</td>`;
        }).join('');
        
        // Build actions based on role
        let actionsHtml = '';
        if (userIsAdmin) {
            actionsHtml = `
                <div class="member-actions">
                    <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); viewMemberOnMap(${member.id})" title="View on Map">📍 Map</button>
                    <button class="btn btn-sm btn-edit" onclick="editMember(${member.id})">Edit</button>
                    <button class="btn btn-sm btn-delete" onclick="deleteMember(${member.id})">Del</button>
                </div>
            `;
        } else {
            // User can only view on map
            actionsHtml = `
                <div class="member-actions">
                    <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); viewMemberOnMap(${member.id})" title="View on Map">📍 Map</button>
                </div>
            `;
        }
        
        return `
            <tr onclick="viewMember(${member.id})">
                ${cells}
                <td onclick="event.stopPropagation()">
                    ${actionsHtml}
                </td>
            </tr>
        `;
    }).join('');
    
    container.innerHTML = `
        <table class="members-table">
            <thead>
                <tr>
                    ${headers}
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                ${rows}
            </tbody>
        </table>
    `;
}

function renderClickableTags(tags) {
    if (!tags || !Array.isArray(tags) || tags.length === 0) {
        return '<span style="color: #999;">-</span>';
    }
    return tags.map(tag => 
        `<a class="tag-link" onclick="event.stopPropagation(); filterByTag('${escapeHtml(tag)}')">${escapeHtml(tag)}</a>`
    ).join(', ');
}

function sortTable(field) {
    const sortBySelect = document.getElementById('sortBy');
    if (sortBySelect) {
        sortBySelect.value = field;
        applySortAndFilter();
    }
}

function renderTemplates() {
    const container = document.getElementById('templatesList');
    
    if (templates.length === 0) {
        container.innerHTML = '<p class="empty-state">No templates yet. Create one to get started.</p>';
        return;
    }
    
    container.innerHTML = templates.map(template => `
        <div class="template-item">
            <h3>${escapeHtml(template.name)}</h3>
            <p><strong>Subject:</strong> ${escapeHtml(template.subject)}</p>
            <p>${escapeHtml(template.body.substring(0, 150))}${template.body.length > 150 ? '...' : ''}</p>
            <div class="template-actions">
                <button class="btn btn-sm btn-secondary" onclick="editTemplate(${template.id})">Edit</button>
                <button class="btn btn-sm btn-delete" onclick="deleteTemplate(${template.id})">Delete</button>
            </div>
        </div>
    `).join('');
}

function updateMemberCount(count) {
    const countElement = document.getElementById('memberCount');
    if (!countElement) return;
    
    const total = members.length;
    countElement.textContent = `${count} of ${total} member${total !== 1 ? 's' : ''}`;
}

// Modal Functions
function showAddMemberModal() {
    document.getElementById('modalTitle').textContent = 'Add New Member';
    document.getElementById('memberForm').reset();
    document.getElementById('memberId').value = '';
    
    // Reset original approved value for new member
    originalApprovedValue = null;
    
    // Show/hide send welcome email checkbox
    setTimeout(showSendWelcomeCheckbox, 100);
    
    openModal('memberModal');
}

let originalApprovedValue = null;

function showEditMemberModal(member) {
    document.getElementById('modalTitle').textContent = 'Edit Member';
    document.getElementById('memberId').value = member.id;
    document.getElementById('first_name').value = member.first_name || '';
    document.getElementById('last_name').value = member.last_name || '';
    document.getElementById('email').value = member.email || '';
    document.getElementById('address').value = member.address || '';
    document.getElementById('city').value = member.city || '';
    document.getElementById('state').value = member.state || '';
    document.getElementById('zip').value = member.zip || '';
    document.getElementById('phone').value = member.phone || '';
    document.getElementById('phone_2').value = member.phone_2 || '';
    document.getElementById('club').value = member.club || '';
    document.getElementById('fromarea').value = member.fromarea || '';
    document.getElementById('mailing_list').value = member.mailing_list || '';
    document.getElementById('fulltime_parttime').value = member.fulltime_parttime || '';
    document.getElementById('approved').value = member.approved || '';
    document.getElementById('tags').value = (member.tags || []).join(', ');
    
    // Store the original approved value to detect changes
    originalApprovedValue = member.approved;
    
    // Show/hide send welcome email checkbox based on approval change
    setTimeout(showSendWelcomeCheckbox, 100);
    
    // Display coordinates if member has them
    const coordinatesDisplay = document.getElementById('coordinatesDisplay');
    const coordinatesInfo = document.getElementById('coordinatesInfo');
    const geocodeBtnContainer = document.getElementById('geocodeBtnContainer');
    if (member.coordinates) {
        coordinatesDisplay.style.display = 'block';
        coordinatesInfo.innerHTML = `
            Lat: ${member.coordinates.lat.toFixed(6)}, Lng: ${member.coordinates.lng.toFixed(6)}
            ${member.coordinates.geocoded_at ? `<br>Geocoded: ${new Date(member.coordinates.geocoded_at).toLocaleString()}${member.coordinates.geocode_source ? ' via ' + member.coordinates.geocode_source : ''}` : ''}
        `;
        
        // Update button to show re-geocode
        if (geocodeBtnContainer) {
            geocodeBtnContainer.innerHTML = `
                <button type="button" class="btn btn-secondary btn-sm" onclick="regeocodeCurrentMember()">🔄 Re-geocode</button>
            `;
        }
        
        // Store existing coordinates in hidden field for saving
        let coordsField = document.getElementById('coordinatesJson');
        if (!coordsField) {
            coordsField = document.createElement('input');
            coordsField.type = 'hidden';
            coordsField.id = 'coordinatesJson';
            document.getElementById('memberForm').appendChild(coordsField);
        }
        coordsField.value = JSON.stringify(member.coordinates);
    } else {
        coordinatesDisplay.style.display = 'none';
        // Reset button to "Get Coordinates"
        if (geocodeBtnContainer) {
            geocodeBtnContainer.innerHTML = `
                <button type="button" class="btn btn-secondary btn-sm" onclick="regeocodeCurrentMember()">📍 Get Coordinates</button>
            `;
        }
    }
    
    openModal('memberModal');
}

function viewMember(id) {
    const member = members.find(m => m.id === id);
    if (!member) return;
    
    currentMember = member;
    
    // Build action buttons based on role
    let actionButtons = '<button type="button" class="btn btn-secondary" onclick="closeViewModal()">Close</button>';
    
    // Map view button for all authenticated users
    actionButtons += '<button type="button" class="btn btn-secondary" onclick="viewCurrentMemberOnMap()">📍 View on Map</button>';
    
    // Edit and Email buttons only for admin
    if (isAdmin()) {
        actionButtons += '<button type="button" class="btn btn-primary" id="sendWelcomeBtn">Send Email</button>';
        actionButtons += '<button type="button" class="btn btn-edit" onclick="editCurrentMember()">Edit</button>';
    }
    
    const details = `
        <div class="detail-row">
            <span class="detail-label">Name:</span>
            <span class="detail-value">${escapeHtml(member.first_name || '')} ${escapeHtml(member.last_name || '')}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Email:</span>
            <span class="detail-value">${escapeHtml(member.email || 'N/A')}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Phone:</span>
            <span class="detail-value">${escapeHtml(member.phone || 'N/A')}${member.phone_2 ? ' / ' + escapeHtml(member.phone_2) : ''}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Address:</span>
            <span class="detail-value">${escapeHtml(member.address || 'N/A')}</span>
        </div>
        ${member.coordinates ? `
        <div class="detail-row">
            <span class="detail-label" style="font-size: 0.75em; color: #888;">Coordinates:</span>
            <span class="detail-value" style="font-size: 0.75em; color: #888;">
                Lat: ${member.coordinates.lat.toFixed(6)}, Lng: ${member.coordinates.lng.toFixed(6)}
                ${member.coordinates.geocoded_at ? `<br>Geocoded: ${new Date(member.coordinates.geocoded_at).toLocaleString()}${member.coordinates.geocode_source ? ' via ' + member.coordinates.geocode_source : ''}` : ''}
            </span>
        </div>
        ` : ''}
        <div class="detail-row">
            <span class="detail-label">City:</span>
            <span class="detail-value">${escapeHtml(member.city || 'N/A')}, ${escapeHtml(member.state || '')} ${escapeHtml(member.zip || '')}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">From Area:</span>
            <span class="detail-value">${escapeHtml(member.fromarea || 'N/A')}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Club:</span>
            <span class="detail-value">${escapeHtml(member.club || 'N/A')}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Mailing List:</span>
            <span class="detail-value">${escapeHtml(member.mailing_list || 'N/A')}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Full/Part:</span>
            <span class="detail-value">${escapeHtml(member.fulltime_parttime || 'N/A')}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Approved:</span>
            <span class="detail-value">${escapeHtml(member.approved || 'N/A')}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Tags:</span>
            <span class="detail-value">${renderTags(member.tags)}</span>
        </div>
        <div class="detail-row" style="margin-top: 20px; color: #666; font-size: 0.9em;">
            <span class="detail-label">Date Created:</span>
            <span class="detail-value">${member.created_at ? new Date(member.created_at).toLocaleDateString() : 'N/A'}</span>
        </div>
    `;
    
    document.getElementById('memberDetails').innerHTML = details;
    
    // Update form actions based on role
    const formActions = document.querySelector('#viewModal .form-actions');
    if (formActions) {
        formActions.innerHTML = actionButtons;
        
        // Re-attach send welcome button event if it exists
        const sendWelcomeBtn = document.getElementById('sendWelcomeBtn');
        if (sendWelcomeBtn) {
            sendWelcomeBtn.addEventListener('click', () => {
                closeViewModal();
                showSendEmailModal(currentMember);
            });
        }
    }
    
    openModal('viewModal');
}

function editMember(id) {
    const member = members.find(m => m.id === id);
    if (!member) return;
    
    closeViewModal();
    showEditMemberModal(member);
}

function editCurrentMember() {
    if (currentMember) {
        editMember(currentMember.id);
    }
}

function viewMemberOnMap(id) {
    // Open map page in the MapTab tab with member ID parameter
    window.open(`member-map.html?member=${id}`, '_MapTab');
}

function viewCurrentMemberOnMap() {
    if (currentMember) {
        viewMemberOnMap(currentMember.id);
    }
}

function showImportModal() {
    document.getElementById('importForm').reset();
    openModal('importModal');
}

function showTemplatesModal() {
    renderTemplates();
    openModal('templatesModal');
}

function showAddTemplate() {
    document.getElementById('templateModalTitle').textContent = 'Add Template';
    document.getElementById('templateForm').reset();
    document.getElementById('templateId').value = '';
    closeTemplatesModal();
    openModal('templateFormModal');
}

function editTemplate(id) {
    const template = templates.find(t => t.id === id);
    if (!template) return;
    
    document.getElementById('templateModalTitle').textContent = 'Edit Template';
    document.getElementById('templateId').value = template.id;
    document.getElementById('templateName').value = template.name;
    document.getElementById('templateSubject').value = template.subject;
    document.getElementById('templateBody').value = template.body;
    closeTemplatesModal();
    openModal('templateFormModal');
}

function showSendEmailModal(member) {
    if (!member) return;
    
    document.getElementById('emailMemberId').value = member.id;
    document.getElementById('emailTo').value = member.email || '';
    document.getElementById('emailSubject').value = '';
    
    // Clear Quill editor
    if (window.emailQuill) {
        window.emailQuill.setContents([]);
    }
    document.getElementById('emailBody').value = '';
    
    // Populate template dropdown
    const templateSelect = document.getElementById('emailTemplate');
    templateSelect.innerHTML = '<option value="">No template (write custom email)</option>';
    templates.forEach(template => {
        const option = document.createElement('option');
        option.value = template.id;
        option.textContent = template.name;
        templateSelect.appendChild(option);
    });
    
    openModal('sendEmailModal');
}

function updateEmailFields() {
    const templateId = document.getElementById('emailTemplate').value;
    
    if (!templateId) {
        // Clear fields if no template selected
        document.getElementById('emailSubject').value = '';
        if (window.emailQuill) {
            window.emailQuill.setContents([]);
        }
        document.getElementById('emailBody').value = '';
        return;
    }
    
    const template = templates.find(t => t.id === parseInt(templateId));
    if (!template) return;
    
    let subject = template.subject;
    let body = template.body;
    
    // Replace placeholders with current member data
    if (currentMember) {
        body = body.replace(/{{first_name}}/g, currentMember.first_name || '');
        body = body.replace(/{{last_name}}/g, currentMember.last_name || '');
        body = body.replace(/{{email}}/g, currentMember.email || '');
        body = body.replace(/{{club}}/g, currentMember.club || '');
        subject = subject.replace(/{{first_name}}/g, currentMember.first_name || '');
        subject = subject.replace(/{{last_name}}/g, currentMember.last_name || '');
    }
    
    document.getElementById('emailSubject').value = subject;
    
    // Set Quill editor content
    if (window.emailQuill) {
        // Convert plain text to HTML if needed
        if (body && !body.includes('<')) {
            body = body.split('\n').map(line => line ? `<p>${escapeHtml(line)}</p>` : '<p><br></p>').join('');
        }
        window.emailQuill.clipboard.dangerouslyPasteHTML(body || '');
    }
    document.getElementById('emailBody').value = window.emailQuill ? window.emailQuill.root.innerHTML : body;
}

function previewEmail() {
    const to = document.getElementById('emailTo').value;
    const subject = document.getElementById('emailSubject').value;
    
    // Get body content from Quill
    let body = '';
    if (window.emailQuill) {
        body = window.emailQuill.root.innerHTML;
        if (!body || body === '<p><br></p>') {
            body = window.emailQuill.getText();
        }
    } else {
        body = document.getElementById('emailBody').value;
    }
    
    if (!to) {
        showToast('Please enter a recipient email', 'error');
        return;
    }
    
    if (!subject || !body) {
        showToast('Please enter subject and body', 'error');
        return;
    }
    
    document.getElementById('previewEmailTo').textContent = to;
    document.getElementById('previewEmailSubject').textContent = subject;
    document.getElementById('previewEmailBody').innerHTML = body;
    
    openModal('emailPreviewModal');
}

function closeEmailPreviewModal() {
    document.getElementById('emailPreviewModal').classList.remove('active');
}

function showEmailLog() {
    renderEmailLog();
    openModal('emailLogModal');
}

function renderEmailLog() {
    const container = document.getElementById('emailLogList');
    
    if (emailLogs.length === 0) {
        container.innerHTML = '<p class="empty-state">No emails sent yet.</p>';
        return;
    }
    
    container.innerHTML = emailLogs.map(log => `
        <div class="email-log-item">
            <div class="email-log-header">
                <span class="email-log-to">To: ${escapeHtml(log.to)}</span>
                <span class="email-log-date">${new Date(log.sentAt).toLocaleString()}</span>
            </div>
            <div class="email-log-subject"><strong>Subject:</strong> ${escapeHtml(log.subject)}</div>
            <div class="email-log-template">Template: ${escapeHtml(log.templateName)} | Member: ${escapeHtml(log.memberName)}</div>
            <div class="email-log-body">${log.body || ''}</div>
        </div>
    `).join('');
}

function closeEmailLogModal() {
    document.getElementById('emailLogModal').classList.remove('active');
}

function closeModal() {
    document.getElementById('memberModal').classList.remove('active');
}

function closeViewModal() {
    document.getElementById('viewModal').classList.remove('active');
}

function closeImportModal() {
    document.getElementById('importModal').classList.remove('active');
}

function closeTemplatesModal() {
    document.getElementById('templatesModal').classList.remove('active');
}

function closeTemplateFormModal() {
    document.getElementById('templateFormModal').classList.remove('active');
}

function closeSendEmailModal() {
    document.getElementById('sendEmailModal').classList.remove('active');
}

function openModal(modalId) {
    document.getElementById(modalId).classList.add('active');
}

// Clear Filters Function
function clearFilters() {
    // Clear search input
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.value = '';
    }
    
    // Clear active tag filter
    activeTagFilter = null;
    
    // Reset sort controls to defaults
    const sortBy = document.getElementById('sortBy');
    const sortOrder = document.getElementById('sortOrder');
    if (sortBy) sortBy.value = 'last_name';
    if (sortOrder) sortOrder.value = 'asc';
    
    // Re-render everything
    applySortAndFilter();
    renderTagFilter();
    showToast('Filters cleared', 'success');
}

// Utility Functions
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function renderTags(tags) {
    if (!tags || !Array.isArray(tags) || tags.length === 0) {
        return '<span style="color: #999;">No tags</span>';
    }
    return tags.map(tag => `<span class="badge badge-tag">${escapeHtml(tag)}</span>`).join(' ');
}

function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// Close modals only on button clicks (not outside click)
// The modal close functionality is handled by individual close functions

// Close modals on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        document.querySelectorAll('.modal.active').forEach(modal => {
            modal.classList.remove('active');
        });
    }
});

// Re-check auth state when page becomes visible (handles bfcache issues)
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
        await checkAuthentication();
        renderNavigation();
        ensureHamburgerVisible();
    }
});

// Handle page show event (bfcache)
window.addEventListener('pageshow', async (event) => {
    if (event.persisted) {
        // Page was restored from bfcache, re-check auth
        await checkAuthentication();
        renderNavigation();
        ensureHamburgerVisible();
    }
});

// ============================================
// BULK EMAIL FUNCTIONS
// ============================================

function setupBulkEmailListeners() {
    // Check if we're on tools page
    if (!document.getElementById('bulkEmailSection')) return;
    
    // Hide bulk email section for non-admin users
    if (!isAdmin()) {
        document.getElementById('bulkEmailSection').style.display = 'none';
        return;
    }
    
    // Load initial recipients and populate filters (only if not already initialized by page-specific script)
    if (!window.bulkEmailInitialized) {
        window.bulkEmailInitialized = true;
        loadBulkRecipients();
        populateBulkFilters();
        populateBulkTemplateDropdown();
    }
    
    // Filter controls
    document.getElementById('bulkApplyFilters').addEventListener('click', loadBulkRecipients);
    
    // Search with enter key
    document.getElementById('bulkSearch').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            loadBulkRecipients();
        }
    });
    
    // Selection controls
    document.getElementById('bulkSelectAll').addEventListener('click', () => bulkSelectAll(true));
    document.getElementById('bulkSelectNone').addEventListener('click', () => bulkSelectAll(false));
    document.getElementById('bulkSelectAllCheckbox').addEventListener('change', (e) => {
        bulkSelectAll(e.target.checked);
    });
    
    // Template selection
    document.getElementById('bulkTemplate').addEventListener('change', updateBulkEmailFields);
    
    // Preview and Send buttons
    document.getElementById('bulkPreviewBtn').addEventListener('click', bulkPreviewEmail);
    document.getElementById('bulkSendBtn').addEventListener('click', bulkSendEmail);
    
    // Preview modal controls
    document.getElementById('bulkPreviewClose').addEventListener('click', closeBulkPreviewModal);
    document.getElementById('bulkPreviewCancel').addEventListener('click', closeBulkPreviewModal);
    document.getElementById('bulkPreviewConfirm').addEventListener('click', confirmBulkSend);
}

async function loadBulkRecipients() {
    const tag = document.getElementById('bulkTagFilter').value;
    const club = document.getElementById('bulkClubFilter').value;
    const search = document.getElementById('bulkSearch').value;
    
    try {
        const params = new URLSearchParams();
        if (tag) params.append('tag', tag);
        if (club) params.append('club', club);
        if (search) params.append('search', search);
        
        const response = await fetch(`${API_URL}/recipients?${params.toString()}`);
        bulkRecipients = await response.json();
        
        renderBulkRecipients();
        updateBulkSelectedCount();
    } catch (error) {
        console.error('Error loading recipients:', error);
        showToast('Error loading recipients', 'error');
    }
}

function populateBulkFilters() {
    // Get all unique tags from members
    const allTags = new Set();
    members.forEach(m => {
        if (m.tags && Array.isArray(m.tags)) {
            m.tags.forEach(tag => allTags.add(tag));
        }
    });
    
    const tagFilter = document.getElementById('bulkTagFilter');
    const sortedTags = Array.from(allTags).sort();
    tagFilter.innerHTML = '<option value="">All Tags</option>' + 
        sortedTags.map(tag => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`).join('');
    
    // Get all unique clubs
    const allClubs = new Set();
    members.forEach(m => {
        if (m.club) allClubs.add(m.club);
    });
    
    const clubFilter = document.getElementById('bulkClubFilter');
    const sortedClubs = Array.from(allClubs).sort();
    clubFilter.innerHTML = '<option value="">All Clubs</option>' + 
        sortedClubs.map(club => `<option value="${escapeHtml(club)}">${escapeHtml(club)}</option>`).join('');
}

function populateBulkTemplateDropdown() {
    const templateSelect = document.getElementById('bulkTemplate');
    templateSelect.innerHTML = '<option value="">No template (custom message)</option>';
    templates.forEach(template => {
        const option = document.createElement('option');
        option.value = template.id;
        option.textContent = template.name;
        templateSelect.appendChild(option);
    });
}

function renderBulkRecipients() {
    const tbody = document.getElementById('bulkRecipientsBody');
    
    if (bulkRecipients.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No eligible recipients found. Only members with mailing_list = "No" are excluded.</td></tr>';
        return;
    }
    
    tbody.innerHTML = bulkRecipients.map(recipient => {
        const isSelected = bulkSelectedIds.has(recipient.id);
        return `
            <tr>
                <td><input type="checkbox" class="bulk-recipient-checkbox" data-id="${recipient.id}" ${isSelected ? 'checked' : ''}></td>
                <td>${escapeHtml(recipient.first_name || '')} ${escapeHtml(recipient.last_name || '')}</td>
                <td>${escapeHtml(recipient.email || '')}</td>
                <td>${escapeHtml(recipient.club || '-')}</td>
                <td>${renderTags(recipient.tags)}</td>
            </tr>
        `;
    }).join('');
    
    // Add checkbox listeners
    tbody.querySelectorAll('.bulk-recipient-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            const id = parseInt(e.target.dataset.id);
            if (e.target.checked) {
                bulkSelectedIds.add(id);
            } else {
                bulkSelectedIds.delete(id);
            }
            updateBulkSelectedCount();
            updateBulkSelectAllCheckbox();
        });
    });
}

function bulkSelectAll(select) {
    if (select) {
        bulkRecipients.forEach(r => bulkSelectedIds.add(r.id));
    } else {
        bulkSelectedIds.clear();
    }
    renderBulkRecipients();
    updateBulkSelectedCount();
    updateBulkSelectAllCheckbox();
}

function updateBulkSelectedCount() {
    document.getElementById('bulkSelectedCount').textContent = `${bulkSelectedIds.size} selected`;
    document.getElementById('bulkSendCount').textContent = bulkSelectedIds.size;
}

function updateBulkSelectAllCheckbox() {
    const checkbox = document.getElementById('bulkSelectAllCheckbox');
    if (bulkRecipients.length === 0) {
        checkbox.checked = false;
        checkbox.indeterminate = false;
    } else if (bulkSelectedIds.size === bulkRecipients.length) {
        checkbox.checked = true;
        checkbox.indeterminate = false;
    } else if (bulkSelectedIds.size > 0) {
        checkbox.checked = false;
        checkbox.indeterminate = true;
    } else {
        checkbox.checked = false;
        checkbox.indeterminate = false;
    }
}

function updateBulkEmailFields() {
    const templateId = document.getElementById('bulkTemplate').value;
    
    if (!templateId) {
        // Clear fields if no template selected
        document.getElementById('bulkSubject').value = '';
        if (window.bulkQuill) {
            window.bulkQuill.setContents([]);
        }
        return;
    }
    
    const template = templates.find(t => t.id === parseInt(templateId));
    if (!template) return;
    
    document.getElementById('bulkSubject').value = template.subject;
    
    // Set Quill editor content
    if (window.bulkQuill) {
        // Convert plain text to HTML if needed
        let bodyContent = template.body;
        if (bodyContent && !bodyContent.includes('<')) {
            // Plain text - convert to HTML paragraphs
            bodyContent = bodyContent.split('\n').map(line => line ? `<p>${escapeHtml(line)}</p>` : '<p><br></p>').join('');
        }
        window.bulkQuill.clipboard.dangerouslyPasteHTML(bodyContent || '');
    }
}

function bulkPreviewEmail() {
    const templateId = document.getElementById('bulkTemplate').value;
    const subject = document.getElementById('bulkSubject').value;
    
    // Get body content from Quill
    let body = '';
    if (window.bulkQuill) {
        body = window.bulkQuill.root.innerHTML;
        if (!body || body === '<p><br></p>') {
            body = window.bulkQuill.getText();
        }
    }
    
    if (bulkSelectedIds.size === 0) {
        showToast('Please select at least one recipient', 'error');
        return;
    }
    
    if (!subject || !body) {
        showToast('Please enter subject and body', 'error');
        return;
    }
    
    // Show preview for first selected recipient
    const firstRecipient = bulkRecipients.find(r => bulkSelectedIds.has(r.id));
    if (!firstRecipient) return;
    
    let previewSubject = subject;
    let previewBody = body;
    
    // Replace placeholders
    previewBody = previewBody.replace(/{{first_name}}/g, firstRecipient.first_name || '');
    previewBody = previewBody.replace(/{{last_name}}/g, firstRecipient.last_name || '');
    previewBody = previewBody.replace(/{{email}}/g, firstRecipient.email || '');
    previewBody = previewBody.replace(/{{club}}/g, firstRecipient.club || '');
    previewSubject = previewSubject.replace(/{{first_name}}/g, firstRecipient.first_name || '');
    previewSubject = previewSubject.replace(/{{last_name}}/g, firstRecipient.last_name || '');
    
    const previewContent = `
        <div class="preview-section">
            <p><strong>To:</strong> ${firstRecipient.first_name || ''} ${firstRecipient.last_name || ''} (${firstRecipient.email})</p>
            <p><strong>Subject:</strong> ${escapeHtml(previewSubject)}</p>
            <div class="preview-body">${previewBody}</div>
            <p class="preview-note"><em>This is a preview for the first selected recipient. All ${bulkSelectedIds.size} selected recipient(s) will receive personalized emails.</em></p>
        </div>
    `;
    
    document.getElementById('bulkPreviewContent').innerHTML = previewContent;
    openModal('bulkPreviewModal');
}

function closeBulkPreviewModal() {
    document.getElementById('bulkPreviewModal').classList.remove('active');
}

async function bulkSendEmail() {
    const templateId = document.getElementById('bulkTemplate').value;
    const batchSize = document.getElementById('bulkBatchSize').value;
    const subject = document.getElementById('bulkSubject').value;
    
    // Get body content from Quill
    let body = '';
    if (window.bulkQuill) {
        body = window.bulkQuill.root.innerHTML;
        if (!body || body === '<p><br></p>') {
            body = window.bulkQuill.getText();
        }
    }
    
    if (bulkSelectedIds.size === 0) {
        showToast('Please select at least one recipient', 'error');
        return;
    }
    
    if (!subject || !body) {
        showToast('Please enter subject and body', 'error');
        return;
    }
    
    // Confirm before sending
    const totalRecipients = bulkSelectedIds.size;
    const batches = Math.ceil(totalRecipients / batchSize);
    if (!confirm(`It will send individual email to each recipient in ${batches} batch(es).\n\nIs that okay?\n\nIf yes, then click Send.\nIf no, click Cancel.`)) {
        return;
    }
    
    const recipientIds = Array.from(bulkSelectedIds);
    
    // Show progress modal
    showBulkProgressModal();
    
    try {
        const response = await fetch(`${API_URL}/send-bulk-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                recipientIds,
                templateId: templateId || null,
                subject,
                body,
                batchSize: parseInt(batchSize)
            })
        });
        
        const result = await response.json();
        
        if (response.ok && result.jobId) {
            // Store job ID for potential reconnection
            const jobInfo = {
                jobId: result.jobId,
                startedAt: Date.now(),
                total: result.total
            };
            sessionStorage.setItem('bulkEmailJob', JSON.stringify(jobInfo));
            
            // Start polling job status
            bulkJobProgressInterval = setInterval(() => pollBulkJobStatus(result.jobId), 1000);
        } else {
            hideBulkProgressModal();
            showToast(result.error || 'Error starting bulk email', 'error');
        }
    } catch (error) {
        hideBulkProgressModal();
        console.error('Error starting bulk email:', error);
        showToast('Error starting bulk email', 'error');
    }
}

// Poll job status
async function pollBulkJobStatus(jobId) {
    try {
        const response = await fetch(`${API_URL}/jobs/${jobId}`);
        if (!response.ok) {
            throw new Error('Job not found');
        }
        
        const job = await response.json();
        
        // Update progress display
        updateBulkJobProgressDisplay(job);
        
        // Check if completed
        if (job.status === 'completed') {
            clearInterval(bulkJobProgressInterval);
            bulkJobProgressInterval = null;
            
            // Clear job from session storage
            sessionStorage.removeItem('bulkEmailJob');
            
            // Show success modal
            showBulkJobCompleteModal(job);
        } else if (job.status === 'failed') {
            clearInterval(bulkJobProgressInterval);
            bulkJobProgressInterval = null;
            
            // Clear job from session storage
            sessionStorage.removeItem('bulkEmailJob');
            
            // Show error modal
            showBulkJobErrorModal(job);
        }
        // Continue polling if pending or running
    } catch (error) {
        console.error('Error polling job status:', error);
        // Stop polling on error
        if (bulkJobProgressInterval) {
            clearInterval(bulkJobProgressInterval);
            bulkJobProgressInterval = null;
        }
        hideBulkProgressModal();
    }
}

// Update progress display for job
function updateBulkJobProgressDisplay(job) {
    const percent = job.percentage || 0;
    const progressBar = document.getElementById('bulkProgressBar');
    const progressPercent = document.getElementById('bulkProgressPercent');
    const progressDetail = document.getElementById('bulkProgressDetail');
    const progressStatus = document.getElementById('bulkProgressStatus');
    
    if (progressBar) progressBar.style.width = percent + '%';
    if (progressPercent) progressPercent.textContent = percent + '%';
    
    // Build detail text
    let detailText = `Email ${job.processedCount || 0} of ${job.totalRecipients || 0}`;
    const batches = Math.ceil((job.totalRecipients || 0) / (job.batchSize || 100));
    if (batches > 1) {
        const currentBatch = Math.ceil((job.processedCount || 0) / (job.batchSize || 100));
        detailText += ` | Batch ${Math.min(currentBatch, batches)} of ${batches}`;
    }
    
    if (progressDetail) progressDetail.textContent = detailText;
    
    const statusMessages = {
        pending: 'Waiting to start...',
        running: 'Sending emails...',
        completed: 'Complete!',
        failed: 'Failed'
    };
    
    if (progressStatus) progressStatus.textContent = statusMessages[job.status] || 'Processing...';
}

// Show job complete modal
function showBulkJobCompleteModal(job) {
    hideBulkProgressModal();
    
    const modal = document.getElementById('bulkJobCompleteModal');
    const messageEl = document.getElementById('bulkJobSuccessMessage');
    const statsEl = document.getElementById('bulkJobStats');
    
    // Build success message
    const sent = job.sentCount || 0;
    const failed = job.failedCount || 0;
    const total = job.totalRecipients || 0;
    
    messageEl.innerHTML = `<strong>${sent}</strong> email${sent !== 1 ? 's' : ''} sent successfully!`;
    
    // Build stats
    let statsHtml = `${total} total recipients`;
    if (failed > 0) {
        statsHtml += ` | <span style="color: #f44336;">${failed} failed</span>`;
    }
    if (job.simulatedCount > 0) {
        statsHtml += ` | ${job.simulatedCount} simulated`;
    }
    if (job.elapsedSeconds) {
        statsHtml += ` | Completed in ${job.elapsedSeconds}s`;
    }
    statsEl.innerHTML = statsHtml;
    
    // Set up continue button
    document.getElementById('bulkJobContinueBtn').onclick = () => {
        closeModal('bulkJobCompleteModal');
        window.location.href = 'index.html';
    };
    
    openModal('bulkJobCompleteModal');
}

// Show job error modal
function showBulkJobErrorModal(job) {
    hideBulkProgressModal();
    
    const modal = document.getElementById('bulkJobErrorModal');
    const messageEl = document.getElementById('bulkJobErrorMessage');
    const detailEl = document.getElementById('bulkJobErrorDetail');
    
    const sent = job.sentCount || 0;
    const failed = job.failedCount || 0;
    
    messageEl.innerHTML = `Job failed after sending ${sent} email${sent !== 1 ? 's' : ''}.`;
    detailEl.innerHTML = `Error: ${job.error || 'Unknown error'}<br>${failed} email${failed !== 1 ? 's' : ''} failed to send.`;
    
    // Set up buttons
    document.getElementById('bulkJobDismissBtn').onclick = () => {
        closeModal('bulkJobErrorModal');
    };
    
    document.getElementById('bulkJobRetryBtn').onclick = () => {
        closeModal('bulkJobErrorModal');
        // Retry by resending to failed recipients if any
        if (job.results && job.results.length > 0) {
            const failedIds = job.results
                .filter(r => r.status === 'failed')
                .map(r => r.memberId);
            if (failedIds.length > 0) {
                bulkSelectedIds = new Set(failedIds);
                updateBulkSelectedCount();
                renderBulkRecipients();
                showToast(`Selected ${failedIds.length} failed recipients for retry`, 'info');
            }
        }
    };
    
    openModal('bulkJobErrorModal');
}

// Check for existing job on page load
async function checkExistingBulkJob() {
    const jobData = sessionStorage.getItem('bulkEmailJob');
    if (!jobData) return;
    
    try {
        const jobInfo = JSON.parse(jobData);
        const job = await fetch(`${API_URL}/jobs/${jobInfo.jobId}`).then(r => r.json()).catch(() => null);
        
        if (job && (job.status === 'pending' || job.status === 'running')) {
            // Job still running - resume polling
            showBulkProgressModal();
            bulkJobProgressInterval = setInterval(() => pollBulkJobStatus(jobInfo.jobId), 1000);
        } else if (job && job.status === 'completed') {
            // Job completed while away - show success modal
            showBulkJobCompleteModal(job);
        } else if (job && job.status === 'failed') {
            // Job failed while away - show error modal
            showBulkJobErrorModal(job);
        } else {
            // Job not found or old - clear storage
            sessionStorage.removeItem('bulkEmailJob');
        }
    } catch (e) {
        sessionStorage.removeItem('bulkEmailJob');
    }
}

async function confirmBulkSend() {
    closeBulkPreviewModal();
    await bulkSendEmail();
}

// Bulk email progress polling
let bulkJobProgressInterval = null;

function showBulkProgressModal() {
    const modal = document.getElementById('bulkProgressModal');
    if (modal) {
        modal.classList.add('active');
    }
    // Reset progress display
    updateBulkJobProgressDisplay({
        processedCount: 0,
        totalRecipients: 0,
        status: 'pending',
        percentage: 0,
        batchSize: 100
    });
}

function hideBulkProgressModal() {
    const modal = document.getElementById('bulkProgressModal');
    if (modal) {
        modal.classList.remove('active');
    }
    // Stop polling
    if (bulkJobProgressInterval) {
        clearInterval(bulkJobProgressInterval);
        bulkJobProgressInterval = null;
    }
}

// Check for existing bulk email job on page load
async function initBulkJobCheck() {
    // Check if we're on the bulk email page
    if (!document.getElementById('bulkProgressModal')) return;
    
    // Check for existing job in session storage
    await checkExistingBulkJob();
}

function updateBulkProgressDisplay(current, total, status, batchCurrent = 0, batchTotal = 0) {
    // Legacy function - delegate to new job progress display
    updateBulkJobProgressDisplay({
        processedCount: current,
        totalRecipients: total,
        status: status === 'completed' ? 'completed' : 'running',
        percentage: total > 0 ? Math.round((current / total) * 100) : 0,
        batchSize: 100
    });
}

function clearBulkFilters() {
    document.getElementById('bulkTagFilter').value = '';
    document.getElementById('bulkClubFilter').value = '';
    document.getElementById('bulkSearch').value = '';
    loadBulkRecipients();
}

function clearBulkTemplate() {
    document.getElementById('bulkTemplate').value = '';
    document.getElementById('bulkSubject').value = '';
    if (window.bulkQuill) {
        window.bulkQuill.setContents([]);
    }
}

// ============================================
// MEMBER MAP FUNCTIONS
// ============================================

let memberMap = null;
let mapMarkers = [];
let mapData = [];

async function initMemberMap() {
    // Check if map element exists
    if (!document.getElementById('map')) return;
    
    // Initialize the map centered on Peoria, AZ
    memberMap = L.map('map').setView([33.5806, -112.2374], 15);
    
    // Add OpenStreetMap tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(memberMap);
    
    // Load map data
    await loadMapData();
    
    // Setup event listeners
    setupMapEventListeners();
    
    // Populate tag filter
    populateMapTagFilter();
    
    // Check if there's a member parameter in URL
    const urlParams = new URLSearchParams(window.location.search);
    const memberId = urlParams.get('member');
    if (memberId) {
        // Find and focus on the specific member
        focusMemberOnMap(parseInt(memberId));
        // Clear the parameter from URL
        window.history.replaceState({}, document.title, window.location.pathname);
    }
}

function focusMemberOnMap(memberId) {
    // Find the address group that contains this member
    const addressGroup = mapData.find(g => 
        g.members.some(m => m.id === memberId)
    );
    
    if (addressGroup && addressGroup.coordinates) {
        // Center map on the address location with zoom level 16
        memberMap.setView([addressGroup.coordinates.lat, addressGroup.coordinates.lng], 16);
        
        // Find and open the marker popup
        const marker = mapMarkers.find(m => 
            m.getLatLng().lat === addressGroup.coordinates.lat && 
            m.getLatLng().lng === addressGroup.coordinates.lng
        );
        
        if (marker) {
            marker.openPopup();
        }
        
        showToast('Focused on member location', 'success');
    } else {
        showToast('Member not found on map or has no coordinates', 'error');
    }
}

async function loadMapData(filters = {}) {
    try {
        const params = new URLSearchParams(filters);
        const response = await fetch(`${API_URL}/members/map-data?${params.toString()}`);
        const allMembers = await response.json();
        
        // Group members by coordinates (unique address)
        const addressGroups = {};
        allMembers.forEach(member => {
            if (!member.coordinates) return;
            
            // Create a unique key based on coordinates (rounded to 6 decimal places)
            const key = `${member.coordinates.lat.toFixed(6)},${member.coordinates.lng.toFixed(6)}`;
            if (!addressGroups[key]) {
                addressGroups[key] = {
                    coordinates: member.coordinates,
                    members: [],
                    address: member.address
                };
            }
            addressGroups[key].members.push(member);
        });
        
        // Convert to array
        mapData = Object.values(addressGroups);
        
        renderMapMarkers();
        updateMapStats();
    } catch (error) {
        console.error('Error loading map data:', error);
        showToast('Error loading map data', 'error');
    }
}

function renderMapMarkers() {
    // Clear existing markers
    mapMarkers.forEach(marker => memberMap.removeLayer(marker));
    mapMarkers = [];
    
    if (mapData.length === 0) {
        showToast('No members with coordinates found. Use the geocoding tool below.', 'info');
        return;
    }
    
    // Create custom icons for different clubs
    const kivaIcon = L.icon({
        iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-blue.png',
        shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
        iconSize: [25, 41],
        iconAnchor: [12, 41],
        popupAnchor: [1, -34],
        shadowSize: [41, 41]
    });
    
    const mitaIcon = L.icon({
        iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png',
        shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
        iconSize: [25, 41],
        iconAnchor: [12, 41],
        popupAnchor: [1, -34],
        shadowSize: [41, 41]
    });
    
    const defaultIcon = L.icon({
        iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-grey.png',
        shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
        iconSize: [25, 41],
        iconAnchor: [12, 41],
        popupAnchor: [1, -34],
        shadowSize: [41, 41]
    });
    
    // Add markers for each unique address
    mapData.forEach((addressGroup, index) => {
        const { coordinates, members, address } = addressGroup;
        
        // Determine icon based on members' clubs
        // Priority: Kiva > Mita > None
        const hasKiva = members.some(m => m.club === 'Kiva');
        const hasMita = members.some(m => m.club === 'Mita');
        let icon = defaultIcon;
        if (hasKiva) icon = kivaIcon;
        else if (hasMita) icon = mitaIcon;
        
        const marker = L.marker(
            [coordinates.lat, coordinates.lng],
            { icon }
        );
        
        // Create popup content
        const popupContent = createAddressPopupContent(addressGroup, index);
        
        marker.bindPopup(popupContent);
        marker.addTo(memberMap);
        mapMarkers.push(marker);
    });
    
    // Fit map to show all markers
    if (mapMarkers.length > 0) {
        const group = L.featureGroup(mapMarkers);
        memberMap.fitBounds(group.getBounds().pad(0.1));
    }
}

function createAddressPopupContent(addressGroup, groupIndex) {
    const { members, address } = addressGroup;
    
    if (members.length === 1) {
        // Single member - show details directly
        return createSingleMemberPopup(members[0]);
    }
    
    // Multiple members - show dropdown only (no details until selected)
    const memberOptions = members.map((m) => 
        `<option value="${m.id}">${escapeHtml(m.name)}</option>`
    ).join('');
    
    const groupId = `addressGroup_${groupIndex}`;
    
    // Store members data in global object for popup access
    window.mapPopupMembers = window.mapPopupMembers || {};
    window.mapPopupMembers[groupId] = members;
    
    return `
        <div class="popup-header">${escapeHtml(address)}</div>
        <div class="popup-detail"><strong>${members.length} members at this address</strong></div>
        <div class="popup-detail">
            <label style="font-size: 0.85em; color: #666;">Select Member:</label>
            <select id="${groupId}_select" onchange="updatePopupMemberDetails('${groupId}', this.value)" style="width: 100%; padding: 6px; margin-top: 3px; border-radius: 4px; border: 1px solid #ddd;">
                ${memberOptions}
            </select>
        </div>
        <div id="${groupId}_details"></div>
        <div class="popup-actions" id="${groupId}_actions"></div>
    `;
}

function updatePopupMemberDetails(groupId, memberId) {
    const members = window.mapPopupMembers && window.mapPopupMembers[groupId];
    const member = members && members.find(m => m.id == memberId);
    if (member) {
        // Show the full single member popup content
        document.getElementById(groupId + '_details').innerHTML = `
            <div class="popup-detail"><strong>Name:</strong> ${escapeHtml(member.name)}</div>
            <div class="popup-detail"><strong>Email:</strong> ${escapeHtml(member.email || 'N/A')}</div>
            <div class="popup-detail"><strong>Phone:</strong> ${escapeHtml(member.phone || 'N/A')}</div>
            <div class="popup-detail"><strong>Club:</strong> ${escapeHtml(member.club || 'None')}</div>
            <div class="popup-detail"><strong>Tags:</strong> ${member.tags && member.tags.length > 0 ? member.tags.map(t => escapeHtml(t)).join(', ') : 'None'}</div>
        `;
        
        // Update action buttons
        const actionsDiv = document.getElementById(groupId + '_actions');
        let popupActions = `<button class="btn btn-sm btn-primary" onclick="viewMemberFromMap(${member.id})">View</button>`;
        if (isAdmin()) {
            popupActions += `<button class="btn btn-sm btn-edit" onclick="editMemberFromMap(${member.id})">Edit</button>`;
        }
        actionsDiv.innerHTML = popupActions;
    }
}

function createMemberDetailsHtml(member) {
    return `
        <div class="popup-detail"><strong>Email:</strong> ${escapeHtml(member.email || 'N/A')}</div>
        <div class="popup-detail"><strong>Phone:</strong> ${escapeHtml(member.phone || 'N/A')}</div>
        <div class="popup-detail"><strong>Club:</strong> ${escapeHtml(member.club || 'None')}</div>
        <div class="popup-detail"><strong>Tags:</strong> ${member.tags && member.tags.length > 0 ? member.tags.map(t => escapeHtml(t)).join(', ') : 'None'}</div>
    `;
}

function createSingleMemberPopup(member) {
    let popupActions = `<button class="btn btn-sm btn-primary" onclick="viewMemberFromMap(${member.id})">View</button>`;
    if (isAdmin()) {
        popupActions += `<button class="btn btn-sm btn-edit" onclick="editMemberFromMap(${member.id})">Edit</button>`;
    }
    
    return `
        <div class="popup-header">${escapeHtml(member.address)}</div>
        <div class="popup-detail"><strong>Name:</strong> ${escapeHtml(member.name)}</div>
        <div class="popup-detail"><strong>Email:</strong> ${escapeHtml(member.email || 'N/A')}</div>
        <div class="popup-detail"><strong>Phone:</strong> ${escapeHtml(member.phone || 'N/A')}</div>
        <div class="popup-detail"><strong>Club:</strong> ${escapeHtml(member.club || 'None')}</div>
        <div class="popup-detail"><strong>Tags:</strong> ${member.tags && member.tags.length > 0 ? member.tags.map(t => escapeHtml(t)).join(', ') : 'None'}</div>
        <div class="popup-actions">
            ${popupActions}
        </div>
    `;
}

function updateMapStats() {
    document.getElementById('totalMembers').textContent = members.length;
    // Calculate total members at unique addresses
    const totalMembersAtAddresses = mapData.reduce((sum, g) => sum + g.members.length, 0);

    document.getElementById('uniqueAddresses').textContent = mapData.length;
    
    // Count addresses with Kiva/Mita members
    const kivaAddresses = mapData.filter(g => 
        g.members.some(m => m.club === 'Kiva')
    ).length;
    const mitaAddresses = mapData.filter(g => 
        g.members.some(m => m.club === 'Mita')
    ).length;
    
    document.getElementById('kivaMembers').textContent = kivaAddresses;
    document.getElementById('mitaMembers').textContent = mitaAddresses;
}

function setupMapEventListeners() {
    const applyBtn = document.getElementById('mapApplyFilters');
    const clearBtn = document.getElementById('mapClearFilters');
    const geocodeBtn = document.getElementById('geocodeAllBtn');
    const statsBtn = document.getElementById('checkStatsBtn');
    
    if (applyBtn) applyBtn.addEventListener('click', applyMapFilters);
    if (clearBtn) clearBtn.addEventListener('click', clearMapFilters);
    if (geocodeBtn) {
        // Only admin can geocode
        if (!isAdmin()) {
            geocodeBtn.style.display = 'none';
        } else {
            geocodeBtn.addEventListener('click', geocodeAllMembers);
        }
    }
    if (statsBtn) statsBtn.addEventListener('click', checkGeocodeStats);
}

async function applyMapFilters() {
    const filters = {
        club: document.getElementById('mapClubFilter').value,
        tag: document.getElementById('mapTagFilter').value,
        approved: document.getElementById('mapApprovedFilter').value
    };
    
    await loadMapData(filters);
}

function clearMapFilters() {
    document.getElementById('mapClubFilter').value = '';
    document.getElementById('mapTagFilter').value = '';
    document.getElementById('mapApprovedFilter').value = '';
    loadMapData();
}

function populateMapTagFilter() {
    const tagFilter = document.getElementById('mapTagFilter');
    if (!tagFilter) return;
    
    const allTags = new Set();
    members.forEach(m => {
        if (m.tags && Array.isArray(m.tags)) {
            m.tags.forEach(tag => allTags.add(tag));
        }
    });
    
    const sortedTags = Array.from(allTags).sort();
    tagFilter.innerHTML = '<option value="">All Tags</option>' +
        sortedTags.map(tag => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`).join('');
}

async function geocodeAllMembers() {
    if (!confirm('This will geocode all members without coordinates. This may take several minutes and requires an API key. Continue?')) {
        return;
    }
    
    const progressDiv = document.getElementById('geocodeProgress');
    const progressFill = document.getElementById('geocodeProgressFill');
    const statusText = document.getElementById('geocodeStatus');
    const geocodeBtn = document.getElementById('geocodeAllBtn');
    
    progressDiv.style.display = 'block';
    progressFill.style.width = '0%';
    progressFill.textContent = '0%';
    geocodeBtn.disabled = true;
    statusText.textContent = 'Starting geocoding process...';
    
    try {
        const response = await fetch(`${API_URL}/members/geocode-all`, {
            method: 'POST'
        });
        
        const result = await response.json();
        
        if (response.ok) {
            progressFill.style.width = '100%';
            progressFill.textContent = '100%';
            statusText.textContent = `Complete! Geocoded ${result.geocoded} members, skipped ${result.skipped}, failed ${result.failed}`;
            
            // Reload members and map data
            await loadMembers();
            await loadMapData();
            
            showToast(result.message, 'success');
        } else {
            statusText.textContent = 'Error: ' + result.error;
            showToast(result.error, 'error');
        }
    } catch (error) {
        console.error('Error geocoding members:', error);
        showToast('Error geocoding members', 'error');
        statusText.textContent = 'Error occurred during geocoding';
    } finally {
        geocodeBtn.disabled = false;
        setTimeout(() => {
            progressDiv.style.display = 'none';
            progressFill.style.width = '0%';
            progressFill.textContent = '0%';
        }, 5000);
    }
}

async function checkGeocodeStats() {
    try {
        const response = await fetch(`${API_URL}/members/geocode-stats`);
        const stats = await response.json();
        
        const message = `Geocoding Status:\n\n` +
            `Total Members: ${stats.total}\n` +
            `Geocoded: ${stats.geocoded} (${stats.percentage}%)\n` +
            `Needs Geocoding: ${stats.needsGeocoding}\n` +
            `Incomplete Addresses: ${stats.incomplete}`;
        
        alert(message);
    } catch (error) {
        console.error('Error checking stats:', error);
        showToast('Error checking geocoding stats', 'error');
    }
}

function viewMemberFromMap(id) {
    // View member in modal on current page (stays on map page)
    viewMember(id);
}

function editMemberFromMap(id) {
    // Edit member in modal on current page (stays on map page)
    editMember(id);
}

// Function to check URL parameters and handle view/edit actions
function checkUrlParameters() {
    // Only run on index.html page
    if (!document.getElementById('membersList')) return;
    
    const urlParams = new URLSearchParams(window.location.search);
    const viewId = urlParams.get('view');
    const editId = urlParams.get('edit');
    
    if (viewId) {
        // View member
        const member = members.find(m => m.id === parseInt(viewId));
        if (member) {
            setTimeout(() => {
                viewMember(member.id);
                // Remove the parameter from URL to prevent re-triggering on page refresh
                window.history.replaceState({}, document.title, window.location.pathname);
            }, 500); // Small delay to ensure page is fully loaded
        }
    } else if (editId) {
        // Edit member - only allow for admin
        if (!isAdmin()) {
            showToast('You do not have permission to edit members', 'error');
            window.history.replaceState({}, document.title, window.location.pathname);
            return;
        }
        const member = members.find(m => m.id === parseInt(editId));
        if (member) {
            setTimeout(() => {
                showEditMemberModal(member);
                // Remove the parameter from URL to prevent re-triggering on page refresh
                window.history.replaceState({}, document.title, window.location.pathname);
            }, 500); // Small delay to ensure page is fully loaded
        }
    }
}
