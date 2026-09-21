/**
 * Moca SDK - Client library for integrating external apps with Moca Hub
 * 
 * This library handles the secure launch token flow:
 * 1. Detects moca_token in URL query params
 * 2. Validates the token with Moca Hub
 * 3. Stores client context + API keys in sessionStorage
 * 4. Provides easy access to config values
 * 
 * @version 1.0.0
 */

class MocaSDK {
    constructor(hubUrl) {
        this.hubUrl = hubUrl.replace(/\/$/, ''); // Remove trailing slash
        this.sessionKey = 'moca_session';
        this.session = null;
    }

    /**
     * Initialize the SDK - checks for token in URL and validates it
     * Call this at app startup before rendering the UI
     * 
     * @returns {Promise<boolean>} - true if authenticated, false otherwise
     */
    async init() {
        // Check if we already have a valid session
        const existingSession = this._loadSession();
        if (existingSession) {
            this.session = existingSession;
            return true;
        }

        // Check for token in URL
        const params = new URLSearchParams(window.location.search);
        const token = params.get('moca_token');

        // LOCAL DEV MODE
        // If we are on localhost and have a mock config, use it
        if (!token && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
            if (this.mockConfig) {
                console.info('[Moca SDK] Running in MOCK MODE for local development');
                this.session = {
                    client: this.mockConfig.client || { id: 'mock-client', name: 'Moca Client (Mock)', logo_url: 'https://placehold.co/100/E52217/FFFFFF?text=M' },
                    user: this.mockConfig.user || { id: 'mock-user', name: 'Developer (Mock)', role: 'admin' },
                    application: { id: 'mock-app', name: 'Local App' },
                    configurations: this.mockConfig.configurations || {},
                    timestamp: Date.now(),
                };
                this._saveSession();
                return true;
            } else {
                console.warn('[Moca SDK] Running locally but no mock config found. Call moca.enableMockMode() before init() to test without Hub.');
            }
        }

        if (!token) {
            console.warn('[Moca SDK] No token found in URL and no existing session');
            return false;
        }

        // Validate the token with Moca Hub
        try {
            const response = await fetch(`${this.hubUrl}/api/validate-launch-token`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ token }),
            });

            const data = await response.json();

            if (!response.ok || !data.success) {
                console.error('[Moca SDK] Token validation failed:', data.error || data.code);
                this._showError(data.error || 'Token non valido', data.code);
                return false;
            }

            // Store session data
            this.session = {
                client: data.client,
                user: data.user,
                application: data.application,
                configurations: data.configurations,
                timestamp: Date.now(),
            };

            this._saveSession();

            // Clean up URL (remove token from address bar)
            this._cleanUrl();

            console.info('[Moca SDK] Authenticated successfully', {
                client: data.client.name,
                user: data.user.name,
            });

            return true;
        } catch (error) {
            console.error('[Moca SDK] Network error during token validation:', error);
            this._showError('Errore di connessione con Moca Hub');
            return false;
        }
    }

    /**
     * Enable Mock Mode for local development
     * @param {Object} config - Mock configuration
     * @param {Object} config.client - Mock client data
     * @param {Object} config.user - Mock user data
     * @param {Object} config.configurations - Mock API keys and settings
     */
    enableMockMode(config = {}) {
        this.mockConfig = config;
    }

    /**
     * Check if the user is authenticated
     * @returns {boolean}
     */
    isAuthenticated() {
        return this.session !== null;
    }

    /**
     * Get a specific configuration value by key
     * @param {string} key - Configuration key (e.g., 'OPENAI_API_KEY')
     * @returns {string|null}
     */
    getConfig(key) {
        if (!this.session || !this.session.configurations) {
            console.warn(`[Moca SDK] Cannot get config '${key}': not authenticated`);
            return null;
        }
        return this.session.configurations[key] || null;
    }

    /**
     * Get all configurations as an object
     * @returns {Object}
     */
    getAllConfigs() {
        if (!this.session || !this.session.configurations) {
            return {};
        }
        return { ...this.session.configurations };
    }

    /**
     * Get client information
     * @returns {Object|null} - { id, name, email, logo_url }
     */
    getClient() {
        return this.session?.client || null;
    }

    /**
     * Get user information
     * @returns {Object|null} - { id, name, email, role, level, job_title }
     */
    getUser() {
        return this.session?.user || null;
    }

    /**
     * Get application information
     * @returns {Object|null} - { id, name, description }
     */
    getApplication() {
        return this.session?.application || null;
    }

    /**
     * Clear the session (logout)
     */
    logout() {
        sessionStorage.removeItem(this.sessionKey);
        this.session = null;
    }

    /**
     * Show an "Access Denied" screen
     * Call this if init() returns false
     */
    showAccessDenied() {
        document.body.innerHTML = `
      <div style="
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        font-family: system-ui, -apple-system, sans-serif;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        text-align: center;
        padding: 20px;
      ">
        <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        <h1 style="font-size: 2rem; margin: 20px 0 10px 0; font-weight: bold;">
          Accesso Negato
        </h1>
        <p style="font-size: 1.1rem; max-width: 500px; opacity: 0.9;">
          Questa applicazione deve essere aperta tramite <strong>Moca Hub</strong>.
        </p>
        <a 
          href="${this.hubUrl}"
          style="
            margin-top: 30px;
            padding: 12px 24px;
            background: white;
            color: #667eea;
            border-radius: 8px;
            text-decoration: none;
            font-weight: 600;
            box-shadow: 0 4px 6px rgba(0,0,0,0.2);
          "
        >
          Vai a Moca Hub
        </a>
      </div>
    `;
    }

    // --- Private methods ---

    _loadSession() {
        try {
            const stored = sessionStorage.getItem(this.sessionKey);
            if (!stored) return null;

            const session = JSON.parse(stored);

            // Session expires after 8 hours
            const maxAge = 8 * 60 * 60 * 1000;
            if (Date.now() - session.timestamp > maxAge) {
                sessionStorage.removeItem(this.sessionKey);
                return null;
            }

            return session;
        } catch (error) {
            console.error('[Moca SDK] Failed to load session:', error);
            return null;
        }
    }

    _saveSession() {
        try {
            sessionStorage.setItem(this.sessionKey, JSON.stringify(this.session));
        } catch (error) {
            console.error('[Moca SDK] Failed to save session:', error);
        }
    }

    _cleanUrl() {
        const url = new URL(window.location.href);
        url.searchParams.delete('moca_token');
        window.history.replaceState({}, document.title, url.toString());
    }

    _showError(message, code) {
        console.error(`[Moca SDK] Error: ${message}${code ? ` (${code})` : ''}`);
        // Optionally show UI error - for now just log
    }
}

// Export for both CommonJS and ES6 modules, and as global
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MocaSDK;
}
if (typeof window !== 'undefined') {
    window.MocaSDK = MocaSDK;
}
