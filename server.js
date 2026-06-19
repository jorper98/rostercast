require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const nodemailer = require('nodemailer');
const Mailgun = require('mailgun.js');
const os = require('os');
const AdmZip = require('adm-zip');
const NodeGeocoder = require('node-geocoder');

// Load package.json for version info
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

const app = express();
const PORT = process.env.PORT || 3032;

// Increase timeout for long-running operations (bulk emails)
app.use((req, res, next) => {
    if (req.path.startsWith('/api/send-bulk-email')) {
        res.setTimeout(600000, () => {
            // 10 minutes for bulk email operations
            console.error('[TIMEOUT] Request timed out:', req.path);
            if (!res.headersSent) {
                res.status(504).json({ error: 'Request timed out. The operation took too long.' });
            }
        });
    }
    next();
});

// Server debug logging (disabled by default)
// Enable by running with: set DEBUG_LOGS=true && npm start
const DEBUG_LOGS = (process.env.DEBUG_LOGS || '').toLowerCase() === 'true';
const debugLog = (...args) => {
    if (DEBUG_LOGS) console.log(...args);
};

const ERROR_LOG_FILE = path.join(__dirname, 'data', 'error-log.txt');
function logErrorToFile(error, context = '') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${context}: ${error.message || error}\n${error.stack || ''}\n\n`;
    fs.appendFileSync(ERROR_LOG_FILE, logMessage);
    console.error(`[FILE LOG] ${context}:`, error.message || error);
}

// Session secret for authentication
// Middleware to parse JSON bodies (increased limit for PDF data)
app.use(express.json({ limit: '50mb' }));

// Middleware to parse cookies on every request
app.use((req, res, next) => {
    req.cookies = parseCookies(req);
    next();
});

// Set EJS as the template engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'public'));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Simple cookie parser
function parseCookies(req) {
    const cookies = {};
    if (req.headers.cookie) {
        req.headers.cookie.split(';').forEach(cookie => {
            const parts = cookie.split('=');
            const name = parts[0].trim();
            const value = parts.slice(1).join('=').trim();
            cookies[name] = decodeURIComponent(value);
        });
    }
    return cookies;
}

// Authentication configuration - read from config.json
const AUTH_CONFIG = {
    userPassword: null,
    adminPassword: null
};

// Initialize authentication config from config.json
function initializeAuth() {
    const config = readConfig();

    // Note: never log secrets (passwords, smtp pass). Keep any debug output minimal.
    debugLog('[AUTH INIT] initializing auth from config.json');
    
    // Environment variables override config.json so production credentials do not need to be stored in data/config.json.
    AUTH_CONFIG.userPassword = process.env.USER_PASSWORD || config.adminPasswords?.userPassword || '';
    AUTH_CONFIG.adminPassword = process.env.ADMIN_PASSWORD || config.adminPasswords?.adminPassword || '';

    debugLog('[AUTH INIT] userPassword set:', !!AUTH_CONFIG.userPassword);
    debugLog('[AUTH INIT] adminPassword set:', !!AUTH_CONFIG.adminPassword);
}

// NOTE: initializeAuth() is called AFTER config file initialization (see below)

// Simple session storage (in production, use Redis or similar)
const sessions = new Map();

// Generate session token
function generateToken() {
    return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Authentication middleware
function requireAuth(req, res, next) {
    // If auth is disabled, allow access with a mock session
    if (!AUTH_ENABLED) {
        req.auth = { role: 'admin' };
        return next();
    }
    
    const token = req.cookies?.authToken || req.headers.authorization?.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    
    const session = sessions.get(token);
    if (!session) {
        return res.status(401).json({ error: 'Invalid or expired session' });
    }
    
    // Check if session is expired (24 hours)
    if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
        sessions.delete(token);
        return res.status(401).json({ error: 'Session expired' });
    }
    
    // Update session activity
    session.lastActivity = Date.now();
    req.auth = session;
    next();
}

// Read-only access middleware
// - If auth is disabled: allow (admin)
// - If token is valid: allow (role from session)
// - If token missing/invalid AND PUBLIC_READONLY: allow as "user" (read-only)
function requireAuthOrPublicRead(req, res, next) {
    // If auth is disabled, allow access with a mock session
    if (!AUTH_ENABLED) {
        req.auth = { role: 'admin' };
        return next();
    }

    const token = req.cookies?.authToken || req.headers.authorization?.split(' ')[1];

    // No token: allow public read-only when enabled
    if (!token) {
        if (PUBLIC_READONLY) {
            req.auth = { role: 'user', publicReadOnly: true };
            return next();
        }
        return res.status(401).json({ error: 'Authentication required' });
    }

    const session = sessions.get(token);

    // Invalid session: fall back to public read-only when enabled
    if (!session) {
        if (PUBLIC_READONLY) {
            req.auth = { role: 'user', publicReadOnly: true };
            return next();
        }
        return res.status(401).json({ error: 'Invalid or expired session' });
    }

    // Expired session: fall back to public read-only when enabled
    if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
        sessions.delete(token);
        if (PUBLIC_READONLY) {
            req.auth = { role: 'user', publicReadOnly: true };
            return next();
        }
        return res.status(401).json({ error: 'Session expired' });
    }

    // Update session activity
    session.lastActivity = Date.now();
    req.auth = session;
    next();
}

// Admin-only middleware
function requireAdmin(req, res, next) {
    // If auth is disabled, allow admin access
    if (!AUTH_ENABLED) {
        return next();
    }
    
    if (!req.auth || req.auth.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

// Auth API routes
app.post('/api/auth/login', (req, res) => {
    // If auth is disabled, just return success
    if (!AUTH_ENABLED) {
        return res.json({ success: true, role: 'admin', token: 'mock' });
    }
    
    const { password } = req.body;
    
    if (!password) {
        return res.status(400).json({ success: false, error: 'Password is required' });
    }
    
    let role = null;
    
    if (password === AUTH_CONFIG.adminPassword) {
        role = 'admin';
    } else if (password === AUTH_CONFIG.userPassword) {
        role = 'user';
    }
    
    if (!role) {
        return res.status(401).json({ success: false, error: 'Invalid password' });
    }
    
    // Create session
    const token = generateToken();
    const session = {
        token,
        role,
        createdAt: Date.now(),
        lastActivity: Date.now()
    };
    
    sessions.set(token, session);
    
    // Set cookie (expires in 24 hours)
    res.cookie('authToken', token, {
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: 'lax'
    });
    
    res.json({ success: true, role, token });
});

app.post('/api/auth/logout', (req, res) => {
    const token = req.cookies?.authToken || req.headers.authorization?.split(' ')[1];
    
    if (token) {
        sessions.delete(token);
    }
    
    res.clearCookie('authToken');
    res.json({ success: true });
});

app.get('/api/auth/check', (req, res) => {
    // If auth is disabled, return authenticated as true
    if (!AUTH_ENABLED) {
        return res.json({ authenticated: true, role: 'admin', authEnabled: false, publicReadOnly: false });
    }
    
    const token = req.cookies?.authToken || req.headers.authorization?.split(' ')[1];
    
    if (!token) {
        return res.json({ authenticated: false, authEnabled: true, publicReadOnly: PUBLIC_READONLY });
    }
    
    const session = sessions.get(token);
    
    if (!session) {
        return res.json({ authenticated: false, authEnabled: true, publicReadOnly: PUBLIC_READONLY });
    }
    
    // Check if session is expired
    if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
        sessions.delete(token);
        return res.json({ authenticated: false, authEnabled: true, publicReadOnly: PUBLIC_READONLY });
    }
    
    res.json({
        authenticated: true,
        role: session.role,
        authEnabled: true,
        publicReadOnly: PUBLIC_READONLY
    });
});

app.get('/api/auth/role', requireAuth, (req, res) => {
    res.json({ role: req.auth.role });
});

// Data file paths
const DATA_DIR = path.join(__dirname, 'data');
const BACKUP_DIR = path.join(__dirname, 'data', 'backups');
const PDF_DIR = path.join(__dirname, 'data', 'pdfs');
const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
const JOBS_DIR = path.join(__dirname, 'data', 'jobs');
const MEMBERS_FILE = path.join(DATA_DIR, 'members.json');
const TEMPLATES_FILE = path.join(__dirname, 'data', 'email-templates.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const EMAIL_LOGS_FILE = path.join(DATA_DIR, 'email-logs.json');
const LATEST_PDF_FILE = path.join(DATA_DIR, 'latest-pdf.json');

// Ensure data and subdirectories exist
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}
if (!fs.existsSync(PDF_DIR)) {
    fs.mkdirSync(PDF_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(JOBS_DIR)) {
    fs.mkdirSync(JOBS_DIR, { recursive: true });
}

// Initialize latest PDF tracking file
if (!fs.existsSync(LATEST_PDF_FILE)) {
    fs.writeFileSync(LATEST_PDF_FILE, JSON.stringify({ filename: null, generatedAt: null }, null, 2));
}

// Initialize data files if they don't exist
if (!fs.existsSync(MEMBERS_FILE)) {
    fs.writeFileSync(MEMBERS_FILE, JSON.stringify([], null, 2));
}

if (!fs.existsSync(TEMPLATES_FILE)) {
    const defaultTemplates = [
        {
            id: 1,
            name: 'Welcome Template',
            subject: 'Welcome to our group!',
            body: `Dear {{first_name}},

Welcome to our group! We're thrilled to have you join us.

