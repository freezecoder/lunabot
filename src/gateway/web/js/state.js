/**
 * Simple reactive state management for LocalBot Dashboard
 */

// State store
const state = {
  // Connection
  connected: false,
  lastUpdate: null,

  // Theme
  theme: localStorage.getItem('theme') || 'dark',

  // Current view
  view: 'dashboard',

  // Data
  health: null,
  services: [],
  sessions: { terminal: {}, telegram: {} },
  activity: { entries: [], stats: {} },
  tools: [],
  cron: [],
  metrics: {},
  ollama: null,

  // Events (database)
  events: [],
  eventTypes: { eventTypes: [], channels: [], levels: [] },

  // Database sessions (enhanced)
  dbSessions: [],
  selectedSession: null,

  // Memory
  memory: null,
  memoryHistory: [],

  // Workspace (SOUL, MEMORY, etc.)
  workspace: null,
  selectedWorkspaceFile: null,

  // Chat (interactive conversation)
  chat: {
    sessionId: null,
    messages: [],
    input: '',
    streaming: false,
    streamingContent: '',
    model: null,
    error: null,
  },

  // Loading states
  loading: {
    health: false,
    sessions: false,
    activity: false,
    tools: false,
    cron: false,
    metrics: false,
    ollama: false,
    events: false,
    dbSessions: false,
    sessionDetail: false,
    memory: false,
    workspace: false,
    chat: false,
  },

  // Filters
  filters: {
    activitySource: null,
    activityLimit: 50,
    toolSearch: '',
    eventChannel: null,
    eventType: null,
    eventLevel: null,
    eventLimit: 100,
    sessionChannel: null,
  },
};

// Subscribers
const subscribers = new Set();

/**
 * Subscribe to state changes
 */
export function subscribe(callback) {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

/**
 * Get current state
 */
export function getState() {
  return state;
}

/**
 * Update state and notify subscribers
 */
export function setState(updates) {
  Object.assign(state, updates);
  state.lastUpdate = Date.now();
  notifySubscribers();
}

/**
 * Update nested state
 */
export function setNestedState(path, value) {
  const keys = path.split('.');
  let obj = state;
  for (let i = 0; i < keys.length - 1; i++) {
    obj = obj[keys[i]];
  }
  obj[keys[keys.length - 1]] = value;
  state.lastUpdate = Date.now();
  notifySubscribers();
}

/**
 * Notify all subscribers
 */
function notifySubscribers() {
  for (const callback of subscribers) {
    try {
      callback(state);
    } catch (error) {
      console.error('State subscriber error:', error);
    }
  }
}

/**
 * Set theme and persist
 */
export function setTheme(theme) {
  state.theme = theme;
  localStorage.setItem('theme', theme);
  document.documentElement.setAttribute('data-theme', theme);
  notifySubscribers();
}

/**
 * Toggle theme
 */
export function toggleTheme() {
  setTheme(state.theme === 'dark' ? 'light' : 'dark');
}

/**
 * Set current view
 */
export function setView(view) {
  state.view = view;
  notifySubscribers();
}

/**
 * Set loading state
 */
export function setLoading(key, loading) {
  state.loading[key] = loading;
  notifySubscribers();
}

/**
 * Set filter
 */
export function setFilter(key, value) {
  state.filters[key] = value;
  notifySubscribers();
}

// Initialize theme
document.documentElement.setAttribute('data-theme', state.theme);