Best regards,
RosterCast Team`
        }
    ];
    fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(defaultTemplates, null, 2));
}

// Initialize config file if it doesn't exist
if (!fs.existsSync(CONFIG_FILE)) {
    const defaultConfig = {
        appName: "RosterCast",
        fontSize: "16px",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        tableFields: ["last_name", "first_name", "address", "tags"]
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
}

// Initialize authentication AFTER config file exists
initializeAuth();

// One-time config migration (strip deprecated fields from tableFields)
migrateConfig();

// Check if authentication is enabled
// Auth is enabled when at least one password is configured
// PUBLIC_READONLY controls whether public (non-logged-in) users can access read-only pages
let AUTH_ENABLED = false;
let PUBLIC_READONLY = false;

function updateAuthSettings() {
    AUTH_ENABLED = !!(AUTH_CONFIG.userPassword || AUTH_CONFIG.adminPassword);
    PUBLIC_READONLY = !!AUTH_CONFIG.adminPassword && !AUTH_CONFIG.userPassword;
    debugLog('[AUTH] AUTH_ENABLED:', AUTH_ENABLED);
    debugLog('[AUTH] PUBLIC_READONLY:', PUBLIC_READONLY);
}

// Initialize auth settings
updateAuthSettings();

// Initialize email logs file if it doesn't exist
if (!fs.existsSync(EMAIL_LOGS_FILE)) {
    fs.writeFileSync(EMAIL_LOGS_FILE, JSON.stringify([], null, 2));
}

// Helper functions
function readMembers() {
    try {
        const data = fs.readFileSync(MEMBERS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

function writeMembers(members) {
    fs.writeFileSync(MEMBERS_FILE, JSON.stringify(members, null, 2));
}

function readTemplates() {
    try {
        const data = fs.readFileSync(TEMPLATES_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

function readEmailLogs() {
    try {
        const data = fs.readFileSync(EMAIL_LOGS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

function writeEmailLogs(logs) {
    fs.writeFileSync(EMAIL_LOGS_FILE, JSON.stringify(logs, null, 2));
}

// ============================================
// JOB QUEUE FUNCTIONS
// ============================================

const JOB_FILE_PREFIX = 'job-';
const JOB_STATUS = {
    PENDING: 'pending',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed'
};

// Get job file path
function getJobFilePath(jobId) {
    return path.join(JOBS_DIR, `${JOB_FILE_PREFIX}${jobId}.json`);
}

// Create a new job
function createJob(type, data) {
    const jobId = Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    const job = {
        id: jobId,
        type: type,
        status: JOB_STATUS.PENDING,
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        totalRecipients: data.recipientIds?.length || 0,
        processedCount: 0,
        sentCount: 0,
        failedCount: 0,
        simulatedCount: 0,
        recipientIds: data.recipientIds || [],
        templateId: data.templateId || null,
        subject: data.subject || '',
        body: data.body || '',
        batchSize: data.batchSize || 100,
        results: [],
        error: null,
        message: null
    };
    
    saveJob(job);
    return job;
}

// Save job to file
function saveJob(job) {
    const jobFilePath = getJobFilePath(job.id);
    fs.writeFileSync(jobFilePath, JSON.stringify(job, null, 2));
}

// Get job by ID
function getJob(jobId) {
    const jobFilePath = getJobFilePath(jobId);
    if (!fs.existsSync(jobFilePath)) {
        return null;
    }
    try {
        const data = fs.readFileSync(jobFilePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading job file:', error);
        return null;
    }
}

// Update job status
function updateJobStatus(jobId, status, additionalData = {}) {
    const job = getJob(jobId);
    if (!job) return null;
    
    job.status = status;
    
    if (status === JOB_STATUS.RUNNING && !job.startedAt) {
        job.startedAt = new Date().toISOString();
    }
    
    if (status === JOB_STATUS.COMPLETED || status === JOB_STATUS.FAILED) {
        job.completedAt = new Date().toISOString();
    }
    
    // Merge additional data
    Object.assign(job, additionalData);
    
    saveJob(job);
    return job;
}

// Update job progress
function updateJobProgress(jobId, processed, sent, failed, simulated, results = []) {
    const job = getJob(jobId);
    if (!job) return null;
    
    job.processedCount = processed;
    job.sentCount = sent;
    job.failedCount = failed;
    job.simulatedCount = simulated;
    
    if (results.length > 0) {
        job.results = job.results.concat(results);
    }
    
    saveJob(job);
    return job;
}

// List all jobs
function listJobs() {
    try {
        const files = fs.readdirSync(JOBS_DIR);
        const jobs = files
            .filter(f => f.startsWith(JOB_FILE_PREFIX) && f.endsWith('.json'))
            .map(filename => {
                const jobFilePath = path.join(JOBS_DIR, filename);
                try {
                    const data = fs.readFileSync(jobFilePath, 'utf8');
                    const job = JSON.parse(data);
                    // Return summary (without results to save space)
                    const { results, ...summary } = job;
                    return summary;
                } catch (e) {
                    return null;
                }
            })
            .filter(j => j !== null)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return jobs;
    } catch (error) {
        console.error('Error listing jobs:', error);
        return [];
    }
}

// Delete job
function deleteJob(jobId) {
    const jobFilePath = getJobFilePath(jobId);
    if (fs.existsSync(jobFilePath)) {
        fs.unlinkSync(jobFilePath);
        return true;
    }
    return false;
}

// Clean up old completed jobs (older than specified days)
function cleanupOldJobs(daysOld = 7) {
    try {
        const files = fs.readdirSync(JOBS_DIR);
        const cutoffTime = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
        let deleted = 0;
        
        files.forEach(f => {
            if (f.startsWith(JOB_FILE_PREFIX) && f.endsWith('.json')) {
                const jobFilePath = path.join(JOBS_DIR, f);
                const stats = fs.statSync(jobFilePath);
                if (stats.birthtimeMs < cutoffTime) {
                    fs.unlinkSync(jobFilePath);
                    deleted++;
                }
            }
        });
        
        if (deleted > 0) {
            console.log(`[JOBS] Cleaned up ${deleted} old job files`);
        }
        return deleted;
    } catch (error) {
        console.error('Error cleaning up jobs:', error);
        return 0;
    }
}

// Run cleanup on startup
cleanupOldJobs();

// Read config file
function migrateConfig() {
    try {
        if (!fs.existsSync(CONFIG_FILE)) return;
        const data = fs.readFileSync(CONFIG_FILE, 'utf8');
        const cfg = JSON.parse(data);
        const removedFields = new Set(['fulltime_parttime', 'twg_subgroups']);
        if (Array.isArray(cfg.tableFields)) {
            const cleaned = cfg.tableFields.filter(f => !removedFields.has(f));
            if (cleaned.length !== cfg.tableFields.length) {
                cfg.tableFields = cleaned;
                fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
            }
        }
    } catch (error) {
        console.error('Config migration error:', error.message);
    }
}

function readConfig() {
    try {
        const data = fs.readFileSync(CONFIG_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return {};
    }
}

// Deep-merge helper for PATCH-like config updates.
// - Plain objects are merged recursively
// - Arrays are replaced
// - null is a valid value (explicitly overwrite)
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, patch) {
    const out = isPlainObject(base) ? { ...base } : {};
    if (!isPlainObject(patch)) return out;

    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;

        if (Array.isArray(value) || value === null || !isPlainObject(value)) {
            out[key] = value;
            continue;
        }

        out[key] = deepMerge(out[key], value);
    }

    return out;
}

// Email configuration from config.json
let emailConfig = null;
let transporter = null;
let mailgunClient = null;
let mailgunInstance = null;

function initializeEmail() {
    const config = readConfig();
    
    // Read SMTP credentials from .env
    const envSmtpUser = process.env.SMTP_USERNAME;
    const envSmtpPass = process.env.SMTP_PASSWORD;
    const envSmtpHost = process.env.SMTP_HOST;
    const envSmtpPort = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : null;
    const envSmtpSecure = process.env.SMTP_SECURE === 'true';
    
    // Read Mailgun credentials from .env
    const envMailgunApiKey = process.env.MAILGUN_API_KEY;
    const envMailgunDomain = process.env.MAILGUN_DOMAIN;
    const envMailgunFrom = process.env.MAILGUN_FROM;
    
    debugLog('[email-init] Loading email configuration...');
    
    // Default email config
    emailConfig = config.emailConfig || {
        enableEmail: false,
        provider: 'smtp',
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        user: '',
        pass: '',
        from: 'RosterCast <your-email@example.com>'
    };
    
    // Ensure provider field exists (default to 'smtp' for backward compatibility)
    if (!emailConfig.provider) {
        emailConfig.provider = 'smtp';
    }
    
    // Load SMTP settings from .env if not in config.json
    if (emailConfig.provider === 'smtp') {
        if (!emailConfig.user && envSmtpUser) {
            emailConfig.user = envSmtpUser;
        }
        if (!emailConfig.pass && envSmtpPass) {
            emailConfig.pass = envSmtpPass;
        }
        if (!emailConfig.host && envSmtpHost) {
            emailConfig.host = envSmtpHost;
        }
        if ((!emailConfig.port || emailConfig.port === 587) && envSmtpPort) {
            emailConfig.port = envSmtpPort;
        }
        if (emailConfig.secure === false && envSmtpSecure) {
            emailConfig.secure = envSmtpSecure;
        }
        if (!emailConfig.from) {
            if (envMailgunFrom) {
                emailConfig.from = envMailgunFrom;
            } else if (process.env.SMTP_FROM) {
                emailConfig.from = process.env.SMTP_FROM;
            }
        }
    }
    
    // Initialize Mailgun client if using mailgun provider
    mailgunClient = null;
    if (emailConfig.provider === 'mailgun') {
        let mailgunApiKey = emailConfig.mailgun?.apiKey || '';
        let mailgunDomain = emailConfig.mailgun?.domain || '';
        let mailgunFrom = emailConfig.mailgun?.from || '';
        
        // Load from .env if not in config.json
        if (!mailgunApiKey && envMailgunApiKey) {
            mailgunApiKey = envMailgunApiKey;
        }
        if (!mailgunDomain && envMailgunDomain) {
            mailgunDomain = envMailgunDomain;
        }
        if (!mailgunFrom && envMailgunFrom) {
            mailgunFrom = envMailgunFrom;
        }
        
        if (mailgunApiKey && mailgunDomain) {
            try {
                mailgunInstance = new Mailgun();
                mailgunClient = mailgunInstance.client({ username: 'api', key: mailgunApiKey });
                // Store the from address for sending
                emailConfig.mailgun = {
                    apiKey: mailgunApiKey,
                    domain: mailgunDomain,
                    from: mailgunFrom
                };
                debugLog('[email-init] Mailgun client initialized');
            } catch (error) {
                console.error('[email-init] Failed to initialize Mailgun client:', error.message);
            }
        } else {
            debugLog('[email-init] Mailgun API key or domain not configured');
        }
    }
    
    // Initialize SMTP transporter if using smtp provider
    transporter = null;
    if (emailConfig.provider === 'smtp') {
        if (emailConfig.enableEmail && emailConfig.user && emailConfig.pass) {
            transporter = nodemailer.createTransport({
                host: emailConfig.host,
                port: emailConfig.port,
                secure: emailConfig.secure,
                auth: {
                    user: emailConfig.user,
                    pass: emailConfig.pass
                }
            });
            debugLog('[email-init] SMTP transporter initialized');
        } else {
            debugLog('[email-init] Email sending disabled (configure SMTP settings in .env or config.json)');
        }
    }
    
    debugLog('[email-init] Final config:');
    debugLog('[email-init]   enableEmail:', emailConfig.enableEmail);
    debugLog('[email-init]   provider:', emailConfig.provider);
    if (emailConfig.provider === 'smtp') {
        debugLog('[email-init]   host:', emailConfig.host);
        debugLog('[email-init]   port:', emailConfig.port);
        debugLog('[email-init]   user:', emailConfig.user);
        debugLog('[email-init]   from:', emailConfig.from);
    } else if (emailConfig.provider === 'mailgun') {
        debugLog('[email-init]   domain:', emailConfig.mailgun?.domain);
        debugLog('[email-init]   from:', emailConfig.mailgun?.from);
    }
}

function isHtmlBody(body) {
    return typeof body === 'string' && /<[a-z][\s\S]*>/i.test(body);
}

function stripHtmlForEmail(html) {
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
        .replace(/<\/div>\s*<div[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Helper function to send email
async function sendEmail(to, subject, body) {
    if (!emailConfig) {
        initializeEmail();
    }
    
    if (!emailConfig.enableEmail) {
        // Email disabled - just log
        debugLog('Email (disabled):', { to, subject, body: body?.substring(0, 100) + '...' });
        return { success: true, simulated: true };
    }
    
    const htmlBody = isHtmlBody(body) ? body : body?.replace(/\n/g, '<br>');
    const textBody = isHtmlBody(body) ? stripHtmlForEmail(body) : body;

    // Send via Mailgun if configured
    if (emailConfig.provider === 'mailgun' && mailgunClient) {
        try {
            const result = await mailgunClient.messages().send({
                from: emailConfig.mailgun?.from || emailConfig.from,
                to,
                subject,
                text: textBody,
                html: htmlBody || ''
            });
            debugLog('Email sent via Mailgun:', result.id);
            return { success: true, messageId: result.id };
        } catch (error) {
            logErrorToFile(error, `sendEmail to ${to}`);
            return { success: false, error: error.message };
        }
    }
    
    // Fallback to SMTP
    if (!transporter) {
        debugLog('Email (no transporter):', { to, subject, body: body?.substring(0, 100) + '...' });
        return { success: true, simulated: true };
    }
    
    try {
        const info = await transporter.sendMail({
            from: emailConfig.from,
            to,
            subject,
            text: textBody,
            html: htmlBody || ''
        });
        debugLog('Email sent via SMTP:', info.messageId);
        return { success: true, messageId: info.messageId };
    } catch (error) {
        logErrorToFile(error, `sendEmail to ${to}`);
        return { success: false, error: error.message };
    }
}

// Initialize email on startup
initializeEmail();

// ============================================
// BULK EMAIL PROGRESS TRACKING
// ============================================

const bulkEmailProgress = {
    inProgress: false,
    total: 0,
    current: 0,
    batchTotal: 0,
    batchCurrent: 0,
    startedAt: null,
    status: 'idle'
};

// Reset progress tracking
function resetBulkEmailProgress() {
    bulkEmailProgress.inProgress = false;
    bulkEmailProgress.total = 0;
    bulkEmailProgress.current = 0;
    bulkEmailProgress.batchTotal = 0;
    bulkEmailProgress.batchCurrent = 0;
    bulkEmailProgress.startedAt = null;
    bulkEmailProgress.status = 'idle';
}

// Update progress
function updateBulkEmailProgress(current, total, batchCurrent = 0, batchTotal = 0) {
    bulkEmailProgress.current = current;
    bulkEmailProgress.total = total;
    bulkEmailProgress.batchCurrent = batchCurrent;
    bulkEmailProgress.batchTotal = batchTotal;
}

// Start bulk email progress tracking
function startBulkEmailProgress(total, batchTotal = 1) {
    bulkEmailProgress.inProgress = true;
    bulkEmailProgress.total = total;
    bulkEmailProgress.current = 0;
    bulkEmailProgress.batchTotal = batchTotal;
    bulkEmailProgress.batchCurrent = 0;
    bulkEmailProgress.startedAt = Date.now();
    bulkEmailProgress.status = 'sending';
}

// Get progress endpoint
app.get('/api/bulk-email/progress', requireAuth, (req, res) => {
    const elapsed = bulkEmailProgress.startedAt ? Math.round((Date.now() - bulkEmailProgress.startedAt) / 1000) : 0;
    const overallPercentage = bulkEmailProgress.total > 0 ? Math.round((bulkEmailProgress.current / bulkEmailProgress.total) * 100) : 0;
    
    res.json({
        inProgress: bulkEmailProgress.inProgress,
        total: bulkEmailProgress.total,
        current: bulkEmailProgress.current,
        batchTotal: bulkEmailProgress.batchTotal,
        batchCurrent: bulkEmailProgress.batchCurrent,
        percentage: overallPercentage,
        status: bulkEmailProgress.status,
        elapsedSeconds: elapsed,
        message: bulkEmailProgress.batchTotal > 1 
            ? `Batch ${bulkEmailProgress.batchCurrent} of ${bulkEmailProgress.batchTotal}`
            : 'Sending emails...'
    });
});

// ============================================
// GEOCODING CONFIGURATION
// ============================================

const geocoderOptions = {
    provider: 'google',
    apiKey: process.env.GOOGLE_API_KEY || process.env.GEOCODING_API_KEY || process.env.OPENCAGE_API_KEY || ''
};

let geocoder = null;
if (process.env.GOOGLE_API_KEY || process.env.GEOCODING_API_KEY) {
    geocoder = NodeGeocoder(geocoderOptions);
    debugLog('Geocoding service initialized (Google)');
} else if (process.env.OPENCAGE_API_KEY) {
    geocoder = NodeGeocoder({ provider: 'opencage', apiKey: process.env.OPENCAGE_API_KEY });
    debugLog('Geocoding service initialized (OpenCage)');
} else {
    debugLog('Geocoding disabled (set GOOGLE_API_KEY or OPENCAGE_API_KEY in .env file)');
}

// Helper function to geocode an address
async function geocodeAddress(address, city, state, zip) {
    if (!geocoder) {
        return null;
    }
    
    const fullAddress = `${address}, ${city}, ${state} ${zip}`;
    
    try {
        const results = await geocoder.geocode(fullAddress);
        
        if (results && results.length > 0) {
            return {
                lat: results[0].latitude,
                lng: results[0].longitude,
                formatted: results[0].formattedAddress
            };
        }
        return null;
    } catch (error) {
        console.error('Geocoding error for address:', fullAddress, error.message);
        return null;
    }
}

const PUBLIC_MEMBER_FIELDS = [
    'id',
    'first_name',
    'last_name',
    'address',
    'city',
    'state',
    'mailing_list',
    'approved',
    'tags',
    'coordinates'
];

function sanitizeMemberForPublic(member = {}) {
    const sanitized = {};
    PUBLIC_MEMBER_FIELDS.forEach(field => {
        if (member[field] !== undefined) {
            if (field === 'tags') {
                sanitized.tags = Array.isArray(member.tags) ? member.tags : [];
            } else if (field === 'coordinates') {
                const lat = Number(member.coordinates?.lat);
                const lng = Number(member.coordinates?.lng);
                if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
                    sanitized.coordinates = { lat, lng };
                }
            } else {
                sanitized[field] = member[field];
            }
        }
    });
    if (!sanitized.address && sanitized.city && sanitized.state) {
        sanitized.address = `${sanitized.city}, ${sanitized.state}`;
    }
    return sanitized;
}

function getPublicMembers(members) {
    return members
        .filter(member => String(member.approved || '').toLowerCase() === 'yes')
        .map(sanitizeMemberForPublic);
}

// API Routes

// Get all members (auth OR public read-only when USER_PASSWORD is not set)
app.get('/api/members', requireAuthOrPublicRead, (req, res) => {
    const members = readMembers();
    if (req.auth && req.auth.role === 'admin') {
        res.json(members);
    } else {
        res.json(getPublicMembers(members));
    }
});

// Search members (require authentication)
app.get('/api/members/search', requireAuth, (req, res) => {
    const query = (req.query.q || '').toLowerCase();
    const members = readMembers();
    const isAdminRequest = req.auth && req.auth.role === 'admin';

    if (!query) {
        return res.json(isAdminRequest ? members : members.map(sanitizeMemberForPublic));
    }

    const results = members.filter(member =>
        (member.first_name && member.first_name.toLowerCase().includes(query)) ||
        (member.last_name && member.last_name.toLowerCase().includes(query)) ||
        (member.email && member.email.toLowerCase().includes(query)) ||
        (member.city && member.city.toLowerCase().includes(query)) ||
        (member.tags && Array.isArray(member.tags) && member.tags.some(tag => tag.toLowerCase().includes(query))) ||
        (isAdminRequest && member.notes && member.notes.toLowerCase().includes(query))
    );

    res.json(isAdminRequest ? results : results.map(sanitizeMemberForPublic));
});

// Check if email already exists (MUST be before :id route) (require authentication)
app.get('/api/members/check-email', requireAuth, (req, res) => {
    const members = readMembers();
    const { email, excludeId } = req.query;
    
    if (!email || email.trim() === '') {
        return res.json({ exists: false });
    }
    
    const existingMember = members.find(m =>
        m.email && m.email.toLowerCase() === email.toLowerCase()
    );
    
    if (existingMember) {
        // If excludeId is provided and matches, consider it as not exists (editing same member)
        if (excludeId && parseFloat(excludeId) === existingMember.id) {
            return res.json({ exists: false });
        }
        return res.json({
            exists: true,
            memberId: existingMember.id,
            memberName: `${existingMember.first_name || ''} ${existingMember.last_name || ''}`.trim()
        });
    }
    
    res.json({ exists: false });
});

// Get map data (members with coordinates) - MUST be before :id route
// (auth OR public read-only when USER_PASSWORD is not set)
app.get('/api/members/map-data', requireAuthOrPublicRead, (req, res) => {
    const members = readMembers();
    const { tag, approved } = req.query;

    // Filter members with coordinates
    let mapMembers = members.filter(m => m.coordinates && m.coordinates.lat && m.coordinates.lng);

    // Apply filters
    if (tag) {
        mapMembers = mapMembers.filter(m =>
            m.tags && Array.isArray(m.tags) && m.tags.includes(tag)
        );
    }

    if (approved) {
        mapMembers = mapMembers.filter(m => m.approved === approved);
    }

    // Return minimal public map data
    const mapData = getPublicMembers(mapMembers).map(m => ({
        id: m.id,
        name: `${m.first_name || ''} ${m.last_name || ''}`.trim(),
        address: `${m.address || ''}, ${m.city || ''}, ${m.state || ''}`.replace(/,\s*$/, ''),
        tags: m.tags,
        approved: m.approved,
        coordinates: m.coordinates
    }));

    res.json(mapData);
});

// Get geocoding statistics - MUST be before :id route (require authentication)
app.get('/api/members/geocode-stats', requireAuth, (req, res) => {
    const members = readMembers();
    const total = members.length;
    const geocoded = members.filter(m => m.coordinates && m.coordinates.lat).length;
    const needsGeocoding = members.filter(m =>
        !m.coordinates && m.address && m.city && m.state
    ).length;
    const incomplete = members.filter(m =>
        !m.address || !m.city || !m.state
    ).length;
    
    res.json({
        total,
        geocoded,
        needsGeocoding,
        incomplete,
        percentage: total > 0 ? Math.round((geocoded / total) * 100) : 0
    });
});

// Geocode a single member - MUST be before :id route
app.post('/api/members/geocode/:id', requireAuth, async (req, res) => {
    if (!geocoder) {
        return res.status(503).json({ error: 'Geocoding service not configured. Set GOOGLE_API_KEY in .env file.' });
    }
    
    const members = readMembers();
    const memberId = parseFloat(req.params.id);
    const memberIndex = members.findIndex(m => m.id === memberId);
    
    if (memberIndex === -1) {
        return res.status(404).json({ error: 'Member not found' });
    }
    
    const member = members[memberIndex];
    
    if (!member.address || !member.city || !member.state) {
        return res.status(400).json({ error: 'Incomplete address information' });
    }
    
    try {
        const coords = await geocodeAddress(
            member.address,
            member.city,
            member.state,
            member.zip
        );
        
        if (coords) {
            members[memberIndex].coordinates = {
                ...coords,
                geocoded_at: new Date().toISOString(),
                geocode_source: 'google'
            };
            
            writeMembers(members);
            res.json({
                success: true,
                coordinates: members[memberIndex].coordinates,
                address: `${member.address}, ${member.city}, ${member.state} ${member.zip}`
            });
        } else {
            res.status(500).json({ error: 'Geocoding failed - no results returned' });
        }
    } catch (error) {
        console.error('Geocoding error:', error);
        res.status(500).json({ error: 'Geocoding failed: ' + error.message });
    }
});

// Ad-hoc geocoding from edit form (geocode address and return coordinates without saving)
app.post('/api/geocode', requireAuth, async (req, res) => {
    debugLog('[/api/geocode] Request received');
    
    if (!geocoder) {
        debugLog('[/api/geocode] Geocoder not initialized - missing API key');
        return res.status(503).json({ error: 'Geocoding service not configured. Set GOOGLE_API_KEY in .env file.' });
    }
    
    const { address, city, state, zip } = req.body;
    
    if (!address || !city) {
        debugLog('[/api/geocode] Missing address or city');
        return res.status(400).json({ error: 'Address and City are required for geocoding' });
    }
    
    debugLog('[/api/geocode] Calling geocodeAddress');
    
    try {
        const coords = await geocodeAddress(address, city, state, zip);
        debugLog('[/api/geocode] Geocode result received');
        
        if (coords) {
            res.json({
                success: true,
                coordinates: {
                    ...coords,
                    geocoded_at: new Date().toISOString(),
                    geocode_source: 'google'
                }
            });
        } else {
            debugLog('[/api/geocode] No results returned');
            res.status(500).json({ error: 'Geocoding failed - no results returned' });
        }
    } catch (error) {
        console.error('[/api/geocode] Error:', error);
        res.status(500).json({ error: 'Geocoding failed: ' + error.message });
    }
});

// Batch geocode all members
app.post('/api/members/geocode-all', requireAuth, async (req, res) => {
    if (!geocoder) {
        return res.status(503).json({ error: 'Geocoding service not configured. Set GOOGLE_API_KEY in .env file.' });
    }
    
    const members = readMembers();
    let geocoded = 0;
    let skipped = 0;
    let failed = 0;
    const errors = [];
    
    for (let i = 0; i < members.length; i++) {
        const member = members[i];
        
        // Skip if already geocoded
        if (member.coordinates && member.coordinates.lat && member.coordinates.lng) {
            skipped++;
            continue;
        }
        
        // Skip if incomplete address
        if (!member.address || !member.city || !member.state) {
            skipped++;
            continue;
        }
        
        try {
            const coords = await geocodeAddress(
                member.address,
                member.city,
                member.state,
                member.zip
            );
            
            if (coords) {
                members[i].coordinates = {
                    ...coords,
                    geocoded_at: new Date().toISOString(),
                    geocode_source: 'google'
                };
                geocoded++;
                debugLog(`Geocoded ${geocoded}/${members.length}: ${member.first_name} ${member.last_name}`);
            } else {
                failed++;
                errors.push(`${member.first_name} ${member.last_name}: No results`);
            }
            
            // Rate limiting - wait between requests (Google allows higher rate limits)
            await new Promise(resolve => setTimeout(resolve, 200));
        } catch (error) {
            failed++;
            errors.push(`${member.first_name} ${member.last_name}: ${error.message}`);
            console.error(`Failed to geocode ${member.first_name} ${member.last_name}:`, error.message);
        }
    }
    
    writeMembers(members);
    
    res.json({
        message: `Geocoded ${geocoded} members`,
        geocoded,
        skipped,
        failed,
        total: members.length,
        errors: errors.slice(0, 10) // Return first 10 errors
    });
});

// Get single member by ID (require authentication)
app.get('/api/members/:id', requireAuth, (req, res) => {
    const members = readMembers();
    const memberId = parseFloat(req.params.id);
    const member = members.find(m => m.id === memberId);

    if (!member) {
        return res.status(404).json({ error: 'Member not found' });
    }

    if (req.auth && req.auth.role === 'admin') {
        res.json(member);
    } else {
        res.json(sanitizeMemberForPublic(member));
    }
});

// Add new member
app.post('/api/members', requireAuth, (req, res) => {
    const members = readMembers();
    const { email } = req.body;
    const isAdminRequest = req.auth && req.auth.role === 'admin';

    // Check for duplicate email (case-insensitive)
    if (email && email.trim() !== '') {
        const existingMember = members.find(m => 
            m.email && m.email.toLowerCase() === email.toLowerCase()
        );
        if (existingMember) {
            return res.status(400).json({ 
                error: 'A member with this email address already exists',
                existingMemberId: existingMember.id
            });
        }
    }

    const body = { ...req.body };
    if (!isAdminRequest) {
        delete body.notes;
    }

    const newMember = {
        id: Date.now(),
        ...body,
        created_at: new Date().toISOString()
    };
    
    members.push(newMember);
    writeMembers(members);
    
    res.status(201).json(newMember);
});

// Update member
app.put('/api/members/:id', requireAuth, (req, res) => {
    const members = readMembers();
    const memberId = parseFloat(req.params.id);
    const index = members.findIndex(m => m.id === memberId);
    const isAdminRequest = req.auth && req.auth.role === 'admin';

    if (index === -1) {
        return res.status(404).json({ error: 'Member not found' });
    }

    const body = { ...req.body };
    if (!isAdminRequest) {
        delete body.notes;
    }

    members[index] = { ...members[index], ...body, updated_at: new Date().toISOString() };
    writeMembers(members);
    
    res.json(members[index]);
});

// Delete member
app.delete('/api/members/:id', requireAuth, (req, res) => {
    const members = readMembers();
    const memberId = parseFloat(req.params.id);
    const index = members.findIndex(m => m.id === memberId);
    
    if (index === -1) {
        return res.status(404).json({ error: 'Member not found' });
    }
    
    const deleted = members.splice(index, 1);
    writeMembers(members);
    
    res.json(deleted[0]);
});

// Import CSV
app.post('/api/import/csv', requireAuth, (req, res) => {
    const members = readMembers();
    const records = [];
    
    const parser = parse(req.body.csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true
    });
    
    parser.on('readable', function() {
        let record;
        while ((record = parser.read()) !== null) {
            const member = {
                id: Date.now() + Math.floor(Math.random() * 10000),
                first_name: record.first_name || '',
                last_name: record.last_name || '',
                address: record.address || '',
                city: record.city || '',
                state: record.state || '',
                zip: record.zip || '',
                phone: record.phone || '',
                email: record.email || '',
                mailing_list: record.mailing_list || '',
                approved: record.approved || '',
                notes: record.notes || '',
                tags: [],
                created_at: new Date().toISOString()
            };
            
            // Convert TWG Subgroups to tags (comma-separated values become individual tags)
            if (record.twg_subgroups) {
                const subgroups = record.twg_subgroups.split(',').map(t => t.trim().toLowerCase().replace(/\s+/g, '')).filter(t => t);
                member.tags = [...member.tags, ...subgroups];
            }
            
            // Also check for 'tags' column in CSV and merge
            if (record.tags) {
                const csvTags = record.tags.split(',').map(t => t.trim().toLowerCase().replace(/\s+/g, '')).filter(t => t);
                member.tags = [...member.tags, ...csvTags];
            }
            
            // Only add if has a name
            if (member.first_name || member.last_name) {
                records.push(member);
            }
        }
    });
    
    parser.on('error', (err) => {
        res.status(400).json({ error: err.message });
    });
    
    parser.on('end', () => {
        const merged = [...members, ...records];
        writeMembers(merged);
        res.json({ 
            message: `Imported ${records.length} members`,
            imported: records.length,
            total: merged.length
        });
    });
});

// Get email templates (require authentication)
app.get('/api/templates', requireAuth, (req, res) => {
    const templates = readTemplates();
    res.json(templates);
});

// Save email template
app.post('/api/templates', requireAuth, (req, res) => {
    const templates = readTemplates();
    const newTemplate = {
        id: Date.now(),
        ...req.body
    };
    
    templates.push(newTemplate);
    fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2));
    
    res.status(201).json(newTemplate);
});

// Update email template
app.put('/api/templates/:id', requireAuth, (req, res) => {
    const templates = readTemplates();
    const index = templates.findIndex(t => t.id === parseInt(req.params.id));
    
    if (index === -1) {
        return res.status(404).json({ error: 'Template not found' });
    }
    
    templates[index] = { ...templates[index], ...req.body };
    fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2));
    
    res.json(templates[index]);
});

// Delete email template
app.delete('/api/templates/:id', requireAuth, (req, res) => {
    const templates = readTemplates();
    const index = templates.findIndex(t => t.id === parseInt(req.params.id));
    
    if (index === -1) {
        return res.status(404).json({ error: 'Template not found' });
    }
    
    templates.splice(index, 1);
    fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2));
    
    res.json({ success: true });
});

function sanitizeConfigForPublic(config) {
    const publicConfig = { ...config };
    delete publicConfig.adminPasswords;
    if (publicConfig.emailConfig) {
        publicConfig.emailConfig = {
            ...publicConfig.emailConfig,
            enableEmail: false,
            user: '',
            pass: ''
        };
    }
    return publicConfig;
}

// Config API routes
// GET is public (used on login page to display app name)
// PUT requires authentication
app.get('/api/config', (req, res) => {
    try {
        const data = fs.readFileSync(CONFIG_FILE, 'utf8');
        res.json(sanitizeConfigForPublic(JSON.parse(data)));
    } catch (error) {
        res.status(500).json({ error: 'Error reading config' });
    }
});

// Get app version (public endpoint)
app.get('/api/version', (req, res) => {
    try {
        const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
        res.json({ version: packageJson.version || '1.0.0' });
    } catch (error) {
        res.json({ version: '1.0.0' });
    }
});

app.put('/api/config', requireAuth, (req, res) => {
    try {
        // Support partial updates: merge request body into existing config
        const current = readConfig();
        const merged = deepMerge(current, req.body);
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Error saving config' });
    }
});

// Get available fields for table (require authentication)
app.get('/api/available-fields', requireAuth, (req, res) => {
    const fields = [
        { value: 'first_name', label: 'First Name' },
        { value: 'last_name', label: 'Last Name' },
        { value: 'email', label: 'Email' },
        { value: 'phone', label: 'Phone' },
        { value: 'approved', label: 'Approved' },
        { value: 'tags', label: 'Tags' },
        { value: 'address', label: 'Address' },
        { value: 'city', label: 'City' },
        { value: 'state', label: 'State' },
        { value: 'zip', label: 'Zip' },
        { value: 'mailing_list', label: 'Mailing List' }
    ];
    res.json(fields);
});

// Send welcome email
app.post('/api/send-email', requireAuth, async (req, res) => {
    const { to, subject, body, templateId, memberData } = req.body;
    const templates = readTemplates();
    
    let emailSubject = subject;
    let emailBody = body;
    
    // If templateId is provided, use template data
    if (templateId && !subject && !body) {
        const template = templates.find(t => t.id === parseInt(templateId));
        
        if (!template) {
            return res.status(404).json({ error: 'Template not found' });
        }
        
        emailSubject = template.subject;
        emailBody = template.body;
        
        // Replace placeholders with member data
        if (memberData) {
            emailBody = emailBody.replace(/{{first_name}}/g, memberData.first_name || '');
            emailBody = emailBody.replace(/{{last_name}}/g, memberData.last_name || '');
            emailBody = emailBody.replace(/{{email}}/g, memberData.email || '');
            emailSubject = emailSubject.replace(/{{first_name}}/g, memberData.first_name || '');
            emailSubject = emailSubject.replace(/{{last_name}}/g, memberData.last_name || '');
        }
    }
    
    // Save email log
    const emailLogs = readEmailLogs();
    const template = templateId ? templates.find(t => t.id === parseInt(templateId)) : null;
    const newLog = {
        id: Date.now(),
        to,
        subject: emailSubject,
        body: emailBody,
        templateId: templateId || null,
        templateName: template ? template.name : 'Custom',
        memberId: memberData?.id || null,
        memberName: memberData ? `${memberData.first_name || ''} ${memberData.last_name || ''}` : 'N/A',
        sentAt: new Date().toISOString(),
        status: 'sent',
        batchId: null  // Single email - no batch
    };
    emailLogs.unshift(newLog);
    writeEmailLogs(emailLogs);
    
    // Actually send the email
    const sendResult = await sendEmail(to, emailSubject, emailBody);
    
    // Update the log with simulated status
    newLog.simulated = sendResult.simulated || false;
    writeEmailLogs(emailLogs);
    
    if (sendResult.success) {
        debugLog(`Email ${sendResult.simulated ? 'SIMULATED' : 'SENT'} to: ${to}`);
    } else {
        console.error(`Failed to send email to: ${to}`, sendResult.error);
    }
    
    res.json({ 
        message: sendResult.simulated ? 'Email simulated (enable SMTP to send)' : 'Email sent',
        preview: { to, subject: emailSubject, body: emailBody },
        logId: newLog.id,
        simulated: sendResult.simulated || false
    });
});

// Send a test email using provided settings (admin only)
app.post('/api/email/test', requireAuth, requireAdmin, async (req, res) => {
    try {
        const to = (req.body?.to || '').toString().trim();
        const cfg = req.body?.emailConfig || {};
        
        const provider = cfg.provider || 'smtp';
        
        if (!to || !to.includes('@')) {
            return res.status(400).json({ error: 'Valid "to" email address is required' });
        }
        
        // Handle Mailgun test
        if (provider === 'mailgun') {
            const apiKey = (cfg.apiKey || '').toString().trim();
            const domain = (cfg.domain || '').toString().trim();
            const from = (cfg.from || '').toString().trim();
            
            if (!apiKey) {
                return res.status(400).json({ error: 'Mailgun API key is required' });
            }
            if (!domain) {
                return res.status(400).json({ error: 'Mailgun domain is required' });
            }
            
            // Initialize Mailgun client for testing
            let testMailgunClient;
            try {
                const mailgun = require('mailgun.js');
                const mailgunInstance = new mailgun();
                testMailgunClient = mailgunInstance.client({ username: 'api', key: apiKey });
            } catch (error) {
                return res.status(500).json({ error: 'Failed to initialize Mailgun client: ' + error.message });
            }
            
            const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
            
            try {
                const result = await testMailgunClient.messages().send({
                    from: from || `RosterCast <mailgun@${domain}>`,
                    to,
                    subject: `${stamp}-Test Email from MemberManagement System`,
                    text: 'This is a test email to confirm Mailgun API settings are working.'
                });
                
                debugLog('[mailgun-test] Email sent successfully, id:', result.id);
                return res.json({ success: true, messageId: result.id });
            } catch (error) {
                console.error('[mailgun-test] Error:', error?.message || error);
                return res.status(500).json({ error: error?.message || 'Failed to send test email via Mailgun' });
            }
        }
        
        // Handle SMTP test (existing code)
        const host = (cfg.host || '').toString().trim();
        const port = Number(cfg.port);
        const secure = !!cfg.secure;
        const user = (cfg.user || '').toString().trim();
        let pass = (cfg.pass || '').toString();
        const from = (cfg.from || user || '').toString().trim();

        debugLog('[smtp-test] Configuration received:');
        debugLog('[smtp-test]   host:', host);
        debugLog('[smtp-test]   port:', port);
        debugLog('[smtp-test]   secure:', secure);
        debugLog('[smtp-test]   user:', user);
        debugLog('[smtp-test]   pass:', pass ? '********' : '(empty)');
        debugLog('[smtp-test]   from:', from);
        debugLog('[smtp-test]   to:', to);

        // PASSWORD HANDLING: If password is masked or empty, use actual password from config/env
        const MASKED_PASSWORD = '********';
        if (!pass || pass === MASKED_PASSWORD) {
            debugLog('[smtp-test] Password is masked or empty, loading from config/env');
            // Re-initialize email config to get current password
            const config = readConfig();
            const envSmtpPass = process.env.SMTP_PASSWORD;
            
            // Use config.json password if present, otherwise .env
            if (config.emailConfig?.pass) {
                pass = config.emailConfig.pass;
                debugLog('[smtp-test] Using password from config.json');
            } else if (envSmtpPass) {
                pass = envSmtpPass;
                debugLog('[smtp-test] Using password from .env');
            } else {
                debugLog('[smtp-test] No password found in config.json or .env');
                return res.status(400).json({ error: 'SMTP password not configured in config.json or .env file' });
            }
        } else {
            debugLog('[smtp-test] Using password from request (user entered new password)');
        }

        if (!host) {
            return res.status(400).json({ error: 'SMTP host is required' });
        }
        if (!Number.isFinite(port) || port <= 0) {
            return res.status(400).json({ error: 'SMTP port is required' });
        }
        if (!user || !pass) {
            return res.status(400).json({ error: 'SMTP username and password/app password are required' });
        }

        const testTransporter = nodemailer.createTransport({
            host,
            port,
            secure,
            auth: { user, pass }
        });

        debugLog('[smtp-test] Verifying connection...');

        // Verify connection/auth before sending
        await testTransporter.verify();

        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

        debugLog('[smtp-test] Sending test email...');

        const info = await testTransporter.sendMail({
            from,
            to,
            subject: `${stamp}-Test Email from MemberManagement System`,
            text: 'This is a test email to confirm SMTP settings are working.'
        });

        debugLog('[smtp-test] Email sent successfully, messageId:', info?.messageId);

        return res.json({ success: true, messageId: info?.messageId || null });
    } catch (error) {
        console.error('[email-test] Error:', error?.message || error);
        return res.status(500).json({ error: error?.message || 'Failed to send test email' });
    }
});

// Email status (admin only)
app.get('/api/email/status', requireAuth, requireAdmin, (req, res) => {
    try {
        if (!emailConfig) {
            initializeEmail();
        }
        
        // Read config locally to check for emailConfig
        const config = readConfig();
        
        // Determine if email is enabled based on provider
        let enabled = false;
        if (emailConfig?.enableEmail) {
            if (emailConfig.provider === 'mailgun' && mailgunClient) {
                enabled = true;
            } else if (emailConfig.provider === 'smtp' && transporter) {
                enabled = true;
            }
        }
        
        // Check which settings come from .env vs config.json
        const smtpFromEnv = {
            user: !config.emailConfig?.user && !!process.env.SMTP_USERNAME,
            pass: !config.emailConfig?.pass && !!process.env.SMTP_PASSWORD
        };
        
        const mailgunFromEnv = {
            apiKey: !config.emailConfig?.mailgun?.apiKey && !!process.env.MAILGUN_API_KEY,
            domain: !config.emailConfig?.mailgun?.domain && !!process.env.MAILGUN_DOMAIN
        };
        
        res.json({
            enabled,
            configured: !!emailConfig?.enableEmail,
            provider: emailConfig?.provider || 'smtp',
            smtpFromEnv,
            mailgunFromEnv,
            // Return the actual email config (masked for security)
            emailConfig: {
                enableEmail: emailConfig?.enableEmail,
                provider: emailConfig?.provider || 'smtp',
                // SMTP config
                host: emailConfig?.host || '',
                port: emailConfig?.port || 587,
                secure: emailConfig?.secure || false,
                user: emailConfig?.user ? emailConfig.user : '',
                pass: emailConfig?.pass ? '********' : '',
                from: emailConfig?.from || '',
                // Mailgun config (nested object for client compatibility)
                mailgun: {
                    domain: emailConfig?.mailgun?.domain || (process.env.MAILGUN_DOMAIN || ''),
                    apiKey: emailConfig?.mailgun?.apiKey ? '********' : (process.env.MAILGUN_API_KEY ? '********' : ''),
                    from: emailConfig?.mailgun?.from || (process.env.MAILGUN_FROM || '')
                }
            }
        });
    } catch (error) {
        console.error('[email-status] Error:', error?.message || error);
        res.status(500).json({ error: 'Failed to get email status' });
    }
});

// Reload email configuration from config.json (admin only)
app.post('/api/email/reload', requireAuth, requireAdmin, (req, res) => {
    try {
        initializeEmail();
        
        // Check if email is enabled based on provider
        let enabled = false;
        if (emailConfig?.enableEmail) {
            if (emailConfig.provider === 'mailgun' && mailgunClient) {
                enabled = true;
            } else if (emailConfig.provider === 'smtp' && transporter) {
                enabled = true;
            }
        }
        
        res.json({
            success: true,
            enabled,
            provider: emailConfig?.provider || 'smtp',
            message: enabled 
                ? `Email configuration reloaded and enabled (${emailConfig.provider})`
                : 'Email configuration reloaded (disabled)'
        });
    } catch (error) {
        console.error('[email-reload] Error:', error?.message || error);
        res.status(500).json({ error: 'Failed to reload email configuration' });
    }
});

// Reload auth configuration from config.json (admin only)
app.post('/api/auth/reload', requireAuth, requireAdmin, (req, res) => {
    try {
        initializeAuth();
        updateAuthSettings();
        res.json({
            success: true,
            authEnabled: AUTH_ENABLED,
            publicReadOnly: PUBLIC_READONLY,
            message: AUTH_ENABLED 
                ? (PUBLIC_READONLY ? 'Auth reloaded - public read-only enabled' : 'Auth reloaded - full authentication enabled')
                : 'Auth reloaded - authentication disabled'
        });
    } catch (error) {
        console.error('[auth-reload] Error:', error?.message || error);
        res.status(500).json({ error: 'Failed to reload auth configuration' });
    }
});

// Reload ALL configuration from config.json (admin only)
// This reloads: auth, email, app settings, etc.
app.post('/api/reload-config', requireAuth, requireAdmin, (req, res) => {
    try {
        // Reload auth settings
        initializeAuth();
        updateAuthSettings();
        
        // Reload email settings
        initializeEmail();
        
        // Check if email is enabled based on provider
        let emailEnabled = false;
        if (emailConfig?.enableEmail) {
            if (emailConfig.provider === 'mailgun' && mailgunClient) {
                emailEnabled = true;
            } else if (emailConfig.provider === 'smtp' && transporter) {
                emailEnabled = true;
            }
        }
        
        // Read full config for logging
        const config = readConfig();
        
        debugLog('[reload-config] Configuration reloaded from config.json');
        debugLog('[reload-config] Auth:', AUTH_ENABLED, '| Public readonly:', PUBLIC_READONLY);
        debugLog('[reload-config] Email:', emailEnabled ? `enabled (${emailConfig.provider})` : 'disabled');
        debugLog('[reload-config] App name:', config.appName);
        
        res.json({
            success: true,
            message: 'Configuration reloaded successfully',
            settings: {
                authEnabled: AUTH_ENABLED,
                publicReadOnly: PUBLIC_READONLY,
                emailEnabled: emailEnabled,
                emailProvider: emailConfig?.provider || 'smtp',
                appName: config.appName
            }
        });
    } catch (error) {
        console.error('[reload-config] Error:', error?.message || error);
        res.status(500).json({ error: 'Failed to reload configuration' });
    }
});

// ============================================
// JOB QUEUE API ROUTES
// ============================================

// Get all jobs (admin only)
app.get('/api/jobs', requireAuth, requireAdmin, (req, res) => {
    try {
        const jobs = listJobs();
        res.json(jobs);
    } catch (error) {
        console.error('[jobs] Error listing jobs:', error);
        res.status(500).json({ error: 'Error listing jobs' });
    }
});

// Get job status (admin only)
app.get('/api/jobs/:jobId', requireAuth, requireAdmin, (req, res) => {
    const { jobId } = req.params;
    const job = getJob(jobId);
    
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    
    // Calculate percentage
    const percentage = job.totalRecipients > 0 
        ? Math.round((job.processedCount / job.totalRecipients) * 100) 
        : 0;
    
    res.json({
        ...job,
        percentage,
        elapsedSeconds: job.startedAt 
            ? Math.round((new Date(job.completedAt || Date.now()) - new Date(job.startedAt)) / 1000)
            : null
    });
});

// Delete job (admin only)
app.delete('/api/jobs/:jobId', requireAuth, requireAdmin, (req, res) => {
    const { jobId } = req.params;
    const deleted = deleteJob(jobId);
    
    if (deleted) {
        res.json({ success: true, message: 'Job deleted' });
    } else {
        res.status(404).json({ error: 'Job not found' });
    }
});

// Clean up old jobs (admin only)
app.post('/api/jobs/cleanup', requireAuth, requireAdmin, (req, res) => {
    const daysOld = parseInt(req.body.days) || 7;
    const deleted = cleanupOldJobs(daysOld);
    res.json({ success: true, deleted });
});

// Get email logs (require authentication)
app.get('/api/email-logs', requireAuth, (req, res) => {
    const logs = readEmailLogs();
    res.json(logs);
});

app.get('/api/email-logs/member/:memberId', requireAuth, requireAdmin, (req, res) => {
    const members = readMembers();
    const memberId = parseInt(req.params.memberId);
    const member = members.find(m => m.id === memberId);
    if (!member || !member.email) {
        return res.json([]);
    }
    const logs = readEmailLogs();
    const filtered = logs.filter(log => log.memberId === memberId);
    res.json(filtered);
});

// Get error log (admin only)
app.get('/api/error-log', requireAuth, requireAdmin, (req, res) => {
    try {
        if (fs.existsSync(ERROR_LOG_FILE)) {
            const content = fs.readFileSync(ERROR_LOG_FILE, 'utf8');
            // Return last 500 lines to avoid overwhelming response
            const lines = content.split('\n');
            const recentLines = lines.slice(-500);
            res.json({
                exists: true,
                content: recentLines.join('\n'),
                lineCount: lines.length
            });
        } else {
            res.json({ exists: false, content: '', lineCount: 0 });
        }
    } catch (error) {
        res.status(500).json({ error: 'Error reading error log' });
    }
});

// Clear error log (admin only)
app.delete('/api/error-log', requireAuth, requireAdmin, (req, res) => {
    try {
        if (fs.existsSync(ERROR_LOG_FILE)) {
            fs.unlinkSync(ERROR_LOG_FILE);
        }
        res.json({ success: true, message: 'Error log cleared' });
    } catch (error) {
        res.status(500).json({ error: 'Error clearing error log' });
    }
});

// Get recipients eligible for bulk email (require authentication)
app.get('/api/recipients', requireAuth, (req, res) => {
    const members = readMembers();
    const { tag, search } = req.query;
    
    // Filter to only include eligible recipients
    let eligibleMembers = members.filter(member => {
        // Exclude only if mailing_list === "No"
        if (member.mailing_list === 'No') return false;
        // Must be approved
        if (member.approved !== 'yes') return false;
        // Must have an email address
        if (!member.email || member.email.trim() === '') return false;
        return true;
    });
    
    // Filter by tag
    if (tag) {
        const tagLower = tag.toLowerCase();
        eligibleMembers = eligibleMembers.filter(member => 
            member.tags && Array.isArray(member.tags) && 
            member.tags.some(t => t.toLowerCase() === tagLower)
        );
    }
    
    // Filter by search query
    if (search) {
        const searchLower = search.toLowerCase();
        eligibleMembers = eligibleMembers.filter(member =>
            (member.first_name && member.first_name.toLowerCase().includes(searchLower)) ||
            (member.last_name && member.last_name.toLowerCase().includes(searchLower)) ||
            (member.email && member.email.toLowerCase().includes(searchLower))
        );
    }
    
    // Return minimal data needed for recipient selection
    const recipients = eligibleMembers.map(member => ({
        id: member.id,
        first_name: member.first_name,
        last_name: member.last_name,
        email: member.email,
        tags: member.tags
    }));
    
    res.json(recipients);
});

// Helper function to process a single batch of emails
async function processEmailBatch(members, batch, template, templateId, subject, body, emailLogs, bulkEmailId, onEmailProcessed) {
    const results = [];
    let sentCount = 0;
    let failedCount = 0;
    let simulatedCount = 0;
    const EMAIL_DELAY_MS = parseInt(process.env.BULK_EMAIL_DELAY_MS) || 500;
    
    for (let i = 0; i < batch.length; i++) {
        const member = batch[i];
        
        // Skip if no email
        if (!member.email || member.email.trim() === '') {
            results.push({
                memberId: member.id,
                memberName: `${member.first_name || ''} ${member.last_name || ''}`.trim(),
                to: 'N/A',
                status: 'failed',
                error: 'No email address'
            });
            failedCount++;
            // Update progress after each email
            if (onEmailProcessed) {
                onEmailProcessed('failed');
            }
            continue;
        }
        
        // Determine subject and body
        let emailSubject = subject || '';
        let emailBody = body || '';
        
        // If template is provided and no custom subject/body, use template
        if (template && !subject && !body) {
            emailSubject = template.subject;
            emailBody = template.body;
        }
        
        // Replace placeholders with member data
        if (emailBody) {
            emailBody = emailBody.replace(/{{first_name}}/g, member.first_name || '');
            emailBody = emailBody.replace(/{{last_name}}/g, member.last_name || '');
            emailBody = emailBody.replace(/{{email}}/g, member.email || '');
        }
        if (emailSubject) {
            emailSubject = emailSubject.replace(/{{first_name}}/g, member.first_name || '');
            emailSubject = emailSubject.replace(/{{last_name}}/g, member.last_name || '');
        }
        
        // Create email log entry
        const newLog = {
            id: Date.now() + Math.floor(Math.random() * 10000),
            to: member.email,
            subject: emailSubject,
            body: emailBody,
            templateId: templateId || null,
            templateName: template ? template.name : 'Custom',
            memberId: member.id,
            memberName: `${member.first_name || ''} ${member.last_name || ''}`.trim(),
            sentAt: new Date().toISOString(),
            status: 'sent',
            batchId: bulkEmailId || null  // Group related emails together
        };
        
        emailLogs.unshift(newLog);
        
        // Actually send the email
        const sendResult = await sendEmail(member.email, emailSubject, emailBody);
        
        // Update the log with simulated status
        newLog.simulated = sendResult.simulated || false;
        
        if (sendResult.simulated) {
            simulatedCount++;
        }
        
        if (sendResult.success) {
            debugLog(`Email ${sendResult.simulated ? 'SIMULATED' : 'SENT'} to: ${member.email}`);
            results.push({
                memberId: member.id,
                memberName: `${member.first_name || ''} ${member.last_name || ''}`.trim(),
                to: member.email,
                status: 'sent',
                simulated: sendResult.simulated || false
            });
            sentCount++;
            // Update progress after each email
            if (onEmailProcessed) {
                onEmailProcessed('sent', sendResult.simulated);
            }
        } else {
            logErrorToFile(new Error(sendResult.error), `BULK-${bulkEmailId}-FAILED-${member.email}`);
            console.error(`Failed to send email to: ${member.email}`, sendResult.error);
            results.push({
                memberId: member.id,
                memberName: `${member.first_name || ''} ${member.last_name || ''}`.trim(),
                to: member.email,
                status: 'failed',
                error: sendResult.error
            });
            failedCount++;
            // Update progress after each email
            if (onEmailProcessed) {
                onEmailProcessed('failed');
            }
        }
        
        // Rate limiting - wait between emails
        if (i < batch.length - 1) {
            await new Promise(resolve => setTimeout(resolve, EMAIL_DELAY_MS));
        }
    }
    
    return { results, sentCount, failedCount, simulatedCount };
}

// Send bulk email with batch processing (Job Queue)
app.post('/api/send-bulk-email', requireAuth, async (req, res) => {
    const { recipientIds, templateId, subject, body, batchSize } = req.body;
    const templates = readTemplates();
    const members = readMembers();
    
    if (!recipientIds || !Array.isArray(recipientIds) || recipientIds.length === 0) {
        return res.status(400).json({ error: 'No recipients specified' });
    }
    
    // Get the selected recipients
    const selectedMembers = members.filter(member => 
        recipientIds.includes(member.id)
    );
    
    if (selectedMembers.length === 0) {
        return res.status(400).json({ error: 'No valid recipients found' });
    }
    
    // Calculate batch size
    const config = readConfig();
    const configBatchSize = config.bulkEmailBatchSize || 100;
    const effectiveBatchSize = parseInt(batchSize) || configBatchSize;
    
    // Create job immediately
    const job = createJob('bulk-email', {
        recipientIds,
        templateId,
        subject,
        body,
        batchSize: effectiveBatchSize
    });
    
    debugLog(`[BULK-JOB] Created job ${job.id} for ${selectedMembers.length} recipients`);
    
    // Return job ID immediately - processing happens in background
    res.json({
        success: true,
        jobId: job.id,
        message: `Bulk email job started. Processing ${selectedMembers.length} recipients in ${Math.ceil(selectedMembers.length / effectiveBatchSize)} batches.`,
        total: selectedMembers.length,
        batches: Math.ceil(selectedMembers.length / effectiveBatchSize),
        batchSize: effectiveBatchSize
    });
    
    // Start processing in background (non-blocking)
    processBulkEmailJob(job.id, selectedMembers, templates, templateId, subject, body);
});

// Process bulk email job in background
async function processBulkEmailJob(jobId, selectedMembers, templates, templateId, subject, body) {
    const job = getJob(jobId);
    if (!job) {
        console.error(`[BULK-JOB] Job ${jobId} not found for processing`);
        return;
    }
    
    // Update job status to running
    updateJobStatus(jobId, JOB_STATUS.RUNNING);
    
    // Log start
    logErrorToFile(new Error(`Job ${jobId}: Started processing ${selectedMembers.length} recipients`), `BULK-JOB-${jobId}`);
    
    const totalRecipients = selectedMembers.length;
    const batchSize = job.batchSize;
    
    // Split into batches
    const batches = [];
    for (let i = 0; i < selectedMembers.length; i += batchSize) {
        batches.push(selectedMembers.slice(i, i + batchSize));
    }
    
    const totalBatches = batches.length;
    
    // Get template if provided
    let template = null;
    if (templateId) {
        template = templates.find(t => t.id === parseInt(templateId));
    }
    
    const emailLogs = readEmailLogs();
    const allResults = [];
    let totalSentCount = 0;
    let totalFailedCount = 0;
    let totalSimulatedCount = 0;
    let totalProcessed = 0;
    
    try {
        // Process each batch
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];
            
            debugLog(`[BULK-JOB] Job ${jobId}: Processing batch ${batchIndex + 1}/${totalBatches} (${batch.length} emails)`);
            
            // Process this batch
            const batchResult = await processEmailBatch(
                selectedMembers, batch, template, templateId, subject, body, 
                emailLogs, `JOB-${jobId}`,
                (status, simulated) => {
                    // Per-email progress callback
                    totalProcessed++;
                    if (status === 'sent') {
                        totalSentCount++;
                        if (simulated) totalSimulatedCount++;
                    } else {
                        totalFailedCount++;
                    }
                    
                    // Update job progress after each email
                    updateJobProgress(jobId, totalProcessed, totalSentCount, totalFailedCount, totalSimulatedCount);
                }
            );
            
            allResults.push(...batchResult.results);
            
            // Update job progress after batch
            updateJobProgress(jobId, totalProcessed, totalSentCount, totalFailedCount, totalSimulatedCount);
            
            debugLog(`[BULK-JOB] Job ${jobId}: Batch ${batchIndex + 1}/${totalBatches} complete: ${batchResult.sentCount} sent, ${batchResult.failedCount} failed`);
            
            // Pause between batches (except after last batch)
            if (batchIndex < batches.length - 1) {
                const BATCH_DELAY_MS = parseInt(process.env.BULK_EMAIL_BATCH_DELAY_MS) || 1000;
                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
            }
        }
        
        writeEmailLogs(emailLogs);
        
        // Calculate elapsed time
        const completedJob = getJob(jobId);
        const elapsedSeconds = completedJob?.startedAt 
            ? Math.round((Date.now() - new Date(completedJob.startedAt).getTime()) / 1000)
            : 0;
        
        // Mark job as completed
        const modeIndicator = totalSimulatedCount > 0 
            ? (totalSimulatedCount === totalSentCount ? 'SIM' : 'SIM+REAL') 
            : 'REAL';
        const completionMessage = `Job ${jobId} ${modeIndicator}: ${totalSentCount} sent, ${totalFailedCount} failed | ${totalBatches} batches | ${elapsedSeconds}s`;
        
        updateJobStatus(jobId, JOB_STATUS.COMPLETED, {
            message: completionMessage,
            results: allResults.slice(0, 100) // Save first 100 results
        });
        
        logErrorToFile(new Error(completionMessage), `BULK-JOB-${jobId}`);
        
        debugLog(`[BULK-JOB] Job ${jobId}: Completed successfully`);
        
    } catch (error) {
        console.error(`[BULK-JOB] Job ${jobId} failed:`, error);
        
        logErrorToFile(error, `BULK-JOB-${jobId}-ERROR`);
        
        updateJobStatus(jobId, JOB_STATUS.FAILED, {
            error: error.message || 'Unknown error',
            results: allResults.slice(0, 100)
        });
    }
}

// BACKUP / RESTORE API ROUTES
// ============================================

// Get list of backups (require authentication)
app.get('/api/backup/list', requireAuth, (req, res) => {
    try {
        const files = fs.readdirSync(BACKUP_DIR);
        const backups = files
            .filter(f => f.endsWith('.zip'))
            .map(filename => {
                const filepath = path.join(BACKUP_DIR, filename);
                const stats = fs.statSync(filepath);
                return {
                    filename,
                    size: stats.size,
                    createdAt: stats.birthtime
                };
            })
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.json(backups);
    } catch (error) {
        console.error('Error listing backups:', error);
        res.json([]);
    }
});

// Create a new backup
app.post('/api/backup/create', requireAuth, requireAdmin, (req, res) => {
    try {
        const zip = new AdmZip();
        
        // Add all data files to the zip
        const dataFiles = ['members.json', 'email-templates.json', 'config.json', 'email-logs.json', 'landing-content.html'];
        
        dataFiles.forEach(filename => {
            const filepath = path.join(DATA_DIR, filename);
            if (fs.existsSync(filepath)) {
                zip.addFile(filename, fs.readFileSync(filepath));
            }
        });
        
        // Add images from data/images directory
        const imagesDir = path.join(DATA_DIR, 'images');
        if (fs.existsSync(imagesDir)) {
            const imageFiles = fs.readdirSync(imagesDir);
            imageFiles.forEach(filename => {
                const filepath = path.join(imagesDir, filename);
                if (fs.statSync(filepath).isFile()) {
                    zip.addFile(`images/${filename}`, fs.readFileSync(filepath));
                }
            });
        }
        
        // Add a manifest file with backup info
        const manifest = {
            createdAt: new Date().toISOString(),
            version: packageJson.version || '1.0.0',
            files: dataFiles.filter(f => fs.existsSync(path.join(DATA_DIR, f)))
        };
        
        // Add images to manifest
        if (fs.existsSync(imagesDir)) {
            const imageFiles = fs.readdirSync(imagesDir);
            imageFiles.forEach(filename => {
                manifest.files.push(`images/${filename}`);
            });
        }
        zip.addFile('backup-manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
        
        // Generate filename with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `backup-${timestamp}.zip`;
        const filepath = path.join(BACKUP_DIR, filename);
        
        // Save the zip file
        zip.writeZip(filepath);
        
        // Send the zip file as a download
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(zip.toBuffer());
    } catch (error) {
        console.error('Error creating backup:', error);
        res.status(500).json({ error: 'Error creating backup: ' + error.message });
    }
});

// Download a backup file (require authentication)
app.get('/api/backup/download/:filename', requireAuth, (req, res) => {
    const filename = req.params.filename;
    const filepath = path.join(BACKUP_DIR, filename);
    
    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ error: 'Backup not found' });
    }
    
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.sendFile(filepath);
});

// Middleware for handling file uploads
const multer = require('multer');
const upload = multer({ dest: UPLOADS_DIR });

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Restore from uploaded file
app.post('/api/backup/restore', requireAuth, requireAdmin, upload.single('backup'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No backup file uploaded' });
    }
    
    restoreFromFile(req.file.path, res);
});

// Restore from saved backup file
app.post('/api/backup/restore/:filename', requireAuth, requireAdmin, (req, res) => {
    const filename = req.params.filename;
    const filepath = path.join(BACKUP_DIR, filename);
    
    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ error: 'Backup not found' });
    }
    
    restoreFromFile(filepath, res);
});

// Helper function to restore from a zip file
function restoreFromFile(filepath, res) {
    try {
        const zip = new AdmZip(filepath);
        
        // Check for manifest
        const manifestEntry = zip.getEntry('backup-manifest.json');
        let manifest = null;
        if (manifestEntry) {
            try {
                manifest = JSON.parse(zip.readAsText(manifestEntry));
            } catch (e) {
                console.error('Error parsing manifest:', e);
            }
        }
        
        // Restore each data file
        const dataFiles = ['members.json', 'email-templates.json', 'config.json', 'email-logs.json', 'landing-content.html'];
        let restoredFiles = [];
        
        dataFiles.forEach(filename => {
            const entry = zip.getEntry(filename);
            if (entry) {
                const destPath = path.join(DATA_DIR, filename);
                fs.writeFileSync(destPath, entry.getData());
                restoredFiles.push(filename);
            }
        });
        
        // Restore images from zip
        const imagesDir = path.join(DATA_DIR, 'images');
        if (!fs.existsSync(imagesDir)) {
            fs.mkdirSync(imagesDir, { recursive: true });
        }
        
        // Find and restore image files
        const zipEntries = zip.getEntries();
        zipEntries.forEach(entry => {
            if (entry.entryName.startsWith('images/') && !entry.isDirectory) {
                const filename = path.basename(entry.entryName);
                const destPath = path.join(imagesDir, filename);
                fs.writeFileSync(destPath, entry.getData());
                restoredFiles.push(`images/${filename}`);
            }
        });
        
        // Clean up uploaded file if it exists
        if (filepath.includes('/uploads/')) {
            fs.unlinkSync(filepath);
        }
        
        res.json({
            message: 'Backup restored successfully',
            restoredFiles,
            manifest
        });
    } catch (error) {
        console.error('Error restoring backup:', error);
        res.status(500).json({ error: 'Error restoring backup: ' + error.message });
    }
}

// Delete a backup file
app.delete('/api/backup/:filename', requireAuth, requireAdmin, (req, res) => {
    const filename = req.params.filename;
    const filepath = path.join(BACKUP_DIR, filename);
    
    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ error: 'Backup not found' });
    }
    
    try {
        fs.unlinkSync(filepath);
        res.json({ message: 'Backup deleted successfully' });
    } catch (error) {
        console.error('Error deleting backup:', error);
        res.status(500).json({ error: 'Error deleting backup' });
    }
});

// ============================================
// ROSTER PDF API ROUTES
// ============================================

// Get latest PDF info (public access for navigation link)
app.get('/api/roster-pdf/latest', (req, res) => {
    try {
        const latestPdf = JSON.parse(fs.readFileSync(LATEST_PDF_FILE, 'utf8'));
        if (latestPdf.filename && fs.existsSync(path.join(PDF_DIR, latestPdf.filename))) {
            res.json({
                exists: true,
                filename: latestPdf.filename,
                generatedAt: latestPdf.generatedAt,
                url: `/api/roster-pdf/download/${latestPdf.filename}`
            });
        } else {
            res.json({ exists: false });
        }
    } catch (error) {
        console.error('Error getting latest PDF:', error);
        res.json({ exists: false });
    }
});

// Save a generated PDF (admin only)
app.post('/api/roster-pdf/save', requireAuth, requireAdmin, (req, res) => {
    try {
        const { pdfData, memberCount } = req.body;
        
        if (!pdfData) {
            return res.status(400).json({ error: 'PDF data is required' });
        }
        
        // Generate filename with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `GroupRoster-${timestamp}.pdf`;
        const filepath = path.join(PDF_DIR, filename);
        
        // Decode base64 PDF data and save to file
        const pdfBuffer = Buffer.from(pdfData, 'base64');
        fs.writeFileSync(filepath, pdfBuffer);
        
        // Update latest PDF tracking
        const latestPdf = {
            filename,
            generatedAt: new Date().toISOString(),
            memberCount: memberCount || 0
        };
        fs.writeFileSync(LATEST_PDF_FILE, JSON.stringify(latestPdf, null, 2));
        
        debugLog(`PDF saved: ${filename} (${pdfBuffer.length} bytes)`);
        
        res.json({
            success: true,
            filename,
            url: `/api/roster-pdf/download/${filename}`
        });
    } catch (error) {
        console.error('Error saving PDF:', error);
        res.status(500).json({ error: 'Error saving PDF: ' + error.message });
    }
});

// Download a PDF file (auth OR public read-only)
app.get('/api/roster-pdf/download/:filename', requireAuthOrPublicRead, (req, res) => {
    const filename = req.params.filename;
    const filepath = path.join(PDF_DIR, filename);
    
    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ error: 'PDF not found' });
    }
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.sendFile(filepath);
});

// Serve the main HTML file
// Serve landing content
app.get('/landing-content.html', (req, res) => {
    console.log('Request for landing-content.html received from:', req.ip);
    const filePath = path.join(__dirname, 'data', 'landing-content.html');
    console.log('Serving file from:', filePath);
    if (fs.existsSync(filePath)) {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        console.log('File content length:', fileContent.length);
        res.sendFile(filePath);
    } else {
        console.error('File not found:', filePath);
        res.status(404).send('File not found');
    }
});

// Update landing content (admin only)
app.put('/api/landing-content', requireAuth, requireAdmin, (req, res) => {
    try {
        const { content } = req.body;
        const filePath = path.join(__dirname, 'data', 'landing-content.html');
        fs.writeFileSync(filePath, content);
        console.log('Landing content updated');
        res.json({ success: true, message: 'Landing page content updated successfully' });
    } catch (error) {
        console.error('Error updating landing content:', error);
        res.status(500).json({ error: 'Failed to update landing page content' });
    }
});

// Get landing content (admin only)
app.get('/api/landing-content', requireAuth, requireAdmin, (req, res) => {
    try {
        const filePath = path.join(__dirname, 'data', 'landing-content.html');
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            res.json({ content });
        } else {
            res.status(404).json({ error: 'Landing content file not found' });
        }
    } catch (error) {
        console.error('Error reading landing content:', error);
        res.status(500).json({ error: 'Failed to read landing page content' });
    }
});

// Serve images from data/images
app.get('/images/:filename', (req, res) => {
    res.sendFile(path.join(__dirname, 'data', 'images', req.params.filename));
});

// Serve the main HTML file
app.get('/', (req, res) => {
    res.render('index', { year: new Date().getFullYear() });
});

app.get('/index.html', (req, res) => {
    res.render('index', { year: new Date().getFullYear() });
});

app.get('/login.html', (req, res) => {
    res.render('login', { year: new Date().getFullYear() });
});

app.listen(PORT, '0.0.0.0', () => {
    const interfaces = os.networkInterfaces();
    let localIP = 'localhost';
    
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                localIP = iface.address;
                break;
            }
        }
        if (localIP !== 'localhost') break;
    }
    
    console.log('\n========================================');
    console.log('  RosterCast App  v' + (packageJson.version || '1.0.0'));
    console.log('========================================');
    console.log(`\n  Local:   http://localhost:${PORT}`);
    console.log(`  Network: http://${localIP}:${PORT}`);
    console.log('\n  Press Ctrl+C to stop\n');
});
